/**
 * When a persisted auto-resume banner no longer describes reality (LLM auth
 * task 13, S3-AC4). Pure and browser-safe: the server uses it to clear the
 * state on browser open, the client to hide the banner between server
 * updates — one rule, two callers.
 *
 * - Paused (repeat-limit guard): nothing will fire, so once the window the
 *   banner names has reset, "limit still active" is false → stale.
 * - Scheduled: stale only when the resume is long overdue (its timer was
 *   lost, e.g. the process died) — between reset and fire it is legit.
 *
 * EC-38: wall-clock comparisons. A backward clock jump keeps the banner
 * visible longer, which is safe because the banner never gates sending.
 */
export const AUTO_RESUME_OVERDUE_GRACE_MS = 10 * 60_000;

export function isAutoResumeStale(
  state: { resetAt: number; fireAt: number; paused?: boolean },
  now: number,
): boolean {
  if (state.paused) return now >= state.resetAt;
  return now >= state.fireAt + AUTO_RESUME_OVERDUE_GRACE_MS;
}
