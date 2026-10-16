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
/** Bound on per-thread state (main + collab subagent threads). */
const THREAD_MEMORY = 64;

type Sum = { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number };

interface ThreadState {
  lastTotalTokens: number | null;
  lastPromptTokens: number | null;
  bucket: { turnId: string; sum: Sum } | null;
  completed: string[];
}

/**
 * Keyed by `threadId`: collab subagents run on their own threads with their
 * own cumulative `total`, so duplicate detection and the per-turn bucket are
 * per thread. A notification without a threadId (older app-server) shares
 * the "" key. Callers decide which thread's usage feeds the turn result
 * (the adapter claims only the main thread's).
 */
export class CodexTurnUsageAccumulator {
  private threads = new Map<string, ThreadState>();

  private stateFor(threadId: string | undefined): ThreadState {
    const key = threadId ?? "";
    let st = this.threads.get(key);
    if (!st) {
      st = { lastTotalTokens: null, lastPromptTokens: null, bucket: null, completed: [] };
      this.threads.set(key, st);
      if (this.threads.size > THREAD_MEMORY) {
        const oldest = this.threads.keys().next().value;
        if (oldest !== undefined && oldest !== key) this.threads.delete(oldest);
      }
    }
    return st;
  }

  /**
   * Feed a `thread/tokenUsage/updated` params object. Returns true when it was
   * a NEW model request (not a duplicate / replay) — callers use this to avoid
   * re-applying session-level side effects for duplicates.
   */
  onTokenUsage(params: Record<string, unknown>): boolean {
    const tokenUsage = params.tokenUsage as { total?: CodexUsageCounters; last?: CodexUsageCounters } | undefined;
    const total = tokenUsage?.total;
    const last = tokenUsage?.last;
    if (!total || !last) return false;
    const st = this.stateFor(typeof params.threadId === "string" ? params.threadId : undefined);
    const totalTokens = num(total.totalTokens);
    // Duplicate delivery / resume replay: this thread's cumulative counter did
    // not move, so no new model request happened.
    if (st.lastTotalTokens !== null && totalTokens === st.lastTotalTokens) return false;
    st.lastTotalTokens = totalTokens;
    st.lastPromptTokens = num(last.inputTokens);

    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    if (!turnId || st.completed.includes(turnId)) return true;
    if (st.bucket?.turnId !== turnId) {
      st.bucket = { turnId, sum: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 } };
    }
    st.bucket.sum.inputTokens += num(last.inputTokens);
    st.bucket.sum.cachedInputTokens += num(last.cachedInputTokens);
    st.bucket.sum.cacheWriteInputTokens += num(last.cacheWriteInputTokens);
    st.bucket.sum.outputTokens += num(last.outputTokens);
    return true;
  }

  /** Full prompt size (cached included) of a thread's most recent model request. */
  lastPromptTokensFor(threadId: string | undefined): number | null {
    return this.threads.get(threadId ?? "")?.lastPromptTokens ?? null;
  }

  /**
   * Claim the accumulated usage for a completing turn on `threadId`. Returns
   * null when no usage was seen for it (interrupted before any request, a
   * duplicate `turn/completed` whose usage was already claimed, or a turn id
   * that belongs to another thread).
   */
  takeForTurn(turnId: string | null, threadId: string | undefined): NormalizedTurnUsage | null {
    if (!turnId) return null;
    const st = this.stateFor(threadId);
    if (!st.completed.includes(turnId)) {
      st.completed.push(turnId);
      if (st.completed.length > COMPLETED_MEMORY) st.completed.shift();
    }
    if (st.bucket?.turnId !== turnId) return null;
    const usage = normalizeCodexUsage(st.bucket.sum);
    st.bucket = null;
    return usage;
  }
}
