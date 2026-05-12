/**
 * Pure state machine for a Council Mode session group.
 *
 * Encoding the lifecycle as a discriminated union + a single deterministic
 * `transition()` function means three different callers cannot disagree on
 * "is this group degraded?" — the answer is always whatever `state` says.
 */

import type { SessionGroupRole } from "./session-types.js";

export type GroupStatus = "pairing" | "active" | "degraded" | "archived" | "reconnecting";

/** Re-export the role type alongside the state machine for callers' convenience. */
export type GroupRole = SessionGroupRole;

export type GroupEvent =
  | { type: "both_ready" }
  | { type: "half_died"; role: GroupRole }
  | { type: "half_respawned"; role: GroupRole }
  | { type: "reconnect_started" }
  | { type: "reconnect_ok" }
  | { type: "reconnect_failed" }
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
