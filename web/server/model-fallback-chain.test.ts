import { describe, it, expect } from "vitest";
import {
  CLAUDE_MODEL_FALLBACK_CHAIN,
  classifyFallbackReason,
  nextModelInChain,
} from "./model-fallback-chain.js";

describe("nextModelInChain", () => {
  it("returns the model at index+1 for chain members", () => {
    for (let i = 0; i < CLAUDE_MODEL_FALLBACK_CHAIN.length - 1; i++) {
      const current = CLAUDE_MODEL_FALLBACK_CHAIN[i];
      const expected = CLAUDE_MODEL_FALLBACK_CHAIN[i + 1];
      expect(nextModelInChain(current)).toBe(expected);
    }
  });

  it("returns null for the last model in the chain", () => {
    const last = CLAUDE_MODEL_FALLBACK_CHAIN[CLAUDE_MODEL_FALLBACK_CHAIN.length - 1];
    expect(nextModelInChain(last)).toBeNull();
  });

  it("returns null for unknown models — chain-closed, never guesses", () => {
    expect(nextModelInChain("claude-fable-5-1")).toBeNull();
    expect(nextModelInChain("gpt-4")).toBeNull();
    expect(nextModelInChain("<synthetic>")).toBeNull();
  });

  it("returns null for null/undefined/empty", () => {
    expect(nextModelInChain(null)).toBeNull();
    expect(nextModelInChain(undefined)).toBeNull();
    expect(nextModelInChain("")).toBeNull();
  });

  it("chain is ordered strongest-to-weakest by convention (opus > sonnet > haiku)", () => {
    const chain = CLAUDE_MODEL_FALLBACK_CHAIN;
    // Structural: opus entries must all precede any sonnet, sonnet must
    // all precede haiku. This does not lock version numbers; it locks
    // the family ordering that makes "fallback" meaningful.
    const firstSonnet = chain.findIndex((m) => m.startsWith("claude-sonnet"));
    const firstHaiku = chain.findIndex((m) => m.startsWith("claude-haiku"));
    const lastOpus = chain.length - 1 - [...chain].reverse().findIndex((m) => m.startsWith("claude-opus"));
    expect(firstSonnet).toBeGreaterThan(lastOpus);
    if (firstHaiku >= 0) {
      const lastSonnet = chain.length - 1 - [...chain].reverse().findIndex((m) => m.startsWith("claude-sonnet"));
      expect(firstHaiku).toBeGreaterThan(lastSonnet);
    }
  });
});

describe("classifyFallbackReason", () => {
  it("recognises rate-limit surfaces", () => {
    expect(classifyFallbackReason("You've hit your session limit · resets 2:40am (UTC)")).toBe("rate_limit");
    expect(classifyFallbackReason("HTTP 429 rate_limit")).toBe("rate_limit");
    expect(classifyFallbackReason("Rate Limit Exceeded")).toBe("rate_limit");
  });

  it("recognises out-of-credits surfaces", () => {
    expect(classifyFallbackReason("Your account is out of credits.")).toBe("out_of_credits");
    expect(classifyFallbackReason("Error: insufficient credit balance")).toBe("out_of_credits");
    expect(classifyFallbackReason("credit_balance_too_low")).toBe("out_of_credits");
  });

  it("recognises unknown-model surfaces", () => {
    expect(classifyFallbackReason("Unknown model: claude-opus-99")).toBe("unknown_model");
    expect(classifyFallbackReason("Model not found for id 'foo'")).toBe("unknown_model");
    expect(classifyFallbackReason("Invalid model name")).toBe("unknown_model");
  });

  it("recognises model-not-available surfaces", () => {
    expect(classifyFallbackReason("model_not_available")).toBe("model_not_available");
    expect(classifyFallbackReason("This model is not available on your plan")).toBe("model_not_available");
    expect(classifyFallbackReason("Access denied to model claude-opus-5")).toBe("model_not_available");
  });

  it("returns null for non-error text — conservative by design", () => {
    expect(classifyFallbackReason("The quick brown fox jumps over the lazy dog.")).toBeNull();
    expect(classifyFallbackReason("Let me think about this...")).toBeNull();
    // A normal assistant answer might mention the word "rate" or "limit"
    // in prose; only the specific error-shape substrings should match.
    expect(classifyFallbackReason("The transfer rate is 500 KB/s.")).toBeNull();
    expect(classifyFallbackReason("Set a limit of 100 requests.")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(classifyFallbackReason("")).toBeNull();
  });

  it("is case-insensitive for the substring match", () => {
    expect(classifyFallbackReason("YOU'VE HIT YOUR SESSION LIMIT")).toBe("rate_limit");
    expect(classifyFallbackReason("Out Of Credits.")).toBe("out_of_credits");
  });
});
