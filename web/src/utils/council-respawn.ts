import type { GroupRecord } from "../types.js";

/**
 * Pick which half of a Council pair the ObserverPanel's recovery button
 * should bring back.
 *
 * - `degraded` groups carry `deadRole`; relaunch exactly that half.
 * - The `reviewing-stalled` state has no `deadRole` (both processes may be
 *   alive, the observer just never answered), so default to the observer —
 *   it is the half that failed to produce a review.
 */
export function pickRespawnTargetSessionId(group: GroupRecord): string {
  return group.deadRole === "orchestrator" ? group.primarySessionId : group.observerSessionId;
}

/**
 * Respawn one half of a Council pair via the regular
 * `POST /sessions/:id/relaunch` route (the same path ChatView's "Reconnect"
 * and the model switcher use; the server keeps the pair's group wiring).
 *
 * Returns the relaunched session id, or `null` when the group is unknown.
 * Errors propagate so the caller decides how to surface them.
 */
export async function respawnCouncilHalf(
  sessionGroupId: string,
  getGroup: (id: string) => GroupRecord | undefined,
  relaunch: (sessionId: string) => Promise<unknown>,
): Promise<string | null> {
  const group = getGroup(sessionGroupId);
  if (!group) return null;
  const target = pickRespawnTargetSessionId(group);
  await relaunch(target);
  return target;
}
