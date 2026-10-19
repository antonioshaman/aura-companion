/**
 * Context-window occupancy — the ONE formula behind `context_used_percent`.
 *
 * Shared by the browser (`web/src/ws.ts`, the live context meter) and the
 * server (`web/server/ws-bridge.ts`, the persisted `session.state` value that
 * `/api/sessions` and a reconnecting browser's `session_init` see), so the two
 * can never disagree. Pure: no imports, safe to bundle into the frontend.
 *
 * Why this shape (see #196):
 *  - Numerator = the per-turn occupancy of the MAIN thread's latest assistant
 *    frame: fresh input + cache-read + cache-write. Cache tokens ARE resident
 *    in the window (caching is a billing optimisation, not a size reduction);
 *    output tokens are not counted (they become next turn's input).
 *  - It must DROP after a `/compact`, so it comes from per-turn `usage`, never
 *    from the result frame's `modelUsage` counters — those accumulate across the
 *    whole session (cache-read alone can reach many times the window), so a
 *    sum over them overshoots and can only climb (the closed PR #195 approach).
 *  - Denominator = the LARGEST `contextWindow` in the result's `modelUsage`, so
 *    a small-window side model (title Haiku, subagent) can neither shrink the
 *    window nor let object key order decide the value.
 */

/** Per-request token counters as carried on an assistant frame's `usage`. */
export interface ContextUsageCounters {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Tokens actually resident in the model's context window for one turn. */
export function contextTokensFromUsage(u: ContextUsageCounters): number {
  return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
}

/**
 * Whether an assistant frame's `usage` should update the occupancy sample.
 *
 * Rejected:
 *  - missing or all-zero usage — the server synthesizes an interrupted-stream
 *    assistant frame with usage {0,0,0,0}; tracking it zeroed the meter until
 *    the next real turn (WS-3 A-3 / prompt-cache audit C-7);
 *  - `streamStatus: "interrupted"` frames, for the same reason;
 *  - Task subagent frames (`parent_tool_use_id` set) — a subagent runs its own,
 *    unrelated context; counting it would make the main session's meter jump.
 */
export function shouldTrackContextUsage(frame: {
  usage?: ContextUsageCounters | null;
  parentToolUseId?: string | null;
  streamStatus?: string;
}): boolean {
  if (frame.parentToolUseId) return false;
  if (frame.streamStatus === "interrupted") return false;
  const u = frame.usage;
  if (!u) return false;
  return (
    n(u.input_tokens) + n(u.output_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
  ) > 0;
}

/**
 * The model's declared context window from a result frame's `modelUsage`:
 * the largest positive `contextWindow` across models, or 0 when none is known.
 */
export function largestContextWindow(
  modelUsage: Record<string, { contextWindow?: number }> | null | undefined,
): number {
  if (!modelUsage) return 0;
  let max = 0;
  for (const u of Object.values(modelUsage)) {
    const w = u?.contextWindow;
    if (typeof w === "number" && Number.isFinite(w) && w > max) max = w;
  }
  return max;
}

/**
 * Integer 0..100 occupancy, or `null` until BOTH the per-turn tokens and the
 * window are known — the assistant frame (numerator) and the result frame
 * (denominator) arrive in either order, and a partial value would flash a
 * wrong reading or clobber a good persisted one.
 */
export function contextUsedPercent(
  tokens: number | null | undefined,
  window: number | null | undefined,
): number | null {
  if (tokens == null || !Number.isFinite(tokens)) return null;
  if (!window || !Number.isFinite(window) || window <= 0) return null;
  return Math.max(0, Math.min(Math.round((tokens / window) * 100), 100));
}
