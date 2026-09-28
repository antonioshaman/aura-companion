/**
 * Metric extraction from agent output streams (P6/D2):
 *
 *  - Claude `claude -p --output-format stream-json --verbose` NDJSON;
 *  - Codex `codex exec --json` JSONL events;
 *  - Companion browser-WS messages (Aura variants — same `assistant`/`result`
 *    shapes for both backends, the bridge normalises Codex).
 *
 * Also detects subscription/API usage limits, so the runner can pause and
 * retry the cell instead of recording a false failure.
 *
 * Claude's `result.total_cost_usd` is CUMULATIVE per CLI process (verified on
 * real recordings: 1.35 → 1.98 → 6.10 …) while `usage` is per query — so
 * cost takes the running max (summing segments if the process restarted and
 * the counter dropped) and tokens are summed.
 *
 * Pure functions over already-read text/objects. Firewall-clean.
 */

import type { AgentMetrics } from "./cells.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function emptyMetrics(): AgentMetrics {
  return {
    turns: null,
    tool_calls: 0,
    tokens_in: null,
    tokens_out: null,
    tokens_cache_read: null,
    tokens_cache_write: null,
    cost_usd: null,
    models: [],
  };
}

export function parseJsonLines(text: string): Obj[] {
  const out: Obj[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (isObj(v)) out.push(v);
    } catch {
      // partial / non-JSON line (stderr noise) — skip
    }
  }
  return out;
}

const add = (a: number | null, b: number | null): number | null => (b === null ? a : (a ?? 0) + b);

/** Accumulates Claude-shaped `assistant` + `result` payloads (CLI stream or
 *  Companion browser messages — the result body is the same CLI object). */
export class ClaudeMetricsAccumulator {
  readonly metrics = emptyMetrics();
  private costSegments = 0;
  private costCurrent = 0;
  results = 0;
  lastResult: Obj | null = null;

  assistant(message: unknown): void {
    if (!isObj(message)) return;
    if (typeof message.model === "string" && !this.metrics.models.includes(message.model)) {
      this.metrics.models.push(message.model);
    }
    const content = message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) if (isObj(block) && block.type === "tool_use") this.metrics.tool_calls++;
  }

  result(r: unknown): void {
    if (!isObj(r)) return;
    this.results++;
    this.lastResult = r;
    const m = this.metrics;
    m.turns = add(m.turns, num(r.num_turns));
    const usage = isObj(r.usage) ? r.usage : {};
    m.tokens_in = add(m.tokens_in, num(usage.input_tokens));
    m.tokens_out = add(m.tokens_out, num(usage.output_tokens));
    m.tokens_cache_read = add(m.tokens_cache_read, num(usage.cache_read_input_tokens));
    m.tokens_cache_write = add(m.tokens_cache_write, num(usage.cache_creation_input_tokens));
    const cost = num(r.total_cost_usd);
    if (cost !== null) {
      // Cumulative counter; a drop means the CLI process restarted.
      if (cost < this.costCurrent) this.costSegments += this.costCurrent;
      this.costCurrent = cost;
      m.cost_usd = this.costSegments + this.costCurrent;
    }
  }
}

export interface ClaudeStreamSummary {
  metrics: AgentMetrics;
  /** The `system/init` frame (isolation evidence). */
  init: Obj | null;
  /** Hook lifecycle events seen (`--include-hook-events`); naked runs must have none. */
  hookEvents: number;
  /** A `result` frame arrived and it was not an error. */
  finishedOk: boolean;
  resultText: string;
}

export function summarizeClaudeStream(text: string): ClaudeStreamSummary {
  const acc = new ClaudeMetricsAccumulator();
  let init: Obj | null = null;
  let hookEvents = 0;
  for (const f of parseJsonLines(text)) {
    if (f.type === "system") {
      if (f.subtype === "init" && !init) init = f;
      else if (typeof f.subtype === "string" && f.subtype.startsWith("hook_")) hookEvents++;
    } else if (f.type === "assistant") acc.assistant(f.message);
    else if (f.type === "result") acc.result(f);
  }
  if (init && typeof init.model === "string" && !acc.metrics.models.includes(init.model)) {
    acc.metrics.models.unshift(init.model);
  }
  const last = acc.lastResult;
  return {
    metrics: acc.metrics,
    init,
    hookEvents,
    finishedOk: !!last && last.is_error !== true && last.subtype === "success",
    resultText: typeof last?.result === "string" ? last.result : "",
  };
}

const CODEX_TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

export interface CodexStreamSummary {
  metrics: AgentMetrics;
  finishedOk: boolean;
  errorText: string;
}

export function summarizeCodexStream(text: string): CodexStreamSummary {
  const m = emptyMetrics();
  let completedTurns = 0;
  let failed = false;
  const errors: string[] = [];
  for (const e of parseJsonLines(text)) {
    if (e.type === "item.completed" && isObj(e.item) && typeof e.item.type === "string") {
      if (CODEX_TOOL_ITEMS.has(e.item.type)) m.tool_calls++;
    } else if (e.type === "turn.completed") {
      completedTurns++;
      const u = isObj(e.usage) ? e.usage : {};
      m.tokens_in = add(m.tokens_in, num(u.input_tokens));
      m.tokens_out = add(m.tokens_out, num(u.output_tokens));
      m.tokens_cache_read = add(m.tokens_cache_read, num(u.cached_input_tokens));
    } else if (e.type === "turn.failed") {
      failed = true;
      if (isObj(e.error) && typeof e.error.message === "string") errors.push(e.error.message);
    } else if (e.type === "error") {
      if (typeof e.message === "string") errors.push(e.message);
    }
  }
  m.turns = completedTurns;
  return { metrics: m, finishedOk: completedTurns > 0 && !failed, errorText: errors.join("\n") };
}

/**
 * The model(s) a Codex run ACTUALLY used, from its session rollouts
 * (`turn_context.payload.model`, one per turn; first-seen order, unique).
 * `codex exec --json` never names the model in its stream.
 */
export function codexModelsFromRollouts(rollouts: readonly string[]): string[] {
  const models: string[] = [];
  for (const text of rollouts) {
    for (const e of parseJsonLines(text)) {
      if (e.type !== "turn_context" || !isObj(e.payload)) continue;
      const model = e.payload.model;
      if (typeof model === "string" && model && !models.includes(model)) models.push(model);
    }
  }
  return models;
}

const LIMIT_RE =
  /usage limit|hit your (usage )?limit|limit reached|rate[ _-]?limit(ed)?|quota exceeded|too many requests|\b429\b|overloaded_error/i;

export interface LimitHit {
  /** Epoch ms when the limit resets, if the message carried one. */
  resetAt: number | null;
  message: string;
}

/**
 * Detect a usage/rate limit in an agent's terminal message (Claude result
 * text, Codex error text, stderr). Only a limit that ENDED the run matters —
 * callers pass the final error/result text, not the whole transcript (an
 * agent grepping for "rate limit" in the repo must not trigger a pause).
 */
export function detectLimit(text: string, now: number): LimitHit | null {
  if (!text || !LIMIT_RE.test(text)) return null;
  // Claude legacy form: "Claude AI usage limit reached|1759000000".
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return { resetAt: Number(epoch[1]) * 1000, message: text.slice(0, 300) };
  // "try again in 37 minutes" / "in 2 hours".
  const rel = /in (\d+)\s*(second|minute|min|hour|hr)s?\b/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = unit.startsWith("s") ? 1000 : unit.startsWith("h") ? 3_600_000 : 60_000;
    return { resetAt: now + n * ms, message: text.slice(0, 300) };
  }
  return { resetAt: null, message: text.slice(0, 300) };
}

/** How long to sleep for a limit: until reset (+1 min slack), clamped to
 *  [1 min, 6 h]; unknown reset → 20 min, then retry (and re-detect). */
export function limitSleepMs(hit: LimitHit, now: number): number {
  if (hit.resetAt === null) return 20 * 60_000;
  return Math.min(6 * 3_600_000, Math.max(60_000, hit.resetAt - now + 60_000));
}
