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
 * Return the next model in the chain after `current`, or `null` if
 * `current` is not in the chain or is already the last entry. `null`
 * means "no fallback available" — caller should relaunch on the same
 * model rather than downgrade blindly.
 */
export function nextModelInChain(current: string | undefined | null): string | null {
  if (!current) return null;
  const idx = CLAUDE_MODEL_FALLBACK_CHAIN.indexOf(current);
  if (idx < 0) return null;
  if (idx >= CLAUDE_MODEL_FALLBACK_CHAIN.length - 1) return null;
  return CLAUDE_MODEL_FALLBACK_CHAIN[idx + 1];
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
