import { describe, expect, it } from "vitest";
import { buildTurnUsageLogLine, classifyTurnUsage } from "./turn-usage-telemetry.js";

// `llm.turn_usage` is the structured per-turn cache-telemetry line (PR #346,
// audit C-6). These tests pin the enriched shape: which backend/model produced
// the turn, how long the session sat idle before it (cache TTL attribution),
// the cache-hit ratio on a backend-neutral prompt basis, and a `countable`
// flag so error / zero-usage frames don't drag hit-rate aggregates to zero.

const T0 = Date.parse("2026-10-16T10:00:00Z");

const realUsage = {
  input_tokens: 2987,
  output_tokens: 91,
  cache_read_input_tokens: 33280,
  cache_creation_input_tokens: 0,
};

describe("classifyTurnUsage", () => {
  it("ok for a successful frame with tokens", () => {
    expect(classifyTurnUsage({ subtype: "success", is_error: false, usage: realUsage })).toBe("ok");
  });
  it("error for an error result even if it carries tokens", () => {
    expect(classifyTurnUsage({ subtype: "error_during_execution", is_error: true, usage: realUsage })).toBe("error");
  });
  it("zero when every counter is 0 (synthesized / interrupted / pre-W6 codex frames)", () => {
    expect(classifyTurnUsage({
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })).toBe("zero");
  });
  it("missing when the frame has no usage object at all", () => {
    expect(classifyTurnUsage({ subtype: "success", is_error: false })).toBe("missing");
  });
});

describe("buildTurnUsageLogLine", () => {
  it("emits backend, model, subtype, prompt total, hit ratio and idle gap in minutes", () => {
    const line = buildTurnUsageLogLine({
      sessionId: "s1",
      backend: "codex",
      model: "gpt-6.1-sol",
      result: { subtype: "success", is_error: false, num_turns: 1, usage: realUsage },
      turnStartedAt: T0,
      previousTurnCompletedAt: T0 - 75 * 60_000,
      prefixChanges: [],
    });
    expect(line).toEqual({
      event: "llm.turn_usage",
      sessionId: "s1",
      backend: "codex",
      model: "gpt-6.1-sol",
      subtype: "success",
      usageStatus: "ok",
      countable: true,
      input_tokens: 2987,
      output_tokens: 91,
      cache_read_input_tokens: 33280,
      cache_creation_input_tokens: 0,
      prompt_tokens: 2987 + 33280,
      cache_hit_ratio: Number((33280 / (2987 + 33280)).toFixed(4)),
      num_turns: 1,
      minutesSinceLastTurn: 75,
      prefixChanges: [],
    });
  });

  it("flags zero-usage and error frames as non-countable with null ratio", () => {
    const zero = buildTurnUsageLogLine({
      sessionId: "s1",
      backend: "claude",
      model: "claude-opus-4-8",
      result: {
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      turnStartedAt: T0,
      previousTurnCompletedAt: undefined,
      prefixChanges: [],
    });
    expect(zero.usageStatus).toBe("zero");
    expect(zero.countable).toBe(false);
    expect(zero.cache_hit_ratio).toBeNull();
    // No previous real turn known (fresh session / pre-upgrade state) → null, not 0.
    expect(zero.minutesSinceLastTurn).toBeNull();

    const err = buildTurnUsageLogLine({
      sessionId: "s1",
      backend: "claude",
      model: "claude-opus-4-8",
      result: { subtype: "error_during_execution", is_error: true, usage: realUsage },
      turnStartedAt: T0,
      previousTurnCompletedAt: T0 - 60_000,
      prefixChanges: [],
    });
    expect(err.usageStatus).toBe("error");
    expect(err.countable).toBe(false);
  });

  it("carries the prefix changes that happened since the previous turn (cache_creation attribution)", () => {
    const line = buildTurnUsageLogLine({
      sessionId: "s1",
      backend: "claude",
      model: "claude-opus-4-8",
      result: { subtype: "success", is_error: false, usage: { ...realUsage, cache_creation_input_tokens: 40_000 } },
      turnStartedAt: T0,
      previousTurnCompletedAt: T0 - 2 * 60_000,
      prefixChanges: ["set_model", "mcp_toggle"],
    });
    expect(line.prefixChanges).toEqual(["set_model", "mcp_toggle"]);
    expect(line.minutesSinceLastTurn).toBe(2);
  });

  it("a negative gap (clock skew / turn started before the stored completion) clamps to 0", () => {
    const line = buildTurnUsageLogLine({
      sessionId: "s1",
      backend: "claude",
      model: "m",
      result: { subtype: "success", is_error: false, usage: realUsage },
      turnStartedAt: T0,
      previousTurnCompletedAt: T0 + 5_000,
      prefixChanges: [],
    });
    expect(line.minutesSinceLastTurn).toBe(0);
  });
});
