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
 * Codex sessions (F/G): the Companion bridge synthesises every Codex `result`
 * with PLACEHOLDER zeros (`total_cost_usd: 0`, all `usage` 0 — codex-adapter
 * `handleTurnCompleted`), so those fields are ignored for a Codex session.
 * Its real token counts come from `session_update.session.codex_token_details`
 * (cumulative per thread; a drop = a new thread, segments are summed); cost
 * stays null (unknown — Codex reports none; priced from tokens in D3), never
 * 0. The backend is learned from `session_init` / `session_update`
 * `backend_type` (any time, also before the prompt), defaulting to the
 * variant's provider.
 *
 * Limit: a primary `result` that is an error whose text is a usage/rate limit,
 * or a limit-shaped `error` message → the cell is not a result, the runner
 * retries it later.
 *
 * Pure (clock passed in). Firewall-clean.
 */

import { ClaudeMetricsAccumulator, detectLimit, isLimitResult, type LimitHit } from "./agent-metrics.js";
import type { AgentMetrics } from "./cells.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const ACTIVITY = new Set(["assistant", "stream_event", "tool_progress", "tool_use_summary", "result", "permission_request"]);

type Backend = "claude" | "codex";

interface CodexTokens {
  in: number;
  out: number;
  cached: number;
}

interface SessionState {
  running: boolean;
  acc: ClaudeMetricsAccumulator;
  backend: Backend;
  /** Summed finished segments + the current cumulative reading (Codex only). */
  codexDone: CodexTokens | null;
  codexCurrent: CodexTokens | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

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
    defaultBackend: Backend = "claude",
  ) {
    for (const id of [primaryId, ...otherIds]) {
      this.sessions.set(id, {
        running: false,
        acc: new ClaudeMetricsAccumulator(),
        backend: defaultBackend,
        codexDone: null,
        codexCurrent: null,
      });
    }
  }

  /** Session-state frames: backend identity and Codex token totals. Read
   *  regardless of the prompt — `session_init` arrives before it, and a
   *  fresh session's cumulative counter starts at 0. */
  private onSessionState(s: SessionState, state: unknown): void {
    if (!isObj(state)) return;
    if (state.backend_type === "claude" || state.backend_type === "codex") s.backend = state.backend_type;
    const t = state.codex_token_details;
    if (!isObj(t)) return;
    const cur = { in: num(t.inputTokens), out: num(t.outputTokens), cached: num(t.cachedInputTokens) };
    if (cur.in === null || cur.out === null || cur.cached === null) return;
    const next = cur as CodexTokens;
    const prev = s.codexCurrent;
    if (prev && (next.in < prev.in || next.out < prev.out)) {
      // Counter went back: a new Codex thread (relaunch). Bank the old one.
      const done = s.codexDone ?? { in: 0, out: 0, cached: 0 };
      s.codexDone = { in: done.in + prev.in, out: done.out + prev.out, cached: done.cached + prev.cached };
    }
    s.codexCurrent = next;
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
    if (!s || !isObj(msg)) return;
    const type = msg.type;
    if (typeof type !== "string") return;
    if (type === "session_init" || type === "session_update") this.onSessionState(s, msg.session);
    if (this.promptSentAt === null) return;
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
          const hit = detectLimit(`${text}\n${errs}`, now, isLimitResult(data));
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

  /** Cell totals over every session that ran (produced a `result`). A
   *  per-field total is null as soon as ONE such session's value is unknown —
   *  a partial sum would read as a smaller known number (the pilot-1 bug:
   *  Codex placeholders summed as 0). */
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
    type Field = "tokens_in" | "tokens_out" | "tokens_cache_read" | "tokens_cache_write" | "cost_usd";
    const unknown = new Set<Field>();
    const put = (f: Field, v: number | null) => {
      if (v === null) unknown.add(f);
      else out[f] = (out[f] ?? 0) + v;
    };
    for (const s of this.sessions.values()) {
      const m = s.acc.metrics;
      if (m.turns !== null) out.turns = (out.turns ?? 0) + m.turns;
      out.tool_calls += m.tool_calls;
      for (const model of m.models) if (!out.models.includes(model)) out.models.push(model);
      if (s.acc.results === 0) continue;
      if (s.backend === "codex") {
        // Result usage/cost are bridge placeholders — see the header.
        const cur = s.codexCurrent;
        const done = s.codexDone ?? { in: 0, out: 0, cached: 0 };
        put("tokens_in", cur ? done.in + cur.in : null);
        put("tokens_out", cur ? done.out + cur.out : null);
        put("tokens_cache_read", cur ? done.cached + cur.cached : null);
        put("tokens_cache_write", null);
        put("cost_usd", null);
        continue;
      }
      put("tokens_in", m.tokens_in);
      put("tokens_out", m.tokens_out);
      put("tokens_cache_read", m.tokens_cache_read);
      put("tokens_cache_write", m.tokens_cache_write);
      put("cost_usd", m.cost_usd);
    }
    for (const f of unknown) out[f] = null;
    return out;
  }
}
