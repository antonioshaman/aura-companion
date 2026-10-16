/**
 * Prompt-cache telemetry — the structured `llm.turn_usage` line (audit C-6,
 * PR #346) and the `cache.prefix_change` event (W7).
 *
 * Counters are backend-neutral: Codex usage is normalised to Claude's shape
 * in codex-turn-usage.ts, so for both backends
 *   prompt_tokens   = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *   cache_hit_ratio = cache_read_input_tokens / prompt_tokens
 * Counters only — never content.
 */

export type TurnUsageStatus = "ok" | "zero" | "error" | "missing";

/** Why the cached prefix may have changed between two turns. */
export type CachePrefixChangeReason = "set_model" | "mcp_toggle" | "mcp_set_servers";

export interface TurnUsageCounters {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface TurnUsageResultLike {
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  usage?: TurnUsageCounters;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function promptTokensOf(u: TurnUsageCounters): number {
  return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
}

/**
 * `ok` frames are the only ones that belong in hit-rate aggregates. `zero`
 * covers synthesized frames (interrupt, resume bookkeeping, a Codex turn with
 * no usage notification); `error` covers failed turns.
 */
export function classifyTurnUsage(result: TurnUsageResultLike): TurnUsageStatus {
  if (!result.usage) return "missing";
  if (result.is_error) return "error";
  if (promptTokensOf(result.usage) + n(result.usage.output_tokens) === 0) return "zero";
  return "ok";
}

export interface TurnUsageLogInput {
  sessionId: string;
  backend: string;
  model: string | null | undefined;
  result: TurnUsageResultLike;
  /** When the user/agent message that opened this turn was routed (falls back to now). */
  turnStartedAt: number;
  /** Completion time of the previous countable turn; undefined when unknown. */
  previousTurnCompletedAt: number | undefined;
  /** Prefix-changing control requests since the previous turn, in order. */
  prefixChanges: CachePrefixChangeReason[];
}

export function buildTurnUsageLogLine(input: TurnUsageLogInput) {
  const u = input.result.usage ?? {};
  const usageStatus = classifyTurnUsage(input.result);
  const countable = usageStatus === "ok";
  const prompt = promptTokensOf(u);
  const minutesSinceLastTurn = input.previousTurnCompletedAt === undefined
    ? null
    : Math.round(Math.max(0, input.turnStartedAt - input.previousTurnCompletedAt) / 6_000) / 10;
  return {
    event: "llm.turn_usage" as const,
    sessionId: input.sessionId,
    backend: input.backend,
    model: input.model || null,
    subtype: input.result.subtype ?? null,
    usageStatus,
    countable,
    input_tokens: input.result.usage ? n(u.input_tokens) : null,
    output_tokens: input.result.usage ? n(u.output_tokens) : null,
    cache_read_input_tokens: input.result.usage ? n(u.cache_read_input_tokens) : null,
    cache_creation_input_tokens: input.result.usage ? n(u.cache_creation_input_tokens) : null,
    prompt_tokens: input.result.usage ? prompt : null,
    cache_hit_ratio: countable && prompt > 0 ? Number((n(u.cache_read_input_tokens) / prompt).toFixed(4)) : null,
    num_turns: input.result.num_turns ?? null,
    minutesSinceLastTurn,
    prefixChanges: input.prefixChanges,
  };
}

/**
 * W7: classify a browser→backend control message as a cached-prefix change.
 * Returns the event payload fields (no MCP config bodies — names/flags only)
 * or null. A `set_model` to the model the session already runs is a no-op
 * for the cache and returns null.
 */
export function describeCachePrefixChange(
  msg: { type: string; model?: unknown; serverName?: unknown; enabled?: unknown; servers?: unknown },
  currentModel: string | undefined,
):
  | { reason: "set_model"; from: string | null; to: string }
  | { reason: "mcp_toggle"; serverName: string; enabled: boolean }
  | { reason: "mcp_set_servers"; serverCount: number }
  | null {
  switch (msg.type) {
    case "set_model":
      if (typeof msg.model !== "string" || msg.model.length === 0 || msg.model === currentModel) return null;
      return { reason: "set_model", from: currentModel || null, to: msg.model };
    case "mcp_toggle":
      return { reason: "mcp_toggle", serverName: String(msg.serverName ?? ""), enabled: msg.enabled === true };
    case "mcp_set_servers":
      return {
        reason: "mcp_set_servers",
        serverCount: msg.servers && typeof msg.servers === "object" ? Object.keys(msg.servers).length : 0,
      };
    default:
      return null;
  }
}
