import type { IdleTimerManager } from "./idle-timer-manager.js";
import type { IdleTimerEnactor } from "./session-group-coordinator.js";
import {
  buildNoopIdleTimerManager,
  runAutoProceedBootReconcile,
  type OrchestratorGroupMetaForRehydrate,
  type OrchestratorWatcherForRehydrate,
} from "./auto-proceed-orchestrator-bindings.js";
import type { GroupEvent } from "./group-state-machine.js";
import type { BrowserObserverFinding } from "./session-types.js";
import { AUTO_PROCEED_MAX_ITERATIONS_CEILING } from "./auto-proceed-types.js";
import { log } from "./logger.js";

/** Validated per-session opt-in (routes.ts boundary parser output). */
export interface AutoProceedOnIdleConfig {
  readonly idleMs: number;
  readonly maxIterations: number;
}

/**
 * A STOP that should hold auto-proceed: the same predicate the browser uses
 * for its blocker banner — live STOP severity, not weakly grounded (B2), not
 * matching an earlier human dispute (B2b). Downgraded findings are already
 * NOTE by severity.
 */
export function isBlockingStopFinding(finding: BrowserObserverFinding): boolean {
  return finding.severity === "STOP" && !finding.weakEvidence && !finding.disputed;
}

/**
 * Auto-proceed (AFK idle-timeout) controller (aura-meta-diet P4/C1c).
 *
 * Owns the orchestrator's handle on the {@link IdleTimerManager} and every
 * call site that drives it: the cross-tab user-frame gate, the sticky-token
 * clear on session exit / archive, the API-limit pause, the boot reconcile of
 * on-disk traces, and the enactor the coordinator drains idle-timer effects
 * into (AP-2 — the state machine stays the sole mutator).
 *
 * Extracted verbatim from `session-orchestrator.ts`. The orchestrator owns the
 * council watcher/meta maps and hands them in (AP-1 DI). Every method reads
 * the CURRENT manager, so the late `setManager` swap `index.ts` performs to
 * break the construct cycle reaches listeners wired before it.
 *
 * Lifecycle of the manager itself:
 *  - Boot reconcile: {@link rehydrateTraces}, run from `initialize()` after
 *    `reconcileCouncilGroups`, scans each active group's `.council/state/` for
 *    trace JSON and rehydrates the per-session iteration counter.
 *  - SIGTERM drain: `disposeAll()` is the FIRST step in `group-shutdown.ts`,
 *    called BEFORE kill propagation (EC-2 extends naturally — timers cleared
 *    before kills fire to children).
 * Null-object when DI omits it so test paths and existing tests don't crash;
 * production always wires the real manager from `index.ts`.
 */

export interface CouncilAutoProceedControllerDeps {
  /** Optional initial manager; defaults to the inert null-object manager. */
  manager?: IdleTimerManager;
  /** Orchestrator-owned group maps — the boot reconcile reads them. */
  groupMeta: ReadonlyMap<string, OrchestratorGroupMetaForRehydrate>;
  watchers: ReadonlyMap<string, OrchestratorWatcherForRehydrate>;
  /**
   * aura-meta-diet C3 — auto-proceed layer gate. Consulted on every `arm`;
   * `false` refuses the arm (logged). Omitted → always allowed (prod default).
   */
  isAutoProceedAllowed?: (sessionId: string) => boolean;
  /**
   * AP-WIRE — the orchestrator-half's persisted `autoProceedOnIdle` opt-in
   * (launcher info). `undefined` → the session never arms. Omitted → nothing
   * arms (tests / non-council wiring).
   */
  getAutoProceedConfig?: (sessionId: string) => AutoProceedOnIdleConfig | undefined;
  /** AP-WIRE — Companion sessionId → council group id (reverse index). */
  getGroupIdForSession?: (sessionId: string) => string | undefined;
  /** AP-WIRE — routes auto-proceed events through `coordinator.applyEvent`
   *  (AP-2: the state machine stays the sole decider of arm/cancel). */
  applyGroupEvent?: (sessionGroupId: string, event: GroupEvent) => void;
  /** AP-WIRE — `COMPANION_ORCH_AUTO_PROCEED_MAX_ITERATIONS_CEILING`, already
   *  resolved; clamps the per-session `maxIterations`. Defaults to the hard cap. */
  iterationCeiling?: number;
}

/** The subscription points {@link CouncilAutoProceedController.wire} needs. */
export interface AutoProceedWiring {
  onUserFrameObserved(callback: (sessionId: string) => void): unknown;
  onSessionExited(callback: (sessionId: string) => void): unknown;
  /** AP-WIRE — `orchestrator:turn-done` (in-flight → awaiting-input edge). */
  onOrchestratorTurnDone?(callback: (sessionId: string, blockedByStop: boolean) => void): unknown;
  /** AP-WIRE — `group:review` (grounded findings for one checkpoint). */
  onGroupReview?(callback: (sessionGroupId: string, findings: readonly BrowserObserverFinding[]) => void): unknown;
}

export class CouncilAutoProceedController {
  private manager: IdleTimerManager;
  private readonly groupMeta: ReadonlyMap<string, OrchestratorGroupMetaForRehydrate>;
  private readonly watchers: ReadonlyMap<string, OrchestratorWatcherForRehydrate>;
  private readonly isAutoProceedAllowed?: (sessionId: string) => boolean;
  private readonly getAutoProceedConfig?: (sessionId: string) => AutoProceedOnIdleConfig | undefined;
  private readonly getGroupIdForSession?: (sessionId: string) => string | undefined;
  private readonly applyGroupEvent?: (sessionGroupId: string, event: GroupEvent) => void;
  private readonly iterationCeiling: number;
  /**
   * Orchestrator sessions whose group's latest observer review carries a
   * blocking STOP. In-memory only: a server restart forgets it until the
   * next review lands (the adapter's own `blockedByStop` axis is reset on
   * every turn edge, so it cannot hold this).
   */
  private readonly stopBlocked = new Set<string>();

  /**
   * PLAN Task 8: route applyEvent's auto-proceed idle-timer descriptors into
   * the real IdleTimerManager. AP-2 — the state machine is the sole mutator;
   * this seam is the enactor that drains its effects.
   */
  readonly enactor: IdleTimerEnactor = {
    arm: (sessionId, options) => {
      if (this.isAutoProceedAllowed && !this.isAutoProceedAllowed(sessionId)) {
        log.info("auto-proceed", "arm refused: autoProceed layer disabled", {
          event: "auto-proceed.layer-disabled",
          sessionId,
        });
        return;
      }
      this.manager.arm(sessionId, options);
    },
    cancel: (sessionId) => this.manager.cancel(sessionId),
    noteUserMessage: (sessionId) => this.manager.noteUserMessage(sessionId),
  };

  constructor(deps: CouncilAutoProceedControllerDeps) {
    // Null-object default when DI omits the manager. Disposing a null
    // manager is a no-op; rehydrate is a no-op; arm/cancel/note are no-ops.
    // Production wires the real manager from `index.ts` so the boot
    // reconcile path actually rehydrates traces.
    this.manager = deps.manager ?? buildNoopIdleTimerManager();
    this.groupMeta = deps.groupMeta;
    this.watchers = deps.watchers;
    this.isAutoProceedAllowed = deps.isAutoProceedAllowed;
    this.getAutoProceedConfig = deps.getAutoProceedConfig;
    this.getGroupIdForSession = deps.getGroupIdForSession;
    this.applyGroupEvent = deps.applyGroupEvent;
    this.iterationCeiling = Math.min(
      deps.iterationCeiling ?? AUTO_PROCEED_MAX_ITERATIONS_CEILING,
      AUTO_PROCEED_MAX_ITERATIONS_CEILING,
    );
  }

  getManager(): IdleTimerManager {
    return this.manager;
  }

  setManager(manager: IdleTimerManager): void {
    this.manager = manager;
  }

  /** Registers the two event-driven call sites. Called once from `initialize()`. */
  wire(wiring: AutoProceedWiring): void {
    // Task 11.6 — cross-tab single-firer wiring for the auto-proceed
    // turn-token. The bridge fires `onUserFrameObserved` once per
    // browser→server `user_message` frame regardless of tab count.
    // Forwarding to `idleTimerManager.noteUserMessage` advances the
    // per-session monotonic turn-token, which cancels any pending
    // synthetic-fire and invalidates an in-flight fire callback (the
    // re-read inside `fire()` is the actual single-firer gate; this
    // wiring is the observability path that drives it).
    //
    // Production caller for `IdleTimerManager.noteUserMessage` — closes
    // the call-site gap from Task 11.1 foundation work where the method
    // shipped with unit tests but no production wiring.
    wiring.onUserFrameObserved((sessionId) => {
      this.manager.noteUserMessage(sessionId);
    });

    // Task 11.8 — clear the pending-synthetic-turn sticky token on every
    // session exit. Without this, a session that died mid-synthetic-turn
    // (CLI crash before result-frame, container teardown, manual kill)
    // would leave the sticky token armed in the manager; if the same
    // sessionId were later re-used (--resume), the next can_use_tool
    // check would falsely treat the resumed session as auto-proceed-
    // driven. `clearPendingSyntheticTurn` is idempotent on never-armed
    // sessions, so firing it on every exit is safe regardless of
    // whether auto-proceed was actually in play.
    wiring.onSessionExited((sessionId) => {
      this.manager.clearPendingSyntheticTurn(sessionId);
    });

    // AP-WIRE — the producer of `orchestrator_turn_idle` (ASK #9: before
    // this, nothing emitted it and auto-proceed never armed in prod). Each
    // in-flight → awaiting-input edge of an opted-in orchestrator arms the
    // idle timer; the synthetic fire flips the session back to in-flight and
    // its `result` re-arms here until the iteration cap trips in the manager.
    wiring.onOrchestratorTurnDone?.((sessionId, blockedByStop) => {
      this.noteOrchestratorIdle(sessionId, blockedByStop);
    });

    // AP-WIRE — the producer of `stop_finding_raised` / `_resolved`. A
    // blocking STOP cancels the pending timer and holds re-arming until a
    // review without one lands; that edge re-tries the arm (the manager's
    // gate refuses if the orchestrator is mid-turn).
    wiring.onGroupReview?.((sessionGroupId, findings) => {
      this.noteGroupReview(sessionGroupId, findings);
    });
  }

  /** Arms the idle timer for an opted-in orchestrator that just went idle. */
  noteOrchestratorIdle(sessionId: string, blockedByStop: boolean): void {
    const config = this.getAutoProceedConfig?.(sessionId);
    if (!config) return; // not opted in (or layer off at create) — nothing arms
    if (blockedByStop || this.stopBlocked.has(sessionId)) return;
    const sessionGroupId = this.getGroupIdForSession?.(sessionId);
    if (!sessionGroupId) return;
    this.applyGroupEvent?.(sessionGroupId, {
      type: "orchestrator_turn_idle",
      sessionId,
      idleMs: config.idleMs,
      maxIterations: Math.min(config.maxIterations, this.iterationCeiling),
    });
  }

  /** Tracks blocking STOPs per orchestrator from each processed review. */
  noteGroupReview(sessionGroupId: string, findings: readonly BrowserObserverFinding[]): void {
    const primary = this.groupMeta.get(sessionGroupId)?.primarySessionId;
    if (!primary || !this.getAutoProceedConfig?.(primary)) return;
    const blocking = findings.some(isBlockingStopFinding);
    const wasBlocked = this.stopBlocked.has(primary);
    if (blocking) {
      this.stopBlocked.add(primary);
      this.applyGroupEvent?.(sessionGroupId, { type: "stop_finding_raised", sessionId: primary });
      return;
    }
    if (!wasBlocked) return;
    this.stopBlocked.delete(primary);
    this.applyGroupEvent?.(sessionGroupId, { type: "stop_finding_resolved", sessionId: primary });
    this.noteOrchestratorIdle(primary, false);
  }

  /**
   * PLAN-aura-orchestrator-idle-auto-proceed Task 9: boot reconcile.
   *
   * Walks each active council group's `.council/state/` directory looking
   * for `<group-id>-auto-proceed-trace.json` files. For each parseable
   * trace whose `sessionGroupId` matches a reconciled group, calls
   * {@link IdleTimerManager.rehydrate} with the orchestrator-half session
   * id so the in-memory iteration counter resumes from disk rather than
   * starting at zero.
   *
   * Logic lives in the dependency-injected `reconcileAutoProceedTraces`
   * reducer so the unit test exercises the real filesystem + real manager
   * without standing up the orchestrator's full event-bus harness. This
   * method is just the concrete-bindings adapter.
   *
   * Idempotency: re-running with no on-disk changes is a no-op. Errors
   * are caught + logged inside the reducer; this method never throws so
   * `initialize()` always completes.
   */
  rehydrateTraces(): void {
    runAutoProceedBootReconcile(
      this.groupMeta,
      this.watchers,
      this.manager,
      (entry) =>
        log.info("session-orchestrator", "auto-proceed reconcile", entry as unknown as Record<string, unknown>),
    );
  }

  /** Read by the checkpoint pipeline: no observer wakes while the account is limited. */
  isApiLimitReached(sessionId: string): boolean {
    return this.manager.isApiLimitReached(sessionId);
  }

  /** Rate-limit / out-of-credits fallback: pause AFK auto-proceed for the session. */
  noteApiLimitReached(sessionId: string): void {
    this.manager.noteApiLimitReached(sessionId);
  }

  /** Idempotent on never-armed sessions. */
  clearPendingSyntheticTurn(sessionId: string): void {
    this.manager.clearPendingSyntheticTurn(sessionId);
  }
}
