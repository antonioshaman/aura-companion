/**
 * Tests for metric extraction and limit detection (Story D2: per cell record
 * turns, tool calls, tokens in/out, cost; "limit exhausted → wait for the
 * reset and continue").
 *
 * Validates:
 *   - Claude stream-json: turns and tokens are SUMMED across results, while
 *     `total_cost_usd` is treated as the cumulative per-process counter it is
 *     (max, not sum) — and a counter drop (CLI restart) starts a new segment;
 *   - tool calls = `tool_use` blocks; the init frame and hook events are
 *     surfaced for the isolation check; an error result is not "finished ok";
 *   - Codex `--json`: tool items counted, usage summed per turn, a failed turn
 *     is not ok;
 *   - limit detection understands the epoch and relative reset forms, returns
 *     null on ordinary errors, and the sleep is clamped.
 */

import { describe, it, expect } from "vitest";
import {
  codexModelsFromRollouts,
  detectLimit,
  isLimitResult,
  limitSleepMs,
  parseResetsAt,
  summarizeClaudeStream,
  summarizeCodexStream,
} from "./agent-metrics.js";

// Trimmed verbatim `result` frame from pilot-2 cell resume-hiccup-loses-conversation|A|1.
const REAL_LIMIT_RESULT = { type: "result", subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "api_error", num_turns: 1, total_cost_usd: 0, duration_ms: 620, result: "You've hit your session limit · resets 12:10am (UTC)" };

const line = (o: unknown) => JSON.stringify(o);

describe("summarizeClaudeStream", () => {
  const init = { type: "system", subtype: "init", model: "claude-x", skills: [], plugins: [], mcp_servers: [] };
  const toolTurn = {
    type: "assistant",
    message: { model: "claude-x", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "1" }, { type: "tool_use", id: "2" }] },
  };
  const result = (cost: number, turns: number, extra: object = {}) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: turns,
    total_cost_usd: cost,
    usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
    result: "done",
    ...extra,
  });

  it("sums turns/tokens, counts tool_use blocks, takes the cumulative cost", () => {
    const text = [line(init), line(toolTurn), line(result(1.5, 4)), line(toolTurn), line(result(2.25, 3)), "not json"].join("\n");
    const s = summarizeClaudeStream(text);
    expect(s.finishedOk).toBe(true);
    expect(s.init).toMatchObject({ model: "claude-x" });
    expect(s.metrics).toMatchObject({
      turns: 7,
      tool_calls: 4,
      tokens_in: 20,
      tokens_out: 200,
      tokens_cache_read: 2000,
      tokens_cache_write: 100,
      cost_usd: 2.25, // cumulative counter — NOT 1.5 + 2.25
      models: ["claude-x"],
    });
  });

  it("adds a new cost segment when the cumulative counter drops (CLI restarted)", () => {
    const s = summarizeClaudeStream([line(result(3, 1)), line(result(0.5, 1))].join("\n"));
    expect(s.metrics.cost_usd).toBeCloseTo(3.5);
  });

  it("counts hook events and marks an error result as not finished", () => {
    const text = [
      line(init),
      line({ type: "system", subtype: "hook_started", hook: "x" }),
      line({ type: "system", subtype: "hook_response", hook: "x" }),
      line(result(0.1, 1, { subtype: "error_during_execution", is_error: true, result: "boom" })),
    ].join("\n");
    const s = summarizeClaudeStream(text);
    expect(s.hookEvents).toBe(2);
    expect(s.finishedOk).toBe(false);
    expect(s.resultText).toBe("boom");
  });

  it("an empty stream yields null metrics, never zeros pretending to be data", () => {
    const s = summarizeClaudeStream("");
    expect(s.metrics.turns).toBeNull();
    expect(s.metrics.cost_usd).toBeNull();
    expect(s.finishedOk).toBe(false);
  });
});

describe("summarizeCodexStream", () => {
  it("counts tool items and sums usage per completed turn", () => {
    const text = [
      line({ type: "thread.started", thread_id: "t" }),
      line({ type: "item.completed", item: { type: "reasoning" } }),
      line({ type: "item.completed", item: { type: "command_execution" } }),
      line({ type: "item.completed", item: { type: "file_change" } }),
      line({ type: "item.completed", item: { type: "agent_message" } }),
      line({ type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 40 } }),
    ].join("\n");
    const s = summarizeCodexStream(text);
    expect(s.finishedOk).toBe(true);
    expect(s.metrics).toMatchObject({ turns: 1, tool_calls: 2, tokens_in: 500, tokens_out: 40, tokens_cache_read: 300, cost_usd: null });
  });

  it("a failed turn is not ok and carries the error text", () => {
    const s = summarizeCodexStream(line({ type: "turn.failed", error: { message: "You've hit your usage limit" } }));
    expect(s.finishedOk).toBe(false);
    expect(s.errorText).toContain("usage limit");
  });
});

describe("detectLimit / limitSleepMs", () => {
  const now = 1_000_000_000_000;
  it("parses the legacy epoch form", () => {
    expect(detectLimit("Claude AI usage limit reached|1000000600", now)).toMatchObject({ resetAt: 1_000_000_600_000 });
  });
  it("parses a relative reset", () => {
    expect(detectLimit("Rate limited, try again in 5 minutes", now)?.resetAt).toBe(now + 5 * 60_000);
    expect(detectLimit("You've hit your usage limit. Try again in 2 hours.", now)?.resetAt).toBe(now + 2 * 3_600_000);
  });
  it("returns a hit without a reset time when none is given", () => {
    expect(detectLimit("429 Too Many Requests", now)).toMatchObject({ resetAt: null });
  });
  it("ignores ordinary failures", () => {
    expect(detectLimit("TypeError: x is not a function", now)).toBeNull();
    expect(detectLimit("", now)).toBeNull();
  });
  // P6/FIX-D2-LIMIT: the verbatim Claude CLI text from pilot 2 (2026-09-28
  // ~23:13 UTC). The old regex missed "session limit", so 5 cells were
  // recorded as agent_error failures instead of pausing until the reset.
  it("recognises the pilot-2 session-limit text and sleeps until the printed UTC reset", () => {
    const at2313 = Date.UTC(2026, 8, 28, 23, 13, 34);
    const hit = detectLimit("You've hit your session limit · resets 12:10am (UTC)", at2313);
    expect(hit).not.toBeNull();
    // 12:10am is the NEXT midnight-ish instant, not today's past 00:10.
    expect(hit!.resetAt).toBe(Date.UTC(2026, 8, 29, 0, 10));
    expect(limitSleepMs(hit!, at2313)).toBe(Date.UTC(2026, 8, 29, 0, 11) - at2313);
  });
  it("recognises other subscription-window wordings (Claude + Codex + Companion)", () => {
    for (const text of [
      "You've hit your weekly limit · resets Oct 3, 5pm (UTC)",
      "5-hour limit reached ∙ resets 3pm",
      "Opus limit reached",
      "codex error: usage_limit_exceeded",
      "Model hit a rate/session limit. Automatic fallback and AFK auto-proceed are paused; send a message manually after the reset.",
    ]) {
      expect(detectLimit(text, now), text).not.toBeNull();
    }
  });
  it("structural evidence (429 result) is a limit even with unrecognised wording", () => {
    expect(detectLimit("Something new from the API", now, true)).toMatchObject({ resetAt: null, message: "Something new from the API" });
    expect(detectLimit("", now, true)?.message).toContain("429");
    // Without the structural flag the same text is an ordinary failure.
    expect(detectLimit("Something new from the API", now)).toBeNull();
  });
  it("isLimitResult reads api_error_status 429 / error rate_limit on an error result only", () => {
    expect(isLimitResult(REAL_LIMIT_RESULT)).toBe(true);
    expect(isLimitResult({ type: "result", is_error: true, error: "rate_limit" })).toBe(true);
    expect(isLimitResult({ type: "result", is_error: false, api_error_status: 429 })).toBe(false);
    expect(isLimitResult({ type: "result", is_error: true, api_error_status: 500 })).toBe(false);
    expect(isLimitResult(null)).toBe(false);
  });
  it("summarizeClaudeStream flags the real limit result", () => {
    const s = summarizeClaudeStream(JSON.stringify(REAL_LIMIT_RESULT));
    expect(s.finishedOk).toBe(false);
    expect(s.limitResult).toBe(true);
  });
  it("parseResetsAt: absolute forms, skew tolerance and untrusted zones", () => {
    const t = Date.UTC(2026, 8, 28, 23, 13);
    expect(parseResetsAt("resets 5pm", t)).toBe(Date.UTC(2026, 8, 29, 17, 0));
    expect(parseResetsAt("resets 23:30 (UTC)", t)).toBe(Date.UTC(2026, 8, 28, 23, 30));
    expect(parseResetsAt("resets Oct 3, 5pm (UTC)", t)).toBe(Date.UTC(2026, 9, 3, 17, 0));
    expect(parseResetsAt("resets 12pm (GMT)", t)).toBe(Date.UTC(2026, 8, 29, 12, 0));
    // Printed reset 2 min ago (late read) → that instant, not +24 h.
    expect(parseResetsAt("resets 11:11pm (UTC)", t)).toBe(Date.UTC(2026, 8, 28, 23, 11));
    // A non-UTC zone is not guessed: null → default 20-min re-probe.
    expect(parseResetsAt("resets 5pm (Europe/Berlin)", t)).toBeNull();
    expect(parseResetsAt("resets 3 things", t)).toBeNull();
    expect(parseResetsAt("resets 13pm", t)).toBeNull();
    expect(parseResetsAt("no reset here", t)).toBeNull();
  });
  it("clamps the sleep to [1 min, 6 h] and defaults to 20 min", () => {
    expect(limitSleepMs({ resetAt: null, message: "" }, now)).toBe(20 * 60_000);
    expect(limitSleepMs({ resetAt: now - 5_000, message: "" }, now)).toBe(60_000);
    expect(limitSleepMs({ resetAt: now + 48 * 3_600_000, message: "" }, now)).toBe(6 * 3_600_000);
    expect(limitSleepMs({ resetAt: now + 10 * 60_000, message: "" }, now)).toBe(11 * 60_000);
  });
});

// P6/FIX-D2-4: naked Codex (B) reads its model from the rollout — the shape
// below is a trimmed real `~/.codex/sessions/.../rollout-*.jsonl` (codex-cli 0.142.5).
describe("codexModelsFromRollouts", () => {
  it("collects turn_context models in first-seen order, unique, across rollouts", () => {
    const a = [
      line({ timestamp: "t", type: "session_meta", payload: { cli_version: "0.142.5", model_provider: "openai" } }),
      line({ timestamp: "t", type: "turn_context", payload: { turn_id: "1", model: "gpt-5.5", collaboration_mode: { settings: { model: "gpt-5.5" } } } }),
      line({ timestamp: "t", type: "event_msg", payload: { type: "token_count", model: "not-this" } }),
    ].join("\n");
    const b = [line({ type: "turn_context", payload: { model: "gpt-5.4-mini" } }), line({ type: "turn_context", payload: { model: "gpt-5.5" } })].join("\n");
    expect(codexModelsFromRollouts([a, b])).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
  });

  it("is empty (unknown) for no rollouts, garbage, or a turn_context without a model", () => {
    expect(codexModelsFromRollouts([])).toEqual([]);
    expect(codexModelsFromRollouts(["not json", line({ type: "turn_context", payload: { model: "" } }), line({ type: "turn_context" })])).toEqual([]);
  });
});
