import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { AgentExecutor } from "./agent-executor.js";
import type { BackendType, CreationStepId, SessionGroupRole } from "./session-types.js";
import type { ContainerConfig, ContainerInfo } from "./container-manager.js";
import { containerManager } from "./container-manager.js";
import { imagePullManager } from "./image-pull-manager.js";
import * as envManager from "./env-manager.js";
import * as sandboxManager from "./sandbox-manager.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import * as sessionLinearIssues from "./session-linear-issues.js";
import { getConnection, resolveApiKey } from "./linear-connections.js";
import { buildLinearSystemPrompt } from "./linear-prompt-builder.js";
import { transitionLinearIssue, fetchLinearTeamStates } from "./routes/linear-routes.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";
import { discoverCommandsAndSkills } from "./commands-discovery.js";
import { getSettings } from "./settings-manager.js";
import { generateSessionTitle } from "./auto-namer.js";
import { companionBus } from "./event-bus.js";
import { metricsCollector } from "./metrics-collector.js";
import { log } from "./logger.js";
import { SessionGroupCoordinator } from "./session-group-coordinator.js";
import { isSupportedPairing as _isSupportedPairing } from "./backend-provider.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import type { CheckpointPayload, ObserverReviewPayload } from "./council-types.js";
import { OBSERVER_WAKE_PAYLOAD_VERSION, OBSERVER_WAKE_TIMEOUT_MS, parseCheckpointPayload } from "./council-types.js";
import { watchCheckpoints } from "./checkpoint-watcher.js";
import { watchReviews } from "./review-watcher.js";
import { validateObserverFindings } from "./observer-grounding.js";
import { buildObserverContextManifest, buildObserverWakePayload } from "./observer-prompt.js";
import type { BridgeObserverWakeOutcome } from "./ws-bridge.js";
import {
  deleteCouncilWakeSentinel,
  readCouncilWakeSentinel,
  writeCouncilWakeSentinel,
} from "./council-wake-sentinel.js";
import { formatObserverInvocationLog } from "./observer-attribution.js";
import type {
  BrowserObserverDowngrade,
  BrowserObserverFinding,
} from "./session-types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_AUTO_RELAUNCHES = 3;
const RELAUNCH_GRACE_MS = 10_000;
const RELAUNCH_COOLDOWN_MS = 5_000;
const RECONNECT_GRACE_MS = Number(process.env.COMPANION_RECONNECT_GRACE_MS || "30000");

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

// Proactive keepalive: base delay before relaunching a crashed CLI (doubles per attempt)
const KEEPALIVE_BASE_DELAY_MS = 3_000;

const VSCODE_EDITOR_CONTAINER_PORT = 13337;
const CODEX_APP_SERVER_CONTAINER_PORT = Number(
  process.env.COMPANION_CODEX_CONTAINER_WS_PORT || "4502",
);
const NOVNC_CONTAINER_PORT = 6080;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionOrchestratorDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  sessionStore: SessionStore;
  worktreeTracker: WorktreeTracker;
  prPoller: {
    watch(sessionId: string, cwd: string, branch: string): void;
    unwatch(sessionId: string): void;
  };
  agentExecutor: AgentExecutor;
}

export interface CreateSessionRequest {
  backend?: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  envSlug?: string;
  sandboxEnabled?: boolean;
  sandboxSlug?: string;
  linearConnectionId?: string;
  linearIssue?: unknown;
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  container?: { image?: string; ports?: number[]; volumes?: string[] };
  resumeSessionAt?: string;
  forkSession?: boolean;
  // Council Mode — present on a regular createSession request only when the
  // call is being dispatched FROM `createCouncilGroup` for each half of the
  // pair. The browser does NOT supply these on the public `councilMode`
  // route; the coordinator generates them server-side.
  sessionGroupId?: string;
  sessionGroupRole?: import("./session-types.js").SessionGroupRole;
}

/** Public Council Mode pair-create request. The coordinator validates the
 *  pairing server-side against {@link SUPPORTED_PAIRINGS}; the browser's
 *  selection is treated as untrusted input. */
export interface CreateCouncilGroupRequest {
  pairing: "claude+claude" | "claude+codex";
  /** Shared base request — model/cwd/env/sandbox/etc. apply to BOTH halves. */
  base: Omit<CreateSessionRequest, "backend" | "sessionGroupId" | "sessionGroupRole">;
}

export type CreateCouncilGroupResult =
  | {
    ok: true;
    sessionGroupId: string;
    primary: SdkSessionInfo;
    observer: SdkSessionInfo;
  }
  | { ok: false; error: string; status: number };

export type CreateSessionResult =
  | { ok: true; session: SdkSessionInfo }
  | { ok: false; error: string; status: number };

export type ProgressCallback = (
  step: CreationStepId,
  label: string,
  status: "in_progress" | "done" | "error",
  detail?: string,
) => Promise<void>;

export interface ArchiveSessionOptions {
  force?: boolean;
  linearTransition?: string;
}

export interface ArchiveSessionResult {
  ok: boolean;
  worktree?: { cleaned?: boolean; dirty?: boolean; path?: string };
  linearTransition?: {
    ok: boolean;
    skipped?: boolean;
    error?: string;
    issue?: { id: string; identifier: string; stateName: string; stateType: string };
  };
}

export interface DeleteSessionResult {
  ok: boolean;
  worktree?: { cleaned?: boolean; dirty?: boolean; path?: string };
}

// ── Council Mode internal state shapes ─────────────────────────────────────

interface CouncilWatcherEntry {
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
   * because the whole entry is removed in {@link stopCouncilWatchers}.
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
}

/**
 * Outcome returned by {@link SessionOrchestrator.dispatchObserverWake}.
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
      | "already_woken" }
  | { kind: "failed"; error: string };

interface CouncilGroupMeta {
  primarySessionId: string;
  observerSessionId: string;
  pairing: string;
  /** Sha256 of the observer prompt artifact at spawn time, captured for invocation-log forensic re-run. */
  observerPromptSha256?: string;
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

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Per-call context plumbed through the SessionGroupCoordinator's
 * `spawnContext` field (PLAN-aura-consolidated-refactor.md Task 2). The
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

/**
 * Single entry point for session lifecycle operations: create, resume,
 * reconnect, and terminate. Coordinates between CliLauncher (process
 * management), WsBridge (message routing), and SessionStore (persistence).
 */
export class SessionOrchestrator {
  private launcher: CliLauncher;
  private wsBridge: WsBridge;
  private sessionStore: SessionStore;
  private worktreeTracker: WorktreeTracker;
  private prPoller: SessionOrchestratorDeps["prPoller"];
  private agentExecutor: AgentExecutor;

  // Auto-relaunch state
  private relaunchingSet = new Set<string>();
  private autoRelaunchCounts = new Map<string, number>();
  // Sessions that have already been notified about relaunch exhaustion.
  // Prevents repeated "keeps crashing" warnings for dead sessions.
  private relaunchExhaustedNotified = new Set<string>();

  // Tracks sessions intentionally killed (idle-kill, manual delete/archive)
  // so the proactive keepalive doesn't relaunch them.
  private intentionalKills = new Set<string>();
  // Timers for proactive keepalive relaunches (for cancellation on delete)
  private keepaliveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Idempotency guard for initialize()
  private _initialized = false;

  // Council Mode — per-group watcher state. Each entry owns an
  // AbortController for the checkpoint + review watchers and the most
  // recent checkpoint payload (used to ground observer findings against
  // the artifact manifest the orchestrator emitted). `previousCheckpoint`
  // feeds `buildObserverContextManifest` so grounding uses the DELTA
  // since the previous phase, not the cumulative manifest.
  private councilWatchers = new Map<string, CouncilWatcherEntry>();
  /**
   * Council Mode — per-group spawn metadata captured at pair creation
   * time so listeners running outside the spawn context (group:review
   * fanout, group:exited fanout) can correlate to the original orchestrator
   * + observer session ids and the observer attribution fields. The
   * coordinator owns the lifecycle source-of-truth; this map is the
   * orchestrator's read-side cache.
   */
  private councilGroupMeta = new Map<string, CouncilGroupMeta>();
  /**
   * Council Review 2026-05-13 Backend #21: reverse index sessionId →
   * sessionGroupId so bus listeners can look up the group in O(1)
   * instead of O(active-group-count). Maintained alongside
   * `councilGroupMeta` writes; cleared on `group:exited`. The frontend
   * slice already has this pattern; this is the server-side mirror.
   */
  private councilGroupBySessionId = new Map<string, string>();

  /**
   * Long-lived coordinator instance — owns the group state machine + the
   * reconnect grace timer map. Lazily constructed on first council
   * operation; persists across calls so listeners (session:exited,
   * session:cli-id-received) hold a stable reference. PLAN Task 1
   * keystone: `coordinator.applyEvent` is now the sole lifecycle mutator.
   */
  private coordinator: SessionGroupCoordinator | null = null;

  // Event listeners
  private exitCallbacks: ((sessionId: string, exitCode: number | null) => void)[] = [];

  constructor(deps: SessionOrchestratorDeps) {
    this.launcher = deps.launcher;
    this.wsBridge = deps.wsBridge;
    this.sessionStore = deps.sessionStore;
    this.worktreeTracker = deps.worktreeTracker;
    this.prPoller = deps.prPoller;
    this.agentExecutor = deps.agentExecutor;
  }

  // ── Initialization (event wiring) ──────────────────────────────────────────

  initialize(): void {
    if (this._initialized) return;
    this._initialized = true;

    // When the CLI reports its internal session_id, store it for --resume
    companionBus.on("session:cli-id-received", ({ sessionId, cliSessionId }) => {
      this.launcher.setCLISessionId(sessionId, cliSessionId);
    });

    // Council Mode auto-wake (Task 4 drain hook): when the observer
    // half's adapter flips turn-state from `in-flight` to `idle`
    // (a `result` NDJSON frame arrived), drain the per-group
    // pendingCheckpoint slot if one is queued.
    //
    // Council Review 2026-05-13 Backend #21: reverse-map via the
    // `councilGroupBySessionId` index instead of iterating
    // `councilGroupMeta` — O(1) lookup.
    companionBus.on("observer:turn-done", ({ sessionId }) => {
      try {
        const groupId = this.councilGroupBySessionId.get(sessionId);
        if (!groupId) return;
        // Guard: only the OBSERVER half's turn-done drives the drain.
        // Orchestrator-half result frames (if they ever flip in-flight,
        // currently they don't) must not trigger observer-side drain.
        const meta = this.councilGroupMeta.get(groupId);
        if (!meta || meta.observerSessionId !== sessionId) return;
        this.drainPendingObserverWake(groupId);
      } catch (err) {
        log.warn("session-orchestrator", "observer turn-done drain failed", {
          event: "council.wake.drain_handler_error",
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

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
        // Find the group this sessionId belongs to via meta cache.
        let foundGroupId: string | null = null;
        for (const [groupId, meta] of this.councilGroupMeta) {
          if (meta.primarySessionId === sessionId || meta.observerSessionId === sessionId) {
            foundGroupId = groupId;
            break;
          }
        }
        if (!foundGroupId) return;
        const ctx = coord.getReconnectContext(foundGroupId);
        if (!ctx) return; // No reconnect armed for this group — normal handshake, nothing to do.
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
          const meta = this.councilGroupMeta.get(foundGroupId);
          const watcher = this.councilWatchers.get(foundGroupId);
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
          this.drainPendingObserverWake(foundGroupId);
        }
      } catch (err) {
        log.warn("session-orchestrator", "reconnect_ok guard violation", {
          event: "group.reconnect_ok.guard_violation",
          sessionId,
          error: String(err),
        });
      }
    });

    // When a Codex adapter is created, attach it to the WsBridge
    companionBus.on("backend:codex-adapter-created", ({ sessionId, adapter }) => {
      this.wsBridge.attachBackendAdapter(sessionId, adapter, "codex");
    });

    // When a CLI/Codex process exits, notify agent executor and external listeners
    // separately so a throw in one doesn't skip the other (bus isolates each handler).
    companionBus.on("session:exited", ({ sessionId, exitCode }) => {
      this.agentExecutor.handleSessionExited(sessionId, exitCode);
    });
    companionBus.on("session:exited", ({ sessionId, exitCode }) => {
      for (const cb of this.exitCallbacks) {
        try {
          cb(sessionId, exitCode);
        } catch (err) {
          console.error("[orchestrator] exitCallback error:", err);
        }
      }
    });
    companionBus.on("session:exited", ({ sessionId }) => {
      const session = this.wsBridge.getSession(sessionId);
      if (session?.stateMachine) {
        session.stateMachine.transition("terminated", "process_exited");
      }
    });

    // Proactive keepalive: auto-relaunch crashed CLI processes even without
    // a browser connected. This ensures long-running sessions (agents, cron
    // jobs) stay alive. Intentional kills (idle-kill, manual delete/archive)
    // are excluded via the intentionalKills set.
    companionBus.on("session:exited", ({ sessionId }) => {
      this.scheduleProactiveRelaunch(sessionId);
    });

    // Start watching PRs when git info is resolved
    companionBus.on("session:git-info-ready", ({ sessionId, cwd, branch }) => {
      this.prPoller.watch(sessionId, cwd, branch);
    });

    // Auto-relaunch CLI when a browser connects to a session with no CLI
    companionBus.on("session:relaunch-needed", async ({ sessionId }) => {
      await this.handleAutoRelaunch(sessionId);
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
        for (const [groupId, meta] of this.councilGroupMeta) {
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
        const meta = this.councilGroupMeta.get(foundGroupId)!;
        this.intentionalKills.add(meta.primarySessionId);
        this.intentionalKills.add(meta.observerSessionId);
        coord.applyEvent(foundGroupId, { type: "reconnect_failed", role: ctx.deadRole });
      } catch (err) {
        log.warn("session-orchestrator", "reconnect_failed short-circuit guard violation", {
          event: "group.reconnect_failed.guard_violation",
          sessionId,
          error: String(err),
        });
      }
    });

    // Kill CLI process when idle with no browsers for 24 hours.
    // Only kills the CLI process — containers are preserved so the session
    // can be relaunched without recreating the container.
    companionBus.on("session:idle-kill", async ({ sessionId }) => {
      const info = this.launcher.getSession(sessionId);
      if (!info || info.archived) return;
      // Subprocess council review #4 (P1#4 — S8): observer-role sessions
      // sleep between checkpoints by design; their `lastCliActivityTs`
      // doesn't advance during normal operation. Idle-killing them would
      // brick the council pair without the user's input. The pair's
      // lifetime is bounded by the orchestrator-half's lifetime, which
      // has its own idle-kill timer.
      if (info.sessionGroupRole === "observer") {
        log.info("orchestrator", "skipping idle-kill for observer session", { sessionId });
        return;
      }
      log.info("orchestrator", "Idle-killing session (preserving container)", { sessionId, reason: "no browsers, no activity" });
      this.intentionalKills.add(sessionId);
      // Cancel the CLI disconnect debounce timer so it doesn't fire
      // session:relaunch-needed after we intentionally kill the process.
      this.wsBridge.cancelDisconnectTimer(sessionId);
      await this.launcher.kill(sessionId);
      // Clear relaunch counters so the session gets a fresh budget when the user
      // returns. Idle-kill is intentional cleanup, not a crash — the session
      // should be fully relaunchable.
      this.clearAutoRelaunchCount(sessionId);
    });

    // Auto-generate session title after first turn completes
    companionBus.on("session:first-turn-completed", async ({ sessionId, firstUserMessage }) => {
      await this.handleAutoNaming(sessionId, firstUserMessage);
    });

    // Council Mode group listener bag — extracted into wireGroupListeners
    // (Fowler council review #15) so the council surface is visibly
    // separated from the solo-session lifecycle wiring above.
    this.wireGroupListeners();

    // Council Mode group reconciliation. Pairs created in a previous server
    // uptime are restored from launcher state (which itself hydrates from
    // session-store on startup). Without this, --resume brings back the
    // CLI processes but `councilGroupMeta` is empty and `startCouncilWatchers`
    // never fires for resumed pairs — the group becomes a zombie with no
    // checkpoint→review pipeline. Must run AFTER wireGroupListeners so the
    // bus is ready to fan future events for the reconciled groups.
    this.reconcileCouncilGroups();

    // Council Review 2026-05-13 Persistence #6 (convention EC-12):
    // `fs.watch` is event-only post-attach; it does NOT replay existing
    // files. A server crash between checkpoint-file-write and wake-send
    // produces a permanent gap unless we scan-on-init for missed
    // checkpoints. Runs AFTER reconcileCouncilGroups so watchers + meta
    // are armed for any wake we dispatch here.
    this.scanForMissedObserverWakes();

    // Reconnection watchdog for stale sessions after server restart
    this.startReconnectionWatchdog();
  }

  /**
   * Council Mode restart-recovery scan (EC-12 — fs.watch is event-only,
   * needs pre-scan reconcile).
   *
   * For each reconciled council group, enumerate `.council/checkpoints/*.json`,
   * find the highest-sequence valid checkpoint, compare against the
   * persisted wake sentinel. If the highest on-disk checkpoint is newer
   * than the last-woken one (or no sentinel exists), fire one wake.
   *
   * Idempotent: the dispatcher's Gate 0 sentinel check (already in place)
   * absorbs double-invocations. Failures are logged + non-fatal — a
   * bad checkpoint file should not crash initialize().
   */
  private scanForMissedObserverWakes(): void {
    // Council Review 2026-05-13-0150 Backend × Hunt #11: bounded
    // iteration. Without a cap, a hostile or runaway workspace with
    // thousands of .json files in `.council/checkpoints/` blocks
    // initialize() proportionally. 200 is generous — typical workflow
    // produces a few dozen checkpoints across a project's lifetime; an
    // overflow surfaces as a structured WARN log so operators can act.
    const SCAN_MAX_FILES_PER_GROUP = 200;
    for (const [groupId, entry] of this.councilWatchers) {
      try {
        const checkpointsDir = join(entry.cwd, ".council", "checkpoints");
        let files: string[];
        try {
          files = readdirSync(checkpointsDir).filter(
            (f) => f.endsWith(".json") && !f.startsWith("."),
          );
        } catch {
          // Directory missing is normal — the watcher's mkdirSync will
          // create it on group registration; first run has no files.
          continue;
        }
        if (files.length > SCAN_MAX_FILES_PER_GROUP) {
          log.warn("session-orchestrator", "catchup scan capped by SCAN_MAX_FILES_PER_GROUP", {
            event: "council.wake.restart_catchup_truncated",
            sessionGroupId: groupId,
            totalFiles: files.length,
            cap: SCAN_MAX_FILES_PER_GROUP,
          });
          // Sort by name so the highest-sequence checkpoint (orchestrator
          // emits with sequence-prefixed phase names typically) tends to
          // sort last; take the tail of the list. Not perfect — a
          // workspace with adversarial filenames could mask the real
          // highest — but the seq check inside the loop is the actual
          // monotonicity guard, not the iteration order.
          files = files.sort().slice(-SCAN_MAX_FILES_PER_GROUP);
        }
        let highest: CheckpointPayload | null = null;
        for (const file of files) {
          let raw: string;
          try {
            raw = readFileSync(join(checkpointsDir, file), "utf-8");
          } catch {
            continue;
          }
          const payload = parseCheckpointPayload(raw);
          if (!payload) continue;
          if (payload.session_group_id !== groupId) continue;
          if (!highest || payload.sequence > highest.sequence) {
            highest = payload;
          }
        }
        if (!highest) continue;

        const sentinel = readCouncilWakeSentinel(entry.cwd, groupId);
        // Skip when the highest on-disk checkpoint has already been
        // woken for. The dispatcher's Gate 0 would also skip, but
        // surfacing it here keeps the structured log self-contained.
        if (sentinel && sentinel.last_woken_sequence >= highest.sequence) {
          continue;
        }
        log.info("session-orchestrator", "catchup wake fired for missed checkpoint", {
          event: "council.wake.restart_catchup",
          sessionGroupId: groupId,
          checkpointId: highest.checkpoint_id,
          sequence: highest.sequence,
          lastWokenSequence: sentinel?.last_woken_sequence ?? null,
        });
        // Drive through the standard dispatcher so all gates apply
        // (sentinel idempotency, group_status, build validation, etc.).
        // Also seed `lastCheckpoint` so subsequent grounding has the
        // manifest context the regular flow would have populated.
        entry.previousCheckpoint = entry.lastCheckpoint;
        entry.lastCheckpoint = highest;
        this.dispatchObserverWake(groupId, highest);
      } catch (err) {
        log.warn("session-orchestrator", "catchup scan failed for group", {
          event: "council.wake.restart_catchup_failed",
          sessionGroupId: groupId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
    for (const s of this.launcher.listSessions()) {
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
      if (this.councilGroupMeta.has(groupId)) continue;
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

      // For partial pairs, synthesize a placeholder sessionId/backendType
      // for the missing half. The group record needs both fields to satisfy
      // GroupMember; the missing half is the snapshotted dead session for
      // the reconnect window. If/when the missing half handshakes,
      // `session:cli-id-received` arrives with the real sessionId.
      const orchestrator = pair.orchestrator;
      const observer = pair.observer;
      const primarySessionId = orchestrator?.sessionId ?? `__missing_orch_${groupId}`;
      const observerSessionId = observer?.sessionId ?? `__missing_obs_${groupId}`;
      const primaryBackend = orchestrator?.backendType ?? "claude";
      const observerBackend = observer?.backendType ?? "claude";
      const pairing = `${primaryBackend}+${observerBackend}`;
      this.councilGroupMeta.set(groupId, {
        primarySessionId,
        observerSessionId,
        pairing,
        observerPromptSha256: observer?.observerPromptSha256,
        createdAt: (orchestrator ?? observer)?.createdAt ?? Date.now(),
        lastCheckpointReceivedAt: null,
      });
      this.councilGroupBySessionId.set(primarySessionId, groupId);
      this.councilGroupBySessionId.set(observerSessionId, groupId);
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
        // P1 #1 (PLAN-aura-consolidated-refactor.md Task 3): apply
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
  private wireGroupListeners(): void {
    // Fan group lifecycle events out to both halves' browsers. Wire-shape
    // matches the BrowserIncomingMessage variants declared in
    // session-types.ts.
    companionBus.on("group:created", ({ sessionGroupId, primarySessionId, observerSessionId }) => {
      const primary = this.launcher.getSession(primarySessionId);
      const observer = this.launcher.getSession(observerSessionId);
      const pairing = `${primary?.backendType ?? "claude"}+${observer?.backendType ?? "claude"}`;
      this.wsBridge.broadcastToGroup([primarySessionId, observerSessionId], {
        type: "group_created",
        sessionGroupId,
        primarySessionId,
        observerSessionId,
        pairing,
        // Task 9: publish the wake-to-review timeout so the frontend
        // panel-state deriver bounds the `reviewing` interval. Mirrors
        // {@link OBSERVER_WAKE_TIMEOUT_MS} from this module — kept
        // as a single constant the server owns; the frontend never
        // hardcodes its own copy.
        wakeTimeoutMs: OBSERVER_WAKE_TIMEOUT_MS,
      });
    });
    companionBus.on("group:exited", ({ sessionGroupId, reason }) => {
      this.wsBridge.broadcastToGroup(this.getGroupMemberIds(sessionGroupId), {
        type: "group_exited",
        sessionGroupId,
        reason,
      });
    });
    companionBus.on("group:degraded", ({ sessionGroupId, deadRole }) => {
      this.wsBridge.broadcastToGroup(this.getGroupMemberIds(sessionGroupId), {
        type: "group_degraded",
        sessionGroupId,
        deadRole,
      });
      // Council Mode auto-wake (Task 5): drop any queued checkpoint
      // when the group falls into `degraded`. The observer half is
      // conceptually gone for this server lifetime; the user must
      // explicitly relaunch. Holding the slot would either pin memory
      // indefinitely or — on user-initiated respawn — feed a stale
      // checkpoint to a fresh observer that has no context for it.
      const entry = this.councilWatchers.get(sessionGroupId);
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
      const entry = this.councilWatchers.get(sessionGroupId);
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
      const entry = this.councilWatchers.get(sessionGroupId);
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
      if (this.intentionalKills.has(sessionId)) return;
      let foundGroupId: string | null = null;
      let foundRole: "orchestrator" | "observer" | null = null;
      for (const [groupId, meta] of this.councilGroupMeta) {
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
      if (this.relaunchExhaustedNotified.has(sessionId)) {
        // Mark both intentional now — relaunch will never succeed for the
        // dead half, so any later cascading exit must not re-enter.
        const meta = this.councilGroupMeta.get(foundGroupId)!;
        this.intentionalKills.add(meta.primarySessionId);
        this.intentionalKills.add(meta.observerSessionId);
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
        const meta = this.councilGroupMeta.get(foundGroupId)!;
        this.intentionalKills.add(meta.primarySessionId);
        this.intentionalKills.add(meta.observerSessionId);
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
   * Public accessor for the long-lived coordinator (PLAN Task 11).
   * Returns null if never initialised (no Council Mode usage this server
   * uptime). Used by `gracefulShutdown` to cancel reconnect timers + drive
   * `shutdownAllGroups`. Read-only — mutations should still go through
   * the appropriate methods on the coordinator itself.
   */
  getCouncilCoordinator(): SessionGroupCoordinator | null {
    return this.coordinator;
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
   * object (PLAN-aura-consolidated-refactor.md Task 2; replaces the prior
   * `this.pendingCouncilCall` instance scalar that was racy across tabs).
   */
  private getOrCreateCoordinatorSync(): SessionGroupCoordinator {
    if (this.coordinator) return this.coordinator;
    log.info("session-orchestrator", "council coordinator initialised", {
      event: "config.grace_ms.resolved",
      resolvedMs: GROUP_RECONNECT_GRACE_MS,
    });
    this.coordinator = new SessionGroupCoordinator({
      graceMs: GROUP_RECONNECT_GRACE_MS,
      spawn: async (opts) => {
        // Per-call context typed at the consumer end — the orchestrator
        // owns both the producer (createCouncilGroup) and this consumer,
        // so the cast is structurally safe.
        const ctx = opts.spawnContext as CouncilSpawnContext | undefined;
        if (!ctx) throw new Error("internal: coordinator spawn invoked without spawnContext");
        const result = await this.doCreateSession({
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
        await this.killSession(sessionId);
      },
    });
    return this.coordinator;
  }

  /**
   * Pure helper (Fowler council review #15 — F2 echo): live session ids
   * for a given group, sourced from the launcher's session map. Returns
   * an empty array when both halves are gone — `broadcastToGroup` is a
   * no-op on missing ids by design.
   */
  private getGroupMemberIds(sessionGroupId: string): string[] {
    const ids: string[] = [];
    for (const s of this.launcher.listSessions()) {
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
  private startCouncilWatchers(sessionGroupId: string, workspaceCwd: string): void {
    if (this.councilWatchers.has(sessionGroupId)) return;
    const abort = new AbortController();
    const entry: CouncilWatcherEntry = {
      cwd: workspaceCwd,
      abort,
      lastCheckpoint: null,
      previousCheckpoint: null,
      pendingCheckpoint: null,
      supersededCheckpointIds: [],
    };
    this.councilWatchers.set(sessionGroupId, entry);

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
      this.councilWatchers.delete(sessionGroupId);
      abort.abort();
      return;
    }

    watchCheckpoints({
      directory: checkpointsDir,
      signal: abort.signal,
      onCheckpoint: (payload) => this.handleCouncilCheckpoint(sessionGroupId, payload),
    }).catch((err) => {
      if (abort.signal.aborted) return;
      log.warn("session-orchestrator", "council checkpoint watcher failed", {
        sessionGroupId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    watchReviews({
      directory: reviewsDir,
      signal: abort.signal,
      onReview: (payload) => this.handleCouncilReview(sessionGroupId, payload),
    }).catch((err) => {
      if (abort.signal.aborted) return;
      log.warn("session-orchestrator", "council review watcher failed", {
        sessionGroupId,
        error: err instanceof Error ? err.message : String(err),
      });
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
  private tearDownCouncilGroupTracking(sessionGroupId: string): void {
    const meta = this.councilGroupMeta.get(sessionGroupId);
    if (meta) {
      this.councilGroupBySessionId.delete(meta.primarySessionId);
      this.councilGroupBySessionId.delete(meta.observerSessionId);
    }
    this.councilGroupMeta.delete(sessionGroupId);
  }

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

  private stopCouncilWatchers(sessionGroupId: string): void {
    const entry = this.councilWatchers.get(sessionGroupId);
    if (!entry) return;
    entry.abort.abort();
    this.councilWatchers.delete(sessionGroupId);
  }

  private handleCouncilCheckpoint(sessionGroupId: string, payload: CheckpointPayload): void {
    const entry = this.councilWatchers.get(sessionGroupId);
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
    const meta = this.councilGroupMeta.get(sessionGroupId);
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
   * do NOT synthesise a fake `session:exited` or mark the half
   * degraded directly. The natural socket-close handler in `ws-bridge.ts`
   * will fire `session:exited` and the existing `armReconnect` path
   * takes over the lifecycle.
   */
  private dispatchObserverWake(
    sessionGroupId: string,
    payload: CheckpointPayload,
  ): WakeDispatchOutcome {
    const entry = this.councilWatchers.get(sessionGroupId);
    const meta = this.councilGroupMeta.get(sessionGroupId);
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
    const sentinel = readCouncilWakeSentinel(entry.cwd, sessionGroupId);
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
    const coordinator = this.coordinator;
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
    const bridgeOutcome: BridgeObserverWakeOutcome = this.wsBridge.sendObserverWakeFrame(
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
  private drainPendingObserverWake(sessionGroupId: string): void {
    const entry = this.councilWatchers.get(sessionGroupId);
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

  private handleCouncilReview(sessionGroupId: string, payload: ObserverReviewPayload): void {
    // Backend P1-3 (council review #L): wrap the whole handler body in a
    // try/catch so a transient throw in the grounding pipeline doesn't
    // unhook the watcher's read loop. Errors are logged structurally and
    // the review is dropped; the dedup key in review-watcher will prevent
    // a re-emission storm on the same file.
    try {
      const entry = this.councilWatchers.get(sessionGroupId);
      if (!entry) return;

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

      const result = validateObserverFindings(payload, { workspaceRoot: entry.cwd, modifiedFiles });

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
        const out: BrowserObserverFinding = {
          id,
          severity: f.severity,
          claim: f.claim,
          evidence_path: f.evidence_path,
          ...(f.evidence_lines !== undefined ? { evidence_lines: f.evidence_lines } : {}),
          ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
          ...(downgrade ? { wasDowngraded: true, downgradeReason: downgrade.reason } : {}),
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

      // Willison P1-4 item 3 (council review #2): emit the structured
      // invocation log entry so the forensic re-run guarantee
      // (`observerPromptSha256` captured per invocation) survives review
      // completion. EC-9 group-lifecycle structured log requirement also
      // honoured.
      const meta = this.councilGroupMeta.get(sessionGroupId);
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
          }),
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

  // ── Session Creation ───────────────────────────────────────────────────────

  async createSession(body: CreateSessionRequest): Promise<CreateSessionResult> {
    return this.doCreateSession(body);
  }

  async createSessionStreaming(
    body: CreateSessionRequest,
    onProgress: ProgressCallback,
  ): Promise<CreateSessionResult> {
    return this.doCreateSession(body, onProgress);
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

    try {
      const group = await coordinator.createGroup({
        cwd: req.base.cwd ?? process.cwd(),
        primary: parsed.primary,
        observer: parsed.observer,
        model: req.base.model,
        permissionMode: req.base.permissionMode,
        spawnContext,
      });
      const primaryInfo = this.launcher.getSession(group.primary.sessionId);
      const observerInfo = this.launcher.getSession(group.observer.sessionId);
      if (!primaryInfo || !observerInfo) {
        return { ok: false, error: "session metadata lost after spawn", status: 500 };
      }
      // Capture group metadata for handleCouncilReview's invocation log
      // and for the bus listeners that broadcast group_* events. The
      // coordinator owns lifecycle truth; this is the orchestrator's
      // read-side cache so listeners running outside the spawn context
      // can correlate without rescanning launcher state.
      const pairingLabel = `${primaryInfo.backendType ?? "claude"}+${observerInfo.backendType ?? "claude"}`;
      this.councilGroupMeta.set(group.sessionGroupId, {
        primarySessionId: group.primary.sessionId,
        observerSessionId: group.observer.sessionId,
        pairing: pairingLabel,
        observerPromptSha256: observerInfo.observerPromptSha256,
        createdAt: Date.now(),
        lastCheckpointReceivedAt: null,
      });
      this.councilGroupBySessionId.set(group.primary.sessionId, group.sessionGroupId);
      this.councilGroupBySessionId.set(group.observer.sessionId, group.sessionGroupId);
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

  private async doCreateSession(
    body: CreateSessionRequest,
    onProgress?: ProgressCallback,
  ): Promise<CreateSessionResult> {
    try {
      const resumeSessionAt =
        typeof body.resumeSessionAt === "string" && body.resumeSessionAt.trim()
          ? body.resumeSessionAt.trim()
          : undefined;
      const forkSession = body.forkSession === true;
      const backend = (body.backend ?? "claude") as BackendType;
      if (backend !== "claude" && backend !== "codex") {
        return { ok: false, error: `Invalid backend: ${String(body.backend)}`, status: 400 };
      }

      // --- Step: Resolve environment ---
      if (onProgress) await onProgress("resolving_env", "Resolving environment...", "in_progress");

      let envVars: Record<string, string> | undefined = body.env;
      const companionEnv = body.envSlug ? envManager.getEnv(body.envSlug) : null;
      if (body.envSlug && companionEnv) {
        console.log(
          `[orchestrator] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
          Object.keys(companionEnv.variables).join(", "),
        );
        envVars = { ...companionEnv.variables, ...body.env };
      } else if (body.envSlug) {
        console.warn(`[orchestrator] Environment "${body.envSlug}" not found, ignoring`);
      }

      // Inject provider tokens from global settings (if not already set by env profile).
      // Note: these tokens also flow into containerized sessions intentionally — the
      // global onboarding tokens serve as defaults for all session types, including
      // containers, so that container auth preflight checks pass automatically.
      const globalSettings = getSettings();
      if (backend === "claude" && globalSettings.claudeCodeOAuthToken && !("CLAUDE_CODE_OAUTH_TOKEN" in (envVars ?? {}))) {
        envVars = { ...envVars, CLAUDE_CODE_OAUTH_TOKEN: globalSettings.claudeCodeOAuthToken };
      }
      if (backend === "codex" && globalSettings.openaiApiKey && !("OPENAI_API_KEY" in (envVars ?? {}))) {
        envVars = { ...envVars, OPENAI_API_KEY: globalSettings.openaiApiKey };
      }

      // Resolve sandbox configuration
      const sandboxEnabled = body.sandboxEnabled === true;
      const companionSandbox = body.sandboxSlug ? sandboxManager.getSandbox(body.sandboxSlug) : null;
      if (sandboxEnabled && body.sandboxSlug && !companionSandbox) {
        return { ok: false, error: `Sandbox "${body.sandboxSlug}" not found`, status: 404 };
      }

      // Inject LINEAR_API_KEY if a Linear connection is specified
      let linearSystemPrompt: string | undefined;
      if (body.linearConnectionId) {
        const conn = getConnection(body.linearConnectionId);
        if (conn?.apiKey) {
          envVars = { ...envVars, LINEAR_API_KEY: conn.apiKey };
          linearSystemPrompt = buildLinearSystemPrompt(conn, body.linearIssue as { identifier: string; title: string; stateName: string; teamName: string; url: string } | undefined);
        }
      }

      // Resolve Docker image early
      let effectiveImage: string | null = null;
      if (sandboxEnabled) {
        effectiveImage = "the-companion:latest";
      } else if (body.container?.image) {
        effectiveImage = body.container.image;
      }
      const isDockerSession = !!effectiveImage;

      if (onProgress) await onProgress("resolving_env", "Environment resolved", "done");

      let cwd = body.cwd;
      let worktreeInfo: { isWorktree: boolean; repoRoot: string; branch: string; actualBranch: string; worktreePath: string } | undefined;

      // Validate branch name to prevent command injection
      if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch)) {
        return { ok: false, error: "Invalid branch name", status: 400 };
      }

      // --- Step: Git operations (host only) ---
      if (!isDockerSession && body.useWorktree && body.branch && cwd) {
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          if (onProgress) await onProgress("fetching_git", "Fetching from remote...", "in_progress");
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            console.warn(`[orchestrator] git fetch failed (non-fatal): ${fetchResult.output}`);
          }
          if (onProgress) await onProgress("fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

          if (onProgress) await onProgress("creating_worktree", "Creating worktree...", "in_progress");
          const result = gitUtils.ensureWorktree(repoInfo.repoRoot, body.branch, {
            baseBranch: repoInfo.defaultBranch,
            createBranch: body.createBranch,
            forceNew: true,
          });
          cwd = result.worktreePath;
          worktreeInfo = {
            isWorktree: true,
            repoRoot: repoInfo.repoRoot,
            branch: body.branch,
            actualBranch: result.actualBranch,
            worktreePath: result.worktreePath,
          };
        }
        if (onProgress) await onProgress("creating_worktree", "Worktree ready", "done");
      } else if (!isDockerSession && body.branch && cwd) {
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          if (onProgress) await onProgress("fetching_git", "Fetching from remote...", "in_progress");
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            console.warn(`[orchestrator] git fetch failed (non-fatal): ${fetchResult.output}`);
          }
          if (onProgress) await onProgress("fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

          if (repoInfo.currentBranch !== body.branch) {
            if (onProgress) await onProgress("checkout_branch", `Checking out ${body.branch}...`, "in_progress");
            gitUtils.checkoutOrCreateBranch(repoInfo.repoRoot, body.branch, {
              createBranch: body.createBranch,
              defaultBranch: repoInfo.defaultBranch,
            });
            if (onProgress) await onProgress("checkout_branch", `On branch ${body.branch}`, "done");
          }

          if (onProgress) await onProgress("pulling_git", "Pulling latest changes...", "in_progress");
          const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
          if (!pullResult.success) {
            console.warn(`[orchestrator] git pull warning (non-fatal): ${pullResult.output}`);
          }
          if (onProgress) await onProgress("pulling_git", "Up to date", "done");
        }
      }

      let containerInfo: ContainerInfo | undefined;
      let containerId: string | undefined;
      let containerName: string | undefined;
      let containerImage: string | undefined;

      // Container auth pre-flight check
      if (effectiveImage && backend === "claude" && !hasContainerClaudeAuth(envVars)) {
        return {
          ok: false,
          error: "Containerized Claude requires auth available inside the container. " +
            "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_AUTH_TOKEN) in the selected environment.",
          status: 400,
        };
      }
      if (effectiveImage && backend === "codex" && !hasContainerCodexAuth(envVars)) {
        return {
          ok: false,
          error: "Containerized Codex requires auth available inside the container. " +
            "Set OPENAI_API_KEY in the selected environment, or ensure ~/.codex/auth.json exists on the host.",
          status: 400,
        };
      }

      // --- Step: Container setup ---
      if (effectiveImage) {
        if (!imagePullManager.isReady(effectiveImage)) {
          const pullState = imagePullManager.getState(effectiveImage);
          if (pullState.status === "idle" || pullState.status === "error") {
            imagePullManager.ensureImage(effectiveImage);
          }

          if (onProgress) {
            await onProgress("pulling_image", "Pulling Docker image...", "in_progress");
            const unsub = imagePullManager.onProgress(effectiveImage, (line: string) => {
              onProgress("pulling_image", "Pulling Docker image...", "in_progress", line).catch(() => {});
            });
            const ready = await imagePullManager.waitForReady(effectiveImage, 300_000);
            unsub();
            if (ready) {
              await onProgress("pulling_image", "Image ready", "done");
            } else {
              const state = imagePullManager.getState(effectiveImage);
              return {
                ok: false,
                error: state.error || `Docker image ${effectiveImage} could not be pulled or built.`,
                status: 503,
              };
            }
          } else {
            const ready = await imagePullManager.waitForReady(effectiveImage, 300_000);
            if (!ready) {
              const state = imagePullManager.getState(effectiveImage);
              return {
                ok: false,
                error: state.error || `Docker image ${effectiveImage} could not be pulled or built.`,
                status: 503,
              };
            }
          }
        }

        // Create container
        if (onProgress) await onProgress("creating_container", "Starting container...", "in_progress");
        const tempId = crypto.randomUUID().slice(0, 8);
        const requestedPorts = Array.isArray(body.container?.ports)
          ? body.container!.ports!.map(Number).filter((n: number) => n > 0)
          : [];
        const containerPorts: (number | { port: number; hostIp?: string })[] = [
          ...Array.from(new Set([
            ...requestedPorts.filter((p: number) => p !== NOVNC_CONTAINER_PORT),
            VSCODE_EDITOR_CONTAINER_PORT,
            ...(backend === "codex" ? [CODEX_APP_SERVER_CONTAINER_PORT] : []),
          ])),
          { port: NOVNC_CONTAINER_PORT, hostIp: "127.0.0.1" },
        ];
        const cConfig: ContainerConfig = {
          image: effectiveImage,
          ports: containerPorts,
          volumes: body.container?.volumes,
          env: { ...(envVars ?? {}), DISPLAY: ":99" },
          privileged: sandboxEnabled && effectiveImage === "the-companion:latest",
        };
        try {
          containerInfo = containerManager.createContainer(tempId, cwd!, cConfig);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            error: `Docker is required to run this environment image (${effectiveImage}) but container startup failed: ${reason}`,
            status: 503,
          };
        }
        containerId = containerInfo.containerId;
        containerName = containerInfo.name;
        containerImage = effectiveImage;
        if (onProgress) await onProgress("creating_container", "Container running", "done");

        // Copy workspace
        if (onProgress) await onProgress("copying_workspace", "Copying workspace files...", "in_progress");
        try {
          await containerManager.copyWorkspaceToContainer(containerInfo.containerId, cwd!);
          containerManager.reseedGitAuth(containerInfo.containerId);
          if (onProgress) await onProgress("copying_workspace", "Workspace copied", "done");
        } catch (err) {
          containerManager.removeContainer(tempId);
          const reason = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `Failed to copy workspace to container: ${reason}`, status: 503 };
        }

        // Git operations inside container
        if (body.branch) {
          const repoInfo = cwd ? gitUtils.getRepoInfo(cwd) : null;
          if (onProgress) await onProgress("fetching_git", "Fetching from remote (in container)...", "in_progress");
          const gitResult = containerManager.gitOpsInContainer(containerInfo.containerId, {
            branch: body.branch,
            currentBranch: repoInfo?.currentBranch || "HEAD",
            createBranch: body.createBranch,
            defaultBranch: repoInfo?.defaultBranch,
          });
          if (onProgress) await onProgress("fetching_git", gitResult.fetchOk ? "Fetch complete" : "Fetch skipped", "done");
          if (onProgress && repoInfo?.currentBranch !== body.branch) {
            await onProgress("checkout_branch",
              gitResult.checkoutOk ? `On branch ${body.branch}` : "Checkout failed",
              gitResult.checkoutOk ? "done" : "error",
            );
          }
          if (onProgress) await onProgress("pulling_git", gitResult.pullOk ? "Up to date" : "Pull skipped", "done");
          if (gitResult.errors.length > 0) {
            console.warn(`[orchestrator] In-container git ops warnings: ${gitResult.errors.join("; ")}`);
          }
          if (!gitResult.checkoutOk) {
            containerManager.removeContainer(tempId);
            return {
              ok: false,
              error: `Failed to checkout branch "${body.branch}" inside container: ${gitResult.errors.join("; ")}`,
              status: 400,
            };
          }
        }

        // Init script
        const initScript = companionSandbox?.initScript?.trim();
        if (initScript) {
          if (onProgress) await onProgress("running_init_script", "Running init script...", "in_progress");
          try {
            console.log(`[orchestrator] Running init script for sandbox "${companionSandbox?.name || "sandbox"}" in container ${containerInfo.name}...`);
            const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
            const result = await containerManager.execInContainerAsync(
              containerInfo.containerId,
              ["sh", "-lc", initScript],
              {
                timeout: initTimeout,
                onOutput: onProgress
                  ? (line: string) => { onProgress("running_init_script", "Running init script...", "in_progress", line).catch(() => {}); }
                  : undefined,
              },
            );
            if (result.exitCode !== 0) {
              console.error(`[orchestrator] Init script failed (exit ${result.exitCode}):\n${result.output}`);
              containerManager.removeContainer(tempId);
              const truncated = result.output.length > 2000
                ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
                : result.output;
              return { ok: false, error: `Init script failed (exit ${result.exitCode}):\n${truncated}`, status: 503 };
            }
            if (onProgress) await onProgress("running_init_script", "Init script complete", "done");
            console.log(`[orchestrator] Init script completed successfully for sandbox "${companionSandbox?.name || "sandbox"}"`);
          } catch (e) {
            containerManager.removeContainer(tempId);
            const reason = e instanceof Error ? e.message : String(e);
            return { ok: false, error: `Init script execution failed: ${reason}`, status: 503 };
          }
        }
      }

      // --- Step: Launch CLI ---
      if (onProgress) await onProgress("launching_cli", `Launching ${backend === "codex" ? "Codex" : "Claude Code"}...`, "in_progress");

      let session: SdkSessionInfo;
      try {
        session = this.launcher.launch({
          model: body.model,
          permissionMode: body.permissionMode,
          cwd,
          claudeBinary: body.claudeBinary,
          codexBinary: body.codexBinary,
          codexInternetAccess: backend === "codex",
          codexSandbox: backend === "codex" ? "danger-full-access" : undefined,
          allowedTools: body.allowedTools,
          env: envVars,
          backendType: backend,
          containerId,
          containerName,
          containerImage,
          containerCwd: containerInfo?.containerCwd,
          resumeSessionAt,
          forkSession,
          systemPrompt: backend === "codex" ? linearSystemPrompt : undefined,
          sandboxSlug: sandboxEnabled ? (body.sandboxSlug || undefined) : undefined,
          // Council Mode pass-through — populated only when this call comes
          // from `createCouncilGroup`. The browser cannot supply these on a
          // regular createSession; the coordinator generates them server-side.
          sessionGroupId: body.sessionGroupId,
          sessionGroupRole: body.sessionGroupRole,
        });
      } catch (e) {
        // Clean up container if it was created but launch failed
        if (containerId) containerManager.removeContainer(containerId);
        const reason = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `Failed to launch CLI: ${reason}`, status: 503 };
      }

      // Post-launch wiring
      if (containerInfo) {
        containerManager.retrack(containerInfo.containerId, session.sessionId);
        this.wsBridge.markContainerized(session.sessionId, cwd!);
      }

      if (worktreeInfo) {
        this.worktreeTracker.addMapping({
          sessionId: session.sessionId,
          repoRoot: worktreeInfo.repoRoot,
          branch: worktreeInfo.branch,
          actualBranch: worktreeInfo.actualBranch,
          worktreePath: worktreeInfo.worktreePath,
          createdAt: Date.now(),
        });
      }

      if (linearSystemPrompt && backend === "claude") {
        this.wsBridge.injectSystemPrompt(session.sessionId, linearSystemPrompt);
      }

      const discovered = await discoverCommandsAndSkills(cwd).catch(() => ({ slash_commands: [] as string[], skills: [] as string[] }));
      this.wsBridge.prePopulateCommands(session.sessionId, discovered.slash_commands, discovered.skills);

      if (onProgress) await onProgress("launching_cli", "Session started", "done");

      metricsCollector.recordSessionCreated(backend);
      metricsCollector.recordSessionSpawned(session.sessionId);

      return { ok: true, session };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("orchestrator", "Failed to create session", { error: msg });
      return { ok: false, error: msg, status: 500 };
    }
  }

  // ── Kill ───────────────────────────────────────────────────────────────────

  async killSession(sessionId: string): Promise<{ ok: boolean }> {
    const killed = await this.launcher.kill(sessionId);
    if (killed) {
      containerManager.removeContainer(sessionId);
    }
    return { ok: killed };
  }

  // ── Relaunch ───────────────────────────────────────────────────────────────

  async relaunchSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const info = this.launcher.getSession(sessionId);
    if (info?.archived) {
      return { ok: false, error: "Session is archived and cannot be relaunched" };
    }
    this.clearAutoRelaunchCount(sessionId);
    const session = this.wsBridge.getSession(sessionId);
    if (session?.stateMachine) {
      session.stateMachine.transition("starting", "relaunch_initiated");
    }
    return this.launcher.relaunch(sessionId);
  }

  // ── Archive ────────────────────────────────────────────────────────────────

  async archiveSession(sessionId: string, options?: ArchiveSessionOptions): Promise<ArchiveSessionResult> {
    let linearTransitionResult: ArchiveSessionResult["linearTransition"];
    const linearTransition = options?.linearTransition;

    if (linearTransition && linearTransition !== "none") {
      const linkedIssue = sessionLinearIssues.getLinearIssue(sessionId);
      if (linkedIssue) {
        const resolved = resolveApiKey(linkedIssue.connectionId);
        if (resolved) {
          const { apiKey: linearApiKey, connectionId: resolvedConnId } = resolved;
          const settings = getSettings();
          const conn = resolvedConnId !== "legacy" ? getConnection(resolvedConnId) : null;
          let targetStateId = "";

          if (linearTransition === "backlog" && linkedIssue.teamId) {
            const teams = await fetchLinearTeamStates(linearApiKey);
            const team = teams.find((t) => t.id === linkedIssue.teamId);
            const backlogState = team?.states.find((s) => s.type === "backlog");
            if (backlogState) targetStateId = backlogState.id;
          } else if (linearTransition === "configured") {
            const archiveStateId = conn ? conn.archiveTransitionStateId : settings.linearArchiveTransitionStateId;
            targetStateId = archiveStateId.trim();
          }

          if (targetStateId) {
            try {
              linearTransitionResult = await transitionLinearIssue(linkedIssue.id, targetStateId, linearApiKey, resolvedConnId);
            } catch {
              linearTransitionResult = { ok: false, error: "Transition failed unexpectedly" };
            }
          } else {
            linearTransitionResult = { ok: true, skipped: true };
          }
        }
      }
    }

    this.intentionalKills.add(sessionId);
    this.cancelKeepaliveTimer(sessionId);
    this.wsBridge.cancelDisconnectTimer(sessionId);
    await this.launcher.kill(sessionId);
    containerManager.removeContainer(sessionId);
    this.prPoller.unwatch(sessionId);

    const worktreeResult = this.cleanupWorktree(sessionId, options?.force);
    this.launcher.setArchived(sessionId, true);
    this.sessionStore.setArchived(sessionId, true);

    return { ok: true, worktree: worktreeResult, linearTransition: linearTransitionResult };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async deleteSession(sessionId: string): Promise<DeleteSessionResult> {
    this.intentionalKills.add(sessionId);
    this.cancelKeepaliveTimer(sessionId);
    this.wsBridge.cancelDisconnectTimer(sessionId);
    await this.launcher.kill(sessionId);
    containerManager.removeContainer(sessionId);
    const worktreeResult = this.cleanupWorktree(sessionId, true);
    this.prPoller.unwatch(sessionId);
    sessionLinearIssues.removeLinearIssue(sessionId);
    this.launcher.removeSession(sessionId);
    this.wsBridge.closeSession(sessionId);
    this.autoRelaunchCounts.delete(sessionId);
    this.relaunchExhaustedNotified.delete(sessionId);
    this.relaunchingSet.delete(sessionId);
    this.intentionalKills.delete(sessionId);
    return { ok: true, worktree: worktreeResult };
  }

  // ── Unarchive ──────────────────────────────────────────────────────────────

  unarchiveSession(sessionId: string): { ok: boolean } {
    this.launcher.setArchived(sessionId, false);
    this.sessionStore.setArchived(sessionId, false);
    return { ok: true };
  }

  // ── Auto-relaunch count ────────────────────────────────────────────────────

  clearAutoRelaunchCount(sessionId: string): void {
    this.autoRelaunchCounts.delete(sessionId);
    this.relaunchExhaustedNotified.delete(sessionId);
  }

  // ── Event registration ─────────────────────────────────────────────────────

  /** Register a callback for session exit events. Returns unsubscribe function. */
  onSessionExited(cb: (sessionId: string, exitCode: number | null) => void): () => void {
    this.exitCallbacks.push(cb);
    return () => {
      const idx = this.exitCallbacks.indexOf(cb);
      if (idx !== -1) this.exitCallbacks.splice(idx, 1);
    };
  }

  // ── Query delegation ───────────────────────────────────────────────────────

  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.launcher.getSession(sessionId);
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
    const sessionGroupId = this.councilGroupBySessionId.get(sessionId);
    if (!sessionGroupId) return null;
    const meta = this.councilGroupMeta.get(sessionGroupId);
    if (!meta) return null;
    const role: "orchestrator" | "observer" =
      meta.primarySessionId === sessionId ? "orchestrator" : "observer";
    return { sessionGroupId, role };
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  shutdown(): void {
    // Timers are owned by the process lifecycle
  }

  // ── Private: Auto-relaunch ─────────────────────────────────────────────────

  private async handleAutoRelaunch(sessionId: string): Promise<void> {
    if (this.relaunchingSet.has(sessionId)) return;
    const info = this.launcher.getSession(sessionId);
    if (info?.archived) return;

    // If we've already notified the user about relaunch exhaustion, bail out
    // silently. Without this, every reconnect event from a dead session
    // (e.g. deleted container) re-logs the "limit reached" warning endlessly.
    if (this.relaunchExhaustedNotified.has(sessionId)) return;

    this.relaunchingSet.add(sessionId);

    await new Promise((r) => setTimeout(r, RELAUNCH_GRACE_MS));
    if (this.wsBridge.isCliConnected(sessionId)) { this.relaunchingSet.delete(sessionId); return; }
    const freshInfo = this.launcher.getSession(sessionId);
    if (freshInfo && (freshInfo.state === "connected" || freshInfo.state === "running")) {
      this.relaunchingSet.delete(sessionId); return;
    }
    // Only check PID liveness if the session is NOT already "exited".
    // After idle-kill or explicit kill(), the PID field stays set but the
    // process is dead. If the kernel recycles the PID to a different process,
    // kill(pid, 0) would incorrectly succeed, preventing any relaunch.
    // For containerized sessions, use container liveness instead of PID check
    // (the PID is the `docker exec` wrapper, which exits immediately for some
    // transports and is unreliable for container health).
    if (freshInfo && freshInfo.state !== "exited") {
      if (freshInfo.containerId) {
        const containerState = containerManager.isContainerAlive(freshInfo.containerId);
        if (containerState === "running") {
          this.relaunchingSet.delete(sessionId);
          return;
        }
      } else if (freshInfo.pid) {
        try { process.kill(freshInfo.pid, 0); this.relaunchingSet.delete(sessionId); return; } catch {}
      }
    }

    const count = this.autoRelaunchCounts.get(sessionId) ?? 0;
    if (count >= MAX_AUTO_RELAUNCHES) {
      metricsCollector.recordRelaunchExhausted();
      log.warn("orchestrator", "Auto-relaunch limit reached", { sessionId, maxAttempts: MAX_AUTO_RELAUNCHES });
      this.wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message: "Session keeps crashing. Please relaunch manually.",
      });
      this.relaunchExhaustedNotified.add(sessionId);
      // PLAN Task 5: signal council reconnect listeners that this session's
      // budget is spent — they can short-circuit `reconnecting → degraded`
      // without waiting for the 45s timer.
      companionBus.emit("session:relaunch-failed", { sessionId, reason: "budget_exhausted" });
      this.relaunchingSet.delete(sessionId);
      return;
    }

    if (freshInfo && freshInfo.state !== "starting") {
      this.autoRelaunchCounts.set(sessionId, count + 1);
      metricsCollector.recordRelaunchAttempted();
      log.info("orchestrator", "Auto-relaunching CLI", { sessionId, attempt: count + 1, maxAttempts: MAX_AUTO_RELAUNCHES });
      const session = this.wsBridge.getSession(sessionId);
      if (session?.stateMachine) {
        session.stateMachine.transition("starting", "relaunch_initiated");
      }
      try {
        const result = await this.launcher.relaunch(sessionId);
        if (!result.ok && result.error) {
          this.wsBridge.broadcastToSession(sessionId, { type: "error", message: result.error });
          // PLAN Task 5: deterministic spawn failure — let council reconnect
          // listeners short-circuit immediately. `ok=false` without `error`
          // is the "spawn happened but maybe needs another attempt" branch;
          // we keep that silent so the retry budget isn't burned.
          companionBus.emit("session:relaunch-failed", { sessionId, reason: result.error });
        } else if (result.ok) {
          metricsCollector.recordRelaunchSucceeded();
          this.autoRelaunchCounts.delete(sessionId);
          this.relaunchExhaustedNotified.delete(sessionId);
          // Clear intentionalKills so future crashes can use proactive keepalive.
          // After a successful relaunch, the session is alive again — any prior
          // idle-kill intent no longer applies.
          this.intentionalKills.delete(sessionId);
        }
        // ok=false without error: keep count to preserve the retry budget
      } finally {
        setTimeout(() => this.relaunchingSet.delete(sessionId), RELAUNCH_COOLDOWN_MS);
      }
    } else {
      this.relaunchingSet.delete(sessionId);
    }
  }

  // ── Private: Proactive keepalive ────────────────────────────────────────────

  /**
   * Schedules a proactive relaunch of a crashed CLI process, regardless of
   * whether any browsers are connected. Uses exponential backoff (3s, 6s, 12s)
   * based on the auto-relaunch attempt count.
   *
   * Skips relaunch for:
   * - Intentional kills (idle-kill, manual delete/archive)
   * - Archived sessions
   * - Sessions that have exhausted their relaunch budget
   */
  private scheduleProactiveRelaunch(sessionId: string): void {
    // Skip if this was an intentional kill. Use has() instead of delete() so
    // the guard is preserved for handleAutoRelaunch (debounce path fires later).
    if (this.intentionalKills.has(sessionId)) return;

    const info = this.launcher.getSession(sessionId);
    if (!info || info.archived) return;

    // Skip if already at relaunch limit
    if (this.relaunchExhaustedNotified.has(sessionId)) return;

    // Skip if a relaunch is already in progress (e.g. triggered by browser reconnect)
    if (this.relaunchingSet.has(sessionId)) return;

    // Exponential backoff: 3s → 6s → 12s based on attempt count
    const attempt = this.autoRelaunchCounts.get(sessionId) ?? 0;
    const delay = KEEPALIVE_BASE_DELAY_MS * Math.pow(2, attempt);

    log.info("orchestrator", "Scheduling proactive keepalive relaunch", {
      sessionId,
      attempt: attempt + 1,
      maxAttempts: MAX_AUTO_RELAUNCHES,
      delayMs: delay,
    });

    // Cancel any existing keepalive timer for this session
    this.cancelKeepaliveTimer(sessionId);

    const timer = setTimeout(async () => {
      this.keepaliveTimers.delete(sessionId);

      // Re-check conditions — state may have changed during the delay
      const freshInfo = this.launcher.getSession(sessionId);
      if (!freshInfo || freshInfo.archived) return;
      if (freshInfo.state === "connected" || freshInfo.state === "running") return;

      // Delegate to the existing auto-relaunch mechanism which handles
      // budget, PID checks, state transitions, and cooldowns.
      await this.handleAutoRelaunch(sessionId);
    }, delay);

    this.keepaliveTimers.set(sessionId, timer);
  }

  private cancelKeepaliveTimer(sessionId: string): void {
    const timer = this.keepaliveTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.keepaliveTimers.delete(sessionId);
    }
  }

  // ── Private: Auto-naming ───────────────────────────────────────────────────

  private async handleAutoNaming(sessionId: string, firstUserMessage: string): Promise<void> {
    if (sessionNames.getName(sessionId)) return;
    if (!getSettings().anthropicApiKey.trim()) return;
    const info = this.launcher.getSession(sessionId);
    const model = info?.model || "claude-sonnet-4-6";
    console.log(`[orchestrator] Auto-naming session ${sessionId} via Anthropic with model ${model}...`);
    const title = await generateSessionTitle(firstUserMessage, model);
    if (title && !sessionNames.getName(sessionId)) {
      console.log(`[orchestrator] Auto-named session ${sessionId}: "${title}"`);
      sessionNames.setName(sessionId, title);
      this.wsBridge.broadcastNameUpdate(sessionId, title);
    }
  }

  // ── Private: Reconnection watchdog ─────────────────────────────────────────

  private startReconnectionWatchdog(): void {
    const starting = this.launcher.getStartingSessions();
    if (starting.length > 0) {
      console.log(`[orchestrator] Waiting ${RECONNECT_GRACE_MS / 1000}s for ${starting.length} CLI process(es) to reconnect...`);
      setTimeout(async () => {
        const stale = this.launcher.getStartingSessions();
        for (const info of stale) {
          if (info.archived) continue;
          console.log(`[orchestrator] CLI for session ${info.sessionId} did not reconnect, relaunching...`);
          await this.launcher.relaunch(info.sessionId);
        }
      }, RECONNECT_GRACE_MS);
    }
  }

  // ── Private: Worktree cleanup ──────────────────────────────────────────────

  private cleanupWorktree(
    sessionId: string,
    force?: boolean,
  ): { cleaned?: boolean; dirty?: boolean; path?: string } | undefined {
    const mapping = this.worktreeTracker.getBySession(sessionId);
    if (!mapping) return undefined;

    if (this.worktreeTracker.isWorktreeInUse(mapping.worktreePath, sessionId)) {
      this.worktreeTracker.removeBySession(sessionId);
      return { cleaned: false, path: mapping.worktreePath };
    }

    const dirty = gitUtils.isWorktreeDirty(mapping.worktreePath);
    if (dirty && !force) {
      return { cleaned: false, dirty: true, path: mapping.worktreePath };
    }

    const branchToDelete =
      mapping.actualBranch && mapping.actualBranch !== mapping.branch
        ? mapping.actualBranch
        : undefined;
    const result = gitUtils.removeWorktree(mapping.repoRoot, mapping.worktreePath, {
      force: dirty,
      branchToDelete,
    });
    if (result.removed) {
      this.worktreeTracker.removeBySession(sessionId);
    }
    return { cleaned: result.removed, path: mapping.worktreePath };
  }
}
