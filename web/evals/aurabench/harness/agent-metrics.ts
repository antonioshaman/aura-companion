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
  /** The last `result` is a structural limit refusal ({@link isLimitResult}). */
  limitResult: boolean;
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
    limitResult: isLimitResult(last),
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

// P6/FIX-D2-LIMIT: pilot 2 recorded 5 cells as agent_error on the Claude CLI
// text "You've hit your session limit · resets 12:10am (UTC)" — neither
// "hit your (usage )?limit" nor "limit reached" matched it. Name every
// subscription window (session / weekly / 5-hour / daily / Opus / usage) and
// Codex's `usage_limit_exceeded` code.
const LIMIT_RE =
  /(?:usage|session|weekly|daily|5[- ]hour|opus|sonnet|subscription)(?: usage)? limit|hit your [\w -]{0,20}limit|limit reached|usage_limit_exceeded|rate[ _-]?limit(ed)?|quota exceeded|too many requests|\b429\b|overloaded_error/i;

export interface LimitHit {
  /** Epoch ms when the limit resets, if the message carried one. */
  resetAt: number | null;
  message: string;
}

/** Structured limit evidence from a Claude `result` frame: the CLI marks a
 *  subscription/rate refusal with `api_error_status: 429` (and the synthetic
 *  assistant message with `error: "rate_limit"`), whatever the wording. */
export function isLimitResult(r: unknown): boolean {
  if (!isObj(r) || r.is_error !== true) return false;
  return r.api_error_status === 429 || r.error === "rate_limit" || r.error === "rate_limit_error";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * "resets 12:10am (UTC)" / "resets 5pm" / "resets Oct 3, 5pm (UTC)" → the next
 * such instant after `now`. Only UTC/GMT (or no zone — the CLI prints UTC on
 * this box) is trusted; any other zone returns null → the caller's default
 * retry cadence re-probes instead of sleeping on a guessed offset.
 */
export function parseResetsAt(text: string, now: number): number | null {
  const m =
    /resets\s+(?:at\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (!m) return null;
  const zone = m[6]?.trim().toUpperCase();
  if (zone && zone !== "UTC" && zone !== "GMT" && zone !== "ETC/UTC") return null;
  let hour = Number(m[3]);
  const minute = m[4] ? Number(m[4]) : 0;
  const ampm = m[5]?.toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
  } else if (!m[4] || hour > 23) return null; // bare "resets 3" is not a time
  if (minute > 59) return null;
  const d = new Date(now);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    let at = Date.UTC(d.getUTCFullYear(), month, Number(m[2]), hour, minute);
    if (at <= now - 24 * 3_600_000) at = Date.UTC(d.getUTCFullYear() + 1, month, Number(m[2]), hour, minute);
    return at;
  }
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  // A reset a few minutes in the past is clock skew / a late read (sleep the
  // 1-min floor), not tomorrow.
  if (at <= now - 5 * 60_000) at += 24 * 3_600_000;
  return at;
}

/**
 * Detect a usage/rate limit in an agent's terminal message (Claude result
 * text, Codex error text, stderr). Only a limit that ENDED the run matters —
 * callers pass the final error/result text, not the whole transcript (an
 * agent grepping for "rate limit" in the repo must not trigger a pause).
 * `structural` = the terminal frame itself says limit ({@link isLimitResult}),
 * so the text only supplies the reset time.
 */
export function detectLimit(text: string, now: number, structural = false): LimitHit | null {
  if (!structural && (!text || !LIMIT_RE.test(text))) return null;
  const message = (text.trim() || "rate limit (api_error_status 429)").slice(0, 300);
  // Claude legacy form: "Claude AI usage limit reached|1759000000".
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return { resetAt: Number(epoch[1]) * 1000, message };
  const resets = parseResetsAt(text, now);
  if (resets !== null) return { resetAt: resets, message };
  // "try again in 37 minutes" / "in 2 hours".
  const rel = /in (\d+)\s*(second|minute|min|hour|hr)s?\b/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = unit.startsWith("s") ? 1000 : unit.startsWith("h") ? 3_600_000 : 60_000;
    return { resetAt: now + n * ms, message };
  }
  return { resetAt: null, message };
}

/** How long to sleep for a limit: until reset (+1 min slack), clamped to
 *  [1 min, 6 h]; unknown reset → 20 min, then retry (and re-detect). */
export function limitSleepMs(hit: LimitHit, now: number): number {
  if (hit.resetAt === null) return 20 * 60_000;
  return Math.min(6 * 3_600_000, Math.max(60_000, hit.resetAt - now + 60_000));
}
