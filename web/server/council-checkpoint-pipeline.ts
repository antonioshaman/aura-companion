import { createHash } from "node:crypto";
import { join } from "node:path";
import type { WsBridge, BridgeObserverWakeOutcome } from "./ws-bridge.js";
import type { SessionGroupCoordinator } from "./session-group-coordinator.js";
import type { GroupDegradeReason } from "./group-state-machine.js";
import type { CheckpointPayload, ObserverReviewPayload } from "./council-types.js";
import {
  OBSERVER_WAKE_PAYLOAD_VERSION,
  OBSERVER_WAKE_TIMEOUT_MS,
  normalizeCodexObserverReviewRaw,
  normalizeObserverFindingShapeRaw,
} from "./council-types.js";
import { companionBus } from "./event-bus.js";
import { metricsCollector } from "./metrics-collector.js";
import { log } from "./logger.js";
import { findReviewForCheckpointSync } from "./review-watcher.js";
import { validateObserverFindings } from "./observer-grounding.js";
import { applyDisputes, readDisputes } from "./observer-disputes.js";
import type { CheckpointLineSnapshots } from "./observer-line-snapshots.js";
import { maybeEmitEvalSidecar } from "./eval-sidecar.js";
import { buildObserverContextManifest, buildObserverWakePayload } from "./observer-prompt.js";
import type { ObserverReplyCapture } from "./observer-reply.js";
import { readCouncilWakeSentinel, writeCouncilWakeSentinel } from "./council-wake-sentinel.js";
import { formatObserverInvocationLog } from "./observer-attribution.js";
import type { BrowserObserverDowngrade, BrowserObserverFinding } from "./session-types.js";

/**
 * Council Mode checkpoint pipeline (aura-meta-diet P4/C1a): checkpoint
 * arrival → observer wake dispatch (gates, 1-slot queue, sentinel) →
 * wake→review watchdog → observer reply capture → review grounding and
 * `group:review` fan-out.
 *
 * Extracted verbatim from `session-orchestrator.ts`. Group lifecycle stays
 * with the orchestrator; it owns the watcher/meta maps and hands them in
 * (AP-1 DI). Getters resolve lazily so a coordinator created later, or a
 * swapped idle-timer manager, is seen at call time.
 */

/**
 * P3/B1: consecutive unusable observer replies tolerated before the
 * wake→review watchdog is allowed to degrade the group. One bad answer is
 * noise; three in a row is a broken observer the operator must see.
 */
export const OBSERVER_REPLY_REJECTIONS_BEFORE_DEGRADE = 3;

export interface CouncilWatcherEntry {
  cwd: string;
  abort: AbortController;
  /** Most recently observed checkpoint payload — drives grounding for the next review. */
  lastCheckpoint: CheckpointPayload | null;
  /** The checkpoint that preceded `lastCheckpoint` — fed to `buildObserverContextManifest` so the manifest is delta-not-cumulative. */
  previousCheckpoint: CheckpointPayload | null;
  /**
   * Council Mode auto-wake — 1-slot newest-wins queue (Task 4).
   *
   * When `dispatchObserverWake` finds the observer is `busy` (turn-state
   * in-flight from a previous wake), the arriving checkpoint lands here
   * instead of being dropped. A subsequent checkpoint arriving before the
   * observer drains overwrites the slot — newest-wins, consistent with
   * the EC-4 watcher-debounce idiom and the orchestrator-side sequence
   * semantic (newer phase supersedes older).
   *
   * Drained when {@link SessionOrchestrator.onObserverTurnDone} fires
   * (Task 5 wires the trigger). Cleared on group teardown for free
   * because the whole entry is removed in `SessionOrchestrator.stopCouncilWatchers`.
   */
  pendingCheckpoint: CheckpointPayload | null;
  /**
   * Task 4/9: checkpoint ids superseded by the newest-wins queue since
   * the previous `observer_review` emit. Drained into the next review's
   * `supersededCheckpointIds` field so the panel can surface "checkpoint
   * X was skipped (superseded)". Cleared after each successful review
   * emit.
   */
  supersededCheckpointIds: string[];
  /**
   * Council Review 2026-06-13 (P1 #1 — accept-but-no-review ghost): the
   * wake→review watchdog. Armed when a wake is successfully dispatched
   * (`dispatchObserverWake` returns `dispatched`), cleared when a matching
   * review file arrives in `handleCouncilReview`, and fired after
   * `OBSERVER_WAKE_TIMEOUT_MS` if no review landed — degrading the group
   * with reason `wake_produced_no_review`. Single-slot: arming a new
   * checkpoint's watchdog clears the prior one (newest checkpoint is the
   * one the observer is now expected to review). Cleared on teardown.
   */
  pendingReviewDeadline: { checkpointId: string; timer: ReturnType<typeof setTimeout> } | null;
}

/**
 * Outcome returned by {@link CouncilCheckpointPipeline.dispatchObserverWake}.
 *
 * Wraps the bridge/adapter-level outcomes with coordinator-level gates
 * (group status, observer-half presence) so the EC-9 audit log emits
 * exactly one structured line per dispatch attempt, with a reason field
 * that pinpoints which gate fired.
 *
 * `dispatched` — wake frame was successfully passed to the adapter's
 *   socket send. `droppedPathCount` reports how many manifest paths
 *   the realpath boundary check filtered out (Task 7) for ops visibility.
 * `skipped` — a gate prevented dispatch; the watcher remains armed for
 *   the next checkpoint. Reasons:
 *     - `observer_unknown` — no observer half mapped for this group
 *     - `group_not_active` — group status is pairing/degraded/reconnecting/archived
 *     - `adapter_missing` — session exists but its backend adapter is null (transient)
 *     - `unsupported_backend` — adapter is not ClaudeAdapter (Codex pairing not yet wired)
 *     - `socket_disconnected` — observer cliSocket null or not OPEN
 *     - `backpressure` — observer socket's bufferedAmount exceeds threshold
 *     - `observer_busy` — observer turn-state is in-flight (queue in Task 4)
 *     - `build_error` — `buildObserverWakePayload` threw on input validation
 *     - `api_limit_reached` — observer previously reported a 429/credit limit
 * `failed` — `adapter.cliSocket.send` threw synchronously; per Subprocess
 *   Council Rec 6, do NOT mark the half degraded — the natural socket-close
 *   handler will fire `session:exited` and the reconnect path takes over.
 */
export type WakeDispatchOutcome =
  | { kind: "dispatched"; checkpointId: string; observerSessionId: string; droppedPathCount: number; wakeBodySha256: string }
  | { kind: "skipped"; reason:
      | "observer_unknown"
      | "group_not_active"
      | "adapter_missing"
      | "unsupported_backend"
      | "socket_disconnected"
      | "backpressure"
      | "observer_busy"
      | "build_error"
      | "api_limit_reached"
      | "already_woken" }
  | { kind: "failed"; error: string };

/**
 * Pure: derive a deterministic finding id from the review identity tuple.
 * Same inputs → same id across server restarts, so the browser's
 * `appendObserverReview` dedup actually catches restart-replays.
 *
 * `evidencePath` + `claim` are mixed into the hash so two findings on
 * the same `(group, checkpoint, provider, index)` with different content
 * (e.g. a re-emitted review with different rows) still get distinct ids.
 *
 * Exported for unit testing — pure, no side effects.
 */
export function deterministicFindingId(input: {
  sessionGroupId: string;
  checkpointId: string;
  observerProvider: string;
  findingIndex: number;
  evidencePath: string;
  claim: string;
}): string {
  const hash = createHash("sha256");
  hash.update(input.sessionGroupId);
  hash.update("\x00");
  hash.update(input.checkpointId);
  hash.update("\x00");
  hash.update(input.observerProvider);
  hash.update("\x00");
  hash.update(String(input.findingIndex));
  hash.update("\x00");
  hash.update(input.evidencePath);
  hash.update("\x00");
  hash.update(input.claim);
  return `fnd_${hash.digest("hex").slice(0, 16)}`;
}

/** The slice of the orchestrator's per-group meta this pipeline reads and writes. */
export interface CheckpointPipelineGroupMeta {
  primarySessionId: string;
  observerSessionId: string;
  pairing: string;
  observerPromptSha256?: string;
  observerPromptSource?: "workspace" | "bundled";
  observerPromptVersion?: number;
  observerModel?: string;
  lastCheckpointReceivedAt: number | null;
  lastReviewedCheckpointId?: string | null;
}

export interface CouncilCheckpointPipelineDeps {
  /** Owned by the orchestrator: started/stopped with the group's watchers. */
  watchers: Map<string, CouncilWatcherEntry>;
  /** Owned by the orchestrator: group lifecycle meta. */
  groupMeta: ReadonlyMap<string, CheckpointPipelineGroupMeta>;
  getCoordinator: () => SessionGroupCoordinator | null;
  getWsBridge: () => Pick<WsBridge, "sendObserverWakeFrame">;
  isApiLimitReached: (sessionId: string) => boolean;
  replyCapture: ObserverReplyCapture;
  lineSnapshots: CheckpointLineSnapshots;
}

export class CouncilCheckpointPipeline {
  constructor(private readonly deps: CouncilCheckpointPipelineDeps) {}

  /**
   * Council Review 2026-05-13-0150 Fowler #6: extracted helper for the
   * three dispatcher arms that queue a checkpoint into pendingCheckpoint
   * (reconnecting, busy, backpressure). Previously the supersede log +
   * slot overwrite was copy-pasted across three branches; a future
   * invariant change (e.g. cap on superseded list length) would require
   * three near-identical edits. The queue reason and the queueing
   * structured-log event are the only branch-specific bits — passed in
   * as the `wakeSkipLog` callback so each branch keeps its own EC-9 line.
   */
  private enqueuePendingCheckpoint(
    entry: { pendingCheckpoint: CheckpointPayload | null; supersededCheckpointIds: string[] },
    sessionGroupId: string,
    observerSessionId: string,
    payload: CheckpointPayload,
  ): void {
    const prior = entry.pendingCheckpoint;
    if (prior) {
      log.info("session-orchestrator", "queued checkpoint superseded", {
        event: "council.checkpoint.superseded",
        sessionGroupId,
        observerSessionId,
        droppedCheckpointId: prior.checkpoint_id,
        supersededByCheckpointId: payload.checkpoint_id,
        droppedSequence: prior.sequence,
        supersededBySequence: payload.sequence,
      });
      entry.supersededCheckpointIds.push(prior.checkpoint_id);
    }
    entry.pendingCheckpoint = payload;
  }

  handleCouncilCheckpoint(sessionGroupId: string, payload: CheckpointPayload): void {
    const entry = this.deps.watchers.get(sessionGroupId);
    if (!entry) return;
    // Council Review 2026-05-13 Hunt finding #1: when two groups share a
    // workspace cwd (multi-group local dev, which the codebase supports),
    // both watchers attach to the same .council/checkpoints/ directory.
    // The checkpoint file carries `session_group_id` validated by
    // parseCheckpointPayload — assert it matches the watcher's bound
    // sessionGroupId BEFORE any state mutation OR dispatch. Mismatch is
    // a cross-tenant leak: group A's checkpoint waking group B's observer
    // and corrupting B's sentinel idempotency state.
    if (payload.session_group_id !== sessionGroupId) {
      log.warn("session-orchestrator", "foreign-group checkpoint observed", {
        event: "council.checkpoint.foreign_group",
        sessionGroupId,
        payloadSessionGroupId: payload.session_group_id,
        checkpointId: payload.checkpoint_id,
      });
      return;
    }
    // Realtime P1-R2 (council review #8): the server is the seq authority;
    // reject out-of-order or duplicate checkpoint events so a stale manifest
    // never poisons grounding for the next observer review. Browser-side
    // monotonicity in council-slice becomes defence-in-depth, not first
    // line.
    if (entry.lastCheckpoint !== null && payload.sequence <= entry.lastCheckpoint.sequence) {
      log.warn("session-orchestrator", "dropping out-of-order checkpoint", {
        sessionGroupId,
        incomingSequence: payload.sequence,
        lastSequence: entry.lastCheckpoint.sequence,
      });
      return;
    }
    // Capture the prior checkpoint BEFORE overwriting so the next review's
    // grounding can use the delta manifest, not the cumulative paths set.
    entry.previousCheckpoint = entry.lastCheckpoint;
    entry.lastCheckpoint = payload;
    this.deps.lineSnapshots.capture(sessionGroupId, payload.checkpoint_id, entry.cwd, payload.artifact_paths);
    const meta = this.deps.groupMeta.get(sessionGroupId);
    if (meta) meta.lastCheckpointReceivedAt = Date.now();
    companionBus.emit("group:checkpoint", {
      sessionGroupId,
      checkpointId: payload.checkpoint_id,
      phase: payload.phase,
      sequence: payload.sequence,
    });

    // Closes Council Mode Story 2 AC#1: push a manifest into the
    // observer's CLI stdin so it actually wakes and produces a review.
    // Returns sync — the dispatcher is pure-sync, no floating promise,
    // no unhandled rejection surface. EC-9 logs land inside the
    // dispatcher itself; the handler stays a clean two-step (capture
    // + emit + dispatch).
    this.dispatchObserverWake(sessionGroupId, payload);
  }

  /**
   * Council Mode auto-wake dispatcher (Story 2 AC#1).
   *
   * Resolves the observer half for this group, builds the wake message
   * via {@link buildObserverWakePayload}, and pushes it to the observer's
   * CLI socket via {@link WsBridge.sendObserverWakeFrame}. Every gate
   * resolves to exactly one structured EC-9 log line, returning a
   * discriminated outcome the caller (handleCouncilCheckpoint) treats
   * as fire-and-forget.
   *
   * Sync by design (Backend Council Rec 1): the send is fire-and-forget
   * at the adapter level; converting this to async would turn the
   * watcher's onCheckpoint callback into an awaitable chain and create
   * an unhandled-rejection surface on every throwing send.
   *
   * Failure-mode discipline (Subprocess Council Rec 6): on `failed`,
   * do NOT synthesise a fake `session:exited`. The natural socket-close
   * handler in `ws-bridge.ts` will fire `session:exited` and the existing
   * `armReconnect` path takes over the transport lifecycle. The group IS,
   * however, marked degraded via {@link degradeObserverWakeFailure} (#4) so
   * a synchronous send failure no longer leaves the pair falsely `active`
   * with zero reviews — this converges with the async codex wake-failed
   * channel onto one degraded path.
   */
  dispatchObserverWake(
    sessionGroupId: string,
    payload: CheckpointPayload,
  ): WakeDispatchOutcome {
    const entry = this.deps.watchers.get(sessionGroupId);
    const meta = this.deps.groupMeta.get(sessionGroupId);
    if (!entry || !meta) {
      // Watcher exists but no meta means the group was archived between
      // checkpoint arrival and dispatch — treat as observer_unknown.
      const outcome: WakeDispatchOutcome = { kind: "skipped", reason: "observer_unknown" };
      log.info("session-orchestrator", "observer wake skipped", {
        event: "group.observer_wake_skipped",
        sessionGroupId,
        observerSessionId: null,
        checkpointId: payload.checkpoint_id,
        sequence: payload.sequence,
        reason: outcome.reason,
      });
      return outcome;
    }
    const observerSessionId = meta.observerSessionId;

    // Gate 0 (restart idempotency, Task 6): pre-dispatch sentinel check.
    // The watcher's seen-LRU is in-memory; after a server restart it
    // rehydrates empty and the watcher would re-emit every historical
    // checkpoint file on its first fs.watch event. The sentinel records
    // "we already sent a wake for this checkpoint_id" durably on disk;
    // a match here is the second-line defence against double-wakes
    // across restarts. Misses (no sentinel, or older sequence) fall
    // through.
    // Council Review 2026-07-05 Backend #1: this read is on the fire-and-forget
    // catch-up path; a corrupt/half-written sentinel (the exact stale-artifact
    // the catch-up scan exists to recover from) must not throw through the wake
    // path. Treat a read/parse failure as "no sentinel" and fall through —
    // Gate 0 idempotency downstream plus the observer's own dedup still guard
    // against a double-wake — so this method honours its never-throws contract.
    let sentinel: ReturnType<typeof readCouncilWakeSentinel>;
    try {
      sentinel = readCouncilWakeSentinel(entry.cwd, sessionGroupId);
    } catch (err) {
      sentinel = null;
      log.warn("session-orchestrator", "observer wake sentinel read failed", {
        event: "council.wake.sentinel_read_failed",
        sessionGroupId,
        observerSessionId,
        checkpointId: payload.checkpoint_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (sentinel && sentinel.last_woken_checkpoint_id === payload.checkpoint_id) {
      const outcome: WakeDispatchOutcome = { kind: "skipped", reason: "already_woken" };
      log.info("session-orchestrator", "observer wake skipped (already woken)", {
        event: "group.observer_wake_skipped",
        sessionGroupId,
        observerSessionId,
        checkpointId: payload.checkpoint_id,
        sequence: payload.sequence,
        reason: outcome.reason,
        sentinelLastWokenAt: sentinel.last_woken_at,
      });
      return outcome;
    }

    // Gate 1: group status must be `active`. AP-2 — the state machine is
    // the source of truth; never derive from session-level booleans.
    //
    // Council Review 2026-05-13 Subprocess #3: `reconnecting` is treated
    // symmetrically to the `busy` mid-turn case — checkpoint is queued
    // into pendingCheckpoint so the existing `reconnect_ok` drain (Task 5)
    // picks it up when the observer half re-handshakes. Other non-active
    // statuses (`degraded`, `archived`, `pairing`) still drop with the
    // group_not_active reason — the observer is conceptually gone.
    const coordinator = this.deps.getCoordinator();
    if (coordinator) {
      const groupRecord = coordinator.get(sessionGroupId);
      if (groupRecord && groupRecord.status === "reconnecting") {
        this.enqueuePendingCheckpoint(entry, sessionGroupId, observerSessionId, payload);
        const outcome: WakeDispatchOutcome = { kind: "skipped", reason: "observer_busy" };
        log.info("session-orchestrator", "observer wake queued (group reconnecting)", {
          event: "group.observer_wake_skipped",
          sessionGroupId,
          observerSessionId,
          checkpointId: payload.checkpoint_id,
          sequence: payload.sequence,
          reason: outcome.reason,
          groupStatus: "reconnecting",
          queued: true,
        });
        return outcome;
      }
      if (!groupRecord || groupRecord.status !== "active") {
        const outcome: WakeDispatchOutcome = { kind: "skipped", reason: "group_not_active" };
        log.info("session-orchestrator", "observer wake skipped", {
          event: "group.observer_wake_skipped",
          sessionGroupId,
          observerSessionId,
          checkpointId: payload.checkpoint_id,
          sequence: payload.sequence,
          reason: outcome.reason,
          groupStatus: groupRecord?.status ?? "unknown",
        });
        return outcome;
      }
    }

    if (this.deps.isApiLimitReached(observerSessionId)) {
      const outcome: WakeDispatchOutcome = { kind: "skipped", reason: "api_limit_reached" };
      log.warn("session-orchestrator", "observer wake skipped after API limit", {
        event: "group.observer_wake_skipped",
        sessionGroupId,
        observerSessionId,
        checkpointId: payload.checkpoint_id,
        sequence: payload.sequence,
        reason: outcome.reason,
      });
      return outcome;
    }

    // Build the per-checkpoint context manifest (delta vs previous).
    // The watcher entry holds previousCheckpoint captured BEFORE the
    // overwrite, so the manifest is delta-not-cumulative.
    const manifest = buildObserverContextManifest({
      current: entry.lastCheckpoint ?? { artifact_paths: [] },
      previous: entry.previousCheckpoint ?? undefined,
    });

    // Build the wake body. The builder validates char-level + size + per-
    // section counts and runs the realpath containment check (Task 7);
    // a throw here is a producer bug or an adversarial-looking checkpoint.
    let built;
    try {
      built = buildObserverWakePayload({
        checkpoint: payload,
        manifest,
        workspaceRoot: entry.cwd,
        observerProvider: meta.pairing.split("+")[1] ?? "claude",
      });
    } catch (err) {
      const outcome: WakeDispatchOutcome = { kind: "skipped", reason: "build_error" };
      log.warn("session-orchestrator", "observer wake build failed", {
        event: "group.observer_wake_skipped",
        sessionGroupId,
        observerSessionId,
        checkpointId: payload.checkpoint_id,
        sequence: payload.sequence,
        reason: outcome.reason,
        error: err instanceof Error ? err.message : String(err),
      });
      return outcome;
    }

    // Log dropped paths (Task 7 EC-9 channel) BEFORE the send so the
    // forensic trail lands even if the send subsequently fails.
    for (const dropped of built.droppedPaths) {
      log.warn("session-orchestrator", "observer wake path dropped", {
        event: "council.wake.path_traversal_dropped",
        sessionGroupId,
        observerSessionId,
        checkpointId: payload.checkpoint_id,
        section: dropped.section,
        offendingPath: dropped.path,
        reason: dropped.reason,
      });
    }

    // Hand off to the bridge — single seam, all sessionId→adapter
    // narrowing lives there.
    const bridgeOutcome: BridgeObserverWakeOutcome = this.deps.getWsBridge().sendObserverWakeFrame(
      observerSessionId,
      built.textBody,
    );

    // Map bridge/adapter outcome → dispatcher outcome + one EC-9 line.
    switch (bridgeOutcome.kind) {
      case "sent": {
        // Task 6 sentinel write — durable record that a wake was sent
        // for this checkpoint id. Cross-restart double-wake protection.
        //
        // Council Review 2026-05-13 Persistence #14: sentinel write
        // failure is logged at ERROR (not WARN — this is a durability-
        // boundary failure) and surfaces a structured operator-grade
        // incident log so the second-restart double-wake risk is
        // visible. The wake send itself already happened, so we do
        // NOT roll it back — the next-restart seq-monotonic guard at
        // the head of handleCouncilCheckpoint plus the watcher LRU
        // are the remaining defences. Future enhancement: degrade
        // the group with a wake_persistence_failed reason; for now
        // keep the group operable with a louder log line.
        try {
          writeCouncilWakeSentinel(entry.cwd, sessionGroupId, {
            checkpointId: payload.checkpoint_id,
            sequence: payload.sequence,
          });
        } catch (err) {
          log.error("session-orchestrator", "wake sentinel write failed — restart double-wake possible", {
            event: "council.wake.sentinel_write_failed",
            sessionGroupId,
            observerSessionId,
            checkpointId: payload.checkpoint_id,
            sequence: payload.sequence,
            error: err instanceof Error ? err.message : String(err),
            incident: "second_restart_double_wake_possible",
          });
        }
        // Council Review 2026-06-13 (P1 #1 — accept-but-no-review ghost):
        // arm the wake→review watchdog. A wake that the transport accepts
        // but that the observer never answers with a review file produced
        // no server-side signal before this — the group stayed `active`
        // forever. The watchdog degrades the group if no matching review
        // arrives within OBSERVER_WAKE_TIMEOUT_MS.
        this.armReviewDeadline(sessionGroupId, entry, payload.checkpoint_id);
        // P3/B1: the observer's reply to THIS wake becomes the review.
        this.deps.replyCapture.expect(observerSessionId, {
          sessionGroupId,
          checkpointId: payload.checkpoint_id,
          phase: payload.phase,
          provider: meta.pairing.split("+")[1] === "codex" ? "codex" : "claude",
          cwd: entry.cwd,
          fallbackModel: meta.observerModel,
        });
        const outcome: WakeDispatchOutcome = {
          kind: "dispatched",
          checkpointId: payload.checkpoint_id,
          observerSessionId,
          droppedPathCount: built.droppedPaths.length,
          wakeBodySha256: built.sha256,
        };
        log.info("session-orchestrator", "observer wake dispatched", {
          event: "group.observer_wake_dispatched",
          sessionGroupId,
          observerSessionId,
          checkpointId: payload.checkpoint_id,
          sequence: payload.sequence,
          droppedPathCount: built.droppedPaths.length,
          wakeBodySha256: built.sha256,
        });
        return outcome;
      }
      case "busy": {
        // Mid-turn case (Task 4): newest-wins queue. See
        // enqueuePendingCheckpoint for the shared supersede log behaviour.
        this.enqueuePendingCheckpoint(entry, sessionGroupId, observerSessionId, payload);
        const outcome: WakeDispatchOutcome = { kind: "skipped", reason: "observer_busy" };
        log.info("session-orchestrator", "observer wake queued", {
          event: "group.observer_wake_skipped",
          sessionGroupId,
          observerSessionId,
          checkpointId: payload.checkpoint_id,
          sequence: payload.sequence,
          reason: outcome.reason,
          queued: true,
        });
        return outcome;
      }
      case "socket_disconnected": {
        const outcome: WakeDispatchOutcome = { kind: "skipped", reason: "socket_disconnected" };
        log.info("session-orchestrator", "observer wake skipped", {
          event: "group.observer_wake_skipped",
          sessionGroupId,
          observerSessionId,
          checkpointId: payload.checkpoint_id,
          sequence: payload.sequence,
          reason: outcome.reason,
        });
        return outcome;
      }
      case "backpressure": {
        // Council Review 2026-05-13 Realtime #17: backpressure was
        // previously a hard drop. The observer transport is stalled
        // but not dead; storing the checkpoint in `pendingCheckpoint`
        // means the next turn-done event drains it. See
        // enqueuePendingCheckpoint for the shared supersede log behaviour.
        this.enqueuePendingCheckpoint(entry, sessionGroupId, observerSessionId, payload);
        const outcome: WakeDispatchOutcome = { kind: "skipped", reason: "backpressure" };
        log.info("session-orchestrator", "observer wake queued (backpressure)", {
          event: "group.observer_wake_skipped",
          sessionGroupId,
          observerSessionId,
          checkpointId: payload.checkpoint_id,
          sequence: payload.sequence,
          reason: outcome.reason,
          bufferedAmount: bridgeOutcome.bufferedAmount,
          queued: true,
        });
        return outcome;
      }
      case "session_unknown":
      case "adapter_missing":
      case "unsupported_backend": {
        const reasonMap = {
          session_unknown: "observer_unknown",
          adapter_missing: "adapter_missing",
          unsupported_backend: "unsupported_backend",
        } as const;
        const outcome: WakeDispatchOutcome = {
          kind: "skipped",
          reason: reasonMap[bridgeOutcome.kind],
        };
        log.warn("session-orchestrator", "observer wake skipped", {
          event: "group.observer_wake_skipped",
          sessionGroupId,
          observerSessionId,
          checkpointId: payload.checkpoint_id,
          sequence: payload.sequence,
          reason: outcome.reason,
        });
        return outcome;
      }
      case "failed": {
        const outcome: WakeDispatchOutcome = { kind: "failed", error: bridgeOutcome.error };
        log.error("session-orchestrator", "observer wake send failed", {
          event: "group.observer_wake_failed",
          sessionGroupId,
          observerSessionId,
          checkpointId: payload.checkpoint_id,
          sequence: payload.sequence,
          error: bridgeOutcome.error,
        });
        // #4: a synchronous send failure (the Claude adapter path + the
        // default coercion) previously logged and returned, leaving the
        // group falsely `active` with zero reviews. Converge it onto the
        // SAME degraded channel the async codex `observer:wake-failed`
        // listener uses — one logical event, one degrade path.
        this.degradeObserverWakeFailure(sessionGroupId, observerSessionId, bridgeOutcome.error, "sync");
        return outcome;
      }
      default: {
        // Council Review 2026-05-13 Backend #23 (EC-10 idiom applied
        // to backend discriminated union): adding a new
        // BridgeObserverWakeOutcome variant without extending this
        // switch is a compile-time error rather than a silent fall-
        // through. Pins the type drift between bridge.kind and
        // dispatcher.reason.
        const _exhaustive: never = bridgeOutcome;
        void _exhaustive;
        const outcome: WakeDispatchOutcome = {
          kind: "failed",
          error: `unknown bridge outcome: ${JSON.stringify(bridgeOutcome)}`,
        };
        this.degradeObserverWakeFailure(sessionGroupId, observerSessionId, outcome.error, "sync");
        return outcome;
      }
    }
  }

  /**
   * Council Mode auto-wake — drain hook for the per-group 1-slot queue.
   *
   * Called when the observer's adapter flips turn-state from `in-flight`
   * back to `idle` (a `result` NDJSON frame arrived). If the watcher
   * entry has a queued checkpoint, dispatch it through the same gate
   * pipeline as a fresh checkpoint — the only difference is its origin
   * is the previous mid-turn arrival, not the filesystem watcher.
   *
   * Idempotent: a drain call when nothing is queued is a no-op. Safe
   * to call from multiple trigger sites (turn-done event, reconnect_ok
   * event in Task 5). Sync — never async — so a drain inside an event
   * handler cannot create an unhandled-rejection surface.
   */
  drainPendingObserverWake(sessionGroupId: string): void {
    const entry = this.deps.watchers.get(sessionGroupId);
    if (!entry || !entry.pendingCheckpoint) return;
    const queued = entry.pendingCheckpoint;
    entry.pendingCheckpoint = null;
    log.info("session-orchestrator", "draining queued observer wake", {
      event: "council.wake.drain",
      sessionGroupId,
      checkpointId: queued.checkpoint_id,
      sequence: queued.sequence,
    });
    this.dispatchObserverWake(sessionGroupId, queued);
  }

  /**
   * Council Review 2026-06-13 (P1 #1 — accept-but-no-review ghost): arm the
   * single-slot wake→review watchdog for `checkpointId`. Clears any prior
   * deadline first — the newest dispatched checkpoint is the one the
   * observer is now expected to answer, so an older pending deadline would
   * fire spuriously even though the observer is correctly working the newer
   * checkpoint. Cleared by `handleCouncilReview` on a matching review or by
   * `stopCouncilWatchers` on teardown.
   */
  private armReviewDeadline(
    sessionGroupId: string,
    entry: CouncilWatcherEntry,
    checkpointId: string,
  ): void {
    if (entry.pendingReviewDeadline) {
      clearTimeout(entry.pendingReviewDeadline.timer);
    }
    const timer = setTimeout(() => {
      this.handleReviewDeadlineExpired(sessionGroupId, checkpointId);
    }, OBSERVER_WAKE_TIMEOUT_MS);
    // Do not keep the event loop alive solely for this watchdog — a process
    // that is otherwise idle should still be allowed to exit.
    if (typeof timer.unref === "function") timer.unref();
    entry.pendingReviewDeadline = { checkpointId, timer };
  }

  /**
   * P3/B1: the observer's turn ended — turn its reply into a review file
   * (host-built envelope, atomic write; the review watcher takes it from
   * there) or record why it could not.
   *
   * One bad answer must not degrade the group: an observer that DID reply,
   * just not with a usable findings list, has proven liveness, so the
   * wake→review watchdog for that checkpoint is disarmed. After
   * {@link OBSERVER_REPLY_REJECTIONS_BEFORE_DEGRADE} rejections in a row the
   * watchdog is left armed and the existing `wake_produced_no_review` path
   * degrades the group (after its own disk rescan). An EMPTY reply (no text
   * after the last tool call, e.g. a watchdog force-release) never disarms —
   * that is the silence the watchdog exists to catch.
   */
  finalizeObserverReply(sessionGroupId: string, observerSessionId: string): void {
    const outcome = this.deps.replyCapture.finalize(observerSessionId);
    if (outcome.kind === "no_expectation") return;
    const base = {
      sessionGroupId,
      sessionId: observerSessionId,
      role: "observer" as const,
      checkpointId: outcome.expectation.checkpointId,
    };
    switch (outcome.kind) {
      case "written":
        log.info("session-orchestrator", "observer reply recorded as review", {
          event: "council.observer_reply.review_written",
          ...base,
          file: outcome.file,
          findingCount: outcome.findingCount,
        });
        return;
      case "skipped_existing":
        log.info("session-orchestrator", "observer wrote its own review file — host stands down", {
          event: "council.observer_reply.observer_wrote_file",
          ...base,
          file: outcome.file,
        });
        return;
      case "write_failed":
        log.error("session-orchestrator", "host review write failed", {
          event: "council.observer_reply.write_failed",
          ...base,
          file: outcome.file,
          error: outcome.error,
        });
        return;
      case "rejected": {
        const entry = this.deps.watchers.get(sessionGroupId);
        const deadline = entry?.pendingReviewDeadline;
        const disarm =
          outcome.reason !== "empty_reply" &&
          outcome.consecutive < OBSERVER_REPLY_REJECTIONS_BEFORE_DEGRADE &&
          deadline?.checkpointId === outcome.expectation.checkpointId;
        if (disarm && entry && deadline) {
          clearTimeout(deadline.timer);
          entry.pendingReviewDeadline = null;
        }
        metricsCollector.recordError("council.observer_reply.rejected");
        log.warn("session-orchestrator", "observer reply rejected — no review written", {
          event: "council.observer_reply.rejected",
          ...base,
          reason: outcome.reason,
          ...(outcome.field ? { field: outcome.field } : {}),
          consecutive: outcome.consecutive,
          deadlineDisarmed: disarm,
        });
        return;
      }
    }
  }

  /**
   * Bring provider-native review output up to schema before parsing.
   *
   * Two independent normalizations, deliberately gated differently. Envelope
   * synthesis is codex-only because it stamps codex identity: the codex CLI
   * emits a review missing every server-mandated audit field, so the parser
   * rejects it on `schema_version` and every codex review drops (prompt
   * tightening was empirically insufficient). Findings-shape mapping runs for
   * EVERY provider — a claude observer emitting `{severity:"low", file, line}`
   * under a correct envelope is observed behaviour, not a codex quirk, and it
   * drops on `findings.severity` with the review already written to disk.
   *
   * Shared by the live watcher and the deadline rescan so a review that the
   * watcher would have accepted cannot be rejected by the recovery path.
   */
  normalizeObserverReviewRaw(
    sessionGroupId: string,
    raw: string,
    provider: "claude" | "codex",
  ): string {
    let out = raw;
    if (provider === "codex") {
      const meta = this.deps.groupMeta.get(sessionGroupId);
      out = normalizeCodexObserverReviewRaw(out, {
        observerModel: meta?.observerModel ?? "unknown",
        observerCliVersion: "unknown",
      });
    }
    return normalizeObserverFindingShapeRaw(out);
  }

  /**
   * Council Review 2026-06-13 (P1 #1): the wake→review watchdog elapsed —
   * the observer accepted a wake but never produced a review file within
   * OBSERVER_WAKE_TIMEOUT_MS. Surface this as a visible `degraded` state
   * (reason `wake_produced_no_review`) instead of leaving the group falsely
   * `active`. Mirrors the synchronous `observer:wake-failed` listener so
   * both non-participation modes converge on one degraded channel.
   */
  handleReviewDeadlineExpired(sessionGroupId: string, checkpointId: string): void {
    try {
      const entry = this.deps.watchers.get(sessionGroupId);
      // Stale fire guard: the entry may have been torn down, or a newer
      // checkpoint may have re-armed the slot, between the timer firing and
      // this callback running. Only act if the slot still tracks THIS
      // checkpoint.
      if (!entry || entry.pendingReviewDeadline?.checkpointId !== checkpointId) return;
      entry.pendingReviewDeadline = null;

      const meta = this.deps.groupMeta.get(sessionGroupId);
      if (!meta) return;
      // Idempotence: a group already past this checkpoint's review (the
      // review landed but the disarm raced) should not be degraded.
      if (meta.lastReviewedCheckpointId === checkpointId) return;

      // Sentinel-before-sweep (EC-8): the in-memory state above says "no review
      // arrived", but that is only true if every fs event reached the watcher.
      // A dropped `fs.watch` event is unrecoverable otherwise — nothing else
      // re-reads `.council/reviews/`, so the pair degrades AND the findings are
      // discarded permanently. Observed in prod 2026-09-07 (grp_2dab66cb): the
      // review landed on disk 3.5 min before this deadline fired, the watcher
      // logged neither success nor drop, and 7 findings including 2 grounded
      // STOPs were lost. Look at the disk before declaring absence.
      const recovered = findReviewForCheckpointSync({
        directory: join(entry.cwd, ".council", "reviews"),
        checkpointId,
        normalizeRaw: (raw, provider) => this.normalizeObserverReviewRaw(sessionGroupId, raw, provider),
      });
      // got-051: the rescan matches on `checkpointId` alone, and a phase name
      // like `council-review` is NOT group-scoped — in a workspace shared by
      // several pairs the directory can hold a same-named review belonging to
      // a different group. `handleCouncilReview` now rejects foreign payloads,
      // so handing one to it would return silently and this group would
      // neither recover nor degrade. Check ownership here and fall through to
      // the degrade path when the only review on disk is someone else's.
      // #8: default degrade reason is genuine silence; the foreign-review
      // branch below overrides it so the banner tells the operator the truth
      // (a review DID arrive, addressed to another pair) instead of
      // "no review in time — respawn", which won't fix a filename collision.
      let degradeReason: GroupDegradeReason = "wake_produced_no_review";
      if (recovered && recovered.payload.session_group_id !== sessionGroupId) {
        degradeReason = "foreign_group_review";
        // #12: distinct counter so the shared-workspace collision rate is
        // visible on a dashboard, not just discoverable by log-grep.
        metricsCollector.recordError("council.review.foreign_group_rescan");
        log.warn("session-orchestrator", "deadline rescan matched a foreign-group review — ignoring", {
          event: "council.review.foreign_group_rescan",
          sessionGroupId,
          payloadSessionGroupId: recovered.payload.session_group_id,
          checkpointId,
          file: recovered.file,
        });
      } else if (recovered) {
        log.warn("session-orchestrator", "review recovered from disk at deadline — watcher missed the event", {
          event: "council.review.recovered_by_deadline_rescan",
          sessionGroupId,
          observerSessionId: meta.observerSessionId,
          checkpointId,
          file: recovered.file,
          reviewedAt: recovered.reviewedAt,
        });
        this.handleCouncilReview(sessionGroupId, recovered.payload, recovered.reviewedAt);
        return;
      }

      // Council Review 2026-06-13 P2 #8: do NOT pre-set the reason map here.
      // The reason rides the `half_died` event into `deriveSideEffects` and is
      // persisted by the `group:degraded` listener ONLY when the transition
      // actually emits — so a no-op transition (already degraded/reconnecting/
      // archived) leaves no orphan reason that bootstrap would later
      // broadcast without the browser ever having seen the frame.
      const coordinator = this.deps.getCoordinator();
      if (coordinator) {
        coordinator.applyEvent(sessionGroupId, {
          type: "half_died",
          role: "observer",
          reason: degradeReason,
        });
      } else {
        companionBus.emit("group:degraded", {
          sessionGroupId,
          deadRole: "observer",
          reason: degradeReason,
        });
      }
      log.warn("session-orchestrator", "observer accepted wake but produced no usable review", {
        event: degradeReason === "foreign_group_review"
          ? "group.observer_wake_foreign_group_review"
          : "group.observer_wake_produced_no_review",
        sessionGroupId,
        observerSessionId: meta.observerSessionId,
        checkpointId,
        timeoutMs: OBSERVER_WAKE_TIMEOUT_MS,
      });
    } catch (err) {
      log.warn("session-orchestrator", "review-deadline handler crashed", {
        event: "group.observer_wake_produced_no_review_handler_error",
        sessionGroupId,
        checkpointId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Council Review 2026-06-13 (P1 #4): single converge point for "the wake
   * did not reach the observer". BOTH the synchronous `failed` outcome of
   * {@link dispatchObserverWake} (Claude adapter + the default coercion) AND
   * the async `observer:wake-failed` bus emit (codex adapter) route here, so
   * one logical event has exactly one degraded channel instead of two
   * divergent paths kept in lockstep only by prose. Callers resolve the
   * observer half themselves; this method only enacts the degrade.
   */
  degradeObserverWakeFailure(
    sessionGroupId: string,
    observerSessionId: string,
    error: string,
    source: "sync" | "async",
  ): void {
    // Council Review 2026-06-13 P2 #8: reason rides the event, not a pre-set
    // map write. The `group:degraded` listener persists it from the bus
    // payload only when the transition emits — no orphan reason on a no-op.
    const coordinator = this.deps.getCoordinator();
    if (coordinator) {
      coordinator.applyEvent(sessionGroupId, {
        type: "half_died",
        role: "observer",
        reason: "wake_send_failed",
      });
    } else {
      companionBus.emit("group:degraded", {
        sessionGroupId,
        deadRole: "observer",
        reason: "wake_send_failed",
      });
    }
    log.warn("session-orchestrator", "observer wake failed — degrading group", {
      event: "group.observer_wake_failed_degraded",
      sessionGroupId,
      observerSessionId,
      error,
      source,
    });
  }

  handleCouncilReview(sessionGroupId: string, payload: ObserverReviewPayload, reviewedAt?: number): void {
    // Backend P1-3 (council review #L): wrap the whole handler body in a
    // try/catch so a transient throw in the grounding pipeline doesn't
    // unhook the watcher's read loop. Errors are logged structurally and
    // the review is dropped; the dedup key in review-watcher will prevent
    // a re-emission storm on the same file.
    try {
      const entry = this.deps.watchers.get(sessionGroupId);
      if (!entry) return;

      // got-051 (prod 2026-09-08): the mirror of the `council.checkpoint
      // .foreign_group` guard in `handleCouncilCheckpoint`. Every pair whose
      // workspace is the same directory watches the SAME
      // `<workspace>/.council/reviews/` tree, so one observer's review file
      // is delivered to every group's `onReview` callback. Without this
      // check each group adopted the foreign findings as its own: three
      // groups sharing /root/aura-companion emitted three
      // `observer.invocation.completed` lines for a single review file,
      // each stamping its OWN observer session + model onto another pair's
      // findings, clearing its own wake watchdog, and feeding its own
      // convergence counter. Reject BEFORE any state mutation — the
      // watchdog disarm below is itself a mutation a foreign review must
      // not perform.
      if (payload.session_group_id !== sessionGroupId) {
        log.warn("session-orchestrator", "foreign-group review observed", {
          event: "council.review.foreign_group",
          sessionGroupId,
          payloadSessionGroupId: payload.session_group_id,
          checkpointId: payload.checkpoint_id,
          observerProvider: payload.observer_provider,
        });
        return;
      }

      // Council Review 2026-06-13 (P1 #1): a review arrived — disarm the
      // wake→review watchdog if it was tracking this checkpoint. A review
      // for an older checkpoint than the armed one leaves the watchdog
      // intact (the newest dispatched wake is still owed its review).
      if (
        entry.pendingReviewDeadline &&
        entry.pendingReviewDeadline.checkpointId === payload.checkpoint_id
      ) {
        clearTimeout(entry.pendingReviewDeadline.timer);
        entry.pendingReviewDeadline = null;
      }

      // Phase E delta manifest (Willison P1-4 item 1; council review #2):
      // when a previous checkpoint exists, modifiedFiles is the DELTA
      // since that checkpoint, not the cumulative artifact_paths. This is
      // the grounding-as-modification-set semantic the prompt artifact
      // and JSDoc described; Phase G had been using cumulative paths.
      const manifest = buildObserverContextManifest({
        current: entry.lastCheckpoint ?? { artifact_paths: [] },
        previous: entry.previousCheckpoint ?? undefined,
      });
      const modifiedFiles = new Set(manifest.delta.length > 0
        ? manifest.delta
        : (entry.lastCheckpoint?.artifact_paths ?? []));

      const lineFacts = this.deps.lineSnapshots.providerFor(sessionGroupId, payload.checkpoint_id, entry.cwd);
      const result = validateObserverFindings(payload, { workspaceRoot: entry.cwd, modifiedFiles, lineFacts });

      // Willison P1-1 (council review #6): deterministic finding ids
      // derived from review identity + finding position + content hash
      // so a re-emission of the same review file across server restarts
      // yields the SAME ids — the browser's appendObserverReview dedup
      // by id then actually catches restart-replays.
      const findings: BrowserObserverFinding[] = result.findings.map((f, idx) => {
        const id = deterministicFindingId({
          sessionGroupId,
          checkpointId: payload.checkpoint_id,
          observerProvider: payload.observer_provider,
          findingIndex: idx,
          evidencePath: f.evidence_path,
          claim: f.claim,
        });
        const downgrade = result.downgrades.find((d) => d.index === idx);
        const weak = result.weakEvidence.find((w) => w.index === idx);
        const out: BrowserObserverFinding = {
          id,
          severity: f.severity,
          claim: f.claim,
          evidence_path: f.evidence_path,
          ...(f.evidence_lines !== undefined ? { evidence_lines: f.evidence_lines } : {}),
          ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
          ...(downgrade ? { wasDowngraded: true, downgradeReason: downgrade.reason } : {}),
          ...(weak ? { weakEvidence: weak.reason } : {}),
          // Server-observed real event time (review file mtime). Mirrors the
          // bootstrap path so live findings carry the file's landing time, not
          // the browser's per-batch ingestion clock. Falls back to now() if the
          // watcher couldn't stat the file.
          reviewedAt: reviewedAt ?? Date.now(),
        };
        return out;
      });
      const downgrades: BrowserObserverDowngrade[] = result.downgrades.map((d) => {
        // Findings array is 1:1 with the input — `result.findings[d.index]`
        // is always defined here. Backend P2-6 (council review #6): drop
        // the random-id fallback that would orphan the chip on a
        // hypothetical filter divergence.
        const target = findings[d.index];
        if (!target) {
          throw new Error(`observer-grounding downgrade index ${d.index} out of bounds (findings length ${findings.length})`);
        }
        return { id: target.id, reason: d.reason };
      });

      // Task 10: wake-payload-version echo validation. The observer is
      // contracted (via system prompt v1) to echo the version it saw
      // in the wake manifest. If the echo is missing OR mismatches
      // what we currently dispatch, all findings in this review are
      // downgraded to NOTE — a schema-drift between server and prompt
      // means we cannot trust severity calibration.
      //
      // Council Review 2026-05-13 Willison #12 (closes the
      // "absent-echo fail-open" branch): missing echo is treated
      // identically to mismatch. The only legitimate v1 producer is
      // the bundled observer system prompt which has been updated to
      // require the echo. An observer that omits it is buggy or
      // cheating — both should land in the downgrade path, not silently
      // pass.
      const wakeEcho = payload.observer_wake_payload_version_echo;
      if (wakeEcho !== OBSERVER_WAKE_PAYLOAD_VERSION) {
        log.warn("session-orchestrator", "observer wake version mismatch", {
          event: "observer.schema_mismatch",
          sessionGroupId,
          checkpointId: payload.checkpoint_id,
          expected: OBSERVER_WAKE_PAYLOAD_VERSION,
          actual: wakeEcho,
          findingsAffected: findings.length,
        });
        for (let i = 0; i < findings.length; i++) {
          const f = findings[i];
          if (!f || f.severity === "NOTE" || f.severity === "INFO") continue;
          findings[i] = {
            ...f,
            severity: "NOTE",
            wasDowngraded: true,
            downgradeReason: "wake_version_mismatch",
          };
          // Avoid duplicate downgrade entries when grounding ALSO downgraded
          // this finding — the grounding entry already names the id.
          if (!downgrades.some((d) => d.id === f.id)) {
            downgrades.push({ id: f.id, reason: "wake_version_mismatch" });
          }
        }
      }

      // B2b: a STOP that repeats a claim already dismissed in this group stays
      // a STOP in the log but never raises the banner again.
      this.markDisputedStops(sessionGroupId, entry.cwd, findings, { checkpointId: payload.checkpoint_id, log: true });

      // Willison P1-4 item 3 (council review #2): emit the structured
      // invocation log entry so the forensic re-run guarantee
      // (`observerPromptSha256` captured per invocation) survives review
      // completion. EC-9 group-lifecycle structured log requirement also
      // honoured.
      const meta = this.deps.groupMeta.get(sessionGroupId);
      if (meta) {
        const stopCountRaw = payload.findings.filter((f) => f.severity === "STOP").length;
        const stopCountGrounded = findings.filter((f) => f.severity === "STOP" && f.wasDowngraded !== true).length;
        log.info("observer-invocation", "observer.invocation.completed", {
          ...formatObserverInvocationLog({
            orchestratorSessionId: meta.primarySessionId,
            observerSessionId: meta.observerSessionId,
            sessionGroupId,
            phase: payload.phase,
            checkpointId: payload.checkpoint_id,
            artifactsRead: entry.lastCheckpoint?.artifact_paths.length ?? 0,
            findingsCount: findings.length,
            stopCountRaw,
            stopCountGrounded,
            downgradeCount: result.downgrades.length,
            latencyMs: meta.lastCheckpointReceivedAt ? Date.now() - meta.lastCheckpointReceivedAt : 0,
            observerProvider: payload.observer_provider,
            observerModel: payload.observer_model,
            observerCliVersion: payload.observer_cli_version,
            promptSha256: meta.observerPromptSha256 ?? "",
            observerPromptSource: meta.observerPromptSource,
            observerPromptVersion: meta.observerPromptVersion,
          }),
          // B2: grounded STOPs kept out of the blocker banner as weak evidence.
          stopCountWeak: findings.filter((f) => f.severity === "STOP" && f.weakEvidence !== undefined).length,
          stopCountDisputed: findings.filter((f) => f.severity === "STOP" && f.disputed !== undefined).length,
        });
      }

      // PLAN Task 12 (Willison): track the most recently validated
      // checkpoint id per group so a post-reconnect handler can detect
      // skipped checkpoints (orchestrator emitted while observer was
      // offline) and surface a structured catchup log rather than
      // silently under-reviewing.
      if (meta) {
        meta.lastReviewedCheckpointId = payload.checkpoint_id;
      }

      // Eval Harness (opt-in, default OFF): freeze the grounding gate's inputs
      // into `.council/eval/<checkpoint>.json` for post-hoc recall scoring and
      // a hermetic grounding rerun. Self-contained error handling — a sidecar
      // failure can never break the live review fanout below.
      maybeEmitEvalSidecar({
        workspaceRoot: entry.cwd,
        sessionGroupId,
        payload,
        manifest,
        grounding: result,
        observerPromptSha256: meta?.observerPromptSha256 ?? "",
        lineFacts,
      });

      companionBus.emit("group:review", {
        sessionGroupId,
        checkpointId: payload.checkpoint_id,
        phase: payload.phase,
        findings,
        downgrades,
        observerModel: payload.observer_model,
        observerProvider: payload.observer_provider,
      });
    } catch (err) {
      log.error("session-orchestrator", "handleCouncilReview failed", {
        sessionGroupId,
        checkpointId: payload.checkpoint_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** In place: mark live STOPs matching one of the group's disputes (B2b). */
  markDisputedStops(
    sessionGroupId: string,
    cwd: string,
    findings: BrowserObserverFinding[],
    opts: { checkpointId?: string; log: boolean },
  ): void {
    const read = readDisputes(cwd, sessionGroupId);
    if (!read.ok) {
      // Fail toward showing the banner: an unreadable dispute list suppresses nothing.
      log.warn("session-orchestrator", "observer disputes unreadable", {
        event: "council.finding.disputes_unreadable",
        sessionGroupId,
        reason: read.reason,
      });
      return;
    }
    const { findings: marked, applied } = applyDisputes(findings, read.records);
    for (const a of applied) {
      const f = marked[a.index];
      if (!f) continue;
      findings[a.index] = f;
      if (opts.log) {
        log.info("session-orchestrator", "observer STOP repeats a disputed claim", {
          event: "council.finding.dispute_matched",
          sessionGroupId,
          sessionId: this.deps.groupMeta.get(sessionGroupId)?.observerSessionId,
          role: "observer",
          checkpointId: opts.checkpointId,
          findingId: f.id,
          via: a.via,
          disputedFindingId: a.record.findingId,
        });
      }
    }
  }
}
