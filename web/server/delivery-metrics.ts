// Reply-delivery reliability metrics: "did every user message get an answer,
// and how long did it take". In-memory, resets on server restart, surfaced via
// GET /api/metrics (`delivery` key), GET /api/metrics/delivery and structured
// `delivery.*` log events.
//
// Why this exists (2026-10 analysis of 19 real projects): ~25% of human
// messages were nudges ("жду", "ответишь?", "ты тут?"); 42 user messages were
// answered "No response requested." because the init-probe marker said "do
// not respond" and the CLI folded the next real prompt into the probe's turn
// after a reconnect (introduced in #200, fixed in #335, while 7917 unit tests
// stayed green); and the Claude CLI sometimes writes its answer to the jsonl
// but not to stdout (drift detector, improved in #335). None of that was
// visible as a number. These counters make it one.
//
// The drift detector fires most often on a CLI that runs many parallel
// background subagents. Its recovery is a kill of the whole CLI process, so
// it also kills every task that CLI still has running (background Bash,
// `local_agent` subagents). The Claude adapter feeds `task_started` /
// `task_notification` frames here, and each drift recovery logs and counts
// how many of those tasks were still running when the kill was issued.
//
// Backend coverage: everything here is fed from the bridge's normalized
// browser frames, so it works the same for Claude Code and Codex. The two
// Claude-only parts are documented where they are fed:
//   - `driftRecoveries` — the silent-stdio drift detector compares the
//     Claude CLI jsonl with stdout; Codex has no such jsonl and is skipped.
//   - `noResponseRequestedReplies` — caused by the Claude init probe. Codex
//     has no init probe (its app-server handshake is `initialize` JSON-RPC,
//     no user frame), so for Codex this stays 0 unless the model says it.

import { log } from "./logger.js";
import { createHistogram, recordHistogramValue, serializeHistogram, type Histogram } from "./metrics-histogram.js";
import type { DeliveryCounters, DeliverySnapshot, SessionDeliveryStats } from "./metrics-types.js";

// ── Configuration ─────────────────────────────────────────────────────────

/** Default "no assistant output within N ms" threshold. */
export const DEFAULT_STALL_THRESHOLD_MS = 60_000;

/** Time-to-first-output buckets (ms). Wider than the generic timing buckets:
 *  a first token takes seconds, a stall takes minutes. */
export const FIRST_OUTPUT_BUCKETS_MS = [1_000, 2_500, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000] as const;

/** Per-session entries kept in memory (least recently active evicted). */
export const MAX_TRACKED_SESSIONS = 200;

/** Exact text the model returns when told the turn needs no answer. */
export const NO_RESPONSE_REQUESTED_TEXT = "No response requested.";

function resolveStallThresholdMs(): number {
  const raw = Number(process.env.COMPANION_DELIVERY_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_THRESHOLD_MS;
}

// ── Nudge detection (proxy metric) ────────────────────────────────────────

/** Longer messages are real prompts that merely contain a nudge word. */
const NUDGE_MAX_LENGTH = 60;

/**
 * Short RU/EN "are you still answering?" messages. Matched against the
 * whole normalized message (lowercase, ё→е, trimmed). `id` goes into logs
 * instead of the message text.
 */
export const NUDGE_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "ru_zhdu", re: /^(ну\s+)?(я\s+)?жду(\s|[.!?…]|$)/u },
  { id: "ru_otvetish", re: /(^|\s)ответишь(\s|[.!?…]|$)/u },
  { id: "ru_ty_tut", re: /(^|\s)ты\s+(тут|здесь|где)(\s|[.!?…]|$)/u },
  { id: "ru_au", re: /^а+у+([.!?…\s]|$)/u },
  { id: "ru_allo", re: /^ал+о+([.!?…\s]|$)/u },
  { id: "ru_prodolzhai", re: /^продолж(ай|аем|и|айте)([.!?…\s]|$)/u },
  { id: "ru_nu", re: /^ну\s*[?!.…]*$/u },
  { id: "ru_gde_otvet", re: /(^|\s)(где|когда)\s+(же\s+)?ответ/u },
  { id: "ru_zavis", re: /(^|\s)завис(\s|[.!?…]|$|ла|ло|ли)/u },
  { id: "en_are_you_there", re: /(^|\s)are\s+you\s+(still\s+)?(there|here|alive)(\s|[.!?…]|$)/u },
  { id: "en_still_there", re: /^(you\s+)?still\s+(there|here|working)(\s|[.!?…]|$)/u },
  { id: "en_hello", re: /^hel+o+\s*[?!]+$/u },
  { id: "en_any_update", re: /^any\s+(update|updates|news|progress)(\s|[.!?…]|$)/u },
  { id: "en_continue", re: /^(continue|go\s+on|keep\s+going)([.!?…\s]|$)/u },
  { id: "en_ping", re: /^ping([.!?…\s]|$)/u },
];

/** Returns the matching nudge pattern id, or null. */
export function matchNudge(text: string): string | null {
  const norm = text.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  if (!norm || norm.length > NUDGE_MAX_LENGTH) return null;
  for (const { id, re } of NUDGE_PATTERNS) {
    if (re.test(norm)) return id;
  }
  return null;
}

// ── Frame classification ──────────────────────────────────────────────────

/** Minimal structural view of a backend → browser frame. */
type BackendFrame = { readonly type: string };

function assistantText(frame: BackendFrame): string | null {
  const message = (frame as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    // A tool call is a real answer even when the text says otherwise.
    if (b.type === "tool_use") return null;
    if (b.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text;
}

/** True when an assistant frame's whole visible text is "No response requested." */
export function isNoResponseRequestedReply(frame: BackendFrame): boolean {
  if (frame.type !== "assistant") return false;
  const text = assistantText(frame);
  if (text === null) return false;
  const t = text.trim();
  return t === NO_RESPONSE_REQUESTED_TEXT || t === NO_RESPONSE_REQUESTED_TEXT.slice(0, -1);
}

/**
 * Frames that mean "the model started answering": streamed content, a
 * consolidated assistant frame, or a tool permission prompt. Stream
 * bookkeeping without content (`message_start`, `content_block_stop`, the
 * synthetic `message_delta{stop_reason:"interrupted"}` Codex emits) does not
 * count — the user still sees nothing.
 */
export function isFirstOutputFrame(frame: BackendFrame): boolean {
  if (frame.type === "assistant" || frame.type === "permission_request") return true;
  if (frame.type === "stream_event") {
    const ev = (frame as { event?: { type?: unknown } }).event;
    return ev?.type === "content_block_start" || ev?.type === "content_block_delta";
  }
  return false;
}

// ── Collector ─────────────────────────────────────────────────────────────

export type UserMessageOrigin = "server:cron" | "server:agent" | "server:rest" | "server:auto-resume" | "council:peer" | undefined;

interface SessionState extends Omit<SessionDeliveryStats, "runningTasks"> {
  /** A user message's turn is open (cleared by the result that ends it). */
  userTurnOpen: boolean;
  /** An output frame arrived since the latest user message. */
  outputSinceUser: boolean;
  /** The stall timer for `awaitingSince` already fired. */
  stallCounted: boolean;
  stallTimer: ReturnType<typeof setTimeout> | null;
  /** Tasks the CLI started and has not reported finished: task_id → task_type. */
  tasks: Map<string, string>;
}

function emptyCounters(): DeliveryCounters {
  return {
    userMessages: 0,
    firstOutputs: 0,
    stalledMessages: 0,
    noResponseRequestedReplies: 0,
    driftRecoveries: 0,
    nudges: 0,
    backgroundTasksKilled: 0,
  };
}

export interface DeliveryMetricsOptions {
  stallThresholdMs?: number;
}

export class DeliveryMetrics {
  private stallThresholdMs: number;
  private global = emptyCounters();
  private firstOutput: Histogram = createHistogram(FIRST_OUTPUT_BUCKETS_MS);
  /** Insertion order = recency (entries are re-inserted on every event). */
  private sessions = new Map<string, SessionState>();

  constructor(opts: DeliveryMetricsOptions = {}) {
    this.stallThresholdMs = opts.stallThresholdMs ?? resolveStallThresholdMs();
  }

  /** A user message was routed to the backend (after dedup). */
  recordUserMessage(
    sessionId: string,
    info: { text: string; backend?: string | null; origin?: UserMessageOrigin },
  ): void {
    const s = this.touch(sessionId, info.backend);
    const now = Date.now();
    s.userMessages++;
    this.global.userMessages++;

    // Nudges are only meaningful when a human typed them.
    if (info.origin === undefined) {
      const nudgeId = matchNudge(info.text);
      if (nudgeId) {
        s.nudges++;
        this.global.nudges++;
        log.info("delivery", "user nudge detected", {
          event: "delivery.nudge_detected",
          sessionId,
          backend: s.backend,
          pattern: nudgeId,
          awaitingReplyMs: s.awaitingSince !== null ? now - s.awaitingSince : null,
        });
      }
    }

    // Keep the clock of the oldest unanswered message running — a re-ask
    // does not reset how long the user has been waiting. Once that wait was
    // already counted as stalled, a new message starts a fresh clock.
    if (s.awaitingSince === null || s.stallCounted) {
      this.clearStallTimer(s);
      s.awaitingSince = now;
      s.stallCounted = false;
      s.stallTimer = setTimeout(() => this.onStall(sessionId, now), this.stallThresholdMs);
      (s.stallTimer as { unref?: () => void }).unref?.();
    }
    s.userTurnOpen = true;
    s.outputSinceUser = false;
  }

  /** A backend → browser frame was received for the session. */
  recordBackendFrame(sessionId: string, frame: BackendFrame): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    if (frame.type === "assistant" && s.userTurnOpen && isNoResponseRequestedReply(frame)) {
      this.touch(sessionId);
      s.noResponseRequestedReplies++;
      this.global.noResponseRequestedReplies++;
      log.warn("delivery", "assistant answered a user message with \"No response requested.\"", {
        event: "delivery.no_response_requested_reply",
        sessionId,
        backend: s.backend,
      });
    }

    if (isFirstOutputFrame(frame)) {
      s.outputSinceUser = true;
      if (s.awaitingSince !== null) {
        const waited = Math.max(0, Date.now() - s.awaitingSince);
        this.touch(sessionId);
        recordHistogramValue(this.firstOutput, waited);
        s.firstOutputs++;
        this.global.firstOutputs++;
        if (waited > this.stallThresholdMs) {
          log.warn("delivery", "first assistant output arrived late", {
            event: "delivery.late_first_output",
            sessionId,
            backend: s.backend,
            waitedMs: waited,
            thresholdMs: this.stallThresholdMs,
          });
        }
        this.clearStallTimer(s);
        s.awaitingSince = null;
        s.stallCounted = false;
      }
      return;
    }

    // A result ends the user's turn only if the model produced something
    // since the user message. A result with no output in between is the
    // tail of an earlier turn — typically the init probe's interrupted
    // turn (`terminal_reason: "aborted_streaming"`) racing a fresh message.
    if (frame.type === "result" && s.outputSinceUser) {
      s.userTurnOpen = false;
    }
  }

  /** The user interrupted the turn: no answer is owed any more. */
  recordInterrupt(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.clearStallTimer(s);
    s.awaitingSince = null;
    s.stallCounted = false;
    s.userTurnOpen = false;
  }

  /**
   * A Claude CLI `system` task frame (`task_started` / `task_notification`).
   * Tracks which background tasks the CLI process is running right now.
   * Codex has no such frames; its sessions simply report 0.
   */
  recordTaskFrame(sessionId: string, frame: { subtype?: unknown; task_id?: unknown; task_type?: unknown }): void {
    if (typeof frame.task_id !== "string") return;
    if (frame.subtype === "task_started") {
      const s = this.touch(sessionId);
      s.tasks.set(frame.task_id, typeof frame.task_type === "string" ? frame.task_type : "unknown");
    } else if (frame.subtype === "task_notification") {
      this.sessions.get(sessionId)?.tasks.delete(frame.task_id);
    }
  }

  /** The CLI process went away: whatever it was running died with it. */
  clearRunningTasks(sessionId: string): void {
    this.sessions.get(sessionId)?.tasks.clear();
  }

  /**
   * The drift detector is about to kill a stuck Claude CLI to recover its
   * reply. The kill takes down every background task that CLI still runs
   * (subagents included) — logged and counted here so the collateral cost
   * of a recovery is visible.
   */
  recordDriftRecovery(sessionId: string, backend?: string | null): void {
    const s = this.touch(sessionId, backend);
    const runningTasksByType: Record<string, number> = {};
    for (const type of s.tasks.values()) runningTasksByType[type] = (runningTasksByType[type] ?? 0) + 1;
    const killed = s.tasks.size;
    s.driftRecoveries++;
    this.global.driftRecoveries++;
    s.backgroundTasksKilled += killed;
    this.global.backgroundTasksKilled += killed;
    log.warn("delivery", "drift detector recovering an undelivered reply", {
      event: "delivery.drift_recovery",
      sessionId,
      backend: s.backend,
      awaitingReplyMs: s.awaitingSince !== null ? Date.now() - s.awaitingSince : null,
      // The recovery kills the CLI process, and with it these tasks.
      runningBackgroundTasks: killed,
      runningTasksByType,
    });
    s.tasks.clear();
  }

  getSnapshot(): DeliverySnapshot {
    let awaitingReply = 0;
    const sessions: Record<string, SessionDeliveryStats> = {};
    // Most recently active first.
    for (const [id, s] of [...this.sessions.entries()].reverse()) {
      if (s.awaitingSince !== null) awaitingReply++;
      sessions[id] = {
        userMessages: s.userMessages,
        firstOutputs: s.firstOutputs,
        stalledMessages: s.stalledMessages,
        noResponseRequestedReplies: s.noResponseRequestedReplies,
        driftRecoveries: s.driftRecoveries,
        nudges: s.nudges,
        backgroundTasksKilled: s.backgroundTasksKilled,
        runningTasks: s.tasks.size,
        backend: s.backend,
        awaitingSince: s.awaitingSince,
        lastEventAt: s.lastEventAt,
      };
    }
    return {
      stallThresholdMs: this.stallThresholdMs,
      global: { ...this.global, awaitingReply },
      timeToFirstOutputMs: serializeHistogram(this.firstOutput),
      sessions,
    };
  }

  /** Testing only. */
  reset(opts: DeliveryMetricsOptions = {}): void {
    for (const s of this.sessions.values()) this.clearStallTimer(s);
    this.sessions.clear();
    this.global = emptyCounters();
    this.firstOutput = createHistogram(FIRST_OUTPUT_BUCKETS_MS);
    this.stallThresholdMs = opts.stallThresholdMs ?? resolveStallThresholdMs();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private onStall(sessionId: string, startedAt: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.awaitingSince !== startedAt || s.stallCounted) return;
    s.stallTimer = null;
    s.stallCounted = true;
    s.stalledMessages++;
    this.global.stalledMessages++;
    log.warn("delivery", "no assistant output within threshold after a user message", {
      event: "delivery.no_output_within_threshold",
      sessionId,
      backend: s.backend,
      thresholdMs: this.stallThresholdMs,
    });
  }

  private clearStallTimer(s: SessionState): void {
    if (s.stallTimer) clearTimeout(s.stallTimer);
    s.stallTimer = null;
  }

  /** Get-or-create, mark as most recently active, evict the oldest. */
  private touch(sessionId: string, backend?: string | null): SessionState {
    let s = this.sessions.get(sessionId);
    if (s) {
      this.sessions.delete(sessionId);
    } else {
      s = {
        ...emptyCounters(),
        backend: null,
        awaitingSince: null,
        lastEventAt: 0,
        userTurnOpen: false,
        outputSinceUser: false,
        stallCounted: false,
        stallTimer: null,
        tasks: new Map(),
      };
    }
    if (backend) s.backend = backend;
    s.lastEventAt = Date.now();
    this.sessions.set(sessionId, s);
    while (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string;
      const evicted = this.sessions.get(oldest);
      if (evicted) this.clearStallTimer(evicted);
      this.sessions.delete(oldest);
    }
    return s;
  }
}

/** Singleton used by the server. */
export const deliveryMetrics = new DeliveryMetrics();
