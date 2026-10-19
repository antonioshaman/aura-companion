import { describe, expect, it } from "vitest";
import {
  contextTokensFromUsage,
  contextUsedPercent,
  largestContextWindow,
  shouldTrackContextUsage,
} from "./context-occupancy.js";

// The single formula behind `context_used_percent`, imported by BOTH the
// browser meter (src/ws.ts) and the server's persisted value (ws-bridge.ts).
// These fixtures pin the semantics introduced in #196: per-turn occupancy
// (input + cache_read + cache_write) over the largest declared window.

describe("contextTokensFromUsage", () => {
  it("counts fresh input + cache-read + cache-write, not output", () => {
    // Cache tokens are resident in the window; output becomes NEXT turn's input.
    expect(contextTokensFromUsage({
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 50000,
      cache_creation_input_tokens: 9000,
    })).toBe(60000);
  });

  it("treats missing / non-finite counters as zero", () => {
    expect(contextTokensFromUsage({})).toBe(0);
    expect(contextTokensFromUsage({ input_tokens: Number.NaN, cache_read_input_tokens: 5 })).toBe(5);
  });
});

describe("shouldTrackContextUsage", () => {
  const real = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  it("accepts a main-thread frame with real usage", () => {
    expect(shouldTrackContextUsage({ usage: real, parentToolUseId: null })).toBe(true);
    expect(shouldTrackContextUsage({ usage: real, streamStatus: "complete" })).toBe(true);
  });

  it("rejects missing and all-zero usage (synthetic interrupted frames zeroed the meter)", () => {
    expect(shouldTrackContextUsage({ usage: undefined })).toBe(false);
    expect(shouldTrackContextUsage({ usage: null })).toBe(false);
    expect(shouldTrackContextUsage({
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })).toBe(false);
  });

  it("rejects interrupted-stream frames even if they carry counters", () => {
    expect(shouldTrackContextUsage({ usage: real, streamStatus: "interrupted" })).toBe(false);
  });

  it("rejects Task subagent frames (their own, unrelated context)", () => {
    expect(shouldTrackContextUsage({ usage: real, parentToolUseId: "toolu_1" })).toBe(false);
  });
});

describe("largestContextWindow", () => {
  it("returns 0 when nothing declares a window", () => {
    expect(largestContextWindow(undefined)).toBe(0);
    expect(largestContextWindow(null)).toBe(0);
    expect(largestContextWindow({})).toBe(0);
    expect(largestContextWindow({ m: { contextWindow: 0 } })).toBe(0);
    expect(largestContextWindow({ m: {} })).toBe(0);
  });

  it("takes the largest window independent of key order", () => {
    // The old server loop let whichever model came last win; a title Haiku
    // listed after the main model shrank the denominator.
    expect(largestContextWindow({ opus: { contextWindow: 1_000_000 }, haiku: { contextWindow: 200_000 } })).toBe(1_000_000);
    expect(largestContextWindow({ haiku: { contextWindow: 200_000 }, opus: { contextWindow: 1_000_000 } })).toBe(1_000_000);
  });
});

describe("contextUsedPercent", () => {
  it("returns null until both the tokens and a positive window are known", () => {
    // A partial reading must not clobber a good (persisted) value.
    expect(contextUsedPercent(undefined, 200_000)).toBeNull();
    expect(contextUsedPercent(null, 200_000)).toBeNull();
    expect(contextUsedPercent(1000, undefined)).toBeNull();
    expect(contextUsedPercent(1000, 0)).toBeNull();
    expect(contextUsedPercent(1000, -5)).toBeNull();
  });

  it("rounds to an integer percent", () => {
    expect(contextUsedPercent(60_000, 200_000)).toBe(30);
    expect(contextUsedPercent(1_000, 200_000)).toBe(1); // 0.5 → rounds up
    expect(contextUsedPercent(0, 200_000)).toBe(0);
  });

  it("clamps to 100", () => {
    expect(contextUsedPercent(500_000, 200_000)).toBe(100);
  });

  it("end to end: a cache-heavy resumed turn reads 80%, not ~0%", () => {
    // Fixture from the regression: 2k fresh + 158k cache-read in a 200k window.
    // The old server formula, (inputTokens + outputTokens) / window, read ~1%.
    const tokens = contextTokensFromUsage({ input_tokens: 2000, cache_read_input_tokens: 158_000 });
    const window = largestContextWindow({ "claude-sonnet-4-6": { contextWindow: 200_000 } });
    expect(contextUsedPercent(tokens, window)).toBe(80);
  });
});
