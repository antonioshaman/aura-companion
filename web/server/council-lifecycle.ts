import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type {
  BackendType,
  BrowserGroupRecord,
  BrowserObserverDowngrade,
  BrowserObserverFinding,
  SessionGroupRole,
} from "./session-types.js";
import type { CheckpointPayload, ObserverReviewPayload } from "./council-types.js";
import { parseObserverReviewPayload } from "./council-types.js";
import { SessionGroupCoordinator, type IdleTimerEnactor } from "./session-group-coordinator.js";
import { isSupportedPairing as _isSupportedPairing } from "./backend-provider.js";
import { companionBus } from "./event-bus.js";
import { log } from "./logger.js";
import { watchCheckpoints } from "./checkpoint-watcher.js";
import { watchReviews } from "./review-watcher.js";
import { DEFAULT_REARM_DELAY_MS, runResilientWatch } from "./resilient-watch.js";
import { validateObserverFindings } from "./observer-grounding.js";
import { addDispute } from "./observer-disputes.js";
import type { CheckpointLineSnapshots } from "./observer-line-snapshots.js";
import { buildObserverContextManifest } from "./observer-prompt.js";
import type { ObserverReplyCapture } from "./observer-reply.js";
import type { ObserverReadLedger } from "./observer-read-ledger.js";
import { deleteCouncilWakeSentinel } from "./council-wake-sentinel.js";
import { buildBrowserGroupRecord } from "./browser-group-record.js";
import { deterministicFindingId, type CouncilWatcherEntry } from "./council-checkpoint-pipeline.js";
import { applyFrozenVerdict, readReviewVerdicts, type FrozenVerdict } from "./observer-review-verdicts.js";
import type {
  CreateCouncilGroupRequest,
  CreateCouncilGroupResult,
  CreateSessionRequest,
  CreateSessionResult,
} from "./session-orchestrator.js";

/**
 * Council lifecycle (aura-meta-diet P4/C1e).
 *
 * Owns the council GROUP lifecycle around the checkpoint pipeline (C1a),
 * the observer scheduler (C1b) and auto-proceed (C1c): pair creation, the
 * long-lived {@link SessionGroupCoordinator} (AP-2 — its `applyEvent` stays
 * the sole lifecycle mutator), boot reconcile of restored pairs, the reconnect
 * handshake / relaunch-failed short-circuit, the `group:*` bus fanout, the
 * per-group `.council/` watchers, and the REST bootstrap reads.
 *
 * Extracted verbatim from `session-orchestrator.ts`. AP-1 DI: the orchestrator
 * owns every map and the coordinator slot and hands them in, so its existing
 * test seams keep reading the same objects. Pipeline / scheduler entry points
 * are injected as callbacks routed through the orchestrator's thin delegates.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Group-level reconnect grace window (PLAN Task 2). Layered on top of the
 * session-level 15s ws debounce in `ws-bridge.ts`; covers the time a single
 * council half needs to relaunch + handshake before its sibling flips to
 * `degraded`. Bounded to [1s, 600s] to catch operator typos; one-shot per
 * active episode (no group-level retry).
 *
 * Read once at module load — never in hot paths, so vitest can pin without
 * env mutation across workers. Resolved value is logged at first call to
 * `getOrCreateCoordinatorSync()` so `ps`/log inspection diagnoses
 * running-build vs disk-build mismatches.
 */
const GROUP_RECONNECT_GRACE_MS = (() => {
  const raw = process.env.COMPANION_GROUP_RECONNECT_GRACE_MS;
  const fallback = 45_000;
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 600_000) {
    log.warn("session-orchestrator", "invalid COMPANION_GROUP_RECONNECT_GRACE_MS, using fallback", {
      event: "config.grace_ms.invalid",
      raw,
      fallbackMs: fallback,
    });
    return fallback;
  }
  return parsed;
})();

// ── Types ────────────────────────────────────────────────────────────────────

export interface CouncilGroupMeta {
  primarySessionId: string;
  observerSessionId: string;
  pairing: string;
  /** Sha256 of the observer prompt artifact at spawn time, captured for invocation-log forensic re-run. */
  observerPromptSha256?: string;
  /**
   * Provenance of the observer prompt at spawn time (workspace vs bundled).
   * Council Review 2026-05-15-1015 CR-1: the path-shaped label was dropped
   * from log egress because it disclosed operator topology on every
   * invocation (multi-expert convergence — Hunt P1, Fowler P2, Backend P2-5).
   * Source discriminator + sha256 carry sufficient forensic-replay value;
   * label stays in-memory only on the SdkSessionInfo's artifact.
   */
  observerPromptSource?: "workspace" | "bundled";
  /** Schema version parsed from the observer prompt's header at spawn time
   *  (CR-13, forward-compat for v2 migration). */
  observerPromptVersion?: number;
  /**
   * Model id the observer half was spawned with. Captured at spawn so the
   * codex-review normalizer can fill the `observer_model` audit field the
   * codex CLI does not emit natively. Undefined when the launcher reported
   * no model (falls back to "unknown" at normalization time).
   */
  observerModel?: string;
  /** Wallclock (ms) when the group was created — used to compute invocation latency. */
  createdAt: number;
  /** Wallclock (ms) when the most recent checkpoint reached this orchestrator — used to compute observer wake-to-emit latency. */
  lastCheckpointReceivedAt: number | null;
  /**
   * PLAN Task 12 (Willison): id of the most recent checkpoint for which the
   * observer produced a validated review. Persists across reconnects so we
   * can detect "checkpoints emitted while the observer was offline" and
   * emit a structured catchup log on resume. Null until the first review
   * lands; updated in `handleCouncilReview`.
   */
  lastReviewedCheckpointId?: string | null;
}

/**
 * Per-call context plumbed through the SessionGroupCoordinator's
 * `spawnContext` field (docs/history/PLAN-aura-consolidated-refactor.md Task 2). The
 * `baseBody` is the parent `CreateSessionRequest` carrying the user's
 * model/permission/env choices the council spawn callback needs to forward
 * to `doCreateSession`. The `spawnErrors` capture struct is mutated by the
 * spawn callback on per-half failure so the parent `createCouncilGroup`
 * can return the actual upstream error code rather than the coordinator's
 * generic 500. Race-free because the entire struct lives in the call's
 * lexical scope, never on the orchestrator instance.
 */
interface CouncilSpawnContext {
  baseBody: CreateSessionRequest;
  spawnErrors: {
    primary: { error: string; status: number } | null;
    observer: { error: string; status: number } | null;
  };
}

export type CouncilDegradedReason =
  | "observer_exited"
  | "wake_send_failed"
  | "reconnect_failed"
  | "wake_produced_no_review"
  | "foreign_group_review";

export interface CouncilLifecycleDeps {
  launcher: CliLauncher;
  getWsBridge: () => WsBridge;
  /** Orchestrator-owned group state (AP-1 DI) — read and written here. */
  watchers: Map<string, CouncilWatcherEntry>;
  groupMeta: Map<string, CouncilGroupMeta>;
  groupBySessionId: Map<string, string>;
  degradedReason: Map<string, CouncilDegradedReason>;
  deadRole: Map<string, SessionGroupRole>;
  /** Shared with session recovery; EC-2 marks both halves here. */
  intentionalKills: Set<string>;
  /** The orchestrator's coordinator slot (lazily filled by this module). */
  getCoordinator: () => SessionGroupCoordinator | null;
  setCoordinator: (coordinator: SessionGroupCoordinator) => void;
  idleTimerEnactor: IdleTimerEnactor;
  isRelaunchExhausted: (sessionId: string) => boolean;
  createSession: (body: CreateSessionRequest) => Promise<CreateSessionResult>;
  killSession: (sessionId: string) => Promise<unknown>;
  // Checkpoint pipeline / observer scheduler entry points.
  handleCouncilCheckpoint: (sessionGroupId: string, payload: CheckpointPayload) => void;
  handleCouncilReview: (sessionGroupId: string, payload: ObserverReviewPayload, reviewedAt?: number) => void;
  normalizeObserverReviewRaw: (sessionGroupId: string, raw: string, provider: "claude" | "codex") => string;
  drainPendingObserverWake: (sessionGroupId: string) => void;
  scanForMissedObserverWakes: (trigger: "init" | "failsafe" | "watcher-rearm") => void;
  scheduleSpawnCheckpointWhenObserverReady: (
    sessionGroupId: string,
    observerSessionId: string,
    workspaceCwd: string,
  ) => Promise<void>;
  forgetScheduledGroup: (sessionGroupId: string) => void;
  markDisputedStops: (
    sessionGroupId: string,
    cwd: string,
    findings: BrowserObserverFinding[],
    opts: { log: boolean },
  ) => void;
  replyCapture: Pick<ObserverReplyCapture, "forget">;
  /** P3/CONV-HONEST: dropped with the observer on group exit. */
  readLedger: Pick<ObserverReadLedger, "forget">;
  lineSnapshots: CheckpointLineSnapshots;
}

export class CouncilLifecycle {
  constructor(private readonly deps: CouncilLifecycleDeps) {}

  private get coordinator(): SessionGroupCoordinator | null {
    return this.deps.getCoordinator();
  }

  private get wsBridge(): WsBridge {
    return this.deps.getWsBridge();
  }

  /** Reconnect handshake + relaunch-failed short-circuit. Called once from `initialize()`. */
  wireReconnectListeners(): void {
    // PLAN Task 4: resolve a council reconnect grace window when the
    // dead half handshakes via `session:cli-id-received`. This fires
    // AFTER the CLI reported its internal session id (post-`system.init`
    // for Claude, post-`initialize` ack for Codex) — handshake-not-transport
    // gate (Q2 lock).
    //
    // Identity binding (Hunt): the incoming `sessionId` must equal the
    // snapshot captured at `reconnect_started`. Companion `sessionId` is
    // stable across `--resume`; the `cliSessionId` changes but is not
    // checked here (the launcher uses it). A different process race-
    // handshaking on the same group is the mismatch case → treat as
    // `reconnect_failed`, not as a successful recovery.
    //
    // Sync handler, try/catch around `applyEvent`; guard violations log
    // and drop, never crash the bus.
    companionBus.on("session:cli-id-received", ({ sessionId }) => {
      try {
        const coord = this.coordinator;
        if (!coord) return;
        // Find the group this sessionId belongs to via meta cache. Capture
        // the role too — the post-grace recovery branch below needs it to
        // build a typed `half_respawned` event, and recomputing it from the
        // GroupRecord would be a second lookup with no extra safety.
        let foundGroupId: string | null = null;
        let foundRole: SessionGroupRole | null = null;
        for (const [groupId, meta] of this.deps.groupMeta) {
          if (meta.primarySessionId === sessionId) {
            foundGroupId = groupId;
            foundRole = "orchestrator";
            break;
          }
          if (meta.observerSessionId === sessionId) {
            foundGroupId = groupId;
            foundRole = "observer";
            break;
          }
        }
        if (!foundGroupId || !foundRole) return;
        const ctx = coord.getReconnectContext(foundGroupId);
        if (!ctx) {
          // No reconnect armed. Two sub-cases:
          //
          // 1) Normal handshake on an active pair (orchestrator/observer
          //    came up cleanly without a prior `half_died` event in flight)
          //    — nothing to do.
          //
          // 2) **Post-grace recovery**: the half flapped earlier, the
          //    reconnect grace window expired without a re-handshake, the
          //    state machine settled in `degraded`, and the half is only
          //    now coming back through `--resume`. `getReconnectContext`
          //    returns undefined because the grace timer was cleaned up at
          //    expiry, so the earlier handler shape silently dropped the
          //    handshake. `degraded × half_respawned → active` exists in
          //    the state machine; emit it here so the pair recovers.
          //
          // Without this branch, a settled `degraded` pair was structurally
          // terminal in production — `dispatchObserverWake` Gate 1 refused
          // every checkpoint with `reason=group_not_active`, while chat
          // (which is `isOperable` in degraded) kept working. Users saw a
          // working pair that silently never produced observer reviews.
          const groupRecord = coord.get(foundGroupId);
          if (groupRecord?.status === "degraded") {
            coord.applyEvent(foundGroupId, { type: "half_respawned", role: foundRole });
            // Council Mode auto-wake: drain any checkpoint that arrived
            // while the pair was stuck in degraded. Mirrors the symmetric
            // drain on `reconnect_ok` below — without this, the first
            // post-recovery checkpoint sits on disk until the next POST.
            if (foundRole === "observer") {
              this.deps.drainPendingObserverWake(foundGroupId);
            }
          }
          return;
        }
        if (ctx.snapshotSessionId !== sessionId) {
          // Identity mismatch: the handshake came from a session we did NOT
          // snapshot as the dead half. Possible causes: a follow-up
          // handshake for the SURVIVING half (already alive — should not
          // re-fire under normal CLI behaviour), or a stale handshake from
          // a different process. Log + drop. Do NOT cancel the grace.
          log.warn("session-orchestrator", "cli-id-received identity mismatch during reconnect", {
            event: "group.reconnect_identity_mismatch",
            sessionGroupId: foundGroupId,
            role: ctx.deadRole,
          });
          return;
        }
        coord.cancelReconnectTimer(foundGroupId, "reconnect_ok");
        coord.applyEvent(foundGroupId, { type: "reconnect_ok", role: ctx.deadRole });
        // PLAN Task 12 (Willison): emit a structured catchup log when the
        // observer comes back. The watcher entry's `lastCheckpoint.id`
        // is the orchestrator's current sequence; `meta.lastReviewedCheckpointId`
        // is what the observer last validated. A mismatch means the observer
        // was offline across one or more checkpoints — surface it so silent
        // under-review is detectable. (Note: rewriting `buildObserverContextManifest`
        // to fold skipped paths into `delta` is the deeper Willison ask;
        // tracked as Watchpoint follow-up to keep this PR scoped.)
        if (ctx.deadRole === "observer") {
          const meta = this.deps.groupMeta.get(foundGroupId);
          const watcher = this.deps.watchers.get(foundGroupId);
          if (meta && watcher?.lastCheckpoint && watcher.lastCheckpoint.checkpoint_id !== meta.lastReviewedCheckpointId) {
            log.info("session-orchestrator", "observer caught up after reconnect", {
              event: "council.observer.catchup",
              sessionGroupId: foundGroupId,
              lastReviewedCheckpointId: meta.lastReviewedCheckpointId ?? null,
              caughtUpCheckpointId: watcher.lastCheckpoint.checkpoint_id,
            });
          }
          // Council Mode auto-wake (Task 5): drain any queued
          // checkpoint that arrived while the observer was in the
          // reconnect grace window. The observer is now reattached and
          // ready for a fresh wake; the canonical checkpoint file on
          // disk is unchanged so the new turn will produce a correct
          // review.
          this.deps.drainPendingObserverWake(foundGroupId);
        }
      } catch (err) {
        log.warn("session-orchestrator", "reconnect_ok guard violation", {
          event: "group.reconnect_ok.guard_violation",
          sessionId,
          error: String(err),
        });
      }
    });

    // PLAN Task 5: short-circuit a council reconnect grace window when
    // the session-level relaunch fails deterministically (synchronous
    // spawn failure or budget exhausted). Without this, the group sits
    // in `reconnecting` for the full 45s on a recovery that has no chance.
    companionBus.on("session:relaunch-failed", ({ sessionId, reason }) => {
      try {
        const coord = this.coordinator;
        if (!coord) return;
        let foundGroupId: string | null = null;
        for (const [groupId, meta] of this.deps.groupMeta) {
          if (meta.primarySessionId === sessionId || meta.observerSessionId === sessionId) {
            foundGroupId = groupId;
            break;
          }
        }
        if (!foundGroupId) return;
        const ctx = coord.getReconnectContext(foundGroupId);
        if (!ctx || ctx.snapshotSessionId !== sessionId) return;
        log.info("session-orchestrator", "council reconnect failed early via relaunch-failed", {
          event: "group.reconnect_failed.short_circuit",
          sessionGroupId: foundGroupId,
          role: ctx.deadRole,
          reason,
        });
        coord.cancelReconnectTimer(foundGroupId, "relaunch_failed");
        // Mark both intentional — relaunch will not succeed, downstream
        // exits must not re-enter the reconnect path.
        const meta = this.deps.groupMeta.get(foundGroupId)!;
        this.deps.intentionalKills.add(meta.primarySessionId);
        this.deps.intentionalKills.add(meta.observerSessionId);
        coord.applyEvent(foundGroupId, { type: "reconnect_failed", role: ctx.deadRole });
      } catch (err) {
        log.warn("session-orchestrator", "reconnect_failed short-circuit guard violation", {
          event: "group.reconnect_failed.guard_violation",
          sessionId,
          error: String(err),
        });
      }
    });
  }

  /**
   * Council Mode — rebuild `councilGroupMeta` + rearm `.council/` watchers
   * for pairs that exist in launcher state but not yet in our in-memory
   * group registry. Called from `initialize()` after the bus is wired and
   * idempotent on re-entry (skips groups already registered).
   *
   * PLAN Task 6: partial pairs (one half alive, one half missing) are no
   * longer dropped on the floor. The surviving half registers the group
   * in `reconnecting` state and the coordinator arms the standard
   * `COMPANION_GROUP_RECONNECT_GRACE_MS` window — session-level
   * auto-relaunch fires for the missing half, and if it handshakes within
   * the grace window, `session:cli-id-received` resolves to `reconnect_ok`
   * just as for live-disconnect recoveries. After the grace expires, the
   * normal `reconnect_failed → degraded` resolution lands.
   *
   * Deliberate EC-8 gap (FS-JSON recommendation): no `writeReconnectIntent`
   * sentinel. A crash mid-grace means the server is restarting again, and
   * the next reconcile re-evaluates from the fresh PID-alive snapshot —
   * strictly more authoritative than any stale marker (PID reuse during
   * restart can make a sentinel lie).
   */
  reconcileCouncilGroups(): void {
    // Bucket BOTH live and archived halves per group so we can distinguish
    // "transient missing half — arm grace" from "intentionally torn down
    // half — do nothing" at the group-level decision. Filtering archived
    // per-session BEFORE bucketing (the original Task 6 approach) caused
    // archived-half pairs to look like partial pairs and incorrectly armed
    // reconnect grace on what was actually an intentional teardown — see
    // the live log entry `event=group.reconnect_failed sessionGroupId=grp_7a2a49e417861d
    // role=orchestrator` that surfaced this bug.
    const byGroup = new Map<string, {
      orchestrator?: SdkSessionInfo;
      observer?: SdkSessionInfo;
      anyArchived: boolean;
    }>();
    for (const s of this.deps.launcher.listSessions()) {
      if (!s.sessionGroupId) continue;
      if (s.sessionGroupRole !== "orchestrator" && s.sessionGroupRole !== "observer") continue;
      const slot = byGroup.get(s.sessionGroupId) ?? { anyArchived: false };
      if (s.archived) {
        slot.anyArchived = true;
      } else {
        slot[s.sessionGroupRole] = s;
      }
      byGroup.set(s.sessionGroupId, slot);
    }

    let restoredComplete = 0;
    let restoredPartial = 0;
    for (const [groupId, pair] of byGroup) {
      if (this.deps.groupMeta.has(groupId)) continue;
      // If EITHER half of the pair was archived (any time, even if the
      // other half is still alive), the group was intentionally torn down.
      // Don't auto-restore it — surviving half stays operable as a solo
      // session, matching the pre-Task 6 behaviour for archived-half cases.
      if (pair.anyArchived) continue;
      const surviving = pair.orchestrator ?? pair.observer;
      if (!surviving) continue;
      const cwd = surviving.cwd;
      if (!cwd) continue;
      const isComplete = pair.orchestrator !== undefined && pair.observer !== undefined;

      // For partial pairs, synthesize a placeholder sessionId for the
      // missing half ONLY because `GroupMember.sessionId` is a required
      // `string` field on the coordinator's GroupRecord shape. Plan Task 3
      // text says "NO synthetic placeholders that can never bind to a
      // real handshake" — the spirit of that injunction is that placeholders
      // must NEVER enter any code path expecting a real sessionId:
      //   - armReconnect: skipped entirely (Task 3 lands in degraded directly).
      //   - councilGroupBySessionId reverse index: placeholder MUST NOT be
      //     inserted below (dead weight + the canary test asserts absence).
      //   - wsBridge.markCouncilSession: only called for real halves below.
      //   - kill / archive: coordinator best-effort kill no-ops on missing
      //     launcher.getSession (placeholder by construction not in map).
      //   - SessionGroupCoordinator.findBySessionId: KNOWN LEAK — iterates
      //     `groups.values()` and matches on `primary.sessionId` /
      //     `observer.sessionId` directly. Because `registerExternalGroup`
      //     below passes the placeholder into the coordinator's groups
      //     map's sessionId slot, `coord.findBySessionId("__missing_...")`
      //     returns the partial-pair group. Orchestrator-level callers
      //     route through `getCouncilGroupBySessionId` (safe — reads the
      //     placeholder-free reverse index); any future caller reaching
      //     into `coord.findBySessionId` directly MUST guard placeholder
      //     inputs at the call site. A `GroupMember.sessionId: string | null`
      //     type widening would close this surface for free — explicitly
      //     out of Task 3 scope.
      const orchestrator = pair.orchestrator;
      const observer = pair.observer;
      const primarySessionId = orchestrator?.sessionId ?? `__missing_orch_${groupId}`;
      const observerSessionId = observer?.sessionId ?? `__missing_obs_${groupId}`;
      const primaryBackend = orchestrator?.backendType ?? "claude";
      const observerBackend = observer?.backendType ?? "claude";
      const pairing = `${primaryBackend}+${observerBackend}`;
      this.deps.groupMeta.set(groupId, {
        primarySessionId,
        observerSessionId,
        pairing,
        observerPromptSha256: observer?.observerPromptSha256,
        observerPromptSource: observer?.observerPromptSource,
        createdAt: (orchestrator ?? observer)?.createdAt ?? Date.now(),
        lastCheckpointReceivedAt: null,
      });
      // Reverse index — placeholder ids MUST NOT enter this map: a future
      // session:cli-id-received for an unrelated session that happens to
      // collide with the placeholder string would resolve to the wrong
      // group. Skip the synthesised half; insert only real halves.
      if (orchestrator) this.deps.groupBySessionId.set(orchestrator.sessionId, groupId);
      if (observer) this.deps.groupBySessionId.set(observer.sessionId, groupId);
      this.startCouncilWatchers(groupId, cwd);
      // Mark real (non-synthetic) halves on the ws-bridge so post-restart
      // browser subscribe sees `state.sessionGroupId` and emits the
      // synthetic `group_created` for hydration (Bug #2 fix).
      if (orchestrator) {
        this.wsBridge.markCouncilSession(orchestrator.sessionId, groupId, "orchestrator");
      }
      if (observer) {
        this.wsBridge.markCouncilSession(observer.sessionId, groupId, "observer");
      }
      const coord = this.getOrCreateCoordinatorSync();
      coord.registerExternalGroup({
        sessionGroupId: groupId,
        primary: { sessionId: primarySessionId, backendType: primaryBackend },
        observer: { sessionId: observerSessionId, backendType: observerBackend },
        status: "active",
        createdAt: (orchestrator ?? observer)?.createdAt ?? Date.now(),
      });
      // Make sure the coordinator's state is consistent BEFORE the
      // partial-pair branch potentially fires `applyEvent`.
      if (isComplete) {
        restoredComplete++;
        log.info("session-orchestrator", "council group reconciled on startup", {
          event: "group:reconciled",
          sessionGroupId: groupId,
          sessionId: primarySessionId,
          role: "orchestrator",
          observerSessionId,
          pairing,
        });
      } else {
        // Partial pair — approach (b) from FINAL-REVIEW 2026-05-12-2211
        // P1 #1 (docs/history/PLAN-aura-consolidated-refactor.md Task 3): apply
        // `half_died → degraded` DIRECTLY, do NOT arm a reconnect grace
        // window. Rationale:
        //
        //  - `scheduleProactiveRelaunch` and the reconnect watchdog key
        //    on `launcher.getSession(sessionId)` which returns undefined
        //    for the synthesised `__missing_*` placeholder — no
        //    session-level relaunch path exists for the missing half by
        //    construction.
        //
        //  - Any real handshake arriving later carries a real Companion
        //    sessionId that cannot equal the `__missing_*` placeholder,
        //    so the identity-binding check would mismatch and drop. The
        //    grace timer would expire and the group would land in
        //    `degraded` anyway after a guaranteed 45s wait with no
        //    possible happy path.
        //
        // Lying via "reconnecting…" UI is worse than honest "degraded".
        // The state machine emits `group:degraded` + EC-9 log via the
        // standard side-effect channel; no new code paths in this branch.
        const deadRole: SessionGroupRole = orchestrator === undefined ? "orchestrator" : "observer";
        coord.applyEvent(groupId, { type: "half_died", role: deadRole });
        restoredPartial++;
        log.info("session-orchestrator", "council group reconciled to degraded (partial pair on restart)", {
          event: "group:reconciled_degraded",
          sessionGroupId: groupId,
          role: deadRole,
          pairing,
        });
      }
    }
    if (restoredComplete > 0 || restoredPartial > 0) {
      log.info("session-orchestrator", "council reconcile completed", {
        event: "council:reconcile_completed",
        restoredComplete,
        restoredPartial,
        examined: byGroup.size,
      });
    }
  }

  // ── Council Mode — wire bus listeners (Fowler council review #15) ────────

  /**
   * Subscribe the orchestrator to every `group:*` event and to the
   * council-specific `session:exited` branch. Extracted from
   * `initialize()` so the council surface lives in one named block
   * and a future addition (e.g. `group:reconnected`, `group:resumed`)
   * lands next to its siblings rather than threading another listener
   * into a 200-line method.
   */
  wireGroupListeners(): void {
    // Fan group lifecycle events out to both halves' browsers. Wire-shape
    // matches the BrowserIncomingMessage variants declared in
    // session-types.ts.
    companionBus.on("group:created", ({ sessionGroupId, primarySessionId, observerSessionId }) => {
      const primary = this.deps.launcher.getSession(primarySessionId);
      const observer = this.deps.launcher.getSession(observerSessionId);
      // PR #68: route the wire-shape assembly through the shared helper
      // (`buildBrowserGroupRecord`). Same helper drives `getAllGroupsForBootstrap`
      // and `ws-bridge.deriveGroupCreatedForBrowser` — pairing label,
      // wakeTimeoutMs, and field ordering cannot drift across the three
      // construction sites. Launcher is the canonical source for the
      // post-spawn backend type; pass undefined-tolerant values straight
      // through — the helper applies its internal `DEFAULT_BACKEND_TYPE`
      // fallback for launcher-propagation-lag (Fowler fix-pass).
      // Status is hardcoded `"active"` because this listener only fires
      // on a transition that leaves the group active.
      const wire = buildBrowserGroupRecord({
        sessionGroupId,
        primary: {
          sessionId: primarySessionId,
          backendType: primary?.backendType,
        },
        observer: {
          sessionId: observerSessionId,
          backendType: observer?.backendType,
        },
        status: "active",
      });
      this.deps.degradedReason.delete(sessionGroupId);
      this.deps.deadRole.delete(sessionGroupId);
      this.wsBridge.broadcastToGroup([primarySessionId, observerSessionId], {
        type: "group_created",
        ...wire,
      });
    });
    companionBus.on("group:exited", ({ sessionGroupId, reason }) => {
      this.wsBridge.broadcastToGroup(this.getGroupMemberIds(sessionGroupId), {
        type: "group_exited",
        sessionGroupId,
        reason,
      });
    });
    companionBus.on("group:degraded", ({ sessionGroupId, deadRole, reason }) => {
      const degradedReason = reason ?? this.deps.degradedReason.get(sessionGroupId);
      if (degradedReason) {
        this.deps.degradedReason.set(sessionGroupId, degradedReason);
      }
      // #9: persist the dead half symmetrically with the reason so a
      // bootstrap snapshot of a degraded pair labels the correct half.
      this.deps.deadRole.set(sessionGroupId, deadRole);
      this.wsBridge.broadcastToGroup(this.getGroupMemberIds(sessionGroupId), {
        type: "group_degraded",
        sessionGroupId,
        deadRole,
        ...(degradedReason ? { reason: degradedReason } : {}),
      });
      // Council Mode auto-wake (Task 5): drop any queued checkpoint
      // when the group falls into `degraded`. The observer half is
      // conceptually gone for this server lifetime; the user must
      // explicitly relaunch. Holding the slot would either pin memory
      // indefinitely or — on user-initiated respawn — feed a stale
      // checkpoint to a fresh observer that has no context for it.
      const entry = this.deps.watchers.get(sessionGroupId);
      if (entry?.pendingCheckpoint) {
        const dropped = entry.pendingCheckpoint;
        entry.pendingCheckpoint = null;
        log.info("session-orchestrator", "queued wake dropped on degraded", {
          event: "council.wake.dropped",
          sessionGroupId,
          deadRole,
          droppedCheckpointId: dropped.checkpoint_id,
          droppedSequence: dropped.sequence,
          reason: "group_degraded",
        });
      }
      // Council Review 2026-05-13-0150 Persistence #7: a group can sit in
      // `degraded` indefinitely without ever emitting `group:exited` (one
      // half dead, surviving half operable). The sentinel for that group
      // would orphan in `.council/state/` until the user explicitly
      // archives. Clean it here — observer half is conceptually gone for
      // this server lifetime; subsequent user-initiated respawn would
      // get a fresh sentinel on its first successful wake dispatch.
      if (entry) {
        try {
          deleteCouncilWakeSentinel(entry.cwd, sessionGroupId);
        } catch (err) {
          log.warn("session-orchestrator", "wake sentinel cleanup failed on degraded", {
            event: "council.wake.sentinel_cleanup_failed",
            sessionGroupId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
    // PLAN Task 7: broadcast `group_reconnecting` at transition time only.
    // `deadlineMs` is the absolute wallclock the server chose when the
    // grace timer was armed; survives in-flight latency, replay, and tabs
    // that backgrounded mid-flight. No periodic heartbeat — one frame per
    // active episode.
    companionBus.on("group:reconnecting", ({ sessionGroupId, survivingRole, deadlineMs }) => {
      this.wsBridge.broadcastToGroup(this.getGroupMemberIds(sessionGroupId), {
        type: "group_reconnecting",
        sessionGroupId,
        survivingRole,
        deadlineMs,
      });
    });
    companionBus.on("group:checkpoint", ({ sessionGroupId, checkpointId, phase, sequence }) => {
      this.wsBridge.broadcastToGroup(this.getGroupMemberIds(sessionGroupId), {
        type: "group_checkpoint",
        sessionGroupId,
        checkpointId,
        phase,
        sequence,
        timestamp: Date.now(),
      });
    });
    companionBus.on("group:review", ({ sessionGroupId, checkpointId, phase, findings, downgrades, observerModel, observerProvider }) => {
      // Task 9: drain superseded checkpoint ids accumulated since the
      // previous review into THIS review's payload so the panel sees
      // "checkpoint X was skipped (superseded)" inline. Cleared after
      // emit so the next review starts fresh.
      const entry = this.deps.watchers.get(sessionGroupId);
      const superseded = entry?.supersededCheckpointIds ?? [];
      if (entry) entry.supersededCheckpointIds = [];
      this.wsBridge.broadcastToGroup(this.getGroupMemberIds(sessionGroupId), {
        type: "observer_review",
        sessionGroupId,
        checkpointId,
        phase,
        findings,
        downgrades,
        observerModel,
        observerProvider,
        timestamp: Date.now(),
        ...(superseded.length > 0 ? { supersededCheckpointIds: superseded } : {}),
      });
    });

    // Bidirectional pipeline Story 4.1 — convergence-tracker fanout.
    // The tracker is wired in initialize(); here we forward its bus
    // emissions to the browsers in the same group as a `group_update`
    // payload carrying the new convergence fields. Frontend reads
    // them off `GroupRecord` (server-authoritative; no client-side
    // counter).
    companionBus.on("group:convergence", ({ sessionGroupId, transition, cycleNumber, convergenceThreshold, convergenceState, notCountedReason }) => {
      this.wsBridge.broadcastToGroup(this.getGroupMemberIds(sessionGroupId), {
        type: "group_convergence",
        sessionGroupId,
        transition,
        cycleNumber,
        convergenceThreshold,
        convergenceState,
        ...(notCountedReason ? { notCountedReason } : {}),
        timestamp: Date.now(),
      });
      log.info("session-orchestrator", "convergence transition", {
        event: "council.convergence.transition",
        sessionGroupId,
        transition,
        cycleNumber,
        convergenceThreshold,
        ...(notCountedReason ? { notCountedReason } : {}),
      });
    });

    // Tear down council watchers + drop group metadata on exit. Bus
    // ordering: this listener runs after the fanout listener above, so
    // the browser receives `group_exited` before its session map starts
    // being trimmed server-side — no race.
    //
    // Council Review 2026-05-13 Persistence #16: also delete the wake
    // sentinel file so `.council/state/` doesn't accumulate orphans
    // across many session lifecycles. Done BEFORE stopCouncilWatchers
    // removes the entry so we still have `entry.cwd` to compute the path.
    companionBus.on("group:exited", ({ sessionGroupId }) => {
      const entry = this.deps.watchers.get(sessionGroupId);
      if (entry) {
        try {
          deleteCouncilWakeSentinel(entry.cwd, sessionGroupId);
        } catch (err) {
          log.warn("session-orchestrator", "wake sentinel cleanup failed", {
            event: "council.wake.sentinel_cleanup_failed",
            sessionGroupId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.stopCouncilWatchers(sessionGroupId);
      this.tearDownCouncilGroupTracking(sessionGroupId);
    });

    // PLAN Task 3: route council-half `session:exited` through the
    // `reconnecting → active|degraded` ladder instead of straight to
    // `degraded`. Ordering inside the listener is load-bearing (Hunt
    // absorbing-kill + Subprocess EC-2):
    //
    //   1. `intentionalKills.has(sessionId)` — absolute first line.
    //      A user-driven archive must NOT enter the reconnect path.
    //      `archiveGroup` adds both ids to `intentionalKills` before
    //      either kill executes (EC-2).
    //   2. Find the group + role from `councilGroupMeta`.
    //   3. If session-level auto-relaunch has already exhausted its
    //      budget (`relaunchExhaustedNotified`), arming a 45s grace
    //      window is pointless — drive `reconnect_failed → degraded`
    //      immediately. EC-8 sentinel-before-sweep idiom: check the
    //      "decided" flag before kicking off a recovery action.
    //   4. Otherwise: arm the reconnect grace. `armReconnect` runs
    //      `applyEvent({type:"reconnect_started"})` internally so the
    //      `group:degraded` emit is deferred until the timer expires
    //      or `session:cli-id-received` resolves it (PLAN Task 4).
    //
    // We do NOT mark BOTH halves intentional here (the pre-Task 3
    // behaviour) — that would short-circuit the dead half's session-level
    // auto-relaunch (scheduleProactiveRelaunch reads `intentionalKills`
    // when its timer fires). The reconnect cycle's hard one-shot counter
    // (`armReconnect` refuses re-entry) prevents the duplicate-emit
    // hazard the old marking was guarding against.
    companionBus.on("session:exited", ({ sessionId }) => {
      if (this.deps.intentionalKills.has(sessionId)) return;
      let foundGroupId: string | null = null;
      let foundRole: "orchestrator" | "observer" | null = null;
      for (const [groupId, meta] of this.deps.groupMeta) {
        if (meta.primarySessionId === sessionId) { foundGroupId = groupId; foundRole = "orchestrator"; break; }
        if (meta.observerSessionId === sessionId) { foundGroupId = groupId; foundRole = "observer"; break; }
      }
      if (!foundGroupId || !foundRole) return;
      const coordinator = this.coordinator;
      if (!coordinator) {
        // Belt-and-braces fallback: the meta entry should not exist without
        // a coordinator (both populated in createCouncilGroup /
        // reconcileCouncilGroups), but if somehow it does, preserve the
        // pre-Task 1 behaviour rather than swallowing the exit.
        companionBus.emit("group:degraded", { sessionGroupId: foundGroupId, deadRole: foundRole });
        return;
      }
      // EC-8 dual: if session-level relaunch budget is already exhausted,
      // do not arm a window for an outcome that's already decided. From the
      // `active` state, the direct route to `degraded` is `half_died`;
      // `reconnect_failed` is a no-op when we never entered `reconnecting`.
      if (this.deps.isRelaunchExhausted(sessionId)) {
        // Mark both intentional now — relaunch will never succeed for the
        // dead half, so any later cascading exit must not re-enter.
        const meta = this.deps.groupMeta.get(foundGroupId)!;
        this.deps.intentionalKills.add(meta.primarySessionId);
        this.deps.intentionalKills.add(meta.observerSessionId);
        coordinator.applyEvent(foundGroupId, { type: "half_died", role: foundRole });
        return;
      }
      // If we are already in a reconnect cycle and a DIFFERENT session in
      // the same group dies, both halves are now gone — short-circuit to
      // `reconnect_failed` so the group settles in `degraded` rather than
      // staying in `reconnecting` until the timer expires.
      const ctx = coordinator.getReconnectContext(foundGroupId);
      if (ctx && ctx.snapshotSessionId !== sessionId) {
        coordinator.cancelReconnectTimer(foundGroupId, "second_half_died");
        const meta = this.deps.groupMeta.get(foundGroupId)!;
        this.deps.intentionalKills.add(meta.primarySessionId);
        this.deps.intentionalKills.add(meta.observerSessionId);
        coordinator.applyEvent(foundGroupId, { type: "reconnect_failed", role: foundRole });
        return;
      }
      coordinator.armReconnect({
        sessionGroupId: foundGroupId,
        deadRole: foundRole,
        snapshotSessionId: sessionId,
      });
    });
  }

  /**
   * Lazily construct the long-lived {@link SessionGroupCoordinator}.
   *
   * The coordinator is shared between `createCouncilGroup` (the primary
   * spawn path) and `reconcileCouncilGroups` (the server-restart partial
   * pair recovery path) so listeners across the orchestrator hold a
   * stable reference. PLAN Task 1 keystone: `coordinator.applyEvent` is
   * the sole lifecycle mutator; without a long-lived instance, the
   * `session:exited` listener would have nothing to drive.
   *
   * Spawn/kill callbacks read per-call context from `opts.spawnContext`
   * (forwarded verbatim by the coordinator from `createGroup`'s request).
   * Two concurrent `createCouncilGroup` invocations cannot cross-contaminate
   * by construction — each call brings its own closure-captured context
   * object (docs/history/PLAN-aura-consolidated-refactor.md Task 2; replaces the prior
   * `this.pendingCouncilCall` instance scalar that was racy across tabs).
   */
  getOrCreateCoordinatorSync(): SessionGroupCoordinator {
    if (this.coordinator) return this.coordinator;
    log.info("session-orchestrator", "council coordinator initialised", {
      event: "config.grace_ms.resolved",
      resolvedMs: GROUP_RECONNECT_GRACE_MS,
    });
    const coordinator = new SessionGroupCoordinator({
      graceMs: GROUP_RECONNECT_GRACE_MS,
      spawn: async (opts) => {
        // Per-call context typed at the consumer end — the orchestrator
        // owns both the producer (createCouncilGroup) and this consumer,
        // so the cast is structurally safe.
        const ctx = opts.spawnContext as CouncilSpawnContext | undefined;
        if (!ctx) throw new Error("internal: coordinator spawn invoked without spawnContext");
        const result = await this.deps.createSession({
          ...ctx.baseBody,
          backend: opts.backendType,
          cwd: opts.cwd,
          model: opts.model ?? ctx.baseBody.model,
          permissionMode: opts.permissionMode ?? ctx.baseBody.permissionMode,
          sessionGroupId: opts.sessionGroupId,
          sessionGroupRole: opts.sessionGroupRole,
        });
        if (!result.ok) {
          if (opts.sessionGroupRole === "orchestrator") {
            ctx.spawnErrors.primary = { error: result.error, status: result.status };
          } else {
            ctx.spawnErrors.observer = { error: result.error, status: result.status };
          }
          throw new Error(result.error);
        }
        return { sessionId: result.session.sessionId };
      },
      kill: async (sessionId) => {
        await this.deps.killSession(sessionId);
      },
      // PLAN Task 8 (AP-2): the coordinator drains idle-timer effects here.
      idleTimerEnactor: this.deps.idleTimerEnactor,
    });
    this.deps.setCoordinator(coordinator);
    return coordinator;
  }

  /**
   * Pure helper (Fowler council review #15 — F2 echo): live session ids
   * for a given group, sourced from the launcher's session map. Returns
   * an empty array when both halves are gone — `broadcastToGroup` is a
   * no-op on missing ids by design.
   */
  private getGroupMemberIds(sessionGroupId: string): string[] {
    const ids: string[] = [];
    for (const s of this.deps.launcher.listSessions()) {
      if (s.sessionGroupId === sessionGroupId) ids.push(s.sessionId);
    }
    return ids;
  }

  // ── Council Mode — per-group filesystem watcher lifecycle ────────────────

  /**
   * Start the checkpoint + review watchers for a newly-created group.
   * Idempotent: a second call with the same `sessionGroupId` is a no-op
   * (the existing AbortController remains in charge).
   *
   * Both watchers run in the background; errors are logged via the
   * watcher's `onDropped` hook rather than thrown, so a malformed file or
   * a missing directory does not propagate up into the group creation
   * path that already returned to the caller.
   */
  startCouncilWatchers(sessionGroupId: string, workspaceCwd: string): void {
    if (this.deps.watchers.has(sessionGroupId)) return;
    const abort = new AbortController();
    const entry: CouncilWatcherEntry = {
      cwd: workspaceCwd,
      abort,
      lastCheckpoint: null,
      previousCheckpoint: null,
      pendingCheckpoint: null,
      supersededCheckpointIds: [],
      pendingReviewDeadline: null,
    };
    this.deps.watchers.set(sessionGroupId, entry);

    const checkpointsDir = join(workspaceCwd, ".council", "checkpoints");
    const reviewsDir = join(workspaceCwd, ".council", "reviews");

    // Ensure the watch targets exist before the watcher attaches —
    // `fs.watch` throws on missing dirs; Phase G.1 silently absorbed that
    // failure into a single warn line, leaving the council pipeline dead.
    // mkdirSync is recursive + idempotent so a pre-existing tree is fine.
    try {
      mkdirSync(checkpointsDir, { recursive: true });
      mkdirSync(reviewsDir, { recursive: true });
    } catch (err) {
      log.warn("session-orchestrator", "council watcher dir mkdir failed", {
        sessionGroupId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.deps.watchers.delete(sessionGroupId);
      abort.abort();
      return;
    }

    // Both watchers run under `runResilientWatch` (Issue #86): a watcher that
    // dies mid-uptime is re-armed instead of leaving the pair functionally
    // dead until a server restart. `onDeath` schedules a catch-up scan a beat
    // after the re-arm attaches, because `fs.watch` never replays files
    // written while it was down — the delayed `scanForMissedObserverWakes`
    // reads `.council/checkpoints/` directly and re-dispatches any missed
    // wake (idempotent: the dispatcher's Gate 0 sentinel absorbs overlap with
    // the freshly re-armed live watcher).
    const scheduleCatchupAfterRearm = () => {
      const t = setTimeout(() => {
        // Council Review 2026-07-05 Subprocess #12: a `setTimeout` callback that
        // throws is an unhandled exception — under Bun that is fatal to the whole
        // server. `scanForMissedObserverWakes` is defensively try/caught per group
        // internally, but guard the boundary anyway for crash-safety symmetry with
        // the failsafe interval tick.
        try {
          this.deps.scanForMissedObserverWakes("watcher-rearm");
        } catch (err) {
          log.warn("session-orchestrator", "watcher-rearm catchup scan threw", {
            event: "council.wake.watcher_rearm_scan_failed",
            sessionGroupId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }, DEFAULT_REARM_DELAY_MS + 250);
      t.unref?.();
    };

    void runResilientWatch({
      kind: "checkpoint",
      logContext: { sessionGroupId },
      signal: abort.signal,
      start: () =>
        watchCheckpoints({
          directory: checkpointsDir,
          signal: abort.signal,
          onCheckpoint: (payload) => this.deps.handleCouncilCheckpoint(sessionGroupId, payload),
        }),
      onDeath: scheduleCatchupAfterRearm,
    });

    void runResilientWatch({
      kind: "review",
      logContext: { sessionGroupId },
      signal: abort.signal,
      start: () =>
        watchReviews({
          directory: reviewsDir,
          signal: abort.signal,
          onReview: (payload, reviewedAt) => this.deps.handleCouncilReview(sessionGroupId, payload, reviewedAt),
          normalizeRaw: (raw, provider) => this.deps.normalizeObserverReviewRaw(sessionGroupId, raw, provider),
        }),
      // A dead review watcher can only be recovered by re-waking the observer
      // (it re-writes its review on the next wake), which the checkpoint
      // catch-up scan triggers — so the same scan covers both channels.
      onDeath: scheduleCatchupAfterRearm,
    });
  }

  /**
   * Council Review 2026-05-13-0150 Backend #4: tear down ALL council-
   * group tracking state atomically — meta + reverse-index. Single
   * helper so any future per-session archive/delete path that bypasses
   * `group:exited` can call this directly without touching the two Maps
   * separately. The order is: clear reverse index FIRST so a concurrent
   * `observer:turn-done` reverse-lookup misses cleanly rather than
   * routing to a half-deleted meta entry.
   */
  tearDownCouncilGroupTracking(sessionGroupId: string): void {
    const meta = this.deps.groupMeta.get(sessionGroupId);
    if (meta) {
      this.deps.groupBySessionId.delete(meta.primarySessionId);
      this.deps.groupBySessionId.delete(meta.observerSessionId);
    }
    this.deps.groupMeta.delete(sessionGroupId);
    this.deps.degradedReason.delete(sessionGroupId);
    this.deps.deadRole.delete(sessionGroupId);
    this.deps.forgetScheduledGroup(sessionGroupId);
  }


  stopCouncilWatchers(sessionGroupId: string): void {
    const entry = this.deps.watchers.get(sessionGroupId);
    if (!entry) return;
    entry.abort.abort();
    // Council Review 2026-06-13 (P1 #1): clear the wake→review watchdog so a
    // torn-down group cannot fire a late degrade against a stale group id.
    if (entry.pendingReviewDeadline) {
      clearTimeout(entry.pendingReviewDeadline.timer);
      entry.pendingReviewDeadline = null;
    }
    const observerSessionId = this.deps.groupMeta.get(sessionGroupId)?.observerSessionId;
    if (observerSessionId) {
      this.deps.replyCapture.forget(observerSessionId);
      this.deps.readLedger.forget(observerSessionId);
    }
    this.deps.lineSnapshots.forget(sessionGroupId);
    this.deps.watchers.delete(sessionGroupId);
  }

  /**
   * Council Mode entry point. Validates the pairing server-side against
   * the supported allow-list, then spawns both halves via
   * {@link SessionGroupCoordinator}. The injected `spawn` is a thin
   * adapter over {@link doCreateSession} so the council path composes on
   * top of the existing single-session machinery without branching it.
   *
   * Atomic: if the second spawn fails, the coordinator kills the first
   * before propagating the error — no orphan subprocesses.
   *
   * Emits `group:created` on success so {@link WsBridge} can fan the
   * `group_created` browser message out to both halves' sockets.
   */
  async createCouncilGroup(req: CreateCouncilGroupRequest): Promise<CreateCouncilGroupResult> {
    // PLAN Task 1: coordinator + backend-provider are now statically imported
    // so reconcileCouncilGroups() (sync, called from initialize()) can wire
    // groups into the same long-lived coordinator instance this method uses.
    // Lazy-import overhead was negligible; uniform import keeps both code
    // paths reading from a single module reference.
    const isSupportedPairing = _isSupportedPairing;
    const parsePairingLabel = (label: string): { primary: BackendType; observer: BackendType } | null => {
      const parts = label.split("+");
      if (parts.length !== 2) return null;
      const [p, o] = parts as [string, string];
      if ((p !== "claude" && p !== "codex") || (o !== "claude" && o !== "codex")) return null;
      return { primary: p, observer: o };
    };

    const parsed = parsePairingLabel(req.pairing);
    if (!parsed) return { ok: false, error: `unsupported pairing: ${req.pairing}`, status: 400 };
    if (!isSupportedPairing(parsed.primary, parsed.observer)) {
      return { ok: false, error: `unsupported pairing: ${req.pairing}`, status: 400 };
    }

    const baseBody: CreateSessionRequest = { ...req.base };
    // Per-call context — entirely lexical, never on `this`. Two concurrent
    // createCouncilGroup invocations get distinct closure-captured objects
    // and the coordinator's spawn callback (set in
    // getOrCreateCoordinatorSync) reads from `opts.spawnContext`, not from
    // shared mutable state. PLAN Task 2 race fix.
    const spawnContext: CouncilSpawnContext = {
      baseBody,
      spawnErrors: { primary: null, observer: null },
    };

    const coordinator = this.getOrCreateCoordinatorSync();

    // Council Plan Bug B Review P1 #2 — refuse to default to
    // `process.cwd()` here. Council Mode requires an explicit workspace
    // cwd so the observer prompt resolution gets a real workspace path
    // (not the server's `/app` under Docker). Without this throw, the
    // upstream `process.cwd()` default silently triggered the bundled-
    // fallback path with `reason: "ENOENT"` — the distinct
    // `no-workspace-cwd` branch was structurally unreachable.
    if (!req.base.cwd || typeof req.base.cwd !== "string" || req.base.cwd.length === 0) {
      throw new Error(
        "createCouncilGroup: explicit cwd is required for Council Mode session creation; refusing to fall back to process.cwd()",
      );
    }
    try {
      const group = await coordinator.createGroup({
        cwd: req.base.cwd,
        primary: parsed.primary,
        observer: parsed.observer,
        model: req.base.model,
        permissionMode: req.base.permissionMode,
        spawnContext,
      });
      const primaryInfo = this.deps.launcher.getSession(group.primary.sessionId);
      const observerInfo = this.deps.launcher.getSession(group.observer.sessionId);
      if (!primaryInfo || !observerInfo) {
        return { ok: false, error: "session metadata lost after spawn", status: 500 };
      }
      // Capture group metadata for handleCouncilReview's invocation log
      // and for the bus listeners that broadcast group_* events. The
      // coordinator owns lifecycle truth; this is the orchestrator's
      // read-side cache so listeners running outside the spawn context
      // can correlate without rescanning launcher state.
      const pairingLabel = `${primaryInfo.backendType ?? "claude"}+${observerInfo.backendType ?? "claude"}`;
      this.deps.groupMeta.set(group.sessionGroupId, {
        primarySessionId: group.primary.sessionId,
        observerSessionId: group.observer.sessionId,
        pairing: pairingLabel,
        observerPromptSha256: observerInfo.observerPromptSha256,
        observerPromptSource: observerInfo.observerPromptSource,
        observerPromptVersion: observerInfo.observerPromptVersion,
        observerModel: observerInfo.model,
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      this.deps.groupBySessionId.set(group.primary.sessionId, group.sessionGroupId);
      this.deps.groupBySessionId.set(group.observer.sessionId, group.sessionGroupId);
      // Mark both halves on the ws-bridge so `session.state.sessionGroupId`
      // is populated and persisted. Without this, the synthetic
      // `group_created` hydration in `handleBrowserOpen` (from commit
      // a37ded5) reads `state.sessionGroupId` which was previously never
      // written in production — surviving pairs across browser reload /
      // server restart looked like two unrelated solo sessions.
      this.wsBridge.markCouncilSession(group.primary.sessionId, group.sessionGroupId, "orchestrator");
      this.wsBridge.markCouncilSession(group.observer.sessionId, group.sessionGroupId, "observer");
      // Start the per-group filesystem watchers BEFORE emitting
      // `group:created` so the watcher's first FS event cannot race past
      // the listener that calls `upsertGroup` in the browser store.
      this.startCouncilWatchers(group.sessionGroupId, primaryInfo.cwd);
      companionBus.emit("group:created", {
        sessionGroupId: group.sessionGroupId,
        primarySessionId: group.primary.sessionId,
        observerSessionId: group.observer.sessionId,
      });
      // Spawn-ack checkpoint — synthetic `phase: "spawn"` with empty
      // artifact_paths, written after both halves are live so the
      // observer's first protocol turn happens deterministically at
      // spawn time instead of waiting for a real user-driven phase.
      // Without this, the observer sits at `control_response:initialize`
      // with `cliSessionId=null` indefinitely (CLI awaits stdin), and
      // the UI panel hangs on `never-checkpointed-yet`. The empty
      // manifest produces a `findings: []` review (per the observer
      // prompt's spawn-ack section), confirming the full pipeline is
      // wired and populating `cliSessionId` on the observer half.
      //
      // CRITICAL: deferred via fire-and-forget poll until the observer's
      // bridge adapter is attached. Without this gate, the file lands +
      // watcher fires + dispatchObserverWake returns `adapter_missing`
      // because the observer CLI subprocess has not yet completed its
      // WebSocket handshake back to the server — the wake is dropped
      // silently and the panel stays stuck on `reviewing-spawn` with no
      // findings. The REST response is NOT blocked on this poll.
      void this.deps.scheduleSpawnCheckpointWhenObserverReady(
        group.sessionGroupId,
        group.observer.sessionId,
        primaryInfo.cwd,
      );
      return { ok: true, sessionGroupId: group.sessionGroupId, primary: primaryInfo, observer: observerInfo };
    } catch (err) {
      if (spawnContext.spawnErrors.primary) return { ok: false, ...spawnContext.spawnErrors.primary };
      if (spawnContext.spawnErrors.observer) return { ok: false, ...spawnContext.spawnErrors.observer };
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, error: reason, status: 500 };
    }
    // No finally block — spawnContext lives in lexical scope and GC'd when
    // this function returns; nothing to clean up on the orchestrator instance.
  }

  /**
   * O(1) lookup of the Council group a session belongs to, returning both
   * the group id and the session's role within it. Returns null when the
   * session is not part of any active council group. Exposed publicly so
   * REST endpoints (notably the orchestrator-side checkpoint emit route)
   * can authorize callers without leaking the full `councilGroupMeta`
   * map. Read-only — does not mutate orchestrator state.
   */
  getCouncilGroupBySessionId(sessionId: string): { sessionGroupId: string; role: "orchestrator" | "observer" } | null {
    const sessionGroupId = this.deps.groupBySessionId.get(sessionId);
    if (!sessionGroupId) return null;
    const meta = this.deps.groupMeta.get(sessionGroupId);
    if (!meta) return null;
    const role: "orchestrator" | "observer" =
      meta.primarySessionId === sessionId ? "orchestrator" : "observer";
    return { sessionGroupId, role };
  }

  /**
   * REST bootstrap for Council Mode group records — return every live
   * group the coordinator currently tracks, in the same wire shape the
   * `group_created` push event uses. Used by the browser on app mount /
   * reload to repopulate `groupBySessionId` so the Sidebar glyph + role
   * suffix render correctly even when the original `group_created` event
   * arrived while no browser was connected.
   *
   * Closes the bootstrap gap described in
   * `docs/history/BUG-council-mode-group-rest-bootstrap-gap.md` — historically the
   * browser's group store was populated EXCLUSIVELY by the live
   * `group:created` push, so a reload after pair creation left the
   * Sidebar without the ☼/☽ decoration and the ObserverPanel without
   * pair context.
   *
   * Returns an empty array when no coordinator exists yet (no Council
   * Mode usage this server uptime). Archived groups are filtered out —
   * they should not appear in the Sidebar list of active pairs.
   */
  getAllGroupsForBootstrap(): BrowserGroupRecord[] {
    if (!this.coordinator || this.coordinator.listAll().length === 0) {
      this.reconcileCouncilGroups();
    }
    if (!this.coordinator) return [];
    const records = this.coordinator.listAll();
    const out: BrowserGroupRecord[] = [];
    for (const g of records) {
      if (g.status === "archived") continue;
      // Shared helper — same construction site as the live push and the
      // ws-bridge synthetic hydration. Pairing label + wakeTimeoutMs +
      // field ordering cannot drift across the three producers because
      // there is only one assembly site.
      out.push(buildBrowserGroupRecord({
        sessionGroupId: g.sessionGroupId,
        primary: g.primary,
        observer: g.observer,
        status: g.status,
        deadRole: this.deps.deadRole.get(g.sessionGroupId),
        degradedReason: this.deps.degradedReason.get(g.sessionGroupId),
      }));
    }
    return out;
  }

  /**
   * REST bootstrap for the ObserverPanel — read all review files for a council
   * group from disk, parse them, run the same grounding validation the WS
   * pipeline uses, and return hydrated findings the browser can populate
   * immediately on reconnect / page reload.
   *
   * Closes `feedback_aura_observer_panel_no_rest_bootstrap` — historically the
   * browser council slice was populated EXCLUSIVELY from live `group:review`
   * WS events; a tab connecting after the event missed everything. This
   * method is the deterministic bootstrap that complements the WS live path.
   *
   * Returns null when:
   *   - the group is unknown to this orchestrator (already archived, never created)
   *   - the workspace cwd cannot be read
   * Returns `{findings: [], reviewCount: 0}` when the group is known but has no
   * review files yet (panel renders `never-checkpointed-yet`).
   */
  async getGroupReviewsForBootstrap(sessionGroupId: string): Promise<{
    sessionGroupId: string;
    findings: BrowserObserverFinding[];
    downgrades: BrowserObserverDowngrade[];
    reviewCount: number;
    observerProvider?: string;
    observerModel?: string;
  } | null> {
    const collected = this.collectGroupReviews(sessionGroupId);
    if (!collected) return null;
    const { gaps: _gaps, unfrozenRawStopIds: _unfrozen, ...view } = collected;
    return view;
  }

  /**
   * FIX-AP-2 — what the auto-proceed hold restore needs after a restart: the
   * bootstrap findings (frozen verdicts applied), the ids whose raw severity
   * was STOP but whose verdict was never frozen (they hold on raw severity),
   * and every reason the view may be incomplete (the restore fails closed on
   * any). `null` → the group is unknown to this orchestrator.
   */
  getGroupStopHoldView(sessionGroupId: string): {
    findings: BrowserObserverFinding[];
    unfrozenRawStopIds: string[];
    gaps: string[];
  } | null {
    const collected = this.collectGroupReviews(sessionGroupId);
    if (!collected) return null;
    return { findings: collected.findings, unfrozenRawStopIds: collected.unfrozenRawStopIds, gaps: collected.gaps };
  }

  private collectGroupReviews(sessionGroupId: string): {
    sessionGroupId: string;
    findings: BrowserObserverFinding[];
    downgrades: BrowserObserverDowngrade[];
    reviewCount: number;
    observerProvider?: string;
    observerModel?: string;
    unfrozenRawStopIds: string[];
    gaps: string[];
  } | null {
    const meta = this.deps.groupMeta.get(sessionGroupId);
    if (!meta) return null;
    const watcher = this.deps.watchers.get(sessionGroupId);
    if (!watcher) return null;
    const gaps: string[] = [];
    const unfrozenRawStopIds: string[] = [];
    const reviewsDir = join(watcher.cwd, ".council", "reviews");
    if (!existsSync(reviewsDir)) {
      return { sessionGroupId, findings: [], downgrades: [], reviewCount: 0, unfrozenRawStopIds, gaps };
    }
    // FIX-AP-2: the verdicts grounding reached at review time. Without them a
    // finding is re-grounded for display, and its raw STOP still holds.
    const frozenRead = readReviewVerdicts(watcher.cwd, sessionGroupId);
    const frozen = frozenRead.ok ? frozenRead.verdicts : new Map<string, FrozenVerdict>();
    if (!frozenRead.ok) gaps.push(`verdicts_${frozenRead.reason}`);
    // Pinned filename shape from review-watcher: `<phase>-<provider>-observer.md`.
    // Duplicated here intentionally — extracting to a shared constant would
    // touch review-watcher (out of scope for this fix); revisit per EC-20.
    const filenamePattern = /^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}-(claude|codex)-observer\.md$/;
    const allFindings: BrowserObserverFinding[] = [];
    const allDowngrades: BrowserObserverDowngrade[] = [];
    let observerProvider: string | undefined;
    let observerModel: string | undefined;
    let reviewCount = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(reviewsDir).filter((f) => filenamePattern.test(f));
    } catch (err) {
      log.warn("session-orchestrator", "getGroupReviewsForBootstrap: readdir failed", {
        sessionGroupId,
        reviewsDir,
        error: err instanceof Error ? err.message : String(err),
      });
      return { sessionGroupId, findings: [], downgrades: [], reviewCount: 0, unfrozenRawStopIds, gaps: [...gaps, "reviews_readdir_failed"] };
    }
    for (const file of entries) {
      const filePath = join(reviewsDir, file);
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch {
        gaps.push(`review_unreadable:${file}`);
        continue;
      }
      const payload = parseObserverReviewPayload(raw);
      if (!payload) {
        gaps.push(`review_unparseable:${file}`);
        continue;
      }
      reviewCount++;
      // Real event time = the review FILE's mtime (server-observed), NOT the
      // observer's self-reported `reviewed_at` (observer-authored, unreliable —
      // observed as a hallucinated placeholder). Stamped per-finding so the UI
      // shows when each review actually landed instead of one page-load time
      // for the whole backlog.
      let reviewedAt: number;
      try {
        reviewedAt = statSync(filePath).mtimeMs;
      } catch {
        reviewedAt = Date.now();
      }
      observerProvider = observerProvider ?? payload.observer_provider;
      observerModel = observerModel ?? payload.observer_model;
      // Apply same grounding validation as the WS path so REST-bootstrapped
      // findings match WS-arrived findings byte-for-byte after deterministic
      // ID dedup. Re-use `validateObserverFindings` from observer-grounding.
      // FIX-AP-2: only a finding without a frozen verdict keeps this result.
      const manifest = buildObserverContextManifest({
        current: watcher.lastCheckpoint ?? { artifact_paths: [] },
        previous: watcher.previousCheckpoint ?? undefined,
      });
      const modifiedFiles = new Set(manifest.delta.length > 0
        ? manifest.delta
        : (watcher.lastCheckpoint?.artifact_paths ?? []));
      const result = validateObserverFindings(payload, {
        workspaceRoot: watcher.cwd,
        modifiedFiles,
        lineFacts: this.deps.lineSnapshots.providerFor(sessionGroupId, payload.checkpoint_id, watcher.cwd),
      });
      result.findings.forEach((f, idx) => {
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
        const regrounded: BrowserObserverFinding = {
          id,
          severity: f.severity,
          claim: f.claim,
          evidence_path: f.evidence_path,
          ...(f.evidence_lines !== undefined ? { evidence_lines: f.evidence_lines } : {}),
          ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
          ...(downgrade ? { wasDowngraded: true, downgradeReason: downgrade.reason } : {}),
          ...(weak ? { weakEvidence: weak.reason } : {}),
          reviewedAt,
        };
        const verdict = frozen.get(id);
        if (!verdict && payload.findings[idx]?.severity === "STOP") unfrozenRawStopIds.push(id);
        const out = verdict ? applyFrozenVerdict(regrounded, verdict) : regrounded;
        allFindings.push(out);
        if (out.wasDowngraded && out.downgradeReason) {
          allDowngrades.push({ id, reason: out.downgradeReason });
        }
      });
    }
    this.deps.markDisputedStops(sessionGroupId, watcher.cwd, allFindings, { log: false });
    return {
      sessionGroupId,
      findings: allFindings,
      downgrades: allDowngrades,
      reviewCount,
      ...(observerProvider !== undefined && { observerProvider }),
      ...(observerModel !== undefined && { observerModel }),
      unfrozenRawStopIds,
      gaps,
    };
  }

  /**
   * B2b: record a human's explicit "Dispute" of an observer STOP as a
   * persistent dispute for the group, so a re-raised copy of the claim on the
   * same evidence file (next checkpoint, other wording, or a page reload) no
   * longer raises the blocker banner. "Dismiss for now" never calls this.
   */
  disputeObserverFinding(
    sessionGroupId: string,
    input: { claim: string; evidencePath: string; findingId?: string },
  ): { ok: true; added: boolean } | { ok: false; reason: "unknown_group" | "invalid_input" | "persist_failed" } {
    const meta = this.deps.groupMeta.get(sessionGroupId);
    const watcher = this.deps.watchers.get(sessionGroupId);
    if (!meta || !watcher) return { ok: false, reason: "unknown_group" };
    const res = addDispute(watcher.cwd, sessionGroupId, { ...input, source: "browser_dispute" });
    if (!res.ok) {
      log.warn("session-orchestrator", "observer dispute not recorded", {
        event: "council.finding.dispute_failed",
        sessionGroupId,
        sessionId: meta.primarySessionId,
        role: "orchestrator",
        findingId: input.findingId,
        reason: res.reason,
        detail: res.detail,
      });
      return { ok: false, reason: res.reason === "invalid-input" ? "invalid_input" : "persist_failed" };
    }
    log.info("session-orchestrator", "observer finding disputed", {
      event: "council.finding.disputed",
      sessionGroupId,
      sessionId: meta.primarySessionId,
      role: "orchestrator",
      findingId: input.findingId,
      evidencePath: input.evidencePath,
      added: res.added,
      disputeCount: res.count,
    });
    return { ok: true, added: res.added };
  }
}
