/**
 * Idle timer manager — fires a synthetic `[auto-proceed:idle-timeout v1]`
 * `user` frame after N milliseconds of orchestrator-half `awaiting-input`,
 * gated by Council group status, capped at N iterations, and persisted
 * to disk before each fire so a restart mid-sequence resumes the counter
 * exactly where it left off.
 *
 * Owned by session-orchestrator via DI (AP-1 — mirrors the
 * SessionGroupCoordinator pattern). Every external dependency is
 * injected:
 *
 *  - `clock` — {@link ClockSource}. Real `SystemClock` in production;
 *    {@link FakeClock} in tests so the cap-reached path is reachable
 *    without a 5-minute wallclock sleep.
 *  - `getSession(sessionId)` — returns `IdleTimerSessionView | null`.
 *    The manager NEVER walks the orchestrator's session map directly —
 *    test substitutes a fake lookup; production wires through to the
 *    real session record.
 *  - `getGroupStatus(sessionGroupId)` — current group state-machine
 *    status. Production reads from the SessionGroupCoordinator; tests
 *    substitute deterministic values.
 *  - `persistTrace(workspaceRoot, groupId, trace)` — writes the
 *    trace JSON. Production uses {@link writeAutoProceedTrace}; tests
 *    capture for assertion.
 *  - `appendSummary(workspaceRoot, groupId, entry)` — appends to the
 *    AFK summary. Production uses {@link appendAfkSummary}.
 *  - `sendSyntheticFrame(sessionId, body)` — the in-process seam that
 *    flips the orchestrator into `in-flight` and records the
 *    synthetic frame. Production wraps `ClaudeAdapter.send` with the
 *    `synthetic: true` recorder marker (Task 11 of the plan).
 *  - `logEvent(entry)` — EC-9 structured JSON log emitter. Production
 *    uses `logger.info`; tests capture for assertion.
 *
 * The fire path enforces all five gates (state=connected, role=orchestrator,
 * group.status=active, blockedByStop=false, no reconnect-grace) on a
 * **fresh** lookup of session + group state — not the snapshot captured
 * at arm time. That's the EC-7 idiom for time-of-check-time-of-use
 * (TOCTOU) defence: a state change between schedule and fire silently
 * skips the fire and lands an EC-9 entry, never proceeds with stale
 * authorization.
 *
 * `turnToken` is a monotonic per-session counter minted at arm; the
 * fire callback re-reads it and aborts if the value has advanced (user
 * frame observed → cancel + new arm with a fresh token). The token
 * lives in the manager's internal state; the orchestrator notifies via
 * {@link noteUserMessage} on every inbound user frame.
 */

import type { ClockSource, ClockTimer } from "./clock-source.js";
import {
  AUTO_PROCEED_DIRECTIVE_PREFIX,
  AUTO_PROCEED_MAX_ITERATIONS_CEILING,
  buildAutoProceedDirectiveBody,
  type AutoProceedEnvelope,
} from "./auto-proceed-types.js";
import {
  AUTO_PROCEED_TRACE_SCHEMA_VERSION,
  type AutoProceedTrace,
} from "./auto-proceed-state.js";

/** Subset of session record fields the manager needs to gate on. */
export interface IdleTimerSessionView {
  readonly sessionId: string;
  readonly sessionGroupId: string | null;
  readonly sessionGroupRole: "orchestrator" | "observer" | null;
  /** SessionState transport layer — `connected` is the only firable value. */
  readonly state: "connected" | "exited" | "reconnecting" | "spawning" | string;
  /**
   * Orchestrator-half turn-state per Task 4. The manager arms only on
   * `awaiting-input` with `blockedByStop=false`. The Discriminated
   * Union shape is duplicated here as a structural view so the manager
   * does not have to depend on `claude-adapter.ts` directly.
   */
  readonly orchestratorTurnState:
    | { kind: "in-flight" }
    | { kind: "awaiting-input"; blockedByStop: boolean };
  /** Workspace root for persistence wrapper resolution. */
  readonly workspaceRoot: string;
  /** True iff a `reconnecting` grace window is currently armed. */
  readonly reconnectGraceActive: boolean;
  /**
   * Council-plan `phase` slug for the directive envelope. Producer-side
   * value comes from the most recent checkpoint or a session-level
   * default; the manager never invents it.
   */
  readonly councilPhase: string;
}

/** Subset of group state the manager needs. */
export type IdleTimerGroupStatus =
  | "pairing"
  | "active"
  | "degraded"
  | "archived"
  | "reconnecting"
  | "unknown";

/**
 * Per-session arm options. `idleMs` is how long the orchestrator must
 * stay in `awaiting-input` before the timer fires; `maxIterations` is
 * the hard cap. Both validated against the protocol-level ceiling.
 */
export interface IdleTimerArmOptions {
  readonly idleMs: number;
  readonly maxIterations: number;
}

/** Outcome of `fire()` — discriminated so the test asserts each branch. */
export type FireOutcome =
  | { kind: "sent"; iteration: number }
  | { kind: "skipped-not-armable"; reason: SkipReason }
  | { kind: "skipped-token-stale" }
  | { kind: "skipped-cap-reached"; iteration: number }
  | { kind: "send-failed"; error: string };

/** Discriminated reasons the gate refused at fire-time. */
export type SkipReason =
  | "session-missing"
  | "session-not-connected"
  | "not-orchestrator-half"
  | "group-not-active"
  | "blocked-by-stop"
  | "in-flight"
  | "reconnect-grace-active";

/** EC-9 log entry shape. */
export interface IdleTimerLogEntry {
  readonly event: string;
  readonly sessionId: string;
  readonly sessionGroupId?: string;
  readonly role?: "orchestrator";
  readonly iteration?: number;
  readonly reason?: string;
  readonly error?: string;
}

/** Dependency-injection surface — full set required by the manager. */
export interface IdleTimerManagerDeps {
  readonly clock: ClockSource;
  readonly getSession: (sessionId: string) => IdleTimerSessionView | null;
  readonly getGroupStatus: (sessionGroupId: string) => IdleTimerGroupStatus;
  readonly persistTrace: (
    workspaceRoot: string,
    groupId: string,
    trace: AutoProceedTrace,
  ) => { ok: true } | { ok: false; error: unknown };
  readonly appendSummary: (
    workspaceRoot: string,
    groupId: string,
    entry: string,
  ) => { ok: true } | { ok: false; error: unknown };
  readonly sendSyntheticFrame: (
    sessionId: string,
    body: string,
  ) => { ok: true } | { ok: false; error: string };
  readonly logEvent: (entry: IdleTimerLogEntry) => void;
}

interface ArmedTimerState {
  readonly sessionId: string;
  options: IdleTimerArmOptions;
  /** Monotonic counter, advanced on every user-message observation. */
  turnToken: number;
  /** Iteration counter — persisted, NOT in-memory-only. */
  iterationCount: number;
  /** All previous fire timestamps for trace replay. */
  firedAt: string[];
  cappedAt: string | null;
  lastObjectiveGateResult: "pass" | "fail" | null;
  /** Active timer handle from the clock — cancelled on user-message / dispose. */
  timer: ClockTimer | null;
}

/**
 * The manager itself. One instance per orchestrator process; tests
 * construct fresh instances per assertion via the `deps` seam.
 */
export class IdleTimerManager {
  private readonly states = new Map<string, ArmedTimerState>();

  constructor(private readonly deps: IdleTimerManagerDeps) {}

  /**
   * Rehydrate iteration counter / firedAt history from a persisted
   * trace. Called from session-orchestrator boot reconcile (Task 9)
   * before the first arm. Idempotent — re-rehydrating with the same
   * trace produces the same state. Trace's `sessionGroupId` mismatch
   * is logged and the rehydrate is skipped (orphan trace from a
   * different group).
   */
  rehydrate(sessionId: string, trace: AutoProceedTrace, expectedGroupId: string | null): void {
    if (expectedGroupId !== null && trace.sessionGroupId !== expectedGroupId) {
      this.deps.logEvent({
        event: "idle-timer.rehydrate-skipped-orphan",
        sessionId,
        sessionGroupId: expectedGroupId ?? undefined,
        reason: "trace-group-mismatch",
      });
      return;
    }
    const existing = this.states.get(sessionId);
    const fresh: ArmedTimerState = existing ?? {
      sessionId,
      options: { idleMs: 0, maxIterations: AUTO_PROCEED_MAX_ITERATIONS_CEILING },
      turnToken: 0,
      iterationCount: 0,
      firedAt: [],
      cappedAt: null,
      lastObjectiveGateResult: null,
      timer: null,
    };
    fresh.iterationCount = trace.iterationCount;
    fresh.firedAt = [...trace.firedAt];
    fresh.cappedAt = trace.cappedAt;
    fresh.lastObjectiveGateResult = trace.lastObjectiveGateResult;
    this.states.set(sessionId, fresh);
    this.deps.logEvent({
      event: "idle-timer.rehydrated",
      sessionId,
      iteration: trace.iterationCount,
    });
  }

  /**
   * Arm a fresh timer for the given session. Validates options against
   * the protocol ceiling, refuses if any gate predicate would refuse at
   * fire time. Returns the action taken so tests can assert.
   *
   * Idempotent on re-arm — cancels any existing timer first, advances
   * the turn token, and schedules afresh.
   */
  arm(sessionId: string, options: IdleTimerArmOptions): { kind: "armed" } | { kind: "refused"; reason: SkipReason | "invalid-options" } {
    if (
      !Number.isFinite(options.idleMs) ||
      !Number.isInteger(options.idleMs) ||
      options.idleMs <= 0 ||
      !Number.isFinite(options.maxIterations) ||
      !Number.isInteger(options.maxIterations) ||
      options.maxIterations < 1 ||
      options.maxIterations > AUTO_PROCEED_MAX_ITERATIONS_CEILING
    ) {
      return { kind: "refused", reason: "invalid-options" };
    }

    const gate = this.checkGate(sessionId);
    if (gate.kind === "blocked") {
      return { kind: "refused", reason: gate.reason };
    }

    const existing = this.states.get(sessionId);
    if (existing?.timer) {
      existing.timer.cancel();
      existing.timer = null;
    }

    const state: ArmedTimerState =
      existing ?? {
        sessionId,
        options,
        turnToken: 0,
        iterationCount: 0,
        firedAt: [],
        cappedAt: null,
        lastObjectiveGateResult: null,
        timer: null,
      };
    state.options = options;
    state.turnToken += 1;
    const myToken = state.turnToken;

    state.timer = this.deps.clock.schedule(() => {
      // Drop the timer reference up-front so a callback that re-arms
      // doesn't see a stale handle.
      const s = this.states.get(sessionId);
      if (s) s.timer = null;
      this.fire(sessionId, myToken);
    }, options.idleMs);

    this.states.set(sessionId, state);
    return { kind: "armed" };
  }

  /**
   * Cancel an armed timer (no fire). Idempotent — cancelling an
   * already-cancelled or never-armed session is a no-op. The state
   * record stays so the iteration counter survives.
   */
  cancel(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    if (state.timer) {
      state.timer.cancel();
      state.timer = null;
    }
  }

  /**
   * Notify the manager that an inbound user-message was observed. Advances
   * the turn token so any in-flight fire callback aborts on token re-read,
   * and cancels the pending timer.
   */
  noteUserMessage(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.turnToken += 1;
    if (state.timer) {
      state.timer.cancel();
      state.timer = null;
    }
  }

  /**
   * Read-only access to per-session counter — used by the boot
   * reconcile path to persist the trace before any arm happens, and
   * by tests for assertion.
   */
  getIterationCount(sessionId: string): number {
    return this.states.get(sessionId)?.iterationCount ?? 0;
  }

  /** Test-only: is a timer currently armed for this session. */
  isArmed(sessionId: string): boolean {
    return this.states.get(sessionId)?.timer != null;
  }

  /**
   * SIGTERM-drain helper. Cancels every armed timer in one pass so
   * the process doesn't hold up exit. EC-2 invariant — mark teardown
   * BEFORE the kills propagate to children; the cancel-all happens
   * first in `group-shutdown.ts` per the plan.
   */
  disposeAll(): void {
    for (const state of this.states.values()) {
      if (state.timer) {
        state.timer.cancel();
        state.timer = null;
      }
    }
  }

  /**
   * Internal: check whether all five gates pass for the given session.
   * Returns either `{kind:"ok"}` or `{kind:"blocked", reason}` — never
   * throws. The gate must be re-evaluated at fire time, never trusted
   * across a clock-tick boundary.
   */
  private checkGate(
    sessionId: string,
  ): { kind: "ok"; view: IdleTimerSessionView } | { kind: "blocked"; reason: SkipReason } {
    const view = this.deps.getSession(sessionId);
    if (!view) return { kind: "blocked", reason: "session-missing" };
    if (view.state !== "connected") return { kind: "blocked", reason: "session-not-connected" };
    if (view.sessionGroupRole !== "orchestrator")
      return { kind: "blocked", reason: "not-orchestrator-half" };
    if (view.reconnectGraceActive) return { kind: "blocked", reason: "reconnect-grace-active" };
    if (view.orchestratorTurnState.kind === "in-flight")
      return { kind: "blocked", reason: "in-flight" };
    if (view.orchestratorTurnState.blockedByStop)
      return { kind: "blocked", reason: "blocked-by-stop" };
    if (view.sessionGroupId === null)
      return { kind: "blocked", reason: "not-orchestrator-half" };
    const status = this.deps.getGroupStatus(view.sessionGroupId);
    if (status !== "active") return { kind: "blocked", reason: "group-not-active" };
    return { kind: "ok", view };
  }

  /**
   * The fire path. Called from inside the `clock.schedule` callback —
   * re-evaluates the gate, re-checks the turn token, persists the
   * iteration counter BEFORE invoking the send, and on any failure
   * lands an EC-9 entry without retrying (the next arm re-tries
   * the gate fresh).
   */
  private fire(sessionId: string, expectedToken: number): FireOutcome {
    const state = this.states.get(sessionId);
    if (!state) {
      this.deps.logEvent({
        event: "idle-timer.fire-skipped",
        sessionId,
        reason: "state-missing",
      });
      return { kind: "skipped-not-armable", reason: "session-missing" };
    }

    // Token re-read — defends the race between schedule and fire. A
    // user-message observed between the two advances the token; the
    // fire path then silently aborts.
    if (state.turnToken !== expectedToken) {
      this.deps.logEvent({
        event: "idle-timer.fire-skipped",
        sessionId,
        reason: "token-stale",
      });
      return { kind: "skipped-token-stale" };
    }

    // Re-evaluate the gate on FRESH session state (not the snapshot
    // captured at arm time). TOCTOU defence per EC-7.
    const gate = this.checkGate(sessionId);
    if (gate.kind === "blocked") {
      this.deps.logEvent({
        event: "idle-timer.fire-skipped",
        sessionId,
        sessionGroupId: state.options.maxIterations ? undefined : undefined,
        reason: gate.reason,
      });
      return { kind: "skipped-not-armable", reason: gate.reason };
    }

    // Cap check — refuse the fire and persist `cappedAt` so the next
    // boot reconcile sees the same cap.
    if (state.iterationCount >= state.options.maxIterations) {
      const cappedAt = new Date(this.deps.clock.now()).toISOString();
      if (!state.cappedAt) {
        state.cappedAt = cappedAt;
        this.persistOrLog(gate.view, state);
      }
      this.deps.logEvent({
        event: "idle-timer.fire-cap-reached",
        sessionId,
        sessionGroupId: gate.view.sessionGroupId ?? undefined,
        role: "orchestrator",
        iteration: state.iterationCount,
      });
      return { kind: "skipped-cap-reached", iteration: state.iterationCount };
    }

    // Persist iteration counter BEFORE the send. A crash mid-send must
    // not lose the bookkeeping — the next boot resumes from the
    // already-incremented count and the worst case is one duplicate
    // fire, never an undercount that lets the cap drift upward.
    const nextIteration = state.iterationCount + 1;
    const firedAtIso = new Date(this.deps.clock.now()).toISOString();
    const projected: AutoProceedTrace = {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: gate.view.sessionGroupId ?? "",
      iterationCount: nextIteration,
      firedAt: [...state.firedAt, firedAtIso],
      cappedAt: state.cappedAt,
      lastObjectiveGateResult: state.lastObjectiveGateResult,
    };
    const persistResult = this.persistOrLog(gate.view, state, projected);
    if (!persistResult) {
      // Persist failure already EC-9-logged. Refuse to send so the
      // counter and the disk state stay in sync. The cap is the
      // bound that cannot be allowed to drift.
      return {
        kind: "send-failed",
        error: "persist-failed-before-send",
      };
    }

    // Persisted — commit in-memory counter to match.
    state.iterationCount = nextIteration;
    state.firedAt = projected.firedAt as string[];

    const envelope: AutoProceedEnvelope = {
      directive: "proceed-with-best-judgment",
      iteration: nextIteration,
      max_iterations: state.options.maxIterations,
      paused_at: firedAtIso,
      phase: gate.view.councilPhase,
      group_id: gate.view.sessionGroupId ?? "",
    };
    const body = buildAutoProceedDirectiveBody(envelope);

    const sendResult = this.deps.sendSyntheticFrame(sessionId, body);
    if (!sendResult.ok) {
      this.deps.logEvent({
        event: "idle-timer.fire-failed",
        sessionId,
        sessionGroupId: gate.view.sessionGroupId ?? undefined,
        role: "orchestrator",
        iteration: nextIteration,
        error: sendResult.error,
      });
      return { kind: "send-failed", error: sendResult.error };
    }

    // Best-effort AFK summary — failure here is logged but does NOT
    // revert the trace (the trace is the cap-authoritative counter;
    // the summary is forensic narrative).
    const summary = `- [${firedAtIso}] iteration=${nextIteration}/${state.options.maxIterations} directive=${envelope.directive} phase=${envelope.phase}`;
    const appendResult = this.deps.appendSummary(
      gate.view.workspaceRoot,
      gate.view.sessionGroupId ?? "",
      summary,
    );
    if (!appendResult.ok) {
      this.deps.logEvent({
        event: "idle-timer.afk-summary-append-failed",
        sessionId,
        sessionGroupId: gate.view.sessionGroupId ?? undefined,
        iteration: nextIteration,
      });
    }

    this.deps.logEvent({
      event: "idle-timer.fire-sent",
      sessionId,
      sessionGroupId: gate.view.sessionGroupId ?? undefined,
      role: "orchestrator",
      iteration: nextIteration,
    });
    return { kind: "sent", iteration: nextIteration };
  }

  /**
   * Persist the trace, optionally overriding with the `projected`
   * shape. Returns whether the persist succeeded. EC-9-logs on failure.
   */
  private persistOrLog(
    view: IdleTimerSessionView,
    state: ArmedTimerState,
    projected?: AutoProceedTrace,
  ): boolean {
    if (view.sessionGroupId === null) return false;
    const trace: AutoProceedTrace = projected ?? {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: view.sessionGroupId,
      iterationCount: state.iterationCount,
      firedAt: state.firedAt,
      cappedAt: state.cappedAt,
      lastObjectiveGateResult: state.lastObjectiveGateResult,
    };
    const out = this.deps.persistTrace(view.workspaceRoot, view.sessionGroupId, trace);
    if (!out.ok) {
      this.deps.logEvent({
        event: "idle-timer.persist-failed",
        sessionId: state.sessionId,
        sessionGroupId: view.sessionGroupId,
      });
      return false;
    }
    return true;
  }
}

/**
 * Convenience: build the canonical envelope from a session-view and
 * the per-fire iteration value. Exported so wire-in tests can pin the
 * exact bytes the manager emits.
 */
export function buildEnvelopeForView(
  view: IdleTimerSessionView,
  iteration: number,
  maxIterations: number,
  nowMs: number,
): AutoProceedEnvelope {
  return {
    directive: "proceed-with-best-judgment",
    iteration,
    max_iterations: maxIterations,
    paused_at: new Date(nowMs).toISOString(),
    phase: view.councilPhase,
    group_id: view.sessionGroupId ?? "",
  };
}

// Re-export for ergonomics — callers usually need the prefix constant
// alongside the manager.
export { AUTO_PROCEED_DIRECTIVE_PREFIX };
