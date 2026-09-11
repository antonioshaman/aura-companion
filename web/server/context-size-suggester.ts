/**
 * Context-size suggester — advise the user to run `/compact` before a
 * long session hits the silent-stdio failure mode observed 2026-09-09→11.
 *
 * Empirical pattern from the incident window: subprocess stability
 * correlates with jsonl size. Under CLI 2.1.266, sessions with
 * `<slug>/<cliSid>.jsonl` above ~1.5 MB start hitting silent-stdio
 * flares every ~1-2h. Below that threshold the same models on fresh
 * sessions work fine indefinitely. Compacting the session (`/compact`
 * slash command inside the CLI) reduces the working context and
 * meaningfully lowers the recurrence rate.
 *
 * This module is the pure decision-maker: given the current jsonl
 * size for a session and the last "milestone" we already advised on,
 * return the next milestone the caller should surface (or `null` when
 * the session is still below thresholds / already at ceiling). The
 * caller (drift-detector tick in `session-orchestrator.ts`) broadcasts
 * a browser toast on each new milestone.
 *
 * Milestones are additive: crossing 1.5 MB fires once, crossing 3 MB
 * fires once, etc. Sessions never fire the SAME milestone twice —
 * that would spam the browser on every tick.
 */

/**
 * Size milestones in bytes. Ordered ascending. Each milestone fires
 * at most once per session lifetime (the caller tracks
 * `lastFiredMilestoneBytes` per session).
 *
 * Rationale:
 *   - 1.5 MB: first-signal advisory. Session is comfortably past what
 *     comfortable compaction can undo, but still recoverable.
 *   - 3 MB: strong-signal — silent-stdio flares recurring roughly
 *     every hour above this size on 2026-09-11 traces.
 *   - 5 MB: urgent — chain-rotation exhaustion incidents (2026-09-10)
 *     tended to originate from sessions at this size or above.
 *   - 10 MB: last-resort — session at this size should be archived,
 *     compaction alone often insufficient.
 */
export const COMPACTION_MILESTONE_BYTES: readonly number[] = [
  1_500_000,
  3_000_000,
  5_000_000,
  10_000_000,
];

/**
 * User-visible copy for each milestone, keyed by the milestone value.
 * Kept next to the numbers so a single edit updates both.
 */
export const MILESTONE_MESSAGE: Record<number, string> = {
  1_500_000: "Session context is large (~1.5 MB). Consider running `/compact` — long sessions become prone to silent-stdio flares.",
  3_000_000: "Session context is now ~3 MB. Strongly recommend `/compact` — silence flares recur ~hourly above this size.",
  5_000_000: "Session context is ~5 MB. Please `/compact` OR archive and start fresh — chain-rotation exhaustion originates here.",
  10_000_000: "Session context is >10 MB. Compaction alone may not be enough — archive this session and start a fresh one.",
};

/**
 * One decision from {@link nextCompactionMilestone}: the new milestone
 * that just crossed (in bytes) and its user-visible message, OR
 * `null` when no new milestone applies.
 */
export interface MilestoneAdvisory {
  readonly milestoneBytes: number;
  readonly message: string;
}

/**
 * Decide whether a session's jsonl size has crossed a new compaction
 * milestone since the last check. Pure — no I/O, no side effects.
 *
 * @param currentSizeBytes  Result of `stat(jsonl).size`.
 * @param lastFiredMilestoneBytes  The highest milestone we've already
 *     advised on for this session, or `0` if none yet.
 * @param milestones  Ordered ascending list of thresholds. Defaults to
 *     {@link COMPACTION_MILESTONE_BYTES}.
 *
 * Returns the NEXT milestone the caller should fire on, or `null` when
 * the session is either below the first threshold OR already at ceiling.
 * Also `null` when current size is between two milestones and the
 * lower one has already been fired (steady state — nothing new to say).
 */
export function nextCompactionMilestone(
  currentSizeBytes: number,
  lastFiredMilestoneBytes: number,
  milestones: readonly number[] = COMPACTION_MILESTONE_BYTES,
  messages: Record<number, string> = MILESTONE_MESSAGE,
): MilestoneAdvisory | null {
  // Find the highest milestone the current size has crossed.
  let crossed = 0;
  for (const m of milestones) {
    if (currentSizeBytes >= m) crossed = m;
    else break; // milestones ordered ascending
  }
  // No milestone crossed → nothing to advise.
  if (crossed === 0) return null;
  // Already fired this or higher → steady state, no re-fire.
  if (crossed <= lastFiredMilestoneBytes) return null;
  // New milestone crossed. Return it with the message; caller
  // updates their `lastFiredMilestoneBytes` state.
  const message = messages[crossed];
  if (!message) {
    // Belt-and-braces: milestone was added to the array without
    // a matching message entry. Fail silently rather than crash.
    return null;
  }
  return { milestoneBytes: crossed, message };
}
