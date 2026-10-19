import {
  BROKEN_MODEL_SUBSTITUTIONS,
  type BrokenModelSubstitution,
  resolveModelSubstitution,
} from "./broken-model-substitution.js";

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
export function nextModelInChain(
  current: string | undefined | null,
  substitutions: readonly BrokenModelSubstitution[] = BROKEN_MODEL_SUBSTITUTIONS,
  chain: readonly string[] = CLAUDE_MODEL_FALLBACK_CHAIN,
): string | null {
  if (!current) return null;
  const idx = chain.indexOf(current);
  if (idx < 0) return null;
  for (const candidate of chain.slice(idx + 1)) {
    if (resolveModelSubstitution(candidate, substitutions) === null) {
      return candidate;
    }
  }
  return null;
}

/**
 * Cross-check the two hand-maintained model tables — the fallback chain
 * (this file) and {@link BROKEN_MODEL_SUBSTITUTIONS} — and return one
 * human-readable problem per violated invariant (empty = in sync).
 *
 * Invariants (each one, if broken, reopens a known failure mode):
 *  1. The chain has no duplicate ids (an `indexOf`-based successor lookup
 *     would loop back to the first occurrence).
 *  2. Each substitution `from` appears once and never maps to itself.
 *  3. A substitution `to` is not itself a substituted `from` — the spawn
 *     rewrite is single-hop, so a chained entry would spawn the broken model.
 *  4. `nextModelInChain` only ever yields a strictly-later, NON-substituted
 *     model. A substituted successor is rewritten on relaunch, often straight
 *     back to the model that just failed — a rotation that never terminates
 *     (2026-09-09 Silent Cliff, default model). The skip in
 *     `nextModelInChain` guarantees this today; the check keeps a future
 *     edit to either table (or to the skip) from regressing it silently.
 */
export function findModelTableInconsistencies(
  chain: readonly string[] = CLAUDE_MODEL_FALLBACK_CHAIN,
  substitutions: readonly BrokenModelSubstitution[] = BROKEN_MODEL_SUBSTITUTIONS,
): string[] {
  const problems: string[] = [];

  const seenChain = new Set<string>();
  for (const model of chain) {
    if (seenChain.has(model)) problems.push(`fallback chain lists ${model} more than once`);
    seenChain.add(model);
  }

  const froms = new Set<string>();
  for (const sub of substitutions) {
    if (froms.has(sub.from)) problems.push(`substitution table lists ${sub.from} more than once`);
    froms.add(sub.from);
    if (sub.from === sub.to) problems.push(`substitution ${sub.from} -> ${sub.to} maps a model to itself`);
  }
  for (const sub of substitutions) {
    if (sub.from !== sub.to && froms.has(sub.to)) {
      problems.push(
        `substitution ${sub.from} -> ${sub.to} targets another substituted model ` +
          `(the spawn rewrite is single-hop, so ${sub.to} would launch broken)`,
      );
    }
  }

  chain.forEach((model, idx) => {
    const next = nextModelInChain(model, substitutions, chain);
    if (next === null) return;
    if (chain.indexOf(next) <= idx) {
      problems.push(`nextModelInChain(${model}) -> ${next} does not move down the chain`);
    }
    if (resolveModelSubstitution(next, substitutions) !== null) {
      problems.push(
        `nextModelInChain(${model}) -> ${next}, which BROKEN_MODEL_SUBSTITUTIONS rewrites on relaunch ` +
          `(the downgrade would bounce back instead of terminating)`,
      );
    }
  });

  return problems;
}

/**
 * Throw when the live tables are out of sync — run once at module load so a
 * bad edit fails the first test that imports this module (and server start)
 * with a named error, instead of silently reopening the non-terminating
 * rotation. Exported for tests with injected tables.
 */
export function assertModelTablesInSync(
  chain: readonly string[] = CLAUDE_MODEL_FALLBACK_CHAIN,
  substitutions: readonly BrokenModelSubstitution[] = BROKEN_MODEL_SUBSTITUTIONS,
): void {
  const problems = findModelTableInconsistencies(chain, substitutions);
  if (problems.length > 0) {
    throw new Error(
      "CLAUDE_MODEL_FALLBACK_CHAIN and BROKEN_MODEL_SUBSTITUTIONS are out of sync:\n  - " +
        problems.join("\n  - "),
    );
  }
}

assertModelTablesInSync();

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
