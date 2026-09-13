import { describe, expect, it } from "vitest";
import {
  shouldAutoCompactContext,
  computeContextUsedPercent,
  type ModelUsageEntry,
} from "./context-auto-compact.js";

/** Build a modelUsage entry with zeros for the fields a test doesn't exercise. */
function usage(partial: Partial<ModelUsageEntry>): ModelUsageEntry {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    contextWindow: 0,
    ...partial,
  };
}

describe("shouldAutoCompactContext", () => {
  it("fires once when context usage reaches the high-water threshold", () => {
    // Validates the main production trigger: the UI can show 85%+ context and
    // the server should synthesize a single `/compact` turn.
    expect(shouldAutoCompactContext({
      contextUsedPercent: 85,
      alreadyFired: false,
      isCompacting: false,
    })).toEqual({ kind: "fire" });
  });

  it("holds after firing until usage drops to the rearm threshold", () => {
    // Prevents spamming `/compact` on every result while the session remains
    // near-full or while Claude has not yet reported a lower post-compact pct.
    expect(shouldAutoCompactContext({
      contextUsedPercent: 95,
      alreadyFired: true,
      isCompacting: false,
    })).toEqual({ kind: "hold" });

    expect(shouldAutoCompactContext({
      contextUsedPercent: 70,
      alreadyFired: true,
      isCompacting: false,
    })).toEqual({ kind: "rearm" });
  });

  it("does not fire while a compaction is already in progress", () => {
    // The CLI can emit status=compacting before its next result; in that state
    // another synthetic slash command would only add noise.
    expect(shouldAutoCompactContext({
      contextUsedPercent: 100,
      alreadyFired: false,
      isCompacting: true,
    })).toEqual({ kind: "hold" });
  });
});

describe("computeContextUsedPercent", () => {
  it("returns null when there is nothing measurable yet", () => {
    // No modelUsage, empty map, or a zero contextWindow all mean "unknown" —
    // the caller must NOT clobber a previously-good percent with a bogus 0.
    expect(computeContextUsedPercent(undefined)).toBeNull();
    expect(computeContextUsedPercent({})).toBeNull();
    expect(computeContextUsedPercent({ m: usage({ inputTokens: 10, contextWindow: 0 }) })).toBeNull();
  });

  it("counts cache tokens as resident context (the bug that read ~0%)", () => {
    // The regression: a resumed session whose prompt is almost entirely cached
    // read ~0% under (in+out)/window because cache tokens were excluded, so it
    // never crossed 85%. Here 160k of 200k is cache -> must read 80%, not 0%.
    const pct = computeContextUsedPercent({
      "claude-opus-4-8": usage({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 150_000,
        cacheCreationInputTokens: 10_000,
        contextWindow: 200_000,
      }),
    });
    expect(pct).toBe(80);
  });

  it("pins to the primary model instead of letting key order decide", () => {
    // Two models on one result: primary Opus at ~30% of its 1M window and a
    // Haiku sub-agent overflowing its own 200k window. The old loop stored
    // whichever came last; we must report the primary Opus figure regardless of
    // insertion order.
    const modelUsage = {
      "claude-haiku-4-5": usage({ inputTokens: 260_000, contextWindow: 200_000 }), // 130% -> clamp 100
      "claude-opus-4-8": usage({ cacheReadInputTokens: 300_000, contextWindow: 1_000_000 }), // 30%
    };
    expect(computeContextUsedPercent(modelUsage, "claude-opus-4-8")).toBe(30);
  });

  it("falls back to the max per-model fraction when the primary is absent", () => {
    // Order-independence guarantee: with no (or an unknown) primary model, the
    // result is the largest per-model fraction, never the last key written.
    const modelUsage = {
      a: usage({ inputTokens: 50_000, contextWindow: 200_000 }), // 25%
      b: usage({ inputTokens: 180_000, contextWindow: 200_000 }), // 90%
    };
    expect(computeContextUsedPercent(modelUsage)).toBe(90);
    expect(computeContextUsedPercent(modelUsage, "missing-model")).toBe(90);
  });

  it("clamps cumulative multi-iteration overshoot to 100", () => {
    // modelUsage sums a turn's internal requests, so cache reuse can exceed the
    // window. A >=threshold gate wants a bounded 100, not 1650%.
    const pct = computeContextUsedPercent({
      "claude-opus-4-8": usage({
        outputTokens: 211_198,
        cacheReadInputTokens: 16_505_838,
        cacheCreationInputTokens: 1_044_313,
        contextWindow: 1_000_000,
      }),
    });
    expect(pct).toBe(100);
  });
});
