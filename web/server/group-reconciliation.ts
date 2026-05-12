import { join } from "node:path";
import { writeAtomicJson } from "./atomic-write.js";
import { COUNCIL_SCHEMA_VERSION } from "./council-types.js";

/**
 * Restart-time view of a group: did each half's CLI subprocess survive
 * the server restart? `aliveByPid` is the result of a PID check against
 * the process table — cheap, fallible (PID reuse), but sufficient when
 * the alternative is "guess". For higher confidence, callers should
 * supplement with `identityExchangeCompleted` once that channel is wired
 * (Subprocess P1-2; not yet plumbed — flagged for Phase D).
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
 * Four-state policy:
 *   - both alive          → resume_pair (rebind in place, no spawn)
 *   - only primary alive  → relaunch_observer with same groupId
 *   - only observer alive → mark as orphan; refuse auto-promotion
 *   - neither alive       → archive_dead; no auto-relaunch
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
 * Tombstone shape — versioned for the same reason every other council
 * artifact is versioned: silent migration drift is a P1 in the audit
 * trail (Persistence F2).
 */
export interface TombstonePayload {
  schema_version: typeof COUNCIL_SCHEMA_VERSION;
  session_group_id: string;
  archived_at: string;
}

/**
 * Write the archive tombstone atomically *before* any directory cleanup.
 * Per-group filename (Persistence F1) — `.council/archived/<groupId>.json` —
 * so multiple archives coexist rather than overwriting each other.
 *
 * A crash between mark and sweep leaves a consistent "archived but not
 * yet swept" state. The sweep half lives in Phase D wiring (idempotent
 * loop on startup: enumerate tombstones, clean matching checkpoint/review
 * files, unlink the tombstone last).
 */
export function writeArchiveTombstone(
  workspaceRoot: string,
  sessionGroupId: string,
  archivedAt: string = new Date().toISOString(),
): void {
  const target = join(workspaceRoot, ".council", "archived", `${sessionGroupId}.json`);
  const payload: TombstonePayload = {
    schema_version: COUNCIL_SCHEMA_VERSION,
    session_group_id: sessionGroupId,
    archived_at: archivedAt,
  };
  writeAtomicJson(target, payload);
}
