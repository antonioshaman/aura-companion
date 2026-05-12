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
  | { type: "half_died"; role: GroupRole }
  | { type: "half_respawned"; role: GroupRole }
  | { type: "reconnect_started"; survivingRole: GroupRole; deadlineMs: number }
  | { type: "reconnect_ok"; role: GroupRole }
  | { type: "reconnect_failed"; role: GroupRole }
  | { type: "user_archived" }
  | { type: "user_killed" };

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
  | { kind: "degraded"; deadRole: GroupRole }
  | { kind: "exited"; reason: "user_archived" | "shutdown" | "both_halves_died" }
  | { kind: "reconnecting"; survivingRole: GroupRole; deadlineMs: number }
  | { kind: "reconnected" };

/** EC-9-shaped log entry descriptor. Fields are the canonical set; no leakage
 *  of cliSessionId / observerPromptSha256 / workspace path. */
export interface GroupLogEntry {
  event:
    | "group.reconnect_started"
    | "group.reconnect_ok"
    | "group.reconnect_failed"
    | "group.degraded"
    | "group.exited";
  role?: GroupRole;
  /** Always `1` in current scope (no group-level retry). Carried as a field
   *  so a future multi-attempt extension is a field-update, not a wire shape change. */
  attempts?: number;
}

export interface GroupTransitionSideEffects {
  busEvents: GroupBusSideEffect[];
  logEntries: GroupLogEntry[];
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
  if (prev === next) return { busEvents, logEntries };

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
    return { busEvents, logEntries };
  }

  // reconnecting → active
  if (prev === "reconnecting" && next === "active" && event.type === "reconnect_ok") {
    busEvents.push({ kind: "reconnected" });
    logEntries.push({
      event: "group.reconnect_ok",
      role: event.role,
      attempts: 1,
    });
    return { busEvents, logEntries };
  }

  // → degraded (covers both `half_died` and `reconnect_failed`)
  if (next === "degraded") {
    const deadRole: GroupRole =
      event.type === "half_died" || event.type === "reconnect_failed" || event.type === "reconnect_ok"
        ? event.role
        : "observer";
    busEvents.push({ kind: "degraded", deadRole });
    if (event.type === "reconnect_failed") {
      logEntries.push({
        event: "group.reconnect_failed",
        role: event.role,
        attempts: 1,
      });
    } else {
      logEntries.push({ event: "group.degraded", role: deadRole });
    }
    return { busEvents, logEntries };
  }

  // → archived (terminal)
  if (next === "archived") {
    busEvents.push({ kind: "exited", reason: "user_archived" });
    logEntries.push({ event: "group.exited" });
    return { busEvents, logEntries };
  }

  return { busEvents, logEntries };
}
