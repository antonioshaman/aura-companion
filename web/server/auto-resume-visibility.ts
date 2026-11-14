/**
 * Usage-limit banner visibility vs the auto-resume schedule (LLM auth task
 * 13, S3-AC4). Pure and browser-safe: the server decides what to clear on
 * browser open / incoming message, the client hides the banner between
 * server updates — one rule, two callers.
 *
 * The banner names a window; once `now >= resetAt` it is no longer true, so
 * it is hidden — independent of when the scheduled resume fires (that lags
 * the reset by 60–120 s jitter and keeps running). Observer STOP, checkpoint
 * 199: visibility must end at the reset, not at fire time.
 *
 * EC-38: wall-clock comparisons. A backward clock jump keeps the banner
 * visible longer, which is safe because the banner never gates sending.
 */
export const AUTO_RESUME_OVERDUE_GRACE_MS = 10 * 60_000;

interface AutoResumeFacts {
  resetAt: number;
  fireAt: number;
  paused?: boolean;
}

export function isAutoResumeBannerVisible(state: AutoResumeFacts, now: number): boolean {
  return now < state.resetAt;
}

/**
 * What the server does with a banner whose window reset:
 * - `none`   — window still running;
 * - `hide`   — clear the banner, keep the pending resume (it fires shortly);
 * - `cancel` — nothing will fire any more: paused by the repeat-limit guard,
 *              or long overdue (its timer was lost).
 */
export type AutoResumeStaleAction = "none" | "hide" | "cancel";

export function autoResumeStaleAction(state: AutoResumeFacts, now: number): AutoResumeStaleAction {
  if (isAutoResumeBannerVisible(state, now)) return "none";
  if (state.paused) return "cancel";
  return now >= state.fireAt + AUTO_RESUME_OVERDUE_GRACE_MS ? "cancel" : "hide";
}
