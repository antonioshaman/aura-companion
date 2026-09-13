/**
 * Server-side context auto-compaction guard.
 *
 * Claude Code can report context usage without reliably kicking off a
 * compaction turn in every transport/version combination. This small pure
 * decision-maker lets the bridge synthesize `/compact` once a session crosses
 * the high-water mark, then re-arms only after usage drops comfortably.
 */

export const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 85;
export const DEFAULT_AUTO_COMPACT_REARM_PERCENT = 70;

/** Per-model token accounting as it arrives on a `result` frame's `modelUsage`. */
export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
}

/**
 * Fraction of the context window occupied, as an integer 0..100, or `null` when
 * no model reports a positive `contextWindow` (nothing to measure yet).
 *
 * Two corrections over the naive `(inputTokens + outputTokens) / contextWindow`
 * that shipped first and made the gauge — and therefore the auto-compact gate —
 * useless on exactly the sessions that needed it:
 *
 *   1. **Cache tokens are resident in the window.** `cacheReadInputTokens` and
 *      `cacheCreationInputTokens` are the bulk of a resumed or long session's
 *      prompt; prompt caching is a billing/latency optimisation, NOT a
 *      context-size reduction. Omitting them makes a near-full cache-heavy
 *      session read ~0%, so it never crosses the threshold. They MUST be summed.
 *   2. **Pick the primary model, don't let object key order decide.** A `result`
 *      frame can carry several models (e.g. a Haiku sub-agent beside the primary
 *      Opus). The old loop overwrote the percent on every iteration, so the
 *      stored value was whichever model happened to be last — flapping between
 *      the primary's fraction and a tiny sub-agent overflowing its own 200K
 *      window. We use the primary model's window when present, else fall back to
 *      the max per-model fraction so the result is order-independent.
 *
 * Note: `modelUsage` is cumulative across a turn's internal iterations, so a
 * long multi-request turn can overshoot 100% before clamping. That is
 * acceptable for a `>= threshold` gate (erring toward compacting a genuinely
 * heavy session); it is not a precise live-occupancy readout.
 */
export function computeContextUsedPercent(
  modelUsage: Record<string, ModelUsageEntry> | undefined,
  primaryModel?: string,
): number | null {
  if (!modelUsage) return null;

  const pctFor = (u: ModelUsageEntry | undefined): number | null => {
    if (!u || !(u.contextWindow > 0)) return null;
    const occupied =
      u.inputTokens +
      u.outputTokens +
      u.cacheReadInputTokens +
      u.cacheCreationInputTokens;
    const pct = Math.round((occupied / u.contextWindow) * 100);
    return Math.max(0, Math.min(pct, 100));
  };

  if (primaryModel) {
    const primary = pctFor(modelUsage[primaryModel]);
    if (primary !== null) return primary;
  }

  let best: number | null = null;
  for (const usage of Object.values(modelUsage)) {
    const pct = pctFor(usage);
    if (pct !== null) best = best === null ? pct : Math.max(best, pct);
  }
  return best;
}

export type AutoCompactDecision =
  | { kind: "fire" }
  | { kind: "rearm" }
  | { kind: "hold" };

export function shouldAutoCompactContext(args: {
  contextUsedPercent: number;
  alreadyFired: boolean;
  isCompacting: boolean;
  thresholdPercent?: number;
  rearmPercent?: number;
}): AutoCompactDecision {
  const threshold = args.thresholdPercent ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
  const rearm = args.rearmPercent ?? DEFAULT_AUTO_COMPACT_REARM_PERCENT;
  const pct = Math.max(0, Math.min(100, Math.round(args.contextUsedPercent)));

  if (args.isCompacting) return { kind: "hold" };
  if (args.alreadyFired) {
    return pct <= rearm ? { kind: "rearm" } : { kind: "hold" };
  }
  return pct >= threshold ? { kind: "fire" } : { kind: "hold" };
}
