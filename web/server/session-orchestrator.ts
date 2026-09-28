import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { AgentExecutor } from "./agent-executor.js";
import type { BackendType, CreationStepId, SessionGroupRole } from "./session-types.js";
import type { ContainerConfig, ContainerInfo } from "./container-manager.js";
import { containerManager } from "./container-manager.js";
import { imagePullManager } from "./image-pull-manager.js";
import { DEFAULT_SANDBOX_IMAGE } from "./sandbox-image.js";
import * as envManager from "./env-manager.js";
import { ConvergenceTracker } from "./convergence-tracker.js";
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
import type { SessionGroupCoordinator } from "./session-group-coordinator.js";
import type { IdleTimerManager } from "./idle-timer-manager.js";
import { CouncilAutoProceedController, type IgnoreRestoreGapResult, type ResolveStopResult } from "./council-auto-proceed-controller.js";
import { SessionRecovery } from "./session-recovery.js";
import type { CheckpointPayload, ObserverReviewPayload } from "./council-types.js";
import { writeAtomicJson } from "./atomic-write.js";
import { findReviewForCheckpointSync } from "./review-watcher.js";
import { CheckpointLineSnapshots } from "./observer-line-snapshots.js";
import { ObserverReplyCapture } from "./observer-reply.js";
import { ObserverReadLedger } from "./observer-read-ledger.js";
import {
  CouncilCheckpointPipeline,
  type CouncilWatcherEntry,
  type WakeDispatchOutcome,
} from "./council-checkpoint-pipeline.js";
export {
  OBSERVER_REPLY_REJECTIONS_BEFORE_DEGRADE,
  deterministicFindingId,
  type WakeDispatchOutcome,
} from "./council-checkpoint-pipeline.js";
import { CouncilObserverScheduler } from "./council-observer-scheduler.js";
import { ObserverAutoheal, observerAutohealBlockedReason } from "./council-observer-autoheal.js";
export {
  OBSERVER_CATCHUP_TIMEOUT_ESCALATION_THRESHOLD,
  OBSERVER_FAILSAFE_FALLBACK_MS,
  OBSERVER_FAILSAFE_MAX_MS,
  OBSERVER_FAILSAFE_MIN_MS,
  parseFailsafeTickMs,
} from "./council-observer-scheduler.js";
import { CouncilLifecycle, type CouncilDegradedReason, type CouncilGroupMeta } from "./council-lifecycle.js";
import type { OrphanTimerRef } from "./sweep-orphans.js";
import type { BrowserGroupRecord } from "./session-types.js";
import { hasNonEmptyEnvVar, hasAnyClaudeAuthEnv } from "./provider-auth-env.js";
import { getServerLayerFlags, type LayerFlags } from "./layer-flags.js";
import { resolveAutoProceedIterationCeiling } from "./auto-proceed-types.js";

// ── Constants ────────────────────────────────────────────────────────────────
/** AP-WIRE: resolve `COMPANION_ORCH_AUTO_PROCEED_MAX_ITERATIONS_CEILING` at
 *  construction; a bad value keeps the hard cap and is warned about. */
function resolveIterationCeilingOnce(): number {
  const { ceiling, warning } = resolveAutoProceedIterationCeiling(process.env);
  if (warning) log.warn("auto-proceed", warning, { event: "auto-proceed.ceiling-invalid" });
  return ceiling;
}

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
  /**
   * Auto-proceed idle-timer manager (PLAN Task 7+9). Optional with a
   * disposable null-object default so tests and existing callers that
   * don't exercise auto-proceed don't need to thread a stub through.
   * Production wires the real {@link IdleTimerManager} in `index.ts`;
   * the orchestrator owns the rehydrate-on-boot + dispose-on-shutdown
   * ladder.
   */
  idleTimerManager?: IdleTimerManager;
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
  /**
   * Auto-proceed (idle-timeout) opt-in. Already-parsed-and-validated by
   * the boundary parser in `routes.ts` (Task 10 — see
   * `auto-proceed-config-validator.ts`). The orchestrator receives the
   * fully-clamped value or `undefined`; never raw user input. Tri-state
   * collapse at the boundary: `false | null | undefined | absent` all
   * arrive here as `undefined`, so a `presence check` on this field is
   * the canonical "is auto-proceed enabled for this session" test.
   */
  autoProceedOnIdle?: { readonly idleMs: number; readonly maxIterations: number };
  /**
   * aura-meta-diet C3 — layer flags, already resolved (server default +
   * per-session override, fail-closed) by the boundary in `routes.ts`.
   * Absent → all layers on (prod behaviour). See `layer-flags.ts`.
   */
  layers?: LayerFlags;
}

export interface RelaunchSessionRequest {
  model?: string;
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
// Watcher entry, wake outcome, finding ids: `council-checkpoint-pipeline.ts`.
// Group meta, spawn context, reconnect grace: `council-lifecycle.ts`.

// ── Orchestrator ─────────────────────────────────────────────────────────────

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
  /**
   * Bidirectional pipeline Story 4.1: convergence tracker folds the
   * `group:review` stream into a per-group clean-cycle counter. Lazy-
   * initialised in {@link initialize} after `wireGroupListeners` so the
   * `group:convergence` listener is armed before the tracker can emit.
   */
  private convergenceTracker: ConvergenceTracker | null = null;

  // Tracks sessions intentionally killed (idle-kill, manual delete/archive)
  // so the proactive keepalive doesn't relaunch them. Shared with
  // {@link SessionRecovery} (AP-1 DI); council lifecycle writes it too.
  private intentionalKills = new Set<string>();
  /**
   * P4/C1d: auto-relaunch, keepalive, silence/model-fallback recovery, the
   * silent-stdio drift detector and the boot reconnection watchdog.
   */
  private recovery: SessionRecovery;
  /** Test seam: the relaunch-exhaustion set lives on the recovery controller. */
  private get relaunchExhaustedNotified(): Set<string> {
    return this.recovery.relaunchExhaustedNotified;
  }
  /** Test seam: silence strike counts live on the recovery controller. */
  private get silenceRecurrenceCounts(): Map<string, { count: number; lastSilentModel: string }> {
    return this.recovery.silenceRecurrenceCounts;
  }

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
   * P4/C1c: auto-proceed (AFK idle-timeout) controller — owns the idle-timer
   * manager handle and its call sites. Built in the constructor (needs DI).
   */
  private autoProceed: CouncilAutoProceedController;
  /**
   * P3/B1: the observer replies with a bare findings array; the host builds
   * the review envelope and writes the file (see `observer-reply.ts`).
   * Deps resolve `this.*` lazily at call time.
   */
  /** B2: per-group checkpoint content snapshots feeding line-level grounding. */
  private checkpointLineSnapshots = new CheckpointLineSnapshots();
  private observerReplyCapture = new ObserverReplyCapture({
    now: () => new Date(),
    writeReview: (path, payload) => writeAtomicJson(path, payload),
    findExistingReview: (directory, checkpointId, sessionGroupId) => {
      const found = findReviewForCheckpointSync({
        directory,
        checkpointId,
        normalizeRaw: (raw, provider) => this.normalizeObserverReviewRaw(sessionGroupId, raw, provider),
      });
      return found && found.payload.session_group_id === sessionGroupId ? found.file : null;
    },
    resolveCliVersion: (sessionId) => this.wsBridge.getSession(sessionId)?.state.claude_code_version || undefined,
  });
  /** P3/CONV-HONEST: host-observed observer reads per dispatched wake. */
  private observerReadLedger = new ObserverReadLedger();
  /** P4/C1a: checkpoint → wake → review pipeline; reads the group maps above. */
  private checkpointPipeline = new CouncilCheckpointPipeline({
    watchers: this.councilWatchers,
    groupMeta: this.councilGroupMeta,
    getCoordinator: () => this.coordinator,
    getWsBridge: () => this.wsBridge,
    isApiLimitReached: (sessionId) => this.autoProceed.isApiLimitReached(sessionId),
    replyCapture: this.observerReplyCapture,
    lineSnapshots: this.checkpointLineSnapshots,
    readLedger: this.observerReadLedger,
    onObserverAdapterMissing: (gid, payload) => this.observerScheduler.requestCatchupWake(gid, payload),
  });
  /** P4/OBS-AUTOHEAL: bounded observer-only relaunch when its adapter is gone. */
  private observerAutoheal = new ObserverAutoheal({
    relaunchObserver: (id) => this.relaunchSession(id),
    isObserverReadyForWake: (id) => this.observerReadyForWake(id),
    blockedReason: (gid, id) =>
      observerAutohealBlockedReason(this.coordinator?.get(gid), id,
        (s) => this.recovery.isStoppedByUser(s), (s) => this.intentionalKills.has(s)),
  });
  /**
   * P4/C1b: observer wake scheduling outside the live watcher (missed-
   * checkpoint scan, EC-13 failsafe tick, catch-up and spawn polls).
   */
  private observerScheduler = new CouncilObserverScheduler({
    watchers: this.councilWatchers,
    groupMeta: this.councilGroupMeta,
    getCoordinator: () => this.coordinator,
    lineSnapshots: this.checkpointLineSnapshots,
    isObserverReadyForWake: (observerSessionId) => this.observerReadyForWake(observerSessionId),
    dispatchWake: (sessionGroupId, payload) => {
      this.dispatchObserverWake(sessionGroupId, payload);
    },
    isSessionStoppedByUser: (sessionId) => this.recovery.isStoppedByUser(sessionId),
    autoheal: this.observerAutoheal,
  });
  private councilGroupDegradedReason = new Map<string, CouncilDegradedReason>();
  /**
   * #9: which half died, persisted symmetrically with
   * `councilGroupDegradedReason` so a degraded-on-arrival bootstrap snapshot
   * (`getAllGroupsForBootstrap`) can label the correct dead half. Without it
   * the frontend deriver falls back to `deadRole ?? "observer"` and a
   * reconnect-failed pair whose ORCHESTRATOR died is mislabeled
   * "Observer offline". Sole writer is the `group:degraded` listener; cleared
   * at the same sites as the reason map.
   */
  private councilGroupDeadRole = new Map<string, SessionGroupRole>();

  /**
   * Long-lived coordinator instance — owns the group state machine + the
   * reconnect grace timer map. Lazily constructed on first council
   * operation; persists across calls so listeners (session:exited,
   * session:cli-id-received) hold a stable reference. PLAN Task 1
   * keystone: `coordinator.applyEvent` is now the sole lifecycle mutator.
   */
  private coordinator: SessionGroupCoordinator | null = null;
  /**
   * P4/C1e: council group lifecycle — pair creation, coordinator, boot
   * reconcile, reconnect handshake, `group:*` fanout, `.council/` watchers
   * and the REST bootstrap reads. Reads/writes the maps above (AP-1 DI).
   */
  private councilLifecycle: CouncilLifecycle;

  // Event listeners
  private exitCallbacks: ((sessionId: string, exitCode: number | null) => void)[] = [];

  constructor(deps: SessionOrchestratorDeps) {
    this.launcher = deps.launcher;
    this.wsBridge = deps.wsBridge;
    this.sessionStore = deps.sessionStore;
    this.worktreeTracker = deps.worktreeTracker;
    this.prPoller = deps.prPoller;
    this.agentExecutor = deps.agentExecutor;
    this.autoProceed = new CouncilAutoProceedController({
      manager: deps.idleTimerManager,
      groupMeta: this.councilGroupMeta,
      watchers: this.councilWatchers,
      // C3: per-session flags (persisted on the launcher info) win; legacy
      // sessions without them follow the server default.
      isAutoProceedAllowed: (sessionId) =>
        (this.launcher.getSession(sessionId)?.layers ?? getServerLayerFlags()).autoProceed,
      // AP-WIRE: the opt-in, the group index and the coordinator — the
      // controller is the producer of the auto-proceed group events.
      getAutoProceedConfig: (sessionId) => this.launcher.getSession(sessionId)?.autoProceedOnIdle,
      getGroupIdForSession: (sessionId) => this.councilGroupBySessionId.get(sessionId),
      applyGroupEvent: (sessionGroupId, event) => {
        this.coordinator?.applyEvent(sessionGroupId, event);
      },
      iterationCeiling: resolveIterationCeilingOnce(),
      // FIX-AP-1/FIX-AP-2: restore the unresolved-STOP hold after a restart
      // from the same view the browser bootstraps its blocker banner from,
      // with the verdicts frozen at review time (no re-grounding).
      loadGroupStopHoldView: async (sessionGroupId) => this.councilLifecycle.getGroupStopHoldView(sessionGroupId),
    });
    this.recovery = new SessionRecovery({
      launcher: this.launcher,
      wsBridge: this.wsBridge,
      intentionalKills: this.intentionalKills,
      onRelaunchSucceeded: (sessionId) => this.rearmSpawnCheckpointAfterObserverRelaunch(sessionId),
      noteApiLimitReached: (sessionId) => this.autoProceed.noteApiLimitReached(sessionId),
    });
    this.councilLifecycle = new CouncilLifecycle({
      launcher: this.launcher,
      getWsBridge: () => this.wsBridge,
      watchers: this.councilWatchers,
      groupMeta: this.councilGroupMeta,
      groupBySessionId: this.councilGroupBySessionId,
      degradedReason: this.councilGroupDegradedReason,
      deadRole: this.councilGroupDeadRole,
      intentionalKills: this.intentionalKills,
      getCoordinator: () => this.coordinator,
      setCoordinator: (coordinator) => {
        this.coordinator = coordinator;
      },
      idleTimerEnactor: this.autoProceed.enactor,
      isRelaunchExhausted: (sessionId) => this.recovery.isRelaunchExhausted(sessionId),
      createSession: (body) => this.doCreateSession(body),
      // Coordinator rollback / archive kills are not user stops.
      killSession: (sessionId) => this.killSessionProcess(sessionId),
      handleCouncilCheckpoint: (sessionGroupId, payload) => this.handleCouncilCheckpoint(sessionGroupId, payload),
      handleCouncilReview: (sessionGroupId, payload, reviewedAt) =>
        this.handleCouncilReview(sessionGroupId, payload, reviewedAt),
      normalizeObserverReviewRaw: (sessionGroupId, raw, provider) =>
        this.normalizeObserverReviewRaw(sessionGroupId, raw, provider),
      drainPendingObserverWake: (sessionGroupId) => this.drainPendingObserverWake(sessionGroupId),
      scanForMissedObserverWakes: (trigger) => this.scanForMissedObserverWakes(trigger),
      scheduleSpawnCheckpointWhenObserverReady: (sessionGroupId, observerSessionId, workspaceCwd) =>
        this.scheduleSpawnCheckpointWhenObserverReady(sessionGroupId, observerSessionId, workspaceCwd),
      forgetScheduledGroup: (sessionGroupId) => this.observerScheduler.forgetGroup(sessionGroupId),
      markDisputedStops: (sessionGroupId, cwd, findings, opts) =>
        this.checkpointPipeline.markDisputedStops(sessionGroupId, cwd, findings, opts),
      replyCapture: this.observerReplyCapture,
      lineSnapshots: this.checkpointLineSnapshots,
      readLedger: this.observerReadLedger,
      invisibleHeldStopIds: (sessionGroupId, view) => this.autoProceed.invisibleHeldStopIds(sessionGroupId, view),
      resolvedStopIds: (sessionGroupId) => this.autoProceed.resolvedStopIds(sessionGroupId),
      autoProceedHoldApplies: (sessionGroupId) => this.autoProceed.autoProceedHoldApplies(sessionGroupId),
    });
  }

  /**
   * Accessor for the gracefulShutdown SIGTERM-drain path in `index.ts`.
   * Returns the manager so `shutdownAllGroups` can call `disposeAll()`
   * BEFORE the kill propagation. EC-2 invariant — cancel timers before
   * kills fire to children.
   */
  getIdleTimerManager(): IdleTimerManager {
    return this.autoProceed.getManager();
  }

  /**
   * Late-injection seam for the idle-timer manager. Necessary because
   * the production wiring is mutually circular — the manager's
   * `getSession` / `getGroupStatus` closures reference the orchestrator
   * (for the coordinator + ws-bridge lookups). `index.ts` constructs the
   * orchestrator first with the noop default, then builds the real
   * manager closing over the orchestrator reference, then calls this
   * setter BEFORE `initialize()` runs the boot reconcile.
   */
  setIdleTimerManager(manager: IdleTimerManager): void {
    this.autoProceed.setManager(manager);
  }

  // ── Initialization (event wiring) ──────────────────────────────────────────

  initialize(): void {
    if (this._initialized) return;
    this._initialized = true;

    // When the CLI reports its internal session_id, store it for --resume
    companionBus.on("session:cli-id-received", ({ sessionId, cliSessionId }) => {
      this.launcher.setCLISessionId(sessionId, cliSessionId);
    });

    // P4/C1c: auto-proceed call sites — Task 11.6 cross-tab user-frame gate
    // (bridge → manager.noteUserMessage) and Task 11.8 sticky-token clear on
    // every session exit. See `council-auto-proceed-controller.ts`.
    this.autoProceed.wire({
      // P4/KILL-INTENTIONAL rides the same single subscription: only
      // browser-typed frames reach it (cron/agent/REST/council-peer
      // injections are filtered in the bridge), and such a frame to a
      // user-stopped session brings it back.
      onUserFrameObserved: (cb) =>
        this.wsBridge.onUserFrameObserved((sessionId) => {
          cb(sessionId);
          this.resumeOnUserMessage(sessionId);
        }),
      onSessionExited: (cb) => companionBus.on("session:exited", ({ sessionId }) => cb(sessionId)),
      onOrchestratorTurnDone: (cb) =>
        companionBus.on("orchestrator:turn-done", ({ sessionId, blockedByStop }) => cb(sessionId, blockedByStop)),
      onGroupReview: (cb) =>
        companionBus.on("group:review", ({ sessionGroupId, findings }) => cb(sessionGroupId, findings)),
    });

    // Council Mode auto-wake (Task 4 drain hook): when the observer
    // half's adapter flips turn-state from `in-flight` to `idle`
    // (a `result` NDJSON frame arrived), drain the per-group
    // pendingCheckpoint slot if one is queued.
    //
    // Council Review 2026-05-13 Backend #21: reverse-map via the
    // `councilGroupBySessionId` index instead of iterating
    // `councilGroupMeta` — O(1) lookup.
    // P3/B1: feed observer assistant frames to the reply capture. No-op for
    // every session without an outstanding wake.
    companionBus.on("message:assistant", ({ sessionId, message }) => {
      this.observerReplyCapture.onAssistant(sessionId, message);
      this.observerReadLedger.onAssistant(sessionId, message);
    });
    companionBus.on("observer:turn-done", ({ sessionId }) => {
      try {
        const groupId = this.councilGroupBySessionId.get(sessionId);
        if (!groupId) return;
        // Guard: only the OBSERVER half's turn-done drives the drain.
        // Orchestrator-half result frames (if they ever flip in-flight,
        // currently they don't) must not trigger observer-side drain.
        const meta = this.councilGroupMeta.get(groupId);
        if (!meta || meta.observerSessionId !== sessionId) return;
        // Finalize the finished turn's reply BEFORE the drain dispatches the
        // next wake (which would replace the capture slot).
        // FIX-B1-1: isolated — a finalize failure must not skip the drain.
        try {
          this.finalizeObserverReply(groupId, sessionId);
        } catch (err) {
          log.error("session-orchestrator", "observer reply finalize failed", {
            event: "council.observer_reply.finalize_error",
            sessionGroupId: groupId,
            sessionId,
            role: "observer",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this.drainPendingObserverWake(groupId);
      } catch (err) {
        log.warn("session-orchestrator", "observer turn-done drain failed", {
          event: "council.wake.drain_handler_error",
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    companionBus.on("observer:wake-failed", ({ sessionId, error }) => {
      try {
        const groupId = this.councilGroupBySessionId.get(sessionId);
        if (!groupId) return;
        const meta = this.councilGroupMeta.get(groupId);
        if (!meta || meta.observerSessionId !== sessionId) return;
        this.checkpointPipeline.degradeObserverWakeFailure(groupId, sessionId, error, "async");
      } catch (err) {
        log.warn("session-orchestrator", "observer wake-failed handler crashed", {
          event: "group.observer_wake_failed_handler_error",
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // P4/C1e: council reconnect handshake (PLAN Task 4) and the relaunch-
    // failed short-circuit (PLAN Task 5). See `council-lifecycle.ts`.
    this.councilLifecycle.wireReconnectListeners();

    // When a Codex adapter is created, attach it to the WsBridge
    companionBus.on("backend:codex-adapter-created", ({ sessionId, adapter }) => {
      this.wsBridge.attachBackendAdapter(sessionId, adapter, "codex");
      this.launcher.markConnected(sessionId);
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
      this.recovery.scheduleProactiveRelaunch(sessionId);
    });

    // Silent-stdio watchdog fired — the subprocess is alive but nothing
    // is coming down the pipe. Kill it; the `session:exited` handler
    // above then schedules an auto-relaunch with `--resume`, giving us
    // a fresh stdio pipe and letting the CLI dial back into the same
    // conversation. See event-bus-types.ts contract for full context.
    companionBus.on("session:backend-silent", async ({ sessionId, sinceMs, reason }) => {
      await this.recovery.handleBackendSilent(sessionId, sinceMs, reason);
    });

    // Successful orchestrator turn = the current model+CLI combo works
    // end-to-end. Clear any silence-recurrence bookkeeping for this
    // session so a future single hiccup does not push straight to a
    // model rotation. Paired with `handleBackendSilent` which bumps
    // the counter.
    companionBus.on("orchestrator:turn-done", ({ sessionId }) => {
      this.recovery.noteTurnSucceeded(sessionId);
    });

    // Rate-limit-class error classified — swap the session's model to
    // the next chain entry, then kill so the keepalive path relaunches
    // with the new `--model`. If no downgrade target exists, we surface
    // an informational error and leave the session alone.
    companionBus.on("session:model-fallback", async ({ sessionId, from, to, reason }) => {
      await this.recovery.handleModelFallback(sessionId, from, to, reason);
    });

    // Pre-spawn substitution of a known-broken model — surface a
    // browser toast so the user knows their model choice was overridden.
    // Silent substitution is user-hostile; the toast makes the override
    // visible without gating the spawn. Fires once per spawn (the
    // launcher persists info.model to the substitute, so subsequent
    // respawns don't re-fire).
    companionBus.on("session:model-substituted", ({ sessionId, from, to, reason }) => {
      log.warn("orchestrator", "Model auto-substituted at spawn", {
        sessionId, from, to, reason,
      });
      this.wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message: `Model ${from} auto-substituted to ${to}: ${reason}`,
      });
    });

    // Init-frame health canary tripped — the CLI subprocess opened
    // its stdio transport but never emitted a `system.init` frame
    // inside INIT_FRAME_TIMEOUT_MS. Distinct from `session:backend-silent`
    // (which fires MID-TURN after a user_message). This one fires
    // on spawn+attach without any user activity — the earliest
    // observable signature of a stream-json emit regression in the
    // upstream Claude CLI (see 2026-09-09/10 CLI 2.1.265 incident).
    // Adapter already broadcast a browser toast; we log at WARN so
    // operators watching journalctl see the regression too.
    companionBus.on("session:no-init-frame", ({ sessionId, sinceMs }) => {
      log.warn("orchestrator", "CLI subprocess never emitted its init frame — likely upstream regression", {
        sessionId, sinceMs,
      });
    });

    // Start watching PRs when git info is resolved
    companionBus.on("session:git-info-ready", ({ sessionId, cwd, branch }) => {
      this.prPoller.watch(sessionId, cwd, branch);
    });

    // Auto-relaunch CLI when a browser connects to a session with no CLI
    companionBus.on("session:relaunch-needed", async ({ sessionId }) => {
      await this.recovery.handleAutoRelaunch(sessionId);
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

    // Bidirectional pipeline Story 4.1 — convergence tracker. Attached
    // AFTER wireGroupListeners so the `group:convergence` listener is
    // armed first; any review processed between attach and first emit
    // is fanned to browsers without race.
    this.convergenceTracker = new ConvergenceTracker({
      isFrozen: (sessionGroupId: string) => {
        const status = this.coordinator?.get(sessionGroupId)?.status;
        return status === "degraded" || status === "reconnecting";
      },
    });
    this.convergenceTracker.attach();

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

    // EC-13: arm the recurring failsafe so a checkpoint whose watcher died
    // (or never fired — Docker/NFS) still wakes the observer within one tick,
    // not only at the next server restart.
    this.startObserverFailsafe();
    this.recovery.startDriftDetector();

    // PLAN-aura-orchestrator-idle-auto-proceed Task 9: rehydrate the idle
    // timer manager's per-session iteration counters from on-disk traces.
    // Must run AFTER `reconcileCouncilGroups` (which populates
    // `councilGroupMeta` with orchestrator sessionId + workspace cwd) so
    // each trace maps to a known orchestrator-half. Idempotent — safe to
    // call multiple times; re-rehydrating with the same trace produces
    // the same in-memory state.
    this.autoProceed.rehydrateTraces();

    // Reconnection watchdog for stale sessions after server restart
    this.recovery.startReconnectionWatchdog();
  }

  /**
   * Council Mode — rebuild group meta + rearm `.council/` watchers for pairs
   * restored from launcher state. Delegates to `council-lifecycle.ts`.
   */
  reconcileCouncilGroups(): void {
    this.councilLifecycle.reconcileCouncilGroups();
  }

  // Thin delegates into `council-lifecycle.ts` — init, the existing suite and
  // the sweep/relaunch paths below call these names.
  private wireGroupListeners(): void {
    this.councilLifecycle.wireGroupListeners();
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

  private getOrCreateCoordinatorSync(): SessionGroupCoordinator {
    return this.councilLifecycle.getOrCreateCoordinatorSync();
  }

  private startCouncilWatchers(sessionGroupId: string, workspaceCwd: string): void {
    this.councilLifecycle.startCouncilWatchers(sessionGroupId, workspaceCwd);
  }

  /**
   * Council-wake send-readiness gate. Returns true only when the observer's
   * bridge adapter would actually accept a synthetic wake frame RIGHT NOW.
   *
   * Prefers the adapter's {@link IBackendAdapter.isReadyForServerFrame}
   * (full transport + protocol readiness — e.g. codex requires its
   * `threadId` assigned, not just `connected`), falling back to
   * {@link IBackendAdapter.isConnected} for adapters that do not implement
   * the predicate. Codex flips `connected` true ~16s before `threadId`
   * lands, so a plain `isConnected()` gate dispatched into a
   * `socket_disconnected` drop (live-test 2026-06-14, both the spawn and
   * restart-catchup wakes). This predicate closes that window for both.
   */
  private observerReadyForWake(observerSessionId: string): boolean {
    const adapter = this.wsBridge.getSession(observerSessionId)?.backendAdapter;
    if (!adapter) return false;
    return adapter.isReadyForServerFrame?.() ?? adapter.isConnected();
  }

  // Thin delegates into `council-observer-scheduler.ts` — init, the watcher
  // re-arm closure, relaunch re-arm and the existing suite call these names.
  private scanForMissedObserverWakes(trigger: "init" | "failsafe" | "watcher-rearm" = "init"): void {
    this.observerScheduler.scanForMissedObserverWakes(trigger);
  }

  private startObserverFailsafe(): void {
    this.observerScheduler.startFailsafe(() => this.scanForMissedObserverWakes("failsafe"));
  }

  private scheduleSpawnCheckpointWhenObserverReady(
    sessionGroupId: string,
    observerSessionId: string,
    workspaceCwd: string,
  ): Promise<void> {
    return this.observerScheduler.scheduleSpawnCheckpointWhenObserverReady(sessionGroupId, observerSessionId, workspaceCwd);
  }

  private scheduleCatchupWakeWhenObserverReady(sessionGroupId: string, payload: CheckpointPayload): Promise<void> {
    return this.observerScheduler.scheduleCatchupWakeWhenObserverReady(sessionGroupId, payload);
  }

  private emitSpawnCheckpoint(sessionGroupId: string, workspaceCwd: string): void {
    this.observerScheduler.emitSpawnCheckpoint(sessionGroupId, workspaceCwd);
  }

  private get spawnCheckpointPending(): Set<string> {
    return this.observerScheduler.spawnCheckpointPending;
  }

  private get spawnCheckpointPollsInFlight(): ReadonlySet<string> {
    return this.observerScheduler.spawnCheckpointPollsInFlight;
  }

  private tearDownCouncilGroupTracking(sessionGroupId: string): void {
    this.councilLifecycle.tearDownCouncilGroupTracking(sessionGroupId);
  }

  private stopCouncilWatchers(sessionGroupId: string): void {
    this.councilLifecycle.stopCouncilWatchers(sessionGroupId);
  }

  // Thin delegates into `council-checkpoint-pipeline.ts` — the watcher
  // callbacks and turn-done/catch-up wiring below call these names.
  private handleCouncilCheckpoint(sessionGroupId: string, payload: CheckpointPayload): void {
    this.checkpointPipeline.handleCouncilCheckpoint(sessionGroupId, payload);
  }

  private handleCouncilReview(sessionGroupId: string, payload: ObserverReviewPayload, reviewedAt?: number): void {
    this.checkpointPipeline.handleCouncilReview(sessionGroupId, payload, reviewedAt);
  }

  private normalizeObserverReviewRaw(sessionGroupId: string, raw: string, provider: "claude" | "codex"): string {
    return this.checkpointPipeline.normalizeObserverReviewRaw(sessionGroupId, raw, provider);
  }

  private dispatchObserverWake(sessionGroupId: string, payload: CheckpointPayload): WakeDispatchOutcome {
    return this.checkpointPipeline.dispatchObserverWake(sessionGroupId, payload);
  }

  private drainPendingObserverWake(sessionGroupId: string): void {
    this.checkpointPipeline.drainPendingObserverWake(sessionGroupId);
  }

  private finalizeObserverReply(sessionGroupId: string, observerSessionId: string): void {
    this.checkpointPipeline.finalizeObserverReply(sessionGroupId, observerSessionId);
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

  /** Council Mode entry point — see `CouncilLifecycle.createCouncilGroup`. */
  async createCouncilGroup(req: CreateCouncilGroupRequest): Promise<CreateCouncilGroupResult> {
    return this.councilLifecycle.createCouncilGroup(req);
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
      if (backend === "claude" && globalSettings.claudeCodeOAuthToken && !hasNonEmptyEnvVar(envVars, "CLAUDE_CODE_OAUTH_TOKEN")) {
        envVars = { ...envVars, CLAUDE_CODE_OAUTH_TOKEN: globalSettings.claudeCodeOAuthToken };
      } else if (backend === "claude" && globalSettings.anthropicApiKey && !hasAnyClaudeAuthEnv(envVars)) {
        envVars = { ...envVars, ANTHROPIC_API_KEY: globalSettings.anthropicApiKey };
      }
      if (backend === "codex" && globalSettings.openaiApiKey && !hasNonEmptyEnvVar(envVars, "OPENAI_API_KEY")) {
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
        effectiveImage = DEFAULT_SANDBOX_IMAGE;
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
          privileged: sandboxEnabled && effectiveImage === DEFAULT_SANDBOX_IMAGE,
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
          layers: body.layers,
          autoProceedOnIdle: body.autoProceedOnIdle,
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

  /**
   * User-driven stop (REST `POST /sessions/:id/kill`, the UI kill button).
   *
   * P4/KILL-INTENTIONAL (ASK #19): before this the kill was indistinguishable
   * from a crash — proactive keepalive relaunched it 3 s later and a council
   * half entered the reconnect ladder. Now every id is marked intentional AND
   * stopped-by-user BEFORE any kill runs; for a council half that is BOTH
   * halves (EC-2) and both are stopped, so the pair stays in a consistent
   * "both down" state without reconnect/degraded churn. The marks are cleared
   * by {@link resumeUserStopped} (explicit relaunch or a new user message), so
   * a later real crash is healed by auto-relaunch again.
   */
  async killSession(sessionId: string): Promise<{ ok: boolean }> {
    if (!this.launcher.getSession(sessionId)) return this.killSessionProcess(sessionId);
    const ids = this.stopScope(sessionId);
    const group = this.coordinator?.findBySessionId(sessionId);
    for (const id of ids) {
      this.intentionalKills.add(id);
      this.recovery.markStoppedByUser(id);
      this.recovery.cancelKeepaliveTimer(id);
      this.wsBridge.cancelDisconnectTimer(id);
      log.info("orchestrator", "session stopped by user", {
        event: "session.kill.user_stopped",
        sessionId: id,
        ...(group ? { sessionGroupId: group.sessionGroupId, role: this.groupRoleOf(group, id) } : {}),
      });
    }
    // A pending auto-proceed fire would queue a synthetic turn into the dead
    // orchestrator; cancel it (hold state is kept — this is not an archive).
    if (group) this.autoProceed.getManager().cancel(group.primary.sessionId);
    let clicked = { ok: false };
    for (const id of ids) {
      const result = await this.killSessionProcess(id);
      if (id === sessionId) clicked = result;
    }
    return clicked;
  }

  /** Plain process kill (coordinator rollback/archive, sweep of the stopped pair). */
  private async killSessionProcess(sessionId: string): Promise<{ ok: boolean }> {
    const killed = await this.launcher.kill(sessionId);
    if (killed) {
      containerManager.removeContainer(sessionId);
    }
    return { ok: killed };
  }

  /** The clicked session, or both halves of its live council group (EC-2). */
  private stopScope(sessionId: string): string[] {
    const group = this.coordinator?.findBySessionId(sessionId);
    if (!group || group.status === "archived") return [sessionId];
    return [group.primary.sessionId, group.observer.sessionId];
  }

  private groupRoleOf(
    group: { primary: { sessionId: string } },
    sessionId: string,
  ): "orchestrator" | "observer" {
    return group.primary.sessionId === sessionId ? "orchestrator" : "observer";
  }

  /**
   * Clears the user-stop marks of `sessionId` and, for a council half, of its
   * still-stopped partner (the pair was stopped together, it resumes
   * together). Returns the ids that were resumed; the caller relaunches them.
   */
  private resumeUserStopped(sessionId: string, trigger: "manual_relaunch" | "user_message"): string[] {
    if (!this.recovery.isStoppedByUser(sessionId)) return [];
    const group = this.coordinator?.findBySessionId(sessionId);
    const resumed = this.stopScope(sessionId).filter((id) => this.recovery.isStoppedByUser(id));
    for (const id of resumed) {
      this.recovery.clearStoppedByUser(id);
      this.intentionalKills.delete(id);
      log.info("orchestrator", "user stop cleared", {
        event: "session.kill.user_stop_cleared",
        trigger,
        sessionId: id,
        ...(group ? { sessionGroupId: group.sessionGroupId, role: this.groupRoleOf(group, id) } : {}),
      });
    }
    return resumed;
  }

  /** A browser-typed message to a user-stopped session brings it (and its pair) back. */
  private resumeOnUserMessage(sessionId: string): void {
    for (const id of this.resumeUserStopped(sessionId, "user_message")) {
      void this.recovery.handleAutoRelaunch(id);
    }
  }

  // ── Relaunch ───────────────────────────────────────────────────────────────

  async relaunchSession(
    sessionId: string,
    opts: RelaunchSessionRequest = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const info = this.launcher.getSession(sessionId);
    if (info?.archived) {
      return { ok: false, error: "Session is archived and cannot be relaunched" };
    }
    this.clearAutoRelaunchCount(sessionId);
    // P4/KILL-INTENTIONAL: an explicit relaunch ends a user stop; a stopped
    // council partner comes back through the regular auto-relaunch path.
    for (const id of this.resumeUserStopped(sessionId, "manual_relaunch")) {
      if (id !== sessionId) void this.recovery.handleAutoRelaunch(id);
    }
    const session = this.wsBridge.getSession(sessionId);
    if (session?.stateMachine) {
      session.stateMachine.transition("starting", "relaunch_initiated");
    }
    // EC-2 / CR-12: a manually-triggered relaunch (Settings "apply
    // credentials", explicit relaunch button) SIGTERMs the old proc exactly
    // like the auto-relaunch path. For a council half that intentional kill
    // would otherwise be seen as a real death by the `session:exited` listener
    // → `armReconnect` → transient reconnecting/degraded flicker on a healthy
    // pair. Mark intentional BEFORE the kill and ALWAYS clear in finally (a
    // stale mark would lock `scheduleProactiveRelaunch` out of recovery).
    this.intentionalKills.add(sessionId);
    try {
      const result = await this.launcher.relaunch(sessionId, opts);
      if (result.ok) this.rearmSpawnCheckpointAfterObserverRelaunch(sessionId);
      return result;
    } finally {
      this.intentionalKills.delete(sessionId);
    }
  }

  /**
   * got-050: if the relaunched session is the OBSERVER half of a council
   * group whose spawn checkpoint never landed (first spawn's adapter died
   * before the 30s readiness poll gave up), re-arm the poll against the
   * fresh process. Without this the pair runs without its spawn-ack review
   * and the panel sits on "never checkpointed" until the next user phase.
   * Orchestrator-half relaunches and groups that already got their spawn
   * checkpoint are a no-op.
   */
  private rearmSpawnCheckpointAfterObserverRelaunch(sessionId: string): void {
    const group = this.coordinator?.findBySessionId(sessionId);
    if (!group || group.status === "archived") return;
    if (group.observer.sessionId !== sessionId) return;
    if (!this.spawnCheckpointPending.has(group.sessionGroupId)) return;
    // #4: a poll is already running for this group (e.g. two relaunches inside
    // the 30s window) — don't log a re-arm that scheduleSpawnCheckpointWhen-
    // ObserverReady will just no-op.
    if (this.spawnCheckpointPollsInFlight.has(group.sessionGroupId)) return;
    const cwd = this.launcher.getSession(sessionId)?.cwd;
    if (!cwd) return;
    log.info("session-orchestrator", "council.spawn_checkpoint.rearmed_after_relaunch", {
      event: "council.spawn_checkpoint.rearmed_after_relaunch",
      sessionGroupId: group.sessionGroupId,
      sessionId,
      role: "observer",
    });
    void this.scheduleSpawnCheckpointWhenObserverReady(group.sessionGroupId, sessionId, cwd);
  }

  // ── Archive ────────────────────────────────────────────────────────────────

  /**
   * Linear-issue transition helper extracted so archiveSession can apply it
   * exactly once per archive — both on the single-session path and on the
   * council-pair path (which must not double-transition the orchestrator's
   * linked issue if the user clicked the observer-half by accident; the
   * observer half has no linked issue and this returns undefined harmlessly).
   */
  private async maybeTransitionLinearForArchive(
    sessionId: string,
    linearTransition: ArchiveSessionOptions["linearTransition"],
  ): Promise<ArchiveSessionResult["linearTransition"]> {
    if (!linearTransition || linearTransition === "none") return undefined;
    const linkedIssue = sessionLinearIssues.getLinearIssue(sessionId);
    if (!linkedIssue) return undefined;
    const resolved = resolveApiKey(linkedIssue.connectionId);
    if (!resolved) return undefined;
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
    if (!targetStateId) return { ok: true, skipped: true };
    try {
      return await transitionLinearIssue(linkedIssue.id, targetStateId, linearApiKey, resolvedConnId);
    } catch {
      return { ok: false, error: "Transition failed unexpectedly" };
    }
  }

  async archiveSession(sessionId: string, options?: ArchiveSessionOptions): Promise<ArchiveSessionResult> {
    // EC-2: when the clicked session is part of an active council group,
    // route the kill through `coordinator.archiveGroup` so BOTH halves'
    // ids land in `intentionalKills` BEFORE either `launcher.kill` runs
    // and the `group:exited` bus event fires via the same `applyEvent`
    // channel as every other lifecycle transition (AP-2). Before this
    // branch, `archiveSession` was group-blind and the surviving half
    // kept self-polling indefinitely (P1 reported 2026-05-14).
    const coord = this.coordinator;
    const group = coord?.findBySessionId(sessionId);
    if (coord && group && group.status !== "archived") {
      const linearTransitionResult = await this.maybeTransitionLinearForArchive(
        sessionId,
        options?.linearTransition,
      );

      // EC-2 ordering: mark BOTH halves intentional BEFORE archiveGroup
      // calls deps.kill on either. Without this, the dead half's
      // `session:exited` handler would enter the `reconnecting → degraded`
      // ladder instead of the absorbing intentional-kill path.
      this.intentionalKills.add(group.primary.sessionId);
      this.intentionalKills.add(group.observer.sessionId);
      // Archive supersedes a user stop: after unarchive the pair must come
      // back on browser open as before.
      this.recovery.clearStoppedByUser(group.primary.sessionId);
      this.recovery.clearStoppedByUser(group.observer.sessionId);

      this.recovery.cancelKeepaliveTimer(group.primary.sessionId);
      this.recovery.cancelKeepaliveTimer(group.observer.sessionId);
      this.wsBridge.cancelDisconnectTimer(group.primary.sessionId);
      this.wsBridge.cancelDisconnectTimer(group.observer.sessionId);
      this.prPoller.unwatch(group.primary.sessionId);
      this.prPoller.unwatch(group.observer.sessionId);

      // CR-5 fix: clear the pending-synthetic-turn sticky token BEFORE
      // archiveGroup's awaited kills. Previously the clear ran AFTER the
      // await — current behaviour was safe ONLY because archiveGroup's
      // kills synchronously fire `session:exited` → listener clears. A
      // future async-kill refactor (deferring `deps.kill` to setImmediate
      // for re-entry hygiene) inverts the safety: the explicit clear at
      // step 3 would then race the eventual exit-emit, leaving a window
      // where the sticky token survives the archive. Move BEFORE await
      // so it's unconditionally before any kill — listener handles late
      // edge cases as belt-and-braces, not as the primary defence.
      // Idempotent on never-armed sessions.
      this.autoProceed.clearPendingSyntheticTurn(group.primary.sessionId);
      // FIX-AP-1: cancel a pending idle timer explicitly (not only via the
      // group status gate at fire time) and drop the STOP hold state.
      this.autoProceed.noteArchived(group.primary.sessionId);

      await coord.archiveGroup(group.sessionGroupId);

      // Worktree cleanup runs ONCE — council pairs share one workspace;
      // calling cleanupWorktree per-half would double-attempt the same
      // directory removal (second call is a no-op today, but relying on
      // that is fragile). Use the orchestrator half's id because the
      // worktree is provisioned against that side at createCouncilGroup.
      const worktreeResult = this.cleanupWorktree(group.primary.sessionId, options?.force);

      containerManager.removeContainer(group.primary.sessionId);
      containerManager.removeContainer(group.observer.sessionId);
      this.launcher.setArchived(group.primary.sessionId, true);
      this.launcher.setArchived(group.observer.sessionId, true);
      this.sessionStore.setArchived(group.primary.sessionId, true);
      this.sessionStore.setArchived(group.observer.sessionId, true);
      this.wsBridge.trimArchivedSessionMemory(group.primary.sessionId);
      this.wsBridge.trimArchivedSessionMemory(group.observer.sessionId);

      return { ok: true, worktree: worktreeResult, linearTransition: linearTransitionResult };
    }

    // ── Single-session path (non-council or already-archived group) ─────────
    const linearTransitionResult = await this.maybeTransitionLinearForArchive(
      sessionId,
      options?.linearTransition,
    );

    this.intentionalKills.add(sessionId);
    this.recovery.clearStoppedByUser(sessionId);
    this.recovery.cancelKeepaliveTimer(sessionId);
    this.wsBridge.cancelDisconnectTimer(sessionId);
    await this.launcher.kill(sessionId);
    containerManager.removeContainer(sessionId);
    this.prPoller.unwatch(sessionId);

    const worktreeResult = this.cleanupWorktree(sessionId, options?.force);
    this.launcher.setArchived(sessionId, true);
    this.sessionStore.setArchived(sessionId, true);
    this.wsBridge.trimArchivedSessionMemory(sessionId);

    return { ok: true, worktree: worktreeResult, linearTransition: linearTransitionResult };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async deleteSession(sessionId: string): Promise<DeleteSessionResult> {
    this.intentionalKills.add(sessionId);
    this.recovery.cancelKeepaliveTimer(sessionId);
    this.wsBridge.cancelDisconnectTimer(sessionId);
    await this.launcher.kill(sessionId);
    containerManager.removeContainer(sessionId);
    const worktreeResult = this.cleanupWorktree(sessionId, true);
    this.prPoller.unwatch(sessionId);
    sessionLinearIssues.removeLinearIssue(sessionId);
    this.launcher.removeSession(sessionId);
    this.wsBridge.closeSession(sessionId);
    this.recovery.forgetSession(sessionId);
    this.intentionalKills.delete(sessionId);
    return { ok: true, worktree: worktreeResult };
  }

  // ── Unarchive ──────────────────────────────────────────────────────────────

  unarchiveSession(sessionId: string): { ok: boolean } {
    this.launcher.setArchived(sessionId, false);
    this.sessionStore.setArchived(sessionId, false);
    this.wsBridge.markSessionUnarchived(sessionId);
    return { ok: true };
  }

  // ── Auto-relaunch count ────────────────────────────────────────────────────

  clearAutoRelaunchCount(sessionId: string): void {
    this.recovery.clearAutoRelaunchCount(sessionId);
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
   * Sweep-orphans Task 5 — enumerate per-session/per-group timers whose owning
   * entity is no longer live in the registry. Two timer families leak this way:
   *
   *   - `keepaliveTimers` (keyed by sessionId): a proactive-relaunch timer for
   *     a session the launcher no longer tracks, or one that has since been
   *     archived (an archived session must never be relaunched, so its timer is
   *     dead weight).
   *   - `councilWatchers` (keyed by sessionGroupId): a checkpoint/review watcher
   *     + wake→review deadline for a group the coordinator no longer lists as a
   *     non-archived record.
   *
   * PURE read — no teardown here; this only feeds `computeSweepCandidates`'s
   * `listOrphanTimers`. The global EC-13 failsafe interval is a single interval
   * (not per-session) and the silent-stdio watchdog is owned by its adapter
   * instance and self-resolves — both are deliberately OUT of scope (PLAN
   * Task 5 / Risks).
   */
  listOrphanTimers(): OrphanTimerRef[] {
    const out: OrphanTimerRef[] = [];
    for (const sessionId of this.recovery.keepaliveSessionIds()) {
      const info = this.launcher.getSession(sessionId);
      if (!info || info.archived) {
        out.push({ id: `keepalive:${sessionId}`, sessionId, kind: "keepalive" });
      }
    }
    const liveGroupIds = new Set<string>();
    for (const g of this.coordinator?.listAll() ?? []) {
      if (g.status !== "archived") liveGroupIds.add(g.sessionGroupId);
    }
    for (const groupId of this.councilWatchers.keys()) {
      if (!liveGroupIds.has(groupId)) {
        out.push({ id: `council-watcher:${groupId}`, kind: "council-watcher" });
      }
    }
    return out;
  }

  /**
   * Sweep-orphans Task 5 — clear ONE orphaned timer by the id
   * {@link listOrphanTimers} minted, routing through the registry's OWN
   * teardown so the underlying resource is released the same way normal
   * lifecycle does — never a bespoke `clearTimeout`. `keepalive:` →
   * {@link cancelKeepaliveTimer} (clears + unmaps). `council-watcher:` →
   * {@link stopCouncilWatchers}, which ALSO aborts the fs.watch handles and
   * clears the wake→review deadline, not just the setTimeout. An unknown
   * prefix is a no-op (logged) rather than a throw — a stale preview must not
   * be able to crash execute.
   */
  clearOrphanTimer(timerId: string): void {
    if (timerId.startsWith("keepalive:")) {
      this.recovery.cancelKeepaliveTimer(timerId.slice("keepalive:".length));
      return;
    }
    if (timerId.startsWith("council-watcher:")) {
      this.stopCouncilWatchers(timerId.slice("council-watcher:".length));
      return;
    }
    log.warn("session-orchestrator", "clearOrphanTimer: unknown timer id", {
      event: "sweep.timer.unknown_id",
      timerId,
    });
  }

  /** O(1) council group + role lookup for a session (REST authz). */
  getCouncilGroupBySessionId(sessionId: string): { sessionGroupId: string; role: "orchestrator" | "observer" } | null {
    return this.councilLifecycle.getCouncilGroupBySessionId(sessionId);
  }

  /** REST bootstrap of live council group records (Sidebar hydration). */
  getAllGroupsForBootstrap(): BrowserGroupRecord[] {
    return this.councilLifecycle.getAllGroupsForBootstrap();
  }

  /** REST bootstrap of a group's grounded observer findings (ObserverPanel). */
  getGroupReviewsForBootstrap(sessionGroupId: string): ReturnType<CouncilLifecycle["getGroupReviewsForBootstrap"]> {
    return this.councilLifecycle.getGroupReviewsForBootstrap(sessionGroupId);
  }

  /** B2b: persist a human dismissal of an observer STOP as a group dispute. */
  disputeObserverFinding(
    sessionGroupId: string,
    input: { claim: string; evidencePath: string; findingId?: string },
  ): ReturnType<CouncilLifecycle["disputeObserverFinding"]> {
    const result = this.councilLifecycle.disputeObserverFinding(sessionGroupId, input);
    // FIX-AP-1: a disputed STOP no longer holds auto-proceed.
    if (result.ok) this.autoProceed.noteDispute(sessionGroupId, input);
    return result;
  }

  /**
   * FIX-AP-1: a human dismissed an observer STOP ("Dismiss for now"). Releases
   * the auto-proceed hold for that finding; not a dispute.
   */
  resolveObserverStop(sessionGroupId: string, findingId: string): ResolveStopResult {
    return this.autoProceed.resolveStop(sessionGroupId, findingId);
  }

  /** FIX-AP-4: a human ignored a review file that keeps the hold restore incomplete. */
  ignoreAutoProceedRestoreGap(sessionGroupId: string, file: string, fingerprint: string): IgnoreRestoreGapResult {
    return this.autoProceed.ignoreRestoreGap(sessionGroupId, file, fingerprint);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  shutdown(): void {
    // Most timers are owned by the process lifecycle; the EC-13 failsafe
    // interval is explicitly cleared so shutdown is deterministic (and tests
    // don't leak a live interval across cases).
    this.observerScheduler.stopFailsafe();
    this.recovery.stopDriftDetector();
  }

  // ── Private: Session recovery delegates (P4/C1d) ───────────────────────────

  /** Delegate kept so the silence-rotation suite reaches the real handler. */
  private handleBackendSilent(sessionId: string, sinceMs: number, reason: string): Promise<void> {
    return this.recovery.handleBackendSilent(sessionId, sinceMs, reason);
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
