/**
 * Tests for the cost/latency scorer. The assertions pin EXACT extracted
 * values (not "parses without throwing"), because the whole point of the
 * scorer is the cross-backend asymmetry:
 *   - Claude per-cycle result frames must be SUMMED.
 *   - Codex cumulative tokenUsage must take the LAST .total (never summed).
 *   - Missing categories must be `unavailable`, never silently 0.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadRecording, parseRecording } from "../recording/read-recording.js";
import { scoreCostLatency, type Metric } from "./cost-latency.js";

const FX = join(__dirname, "..", "__fixtures__");

function value(m: Metric): number {
  if (m.kind !== "value") throw new Error(`expected value, got unavailable: ${m.why}`);
  return m.value;
}

describe("scoreCostLatency — claude (per-cycle, SUM)", () => {
  const score = scoreCostLatency(loadRecording(join(FX, "claude-basic.jsonl")));

  it("sums token usage across result frames and ignores the synthetic envelope", () => {
    expect(score.frames.result).toBe(2); // synthetic {data,seq} excluded
    expect(value(score.tokens.input)).toBe(10 + 5);
    expect(value(score.tokens.output)).toBe(20 + 7);
    expect(value(score.tokens.cached_input)).toBe(100 + 30);
    expect(value(score.tokens.cache_creation_input)).toBe(50 + 0);
    expect(value(score.tokens.total)).toBe(15 + 27 + 130 + 50);
  });

  it("sums cost and api latency, derives wall-clock from ts span", () => {
    expect(value(score.cost_usd)).toBeCloseTo(0.75, 10);
    expect(value(score.latency.api_ms)).toBe(1000 + 500);
    expect(value(score.latency.wall_clock_ms)).toBe(3000 - 1000);
  });

  it("marks codex-only reasoning tokens as unavailable, not zero", () => {
    expect(score.tokens.reasoning_output.kind).toBe("unavailable");
  });
});

describe("scoreCostLatency — codex (cumulative, LAST)", () => {
  const score = scoreCostLatency(loadRecording(join(FX, "codex-basic.jsonl")));

  it("takes the last cumulative total, never summing", () => {
    expect(score.frames.token_usage_updated).toBe(3);
    expect(value(score.tokens.input)).toBe(220);
    expect(value(score.tokens.output)).toBe(30);
    expect(value(score.tokens.cached_input)).toBe(40);
    expect(value(score.tokens.reasoning_output)).toBe(5);
    expect(value(score.tokens.total)).toBe(250);
  });

  it("reports cost and cache-creation as unavailable (codex omits them), not zero", () => {
    expect(score.cost_usd.kind).toBe("unavailable");
    expect(score.tokens.cache_creation_input.kind).toBe("unavailable");
    expect(score.latency.api_ms.kind).toBe("unavailable");
    expect(value(score.latency.wall_clock_ms)).toBe(2000 - 1000);
  });
});

describe("scoreCostLatency — degenerate & unknown inputs", () => {
  it("unknown backend → recognized:false, all unavailable, unhandled counted", () => {
    const score = scoreCostLatency(loadRecording(join(FX, "unknown-backend.jsonl")));
    expect(score.recognized).toBe(false);
    expect(score.backend).toBe("gemini");
    expect(score.tokens.total.kind).toBe("unavailable");
    expect(score.frames.unhandled).toBe(2);
  });

  it("claude recording with no usage frames → unavailable, not 0", () => {
    const rec = parseRecording(
      JSON.stringify({ _header: true, version: 3, backend_type: "claude" }) +
        "\n" +
        JSON.stringify({ ts: 1, dir: "in", ch: "cli", raw: JSON.stringify({ type: "keep_alive" }) }),
    );
    const score = scoreCostLatency(rec);
    expect(score.tokens.input.kind).toBe("unavailable");
    expect(score.cost_usd.kind).toBe("unavailable");
    // wall-clock still derivable from the single entry (span 0).
    expect(value(score.latency.wall_clock_ms)).toBe(0);
  });
});
