/**
 * Cost & latency scorer — extracts token usage, dollar cost, and wall-clock
 * latency from a session recording. Symmetric across the two backends, which
 * report usage in fundamentally different ways:
 *
 *   - Claude: one NDJSON `result` frame per prompt→response CYCLE, each
 *     carrying that cycle's own `usage` + `total_cost_usd` + `duration_ms`.
 *     These are PER-CYCLE (verified: `usage.output_tokens` is non-monotonic
 *     across frames), so a session total is the SUM over result frames.
 *
 *   - Codex: `thread/tokenUsage/updated` frames whose `params.tokenUsage.total`
 *     is CUMULATIVE (monotonic) and `.last` is per-turn. A session total is
 *     therefore the LAST frame's `.total` — summing would multiply-count.
 *     Codex reports no dollar cost, so cost is `unavailable`, NOT 0.
 *
 * The "absent vs zero" distinction is load-bearing: a missing-usage recording
 * must surface as `unavailable` so it can never be averaged in as a real 0.
 * An unknown backend routes to a no-throw `unhandled` count rather than
 * crashing, so a future protocol shows up as a metric, not an exception.
 */

import type { LoadedRecording, RecordingEntry } from "../recording/read-recording.js";

export type Metric =
  | { kind: "value"; value: number }
  | { kind: "unavailable"; why: string };

const val = (n: number): Metric => ({ kind: "value", value: n });
const na = (why: string): Metric => ({ kind: "unavailable", why });

export interface TokenMetrics {
  input: Metric;
  output: Metric;
  /** Cache-read / cached input tokens (Claude cache_read, Codex cachedInput). */
  cached_input: Metric;
  /** Claude-only cache-creation tokens; Codex does not report this. */
  cache_creation_input: Metric;
  /** Codex-only reasoning tokens; Claude does not report this. */
  reasoning_output: Metric;
  total: Metric;
}

export interface CostLatencyScore {
  backend: string;
  /** False when the backend discriminant was unrecognized. */
  recognized: boolean;
  tokens: TokenMetrics;
  cost_usd: Metric;
  latency: {
    /** last-entry ts − first-entry ts. Backend-agnostic, always available. */
    wall_clock_ms: Metric;
    /** Sum of Claude `result.duration_ms`; Codex does not report it. */
    api_ms: Metric;
  };
  frames: {
    result: number;
    token_usage_updated: number;
    unhandled: number;
  };
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function wallClock(entries: RecordingEntry[]): Metric {
  if (entries.length === 0) return na("no entries");
  let min = Infinity;
  let max = -Infinity;
  for (const e of entries) {
    if (e.ts < min) min = e.ts;
    if (e.ts > max) max = e.ts;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return na("no timestamps");
  return val(max - min);
}

interface Acc {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cost: number;
  apiMs: number;
  resultFrames: number;
  sawUsage: boolean;
  sawCost: boolean;
  sawApiMs: boolean;
}

function scoreClaude(rec: LoadedRecording): CostLatencyScore {
  const a: Acc = {
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, apiMs: 0,
    resultFrames: 0, sawUsage: false, sawCost: false, sawApiMs: false,
  };
  for (const e of rec.entries) {
    const r = safeParse(e.raw);
    if (!r || r.type !== "result") continue;
    const usage = r.usage;
    // The authoritative per-cycle result carries a usage object; the
    // synthetic `{data,seq,type:"result"}` envelope does not — skip it.
    if (typeof usage !== "object" || usage === null) continue;
    a.resultFrames++;
    const u = usage as Record<string, unknown>;
    const inp = num(u.input_tokens);
    const out = num(u.output_tokens);
    const cr = num(u.cache_read_input_tokens);
    const cc = num(u.cache_creation_input_tokens);
    if (inp !== null || out !== null) a.sawUsage = true;
    a.input += inp ?? 0;
    a.output += out ?? 0;
    a.cacheRead += cr ?? 0;
    a.cacheCreation += cc ?? 0;
    const cost = num(r.total_cost_usd);
    if (cost !== null) { a.cost += cost; a.sawCost = true; }
    const dur = num(r.duration_ms);
    if (dur !== null) { a.apiMs += dur; a.sawApiMs = true; }
  }
  const totalTokens = a.sawUsage ? a.input + a.output + a.cacheRead + a.cacheCreation : null;
  return {
    backend: "claude",
    recognized: true,
    tokens: {
      input: a.sawUsage ? val(a.input) : na("no result usage frames"),
      output: a.sawUsage ? val(a.output) : na("no result usage frames"),
      cached_input: a.sawUsage ? val(a.cacheRead) : na("no result usage frames"),
      cache_creation_input: a.sawUsage ? val(a.cacheCreation) : na("no result usage frames"),
      reasoning_output: na("not reported by claude"),
      total: totalTokens !== null ? val(totalTokens) : na("no result usage frames"),
    },
    cost_usd: a.sawCost ? val(a.cost) : na("no total_cost_usd in recording"),
    latency: {
      wall_clock_ms: wallClock(rec.entries),
      api_ms: a.sawApiMs ? val(a.apiMs) : na("no duration_ms in recording"),
    },
    frames: { result: a.resultFrames, token_usage_updated: 0, unhandled: 0 },
  };
}

function scoreCodex(rec: LoadedRecording): CostLatencyScore {
  // Cumulative — take the LAST tokenUsage.total, do not sum.
  let last: Record<string, unknown> | null = null;
  let count = 0;
  for (const e of rec.entries) {
    const r = safeParse(e.raw);
    if (!r || r.method !== "thread/tokenUsage/updated") continue;
    const params = r.params;
    if (typeof params !== "object" || params === null) continue;
    const tu = (params as Record<string, unknown>).tokenUsage;
    if (typeof tu !== "object" || tu === null) continue;
    const total = (tu as Record<string, unknown>).total;
    if (typeof total !== "object" || total === null) continue;
    last = total as Record<string, unknown>;
    count++;
  }
  if (last === null) {
    return {
      backend: "codex",
      recognized: true,
      tokens: {
        input: na("no tokenUsage frames"),
        output: na("no tokenUsage frames"),
        cached_input: na("no tokenUsage frames"),
        cache_creation_input: na("not reported by codex"),
        reasoning_output: na("no tokenUsage frames"),
        total: na("no tokenUsage frames"),
      },
      cost_usd: na("not reported by codex"),
      latency: { wall_clock_ms: wallClock(rec.entries), api_ms: na("not reported by codex") },
      frames: { result: 0, token_usage_updated: 0, unhandled: 0 },
    };
  }
  const m = (k: string): Metric => {
    const n = num(last![k]);
    return n !== null ? val(n) : na(`tokenUsage.total.${k} missing`);
  };
  return {
    backend: "codex",
    recognized: true,
    tokens: {
      input: m("inputTokens"),
      output: m("outputTokens"),
      cached_input: m("cachedInputTokens"),
      cache_creation_input: na("not reported by codex"),
      reasoning_output: m("reasoningOutputTokens"),
      total: m("totalTokens"),
    },
    cost_usd: na("not reported by codex"),
    latency: { wall_clock_ms: wallClock(rec.entries), api_ms: na("not reported by codex") },
    frames: { result: 0, token_usage_updated: count, unhandled: 0 },
  };
}

/**
 * Score a loaded recording. Branches on the backend discriminant; an
 * unrecognized backend returns a fully-`unavailable` score with
 * `recognized:false` and an `unhandled` frame count — never throws.
 */
export function scoreCostLatency(rec: LoadedRecording): CostLatencyScore {
  const backend = rec.backendType;
  if (backend === "claude") return scoreClaude(rec);
  if (backend === "codex") return scoreCodex(rec);
  return {
    backend: backend || "(unknown)",
    recognized: false,
    tokens: {
      input: na("unrecognized backend"),
      output: na("unrecognized backend"),
      cached_input: na("unrecognized backend"),
      cache_creation_input: na("unrecognized backend"),
      reasoning_output: na("unrecognized backend"),
      total: na("unrecognized backend"),
    },
    cost_usd: na("unrecognized backend"),
    latency: { wall_clock_ms: wallClock(rec.entries), api_ms: na("unrecognized backend") },
    frames: { result: 0, token_usage_updated: 0, unhandled: rec.entries.length },
  };
}
