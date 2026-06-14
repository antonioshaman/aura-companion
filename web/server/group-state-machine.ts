/**
 * Pure state machine for a Council Mode session group.
 *
 * Encoding the lifecycle as a discriminated union + a single deterministic
 * `transition()` function means three different callers cannot disagree on
 * "is this group degraded?" — the answer is always whatever `state` says.
 *
 * Bus + log side effects are *decided* here (pure: `deriveSideEffects`) but
 * *enacted* by `SessionGroupCoordinator.applyEvent`. This is the Fowler
 * shape from PLAN Task 1: every transition produces its bus emits and EC-9
 * log entries in one atomic block, so a future event type that ships
 * without an emit (or vice versa) is structurally impossible.
 */

import type { SessionGroupRole } from "./session-types.js";

export type GroupStatus = "pairing" | "active" | "degraded" | "archived" | "reconnecting";

/** Re-export the role type alongside the state machine for callers' convenience. */
export type GroupRole = SessionGroupRole;

/**
 * Why a group degraded. Single source of truth for the reason union — the
 * bus payload (`event-bus-types.ts:group:degraded.reason`) and the orchestrator's
 * bootstrap-reason cache both reference THIS type, so the four values cannot
 * drift apart. A `half_died` event may carry an explicit reason (the
 * orchestrator's wake-failure / no-review paths); when absent the side-effect
 * table derives `observer_exited` (plain crash) or `reconnect_failed`
 * (grace-window expiry).
 */
export type GroupDegradeReason =
  | "observer_exited"
  | "wake_send_failed"
  | "reconnect_failed"
  | "wake_produced_no_review";

/**
 * `reconnect_started` carries the surviving role: the half whose ws is still
 * up and whose browser is the one that will actually receive the wire
 * frame. UI uses this to render "your X is still here, waiting for Y"
 * (PLAN Task 7: surviving-role not dead-role). The dead role is derivable
 * (`oppositeRole`) but kept implicit on the wire to keep the v1 payload narrow.
 *
 * `reconnect_ok` / `reconnect_failed` carry the previously-dead role for
 * symmetry with `half_respawned` / `half_died` — observers downstream of
 * the bus emission may key on it.
 */
export type GroupEvent =
  | { type: "both_ready" }
  | { type: "half_died"; role: GroupRole; reason?: GroupDegradeReason }
  | { type: "half_respawned"; role: GroupRole }
  | { type: "reconnect_started"; survivingRole: GroupRole; deadlineMs: number }
  | { type: "reconnect_ok"; role: GroupRole }
  | { type: "reconnect_failed"; role: GroupRole }
  | { type: "user_archived" }
  | { type: "user_killed" }
  // ── Auto-proceed (orchestrator-idle) events ──────────────────────────
  //
  // Session-scoped (not group-status-changing) events that drive the
  // idle-timer manager via the side-effect channel. AP-2: routing arm/
  // disarm through `applyEvent` rather than a parallel mutator is the
  // single source of truth — see PLAN-aura-orchestrator-idle-auto-proceed
  // Task 8. `transition()` returns `from` unchanged for all six; only
  // `deriveSideEffects` produces output.
  | {
    /** Orchestrator-half entered `awaiting-input` with no STOP blocker.
     *  Emitted by the bus listener for `orchestrator:turn-done` when
     *  `blockedByStop === false`. Effect: arm the per-session idle
     *  timer (gated downstream on group `status === "active"`). */
    type: "orchestrator_turn_idle";
    sessionId: string;
    idleMs: number;
    maxIterations: number;
  }
  | {
    /** Orchestrator-half left `awaiting-input` (user typed, OR a synthetic
     *  fire flipped it to `in-flight`). Effect: advance the manager's
     *  turn-token + cancel any pending timer. Idempotent. */
    type: "orchestrator_turn_active";
    sessionId: string;
  }
  | {
    /** Observer raised a STOP finding bound to the orchestrator-half's
     *  group. Effect: cancel any pending timer; subsequent
     *  `orchestrator_turn_idle` events while the STOP is unresolved
     *  carry `blockedByStop=true` upstream and produce no arm. */
    type: "stop_finding_raised";
    sessionId: string;
  }
  | {
    /** The previously-raised STOP was resolved. Effect: no immediate
     *  action — the next `orchestrator_turn_idle` re-arms naturally. */
    type: "stop_finding_resolved";
    sessionId: string;
  }
  | {
    /** Notification from the manager that a synthetic auto-proceed
     *  frame was successfully sent. Effect: EC-9 log entry only — the
     *  manager has already persisted the trace before the send. */
    type: "auto_proceed_fired";
    sessionId: string;
    iteration: number;
    firedAtMs: number;
  }
  | {
    /** Notification from the manager that the iteration cap was hit on
     *  a fire attempt. Effect: EC-9 log entry only — `cappedAt` was
     *  already persisted by the manager. */
    type: "iteration_cap_tripped";
    sessionId: string;
    iteration: number;
    cappedAtMs: number;
  };

/**
 * Returns the next status given the current status and an event. Unknown
 * (state, event) combinations are no-ops — they return the current state.
 * Archive is terminal: no event can transition out of it.
 */
export function transition(from: GroupStatus, event: GroupEvent): GroupStatus {
  if (event.type === "user_archived" || event.type === "user_killed") {
    return from === "archived" ? from : "archived";
  }

  switch (from) {
    case "pairing":
      if (event.type === "both_ready") return "active";
      return from;

    case "active":
      if (event.type === "half_died") return "degraded";
      if (event.type === "reconnect_started") return "reconnecting";
      return from;

    case "degraded":
      if (event.type === "half_respawned") return "active";
      return from;

    case "reconnecting":
      if (event.type === "reconnect_ok") return "active";
      if (event.type === "reconnect_failed") return "degraded";
      return from;

    case "archived":
      return from;
  }
}

/** Convenience predicate — orchestrator chat may continue accepting input. */
export function isOperable(state: GroupStatus): boolean {
  return state === "active" || state === "degraded" || state === "reconnecting";
}

/** Convenience predicate — observer findings may be accepted. */
export function isObserverHealthy(state: GroupStatus): boolean {
  return state === "active";
}

/**
 * The bus events the coordinator should emit for a given `(prev, next, event)`
 * triple. Descriptors not actual emits — the coordinator owns the bus
 * reference and enacts these. Pure values keep the state machine
 * dependency-free and trivially testable.
 *
 * `deadRole` on `degraded` is the role that died; on `reconnecting` is the
 * role we're waiting on to come back; absent on `reconnected` / `archived`.
 */
export type GroupBusSideEffect =
  | { kind: "degraded"; deadRole: GroupRole; reason: GroupDegradeReason }
  | { kind: "exited"; reason: "user_archived" | "shutdown" | "both_halves_died" }
  | { kind: "reconnecting"; survivingRole: GroupRole; deadlineMs: number }
  | { kind: "reconnected" };

/**
 * Idle-timer side-effect descriptors for the auto-proceed pipeline. These
 * are session-scoped (not group-status-changing) — `applyEvent` drains
 * them through an injected `IdleTimerEnactor` rather than the bus. See
 * PLAN Task 8: routing arm/disarm through `applyEvent` is the AP-2
 * single-source-of-truth invariant for the orchestrator-idle pipeline.
 */
export type GroupIdleTimerEffect =
  | {
    /** Arm a fresh idle timer for the orchestrator-half session. The
     *  manager re-evaluates its own gate stack at fire time (EC-7
     *  TOCTOU defence) — this descriptor is the request, not the
     *  guarantee. */
    kind: "arm-idle-timer";
    sessionId: string;
    idleMs: number;
    maxIterations: number;
  }
  | {
    /** Cancel any pending idle timer for the session. Idempotent —
     *  cancelling an un-armed session is a no-op. */
    kind: "cancel-idle-timer";
    sessionId: string;
  }
  | {
    /** Advance the manager's monotonic per-session turn-token (cancels
     *  any pending timer + invalidates an in-flight fire callback that
     *  re-reads the token). Emitted when the orchestrator's turn-state
     *  flips back to `in-flight` (user typed OR synthetic fire). */
    kind: "note-user-message";
    sessionId: string;
  };

/** EC-9-shaped log entry descriptor. Fields are the canonical set; no leakage
 *  of cliSessionId / observerPromptSha256 / workspace path. */
export interface GroupLogEntry {
  event:
    | "group.reconnect_started"
    | "group.reconnect_ok"
    | "group.reconnect_failed"
    | "group.degraded"
    | "group.half_respawned"
    | "group.exited"
    | "group.auto-proceed.fired"
    | "group.auto-proceed.cap-reached";
  role?: GroupRole;
  /** Always `1` in current scope (no group-level retry). Carried as a field
   *  so a future multi-attempt extension is a field-update, not a wire shape change. */
  attempts?: number;
  /** Orchestrator-half companion sessionId — present only on auto-proceed
   *  notification entries. Lifecycle log lines omit this field (the
   *  sessionGroupId in `enactLogEntry` is enough context). */
  sessionId?: string;
  /** Iteration counter at the moment of the auto-proceed notification.
   *  Present on `group.auto-proceed.fired` and `group.auto-proceed.cap-reached`. */
  iteration?: number;
}

export interface GroupTransitionSideEffects {
  busEvents: GroupBusSideEffect[];
  logEntries: GroupLogEntry[];
  /** Idle-timer descriptors — auto-proceed pipeline. Empty for every
   *  existing lifecycle event; populated only for the six auto-proceed
   *  events. Drained alongside `busEvents` / `logEntries` by `applyEvent`. */
  idleTimerEffects: GroupIdleTimerEffect[];
}

/**
 * Pure: given the transition `(prev → next)` and the event that caused it,
 * describe the side effects the coordinator should enact. Empty arrays for
 * no-op transitions (unknown event, terminal state). Caller decides bus
 * reference + logger.
 *
 * Why a separate function instead of folding into `transition`: keeps
 * `transition()` returning a bare `GroupStatus` (one-line, test-friendly,
 * unchanged downstream call sites). The pure-function pair is the Fowler
 * shape: decisions live in pure functions, enactment happens at one named
 * choke point (`applyEvent`).
 */
export function deriveSideEffects(
  prev: GroupStatus,
  next: GroupStatus,
  event: GroupEvent,
): GroupTransitionSideEffects {
  const busEvents: GroupBusSideEffect[] = [];
  const logEntries: GroupLogEntry[] = [];
  const idleTimerEffects: GroupIdleTimerEffect[] = [];

  // ── Auto-proceed events (PLAN Task 8) ────────────────────────────────
  //
  // These do not change `GroupStatus` (`transition()` returns `from`
  // unchanged), so the `prev === next` early-return below would suppress
  // their effects. Handle them first; the lifecycle table runs only when
  // we fall through.
  //
  // Group-status gate is enforced HERE: arm-idle-timer fires only while
  // `prev === "active"` (the manager re-checks all gates at fire time
  // — TOCTOU defence — so this is a coarse early-exit, not authoritative).
  // Cancel + note-user-message fire regardless of status so a STOP-raised
  // event during reconnecting still clears the pending timer.
  switch (event.type) {
    case "orchestrator_turn_idle":
      if (prev === "active") {
        idleTimerEffects.push({
          kind: "arm-idle-timer",
          sessionId: event.sessionId,
          idleMs: event.idleMs,
          maxIterations: event.maxIterations,
        });
      }
      return { busEvents, logEntries, idleTimerEffects };
    case "orchestrator_turn_active":
      idleTimerEffects.push({ kind: "note-user-message", sessionId: event.sessionId });
      return { busEvents, logEntries, idleTimerEffects };
    case "stop_finding_raised":
      idleTimerEffects.push({ kind: "cancel-idle-timer", sessionId: event.sessionId });
      return { busEvents, logEntries, idleTimerEffects };
    case "stop_finding_resolved":
      // No-op effect — the next `orchestrator_turn_idle` will re-arm
      // naturally once the orchestrator next flips back to awaiting-input.
      return { busEvents, logEntries, idleTimerEffects };
    case "auto_proceed_fired":
      logEntries.push({
        event: "group.auto-proceed.fired",
        role: "orchestrator",
        sessionId: event.sessionId,
        iteration: event.iteration,
      });
      return { busEvents, logEntries, idleTimerEffects };
    case "iteration_cap_tripped":
      logEntries.push({
        event: "group.auto-proceed.cap-reached",
        role: "orchestrator",
        sessionId: event.sessionId,
        iteration: event.iteration,
      });
      return { busEvents, logEntries, idleTimerEffects };
  }

  // ── Lifecycle events (existing) ──────────────────────────────────────
  if (prev === next) return { busEvents, logEntries, idleTimerEffects };

  // → reconnecting
  if (next === "reconnecting" && event.type === "reconnect_started") {
    busEvents.push({
      kind: "reconnecting",
      survivingRole: event.survivingRole,
      deadlineMs: event.deadlineMs,
    });
    logEntries.push({
      event: "group.reconnect_started",
      role: event.survivingRole,
      attempts: 1,
    });
    return { busEvents, logEntries, idleTimerEffects };
  }

  // reconnecting → active
  if (prev === "reconnecting" && next === "active" && event.type === "reconnect_ok") {
    busEvents.push({ kind: "reconnected" });
    logEntries.push({
      event: "group.reconnect_ok",
      role: event.role,
      attempts: 1,
    });
    return { busEvents, logEntries, idleTimerEffects };
  }

  // degraded → active (post-grace handshake recovery).
  //
  // Symmetric with `reconnect_ok`: when a half re-handshakes AFTER the
  // reconnect grace window expired and the pair has already settled in
  // `degraded`, `session:cli-id-received` emits `half_respawned` to drive
  // the recovery transition. Replay `group:created` (via the `reconnected`
  // bus descriptor) so browsers flip status back to active. Log an EC-9
  // line so the recovery is observable from journalctl alongside the
  // earlier `group.degraded`.
  //
  // Closes the gap where `transition()` defined this recovery but no
  // producer emitted the event in production — pairs were stuck in
  // degraded permanently despite halves re-handshaking.
  if (prev === "degraded" && next === "active" && event.type === "half_respawned") {
    busEvents.push({ kind: "reconnected" });
    logEntries.push({
      event: "group.half_respawned",
      role: event.role,
      attempts: 1,
    });
    return { busEvents, logEntries, idleTimerEffects };
  }

  // → degraded (covers both `half_died` and `reconnect_failed`)
  if (next === "degraded") {
    const deadRole: GroupRole =
      event.type === "half_died" || event.type === "reconnect_failed" || event.type === "reconnect_ok"
        ? event.role
        : "observer";
    // Discriminate the reason at the transition so EVERY degrade carries one
    // on the wire (Council Review 2026-06-13 P2 #7). `reconnect_failed`
    // grace-expiry → `reconnect_failed`; a `half_died` defaults to the plain
    // crash reason `observer_exited` UNLESS the caller threaded a more
    // specific one (the orchestrator's wake-failure / no-review paths pass
    // `wake_send_failed` / `wake_produced_no_review`).
    const reason: GroupDegradeReason =
      event.type === "reconnect_failed"
        ? "reconnect_failed"
        : event.type === "half_died"
          ? (event.reason ?? "observer_exited")
          : "observer_exited";
    busEvents.push({ kind: "degraded", deadRole, reason });
    if (event.type === "reconnect_failed") {
      logEntries.push({
        event: "group.reconnect_failed",
        role: event.role,
        attempts: 1,
      });
    } else {
      logEntries.push({ event: "group.degraded", role: deadRole });
    }
    return { busEvents, logEntries, idleTimerEffects };
  }

  // → archived (terminal)
  if (next === "archived") {
    busEvents.push({ kind: "exited", reason: "user_archived" });
    logEntries.push({ event: "group.exited" });
    return { busEvents, logEntries, idleTimerEffects };
  }

  return { busEvents, logEntries, idleTimerEffects };
}
