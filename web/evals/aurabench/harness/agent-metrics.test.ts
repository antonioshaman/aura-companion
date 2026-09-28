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
import { detectLimit, limitSleepMs, summarizeClaudeStream, summarizeCodexStream } from "./agent-metrics.js";

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
  it("clamps the sleep to [1 min, 6 h] and defaults to 20 min", () => {
    expect(limitSleepMs({ resetAt: null, message: "" }, now)).toBe(20 * 60_000);
    expect(limitSleepMs({ resetAt: now - 5_000, message: "" }, now)).toBe(60_000);
    expect(limitSleepMs({ resetAt: now + 48 * 3_600_000, message: "" }, now)).toBe(6 * 3_600_000);
    expect(limitSleepMs({ resetAt: now + 10 * 60_000, message: "" }, now)).toBe(11 * 60_000);
  });
});
