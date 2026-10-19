/**
 * Checkpoint review coverage (observer rigor, 2026-10-16).
 *
 * The observer panel used to show only what reviews SAID. A checkpoint that
 * never got a review (the pair degraded before answering, the newest-wins
 * queue superseded it, the observer replied with a probe's prose) simply
 * left no trace — prod 2026-10-15, grp_1af4cd: plan-147 was never reviewed
 * and nothing said so. And an empty review whose observer read only the
 * prose artifact looked exactly like a clean one (checkpoint 148).
 *
 * This module answers, from the files on disk, which of a group's
 * checkpoints are NOT covered by a real review:
 *   - `unreviewed` — a checkpoint of this group with no own review naming it;
 *   - `unverified` — an own review stamped `host_verification: "unverified"`.
 *
 * Checkpoint files are per phase (`<phase>-<group>.json`, overwritten by the
 * next emission of that phase) and so are review files, so the answer covers
 * the latest checkpoint of every phase — exactly what the user can still act
 * on. The spawn checkpoint has nothing to review and is never a gap; a
 * checkpoint whose wake is in flight is "reviewing", not a gap.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCheckpointPayload, parseObserverReviewPayload } from "./council-types.js";
import { OBSERVER_REVIEW_FILE_PATTERN } from "./review-watcher.js";
import type { BrowserCheckpointCoverageGap } from "./session-types.js";

export type CheckpointCoverageGap = BrowserCheckpointCoverageGap;

/** Upper bound on files read per directory (a runaway `.council/` must not
 *  turn a bootstrap request into an unbounded scan). */
const MAX_FILES = 200;

function listJson(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir).filter((f) => pattern.test(f) && !f.startsWith(".")).slice(0, MAX_FILES);
  } catch {
    return [];
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Coverage gaps of `sessionGroupId` in workspace `cwd`, oldest sequence
 * first. Never throws: unreadable files are skipped (best-effort view).
 */
export function collectCheckpointCoverageGaps(opts: {
  cwd: string;
  sessionGroupId: string;
  /** Checkpoint ids whose wake is outstanding or queued — not gaps yet. */
  inFlightCheckpointIds?: ReadonlySet<string>;
  /** Group is degraded: its unreviewed checkpoints are labelled `degraded`. */
  degraded?: boolean;
  /** Provider-native review normalisation (the pipeline's), so an
   *  observer-written review the watcher accepts is not reported missing. */
  normalizeRaw?: (raw: string, provider: "claude" | "codex") => string;
}): CheckpointCoverageGap[] {
  const { cwd, sessionGroupId } = opts;
  const reviewed = new Map<string, { phase: string; unverified: boolean }>();
  const reviewsDir = join(cwd, ".council", "reviews");
  for (const file of listJson(reviewsDir, OBSERVER_REVIEW_FILE_PATTERN)) {
    let raw = readText(join(reviewsDir, file));
    const provider = OBSERVER_REVIEW_FILE_PATTERN.exec(file)?.[1] as "claude" | "codex" | undefined;
    if (raw !== null && provider && opts.normalizeRaw) {
      try {
        raw = opts.normalizeRaw(raw, provider);
      } catch {
        // keep the raw text; the parser decides
      }
    }
    const payload = raw === null ? null : parseObserverReviewPayload(raw);
    if (!payload || payload.session_group_id !== sessionGroupId) continue;
    // W15: coverage is the OBSERVER's coverage; a second opinion alone does
    // not make a checkpoint "reviewed".
    if (payload.reviewer_role === "second") continue;
    const prior = reviewed.get(payload.checkpoint_id);
    // Any verified review of the checkpoint outranks an unverified one.
    const unverified = payload.host_verification === "unverified" && (prior?.unverified ?? true);
    reviewed.set(payload.checkpoint_id, { phase: payload.phase, unverified });
  }

  const gaps: CheckpointCoverageGap[] = [];
  const seen = new Set<string>();
  const checkpointsDir = join(cwd, ".council", "checkpoints");
  for (const file of listJson(checkpointsDir, /\.json$/)) {
    const raw = readText(join(checkpointsDir, file));
    const cp = raw === null ? null : parseCheckpointPayload(raw);
    if (!cp || cp.session_group_id !== sessionGroupId) continue;
    if (cp.phase === "spawn" || seen.has(cp.checkpoint_id)) continue;
    seen.add(cp.checkpoint_id);
    const review = reviewed.get(cp.checkpoint_id);
    const emitted = Date.parse(cp.emitted_at);
    const emittedAt = Number.isFinite(emitted) ? { emittedAt: emitted } : {};
    if (review) {
      if (review.unverified) {
        gaps.push({ checkpointId: cp.checkpoint_id, phase: cp.phase, sequence: cp.sequence, kind: "unverified", ...emittedAt });
      }
      continue;
    }
    if (opts.inFlightCheckpointIds?.has(cp.checkpoint_id)) continue;
    gaps.push({
      checkpointId: cp.checkpoint_id,
      phase: cp.phase,
      sequence: cp.sequence,
      kind: "unreviewed",
      reason: opts.degraded ? "degraded" : "no_review",
      ...emittedAt,
    });
  }
  // Unverified reviews whose checkpoint file was already overwritten still
  // count: the review is the only record left.
  for (const [checkpointId, r] of reviewed) {
    if (r.unverified && !seen.has(checkpointId)) gaps.push({ checkpointId, phase: r.phase, kind: "unverified" });
  }
  return gaps.sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER));
}
