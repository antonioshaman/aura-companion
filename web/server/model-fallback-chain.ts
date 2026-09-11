/**
 * Model fallback chain + rate-limit-class error classification.
 *
 * When a Claude CLI subprocess produces a rate-limit / out-of-credits /
 * unknown-model error, the orchestrator can downgrade to the next model
 * in the chain and relaunch with `--resume`, salvaging the conversation
 * without operator intervention. Chain is closed and ordered from most
 * capable to least; a model outside the chain (custom `claude-*-*` id,
 * a Sonnet variant not listed, etc.) has no fallback target and the
 * chain returns `null` — the orchestrator then just relaunches on the
 * same model like today.
 *
 * The classifier is deliberately conservative: it only matches on
 * substrings that reliably identify a fallback-worthy error surface
 * emitted by the Claude API through the stream-json protocol. Anything
 * ambiguous returns `null` and the message flows through as a normal
 * assistant / error frame.
 */

import { resolveModelSubstitution } from "./broken-model-substitution";

/**
 * Fallback chain from strongest to fallback. Each entry MUST be a model
 * id the Claude CLI accepts on `--model`. The chain is closed — adding
 * a new model requires updating this array; the classifier deliberately
 * does NOT synthesize downgrade targets from name patterns because the
 * "next model" is a product decision, not a heuristic on the model id.
 */
export const CLAUDE_MODEL_FALLBACK_CHAIN: readonly string[] = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

/**
 * Return the next LAUNCHABLE model in the chain after `current`, or
 * `null` if `current` is not in the chain or has no non-substituted
 * successor. `null` means "no fallback available" — caller should
 * relaunch on the same model rather than downgrade blindly.
 *
 * SINGLE SOURCE OF TRUTH: a successor that is itself a
 * {@link BROKEN_MODEL_SUBSTITUTIONS} `from` is skipped, because the
 * relaunch path (`cli-launcher.applyBrokenModelSubstitution`) would
 * rewrite it right back to its substitute — often a model EARLIER in
 * the chain. Without this skip the chain can bounce forever: e.g.
 * `next(opus-4-8) → opus-4-7`, but `opus-4-7` is substituted back to
 * `opus-4-8`, so the "downgrade" respawns the exact model that just
 * failed and the rotation never terminates (2026-09-09 Silent Cliff
 * for the default model). Skipping substituted entries guarantees the
 * returned model both (a) actually spawns as announced and (b) is a
 * strictly-further step down the chain.
 */
export function nextModelInChain(current: string | undefined | null): string | null {
  if (!current) return null;
  const idx = CLAUDE_MODEL_FALLBACK_CHAIN.indexOf(current);
  if (idx < 0) return null;
  for (let i = idx + 1; i < CLAUDE_MODEL_FALLBACK_CHAIN.length; i++) {
    const candidate = CLAUDE_MODEL_FALLBACK_CHAIN[i];
    // Skip a successor the substitution table would rewrite on relaunch —
    // it would bounce back to its target and defeat the downgrade.
    if (resolveModelSubstitution(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Module-load canary (mirrors `observer-permissions.ts`'s disjoint check):
 * the fallback chain and the broken-model table are two hand-maintained
 * lists that MUST agree. The load-bearing invariant is that
 * `nextModelInChain` only ever yields a launchable, non-substituted model.
 * A future edit to either table (a new broken entry, a chain reorder) that
 * violates it fails HERE at import time with a named error, instead of
 * silently reopening the non-terminating-rotation P1 with zero signal.
 */
(function assertChainYieldsOnlyLaunchableModels(): void {
  for (const model of CLAUDE_MODEL_FALLBACK_CHAIN) {
    const next = nextModelInChain(model);
    if (next !== null && resolveModelSubstitution(next)) {
      throw new Error(
        `model-fallback-chain invariant violated: nextModelInChain(${model}) → ${next}, ` +
          `which is a BROKEN_MODEL_SUBSTITUTIONS.from and would bounce back on relaunch. ` +
          `Keep CLAUDE_MODEL_FALLBACK_CHAIN and BROKEN_MODEL_SUBSTITUTIONS in sync.`,
      );
    }
  }
})();

/** One session's silence-recurrence bookkeeping — see `session-orchestrator.ts:silenceRecurrenceCounts`. */
export interface SilenceRecurrenceRecord {
  count: number;
  lastSilentModel: string;
}

/** Decision from {@link computeSilenceRotation} for one silence event. */
export interface SilenceRotationDecision {
  /**
   * The bookkeeping record to persist AFTER this silence event, OR
   * `null` when the caller should DELETE the entry (either because a
   * rotation just happened — new model gets a clean scorecard — or
   * because no rotation is planned but the map should reset for a
   * different reason). Caller writes / deletes per this value.
   */
  newRecord: SilenceRecurrenceRecord | null;
  /**
   * Model id to rotate to via `launcher.setModel` BEFORE the next
   * kill+respawn, or `null` when no rotation should happen (either
   * threshold not reached, or the current model is not in the chain
   * / already at the tail).
   */
  rotateTo: string | null;
}

/**
 * Pure decision helper for the recurring-silence model-rotation loop
 * in `session-orchestrator.ts:handleBackendSilent`. Extracted so the
 * counting + threshold + chain-lookup rules are unit-testable without
 * the full orchestrator setup.
 *
 * Rules:
 *   - Same session going silent AGAIN on the SAME model → bump count.
 *   - Model changed between silences → reset count to 1.
 *   - Count reaches `threshold` AND chain has a successor → return
 *     `rotateTo: <next>` with `newRecord: null` (caller clears map).
 *   - Count reaches `threshold` but no chain successor → keep bumping
 *     (`newRecord: bumped, rotateTo: null`); rotation exhausted.
 */
export function computeSilenceRotation(
  prev: SilenceRecurrenceRecord | undefined,
  currentModel: string,
  threshold: number,
  chainNext: (m: string) => string | null = nextModelInChain,
): SilenceRotationDecision {
  const bumped: SilenceRecurrenceRecord =
    prev && prev.lastSilentModel === currentModel
      ? { count: prev.count + 1, lastSilentModel: currentModel }
      : { count: 1, lastSilentModel: currentModel };
  if (bumped.count >= threshold) {
    const next = chainNext(currentModel);
    if (next) {
      // Rotation triggered — new model gets a clean scorecard.
      return { newRecord: null, rotateTo: next };
    }
    // Threshold reached but no chain successor — keep bumping,
    // no rotation. Caller may separately notice via
    // `newRecord.count >= threshold && rotateTo === null` and
    // escalate to operator (e.g. "model rotation exhausted").
  }
  return { newRecord: bumped, rotateTo: null };
}

/** Closed classifier reason set — extend by adding a case + regex, never widen the union in-place. */
export type FallbackReason =
  | "rate_limit"
  | "out_of_credits"
  | "unknown_model"
  | "model_not_available";

/**
 * Classify raw error / assistant text as a fallback-worthy error, or
 * return `null` if it looks like a normal message. Substring matching
 * is intentionally conservative — false positives here trigger real
 * subprocess kill + model downgrade, so we err on the side of "flow
 * through as normal frame".
 *
 * Matches on lowercase substrings of the concatenated text/error body.
 * Callers should join all text blocks before passing in.
 */
export function classifyFallbackReason(text: string): FallbackReason | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // Rate limit — Claude API returns "you've hit your session limit"
  // (per-model 5-hour window) and "rate_limit" (HTTP 429). Both mean
  // this specific model is temporarily unavailable to this account.
  if (
    lower.includes("hit your session limit") ||
    lower.includes("rate_limit") ||
    lower.includes("rate limit exceeded")
  ) {
    return "rate_limit";
  }

  // Out of credits — Anthropic billing exhaustion. Retrying is
  // pointless; downgrading MAY hit a model that's still in a paid
  // tier, but often the account is fully out.
  if (
    lower.includes("out of credits") ||
    lower.includes("insufficient credit") ||
    lower.includes("credit_balance_too_low")
  ) {
    return "out_of_credits";
  }

  // Unknown model — CLI accepted `--model X` at spawn but the API
  // doesn't recognize the id. Common cause: preview model id in UI
  // that hasn't been released yet, or codename that gates on a
  // feature flag. Downgrade to a stable model.
  if (
    lower.includes("unknown model") ||
    lower.includes("model not found") ||
    lower.includes("invalid model")
  ) {
    return "unknown_model";
  }

  // Model not available — model exists but this account tier can't
  // reach it (opus for a free tier, preview for public etc).
  if (
    lower.includes("model_not_available") ||
    lower.includes("not available on your plan") ||
    lower.includes("access denied to model")
  ) {
    return "model_not_available";
  }

  return null;
}
