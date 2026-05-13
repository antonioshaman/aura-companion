/**
 * Council Mode auto-wake — per-group restart-idempotency sentinel.
 *
 * Records the most-recent checkpoint id the server successfully dispatched
 * a wake for. Two consumers:
 *
 * 1. **Pre-dispatch guard (hot path).** Before sending a wake to the
 *    observer, the orchestrator reads the sentinel. If `lastWokenCheckpointId`
 *    equals the incoming `checkpoint_id`, the wake has already been
 *    dispatched (most likely the watcher re-emitted across a restart or
 *    LRU eviction). Skip with an EC-9 log line; do not double-send.
 *
 * 2. **Restart reconcile.** On {@link SessionOrchestrator.initialize}
 *    the reconciler scans `.council/checkpoints/<phase>.json`, finds the
 *    highest-sequence checkpoint per group, compares against the
 *    sentinel. A gap means a checkpoint landed but the observer never
 *    received a wake — fire one on resume.
 *
 * File location: `<workspaceCwd>/.council/state/<groupId>-wake.json`.
 * Workspace-scoped (visible alongside checkpoints/reviews; survives a
 * `$TMPDIR` wipe; pairs with the artifacts it tracks). Written via
 * `writeAtomicJson` for the same atomicity guarantee the checkpoint
 * writer uses. Per-group rather than global — a multi-group server
 * never cross-contaminates sentinels, and a single-group teardown can
 * clean its own state directory.
 *
 * Schema versioning follows the council-types convention: a numeric
 * `schema_version` field, validated on read. A future v2 bumps the
 * accepted set in the reader; the writer always emits the current.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicJson } from "./atomic-write.js";
import {
  isBoundedToken,
  isIsoTimestamp,
} from "./council-types.js";

export const COUNCIL_WAKE_SENTINEL_SCHEMA_VERSION = 1 as const;

export interface CouncilWakeSentinel {
  schema_version: typeof COUNCIL_WAKE_SENTINEL_SCHEMA_VERSION;
  /** Checkpoint id of the most-recent successful wake dispatch. */
  last_woken_checkpoint_id: string;
  /** Sequence number of the most-recent wake — used by the gap detector
   *  on restart, so a re-emission of a stale checkpoint file with a
   *  superseded id is still recognised as already-woken. */
  last_woken_sequence: number;
  /** Wallclock ISO 8601 of the wake send. Informational; never gated on. */
  last_woken_at: string;
}

/**
 * Resolve the sentinel path for a given workspace + group id.
 *
 * The `.council/state/` subtree is created lazily by `writeAtomicJson`
 * (mkdir -p) on first write — pre-creating from the orchestrator side
 * would duplicate that work and create a TOCTOU window with the watcher
 * arming on `.council/`.
 */
export function councilWakeSentinelPath(workspaceCwd: string, sessionGroupId: string): string {
  return join(workspaceCwd, ".council", "state", `${sessionGroupId}-wake.json`);
}

/**
 * Pure: parse and validate a sentinel from raw bytes. Returns `null` on
 * any validation failure — callers treat null as "no sentinel" (which
 * means "no wake has been dispatched for this group yet" — the safe
 * default that allows the next checkpoint through the pre-dispatch gate).
 *
 * Never throws. The orchestrator's reconciler reads many sentinels at
 * startup; a corrupt one must not bring down initialization.
 */
export function parseCouncilWakeSentinel(raw: string): CouncilWakeSentinel | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.schema_version !== COUNCIL_WAKE_SENTINEL_SCHEMA_VERSION) return null;
  if (!isBoundedToken(obj.last_woken_checkpoint_id, 128)) return null;
  if (typeof obj.last_woken_sequence !== "number" || !Number.isInteger(obj.last_woken_sequence) || obj.last_woken_sequence < 0) return null;
  if (!isIsoTimestamp(obj.last_woken_at)) return null;
  return {
    schema_version: COUNCIL_WAKE_SENTINEL_SCHEMA_VERSION,
    last_woken_checkpoint_id: obj.last_woken_checkpoint_id,
    last_woken_sequence: obj.last_woken_sequence,
    last_woken_at: obj.last_woken_at,
  };
}

/**
 * Read the sentinel for a group, returning `null` if missing or invalid.
 *
 * Missing-file is the universal "no sentinel yet" case (first checkpoint
 * for the group); ENOENT is silently absorbed. Other read errors (perm
 * denied, IO failure) also resolve to `null` — the orchestrator's
 * pre-dispatch gate treats null as "no record of a prior wake" and
 * proceeds, which is the safe-fail direction (better to re-wake than
 * to silently never wake).
 */
export function readCouncilWakeSentinel(
  workspaceCwd: string,
  sessionGroupId: string,
): CouncilWakeSentinel | null {
  const path = councilWakeSentinelPath(workspaceCwd, sessionGroupId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  return parseCouncilWakeSentinel(raw);
}

/**
 * Write the sentinel for a group atomically. Caller is the dispatcher
 * after a successful wake send (Task 3 + Task 6); the sentinel records
 * "we sent this wake", not "we received a review for it" — the review
 * tracking lives on `councilGroupMeta.lastReviewedCheckpointId` and is
 * separate.
 *
 * Throws on filesystem error per `writeAtomicJson`'s contract; the
 * dispatcher's try/catch wraps the call so a sentinel-write failure
 * logs at EC-9 but does not unhook the watcher.
 */
export function writeCouncilWakeSentinel(
  workspaceCwd: string,
  sessionGroupId: string,
  payload: { checkpointId: string; sequence: number },
): void {
  const sentinel: CouncilWakeSentinel = {
    schema_version: COUNCIL_WAKE_SENTINEL_SCHEMA_VERSION,
    last_woken_checkpoint_id: payload.checkpointId,
    last_woken_sequence: payload.sequence,
    last_woken_at: new Date().toISOString(),
  };
  writeAtomicJson(councilWakeSentinelPath(workspaceCwd, sessionGroupId), sentinel);
}

/**
 * Council Review 2026-05-13 Persistence #16: delete the sentinel file
 * when a group is archived or exits. Without this, the
 * `.council/state/` directory accumulates orphan sentinel files for
 * every historical group.
 *
 * Best-effort: ENOENT (sentinel never existed, or already deleted) is
 * silently absorbed; other fs errors are propagated so the caller's
 * structured-log path can decide what to do.
 */
export function deleteCouncilWakeSentinel(
  workspaceCwd: string,
  sessionGroupId: string,
): void {
  const path = councilWakeSentinelPath(workspaceCwd, sessionGroupId);
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
