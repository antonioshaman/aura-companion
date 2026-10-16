/**
 * W6 — per-turn token usage for Codex sessions.
 *
 * Codex app-server reports usage via `thread/tokenUsage/updated`:
 *   { threadId, turnId, tokenUsage: { total, last, modelContextWindow } }
 * where `last` is the most recent MODEL REQUEST (a turn with tool calls makes
 * several requests) and `total` is cumulative over the whole thread.
 *
 * Observed on real recordings (session 17fbf63f, 2026-10-14/15, see
 * `__fixtures__/codex-token-usage/`):
 *  - every notification may be delivered twice (identical `total`);
 *  - on thread resume the previous turn's usage is replayed (old `turnId`);
 *  - a duplicate may land AFTER `turn/completed`.
 * So per-turn usage = sum of `last` over notifications whose cumulative
 * `total.totalTokens` moved (strictly a new request), keyed by `turnId`.
 * This equals the delta of `total` across the turn on every fixture.
 *
 * ── Accounting normalisation (documented formula) ──────────────────────────
 * Claude:  prompt = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *          (input_tokens EXCLUDES cached tokens).
 * Codex:   inputTokens is the WHOLE prompt (cached included); cachedInputTokens
 *          is the cache-hit part; cacheWriteInputTokens (newer app-server) the
 *          part written to cache. outputTokens already includes reasoning.
 * Mapping:
 *   cache_read_input_tokens     = cachedInputTokens
 *   cache_creation_input_tokens = cacheWriteInputTokens (0 when absent)
 *   input_tokens                = max(0, inputTokens − cachedInputTokens − cacheWriteInputTokens)
 *   output_tokens               = outputTokens
 * so `input + cache_read + cache_creation` is the prompt size for BOTH
 * backends and cache-hit ratio = cache_read / prompt is comparable.
 */

export interface CodexUsageCounters {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface NormalizedTurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function normalizeCodexUsage(u: CodexUsageCounters): NormalizedTurnUsage {
  const input = num(u.inputTokens);
  const cached = num(u.cachedInputTokens);
  const written = num(u.cacheWriteInputTokens);
  return {
    input_tokens: Math.max(0, input - cached - written),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    output_tokens: num(u.outputTokens),
  };
}

/** How many completed turn ids to remember for late-duplicate rejection. */
const COMPLETED_MEMORY = 32;

export class CodexTurnUsageAccumulator {
  private lastTotalTokens: number | null = null;
  private bucket: { turnId: string; sum: Required<Pick<CodexUsageCounters, "inputTokens" | "cachedInputTokens" | "cacheWriteInputTokens" | "outputTokens">> } | null = null;
  private completed: string[] = [];
  /** Full prompt size (cached included) of the most recent model request. */
  lastPromptTokens: number | null = null;

  /** Feed a `thread/tokenUsage/updated` params object. */
  onTokenUsage(params: Record<string, unknown>): void {
    const tokenUsage = params.tokenUsage as { total?: CodexUsageCounters; last?: CodexUsageCounters } | undefined;
    const total = tokenUsage?.total;
    const last = tokenUsage?.last;
    if (!total || !last) return;
    const totalTokens = num(total.totalTokens);
    // Duplicate delivery / resume replay: the cumulative counter did not move,
    // so no new model request happened.
    if (this.lastTotalTokens !== null && totalTokens === this.lastTotalTokens) return;
    this.lastTotalTokens = totalTokens;
    this.lastPromptTokens = num(last.inputTokens);

    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    if (!turnId || this.completed.includes(turnId)) return;
    if (this.bucket?.turnId !== turnId) {
      this.bucket = { turnId, sum: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 } };
    }
    this.bucket.sum.inputTokens += num(last.inputTokens);
    this.bucket.sum.cachedInputTokens += num(last.cachedInputTokens);
    this.bucket.sum.cacheWriteInputTokens += num(last.cacheWriteInputTokens);
    this.bucket.sum.outputTokens += num(last.outputTokens);
  }

  /**
   * Claim the accumulated usage for a completing turn. Returns null when no
   * usage was seen for it (interrupted before any request, or a duplicate
   * `turn/completed` whose usage was already claimed).
   */
  takeForTurn(turnId: string | null): NormalizedTurnUsage | null {
    if (!turnId) return null;
    if (!this.completed.includes(turnId)) {
      this.completed.push(turnId);
      if (this.completed.length > COMPLETED_MEMORY) this.completed.shift();
    }
    if (this.bucket?.turnId !== turnId) return null;
    const usage = normalizeCodexUsage(this.bucket.sum);
    this.bucket = null;
    return usage;
  }
}
