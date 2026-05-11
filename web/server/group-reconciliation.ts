import { join } from "node:path";
import { writeAtomicJson } from "./atomic-write.js";

/**
 * Restart-time view of a group: did each half's CLI subprocess survive
 * the server restart? `aliveByPid` is the result of a PID check against
 * the process table — cheap, fallible (PID reuse), but sufficient when
 * the alternative is "guess".
 */
export interface RestartState {
  sessionGroupId: string;
  primary: { sessionId: string; aliveByPid: boolean };
  observer: { sessionId: string; aliveByPid: boolean };
}

/**
 * Deterministic action to take after observing the restart state of a
 * group. Discriminated union — exhaustive cases prevent "did we forget
 * the observer-only branch?" ambiguity.
 *
 * Four-state policy (FS-Durability rec):
 *   - both alive          → resume_pair (rebind in place, no spawn)
 *   - only primary alive  → relaunch_observer with same groupId so the
 *                            observer can re-attach to the existing
 *                            checkpoint stream
 *   - only observer alive → mark as orphan; refuse auto-promotion. The
 *                            orchestrator-less observer cannot drive a
 *                            new phase, so the user must decide.
 *   - neither alive       → archive_dead. Auto-relaunching both would
 *                            fork the checkpoint timeline behind the
 *                            user's back; force an explicit user action.
 */
export type ReconciliationAction =
  | { type: "resume_pair"; sessionGroupId: string }
  | { type: "relaunch_observer"; sessionGroupId: string; primarySessionId: string }
  | { type: "mark_orphan"; sessionGroupId: string; reason: "observer_only_alive" }
  | { type: "archive_dead"; sessionGroupId: string; reason: "neither_alive" };

export function decideReconciliation(state: RestartState): ReconciliationAction {
  const primaryUp = state.primary.aliveByPid;
  const observerUp = state.observer.aliveByPid;
  if (primaryUp && observerUp) {
    return { type: "resume_pair", sessionGroupId: state.sessionGroupId };
  }
  if (primaryUp && !observerUp) {
    return {
      type: "relaunch_observer",
      sessionGroupId: state.sessionGroupId,
      primarySessionId: state.primary.sessionId,
    };
  }
  if (!primaryUp && observerUp) {
    return {
      type: "mark_orphan",
      sessionGroupId: state.sessionGroupId,
      reason: "observer_only_alive",
    };
  }
  return {
    type: "archive_dead",
    sessionGroupId: state.sessionGroupId,
    reason: "neither_alive",
  };
}

/**
 * Write the archive tombstone atomically *before* any directory cleanup.
 * A crash between mark and sweep leaves a consistent
 * "archived but not yet swept" state that the next reconciliation can
 * detect and finish idempotently — never a torn purge.
 */
export interface TombstonePayload {
  session_group_id: string;
  archived_at: string;
}

export function writeArchiveTombstone(
  workspaceRoot: string,
  sessionGroupId: string,
  archivedAt: string = new Date().toISOString(),
): void {
  const target = join(workspaceRoot, ".council", "ARCHIVED");
  const payload: TombstonePayload = {
    session_group_id: sessionGroupId,
    archived_at: archivedAt,
  };
  writeAtomicJson(target, payload);
}
