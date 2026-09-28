/**
 * Completion + metrics tracker for an Aura variant cell (P6/D2). Fed the
 * browser-WS messages of every session in the cell (the primary, plus the
 * observer for Council pairs); decides when the cell is DONE and accumulates
 * metrics across all of them (the observer's tokens and cost are Aura's cost).
 *
 * Done = the prompt was sent, the primary produced at least one `result`
 * after it, every session is idle, and nothing happened for `quietMs`. The
 * quiet window covers the gaps a Council pair has between "primary idle" and
 * "observer woken by a checkpoint", and the auto-proceed idle timer. A
 * session is running from the prompt until a `result` / `status_change:idle`,
 * so a long silent tool call (a test run) never looks idle.
 *
 * Limit: a primary `result` that is an error whose text is a usage/rate limit,
 * or a limit-shaped `error` message → the cell is not a result, the runner
 * retries it later.
 *
 * Pure (clock passed in). Firewall-clean.
 */

import { ClaudeMetricsAccumulator, detectLimit, type LimitHit } from "./agent-metrics.js";
import type { AgentMetrics } from "./cells.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const ACTIVITY = new Set(["assistant", "stream_event", "tool_progress", "tool_use_summary", "result", "permission_request"]);

interface SessionState {
  running: boolean;
  acc: ClaudeMetricsAccumulator;
}

export class AuraSessionTracker {
  private readonly sessions = new Map<string, SessionState>();
  private promptSentAt: number | null = null;
  private lastActivity = 0;
  private primaryResults = 0;
  private lastPrimaryError: string | null = null;
  limit: LimitHit | null = null;

  constructor(
    private readonly primaryId: string,
    otherIds: readonly string[],
    private readonly quietMs: number,
  ) {
    for (const id of [primaryId, ...otherIds]) {
      this.sessions.set(id, { running: false, acc: new ClaudeMetricsAccumulator() });
    }
  }

  promptSent(now: number): void {
    this.promptSentAt = now;
    this.lastActivity = now;
    this.sessions.get(this.primaryId)!.running = true;
  }

  /** Feed one parsed browser-WS message of `sessionId`. Messages before the
   *  prompt (history replay, the Companion init probe) are ignored. */
  onMessage(sessionId: string, msg: unknown, now: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || !isObj(msg) || this.promptSentAt === null) return;
    const type = msg.type;
    if (typeof type !== "string") return;
    if (ACTIVITY.has(type)) this.lastActivity = now;
    if (type === "assistant") {
      s.running = true;
      s.acc.assistant(msg.message);
    } else if (type === "stream_event" || type === "tool_progress") {
      s.running = true;
    } else if (type === "status_change") {
      if (msg.status === "running" || msg.status === "compacting") {
        s.running = true;
        this.lastActivity = now;
      } else if (msg.status === "idle") s.running = false;
    } else if (type === "result") {
      s.running = false;
      const data = isObj(msg.data) ? msg.data : {};
      s.acc.result(data);
      if (sessionId === this.primaryId) {
        this.primaryResults++;
        const text = typeof data.result === "string" ? data.result : "";
        const errs = Array.isArray(data.errors) ? data.errors.filter((e) => typeof e === "string").join("\n") : "";
        if (data.is_error === true) {
          this.lastPrimaryError = text || errs || String(data.subtype ?? "error");
          const hit = detectLimit(`${text}\n${errs}`, now);
          if (hit) this.limit = hit;
        } else {
          this.lastPrimaryError = null;
          this.limit = null;
        }
      }
    } else if (type === "error" && typeof msg.message === "string") {
      const hit = detectLimit(msg.message, now);
      if (hit && sessionId === this.primaryId) this.limit = hit;
    } else if (type === "cli_disconnected" && sessionId === this.primaryId) {
      s.running = false;
    }
  }

  isDone(now: number): boolean {
    if (this.promptSentAt === null || this.primaryResults === 0) return false;
    for (const s of this.sessions.values()) if (s.running) return false;
    return now - this.lastActivity >= this.quietMs;
  }

  /** The primary's last result was an error (and not a limit). */
  get primaryError(): string | null {
    return this.limit ? null : this.lastPrimaryError;
  }

  metrics(): AgentMetrics {
    const out: AgentMetrics = {
      turns: null,
      tool_calls: 0,
      tokens_in: null,
      tokens_out: null,
      tokens_cache_read: null,
      tokens_cache_write: null,
      cost_usd: null,
      models: [],
    };
    const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);
    for (const { acc } of this.sessions.values()) {
      const m = acc.metrics;
      out.turns = add(out.turns, m.turns);
      out.tool_calls += m.tool_calls;
      out.tokens_in = add(out.tokens_in, m.tokens_in);
      out.tokens_out = add(out.tokens_out, m.tokens_out);
      out.tokens_cache_read = add(out.tokens_cache_read, m.tokens_cache_read);
      out.tokens_cache_write = add(out.tokens_cache_write, m.tokens_cache_write);
      out.cost_usd = add(out.cost_usd, m.cost_usd);
      for (const model of m.models) if (!out.models.includes(model)) out.models.push(model);
    }
    return out;
  }
}
