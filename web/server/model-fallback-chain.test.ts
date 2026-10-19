import { describe, it, expect } from "vitest";
import {
  CLAUDE_MODEL_FALLBACK_CHAIN,
  classifyFallbackReason,
  computeSilenceRotation,
  nextModelInChain,
  findModelTableInconsistencies,
  assertModelTablesInSync,
} from "./model-fallback-chain.js";
import { BROKEN_MODEL_SUBSTITUTIONS } from "./broken-model-substitution.js";

describe("nextModelInChain", () => {
  it("returns the next usable model for chain members", () => {
    expect(nextModelInChain("claude-opus-5")).toBe("claude-opus-4-8");
    // Substitution table is empty since 2026-10-16 (CLI 2.1.283 re-probe),
    // so 4.8 falls back to 4.7 again instead of skipping it.
    expect(nextModelInChain("claude-opus-4-8")).toBe("claude-opus-4-7");
    expect(nextModelInChain("claude-opus-4-7")).toBe("claude-opus-4-6");
    expect(nextModelInChain("claude-opus-4-6")).toBe("claude-sonnet-4-6");
    expect(nextModelInChain("claude-sonnet-4-6")).toBe("claude-haiku-4-5");
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

  it("skips fallback targets that are substituted back to an earlier model", () => {
    // If `claude-opus-4-7` spawns as 4.8 (substitution entry), rotating
    // 4.8 -> 4.7 would relaunch right back on 4.8 and reset the silence
    // counter forever. Injected table: the live one is empty since 2026-10-16.
    const table = [{ from: "claude-opus-4-7", to: "claude-opus-4-8", reason: "fixture: CLI stdout bug" }];
    expect(nextModelInChain("claude-opus-4-8", table)).toBe("claude-opus-4-6");
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

// The fallback chain and BROKEN_MODEL_SUBSTITUTIONS are two hand-maintained
// tables that must agree: a downgrade target the substitution table rewrites
// would bounce back on relaunch (2026-09-09 Silent Cliff). The module runs
// `assertModelTablesInSync()` at load, so the live tables are checked the
// moment anything imports this file; these tests pin the checker itself with
// injected tables (the live substitution table is empty since 2026-10-16).
describe("model table sync check", () => {
  const CHAIN = ["m-a", "m-b", "m-c", "m-d"] as const;

  it("the live tables are in sync (also enforced at module load)", () => {
    expect(findModelTableInconsistencies()).toEqual([]);
    expect(() => assertModelTablesInSync()).not.toThrow();
  });

  it("accepts a substituted chain member because nextModelInChain steps past it", () => {
    // m-b is rewritten to m-a; next(m-a) must skip m-b and land on m-c.
    const table = [{ from: "m-b", to: "m-a", reason: "fixture" }];
    expect(nextModelInChain("m-a", table, CHAIN)).toBe("m-c");
    expect(findModelTableInconsistencies(CHAIN, table)).toEqual([]);
  });

  it("flags a duplicated chain entry", () => {
    const problems = findModelTableInconsistencies(["m-a", "m-b", "m-a"], []);
    expect(problems.some((p) => p.includes("m-a more than once"))).toBe(true);
  });

  it("flags a substitution that maps a model to itself", () => {
    const problems = findModelTableInconsistencies(CHAIN, [{ from: "m-b", to: "m-b", reason: "fixture" }]);
    expect(problems.some((p) => p.includes("maps a model to itself"))).toBe(true);
  });

  it("flags a duplicated substitution `from`", () => {
    const problems = findModelTableInconsistencies(CHAIN, [
      { from: "m-b", to: "m-a", reason: "fixture" },
      { from: "m-b", to: "m-c", reason: "fixture" },
    ]);
    expect(problems.some((p) => p.includes("m-b more than once"))).toBe(true);
  });

  it("flags a chained substitution (the spawn rewrite is single-hop)", () => {
    // m-c -> m-b, but m-b is itself broken (-> m-a): spawning m-c would land
    // on the broken m-b.
    const problems = findModelTableInconsistencies(CHAIN, [
      { from: "m-b", to: "m-a", reason: "fixture" },
      { from: "m-c", to: "m-b", reason: "fixture" },
    ]);
    expect(problems.some((p) => p.includes("m-c -> m-b targets another substituted model"))).toBe(true);
  });

  it("assertModelTablesInSync throws a named error listing every problem", () => {
    expect(() => assertModelTablesInSync(["m-a", "m-a"], [{ from: "m-b", to: "m-b", reason: "fixture" }]))
      .toThrow(/out of sync[\s\S]*m-a more than once[\s\S]*maps a model to itself/);
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

/**
 * `computeSilenceRotation` — pure decision helper for the recurring-silence
 * model-rotation loop in `session-orchestrator.ts:handleBackendSilent`.
 * See the JSDoc there for the full contract.
 */
describe("computeSilenceRotation", () => {
  const CHAIN: Record<string, string> = {
    "claude-opus-5": "claude-opus-4-8",
    "claude-opus-4-8": "claude-opus-4-7",
    "claude-opus-4-7": "claude-opus-4-6",
    "claude-opus-4-6": "claude-sonnet-4-6",
    "claude-sonnet-4-6": "claude-haiku-4-5",
  };
  const fakeChain = (m: string) => CHAIN[m] ?? null;

  it("first silence for a model → count=1, no rotation", () => {
    const d = computeSilenceRotation(undefined, "claude-opus-4-7", 2, fakeChain);
    expect(d.rotateTo).toBeNull();
    expect(d.newRecord).toEqual({ count: 1, lastSilentModel: "claude-opus-4-7" });
  });

  it("second silence on the SAME model at threshold=2 → rotates and clears map", () => {
    const prev = { count: 1, lastSilentModel: "claude-opus-4-7" };
    const d = computeSilenceRotation(prev, "claude-opus-4-7", 2, fakeChain);
    expect(d.rotateTo).toBe("claude-opus-4-6");
    expect(d.newRecord).toBeNull();
  });

  it("silence on a DIFFERENT model resets counter to 1", () => {
    const prev = { count: 5, lastSilentModel: "claude-opus-4-7" };
    const d = computeSilenceRotation(prev, "claude-opus-4-8", 2, fakeChain);
    expect(d.rotateTo).toBeNull();
    expect(d.newRecord).toEqual({ count: 1, lastSilentModel: "claude-opus-4-8" });
  });

  it("threshold=3 → does not rotate on second silence", () => {
    const prev = { count: 1, lastSilentModel: "claude-opus-5" };
    const d = computeSilenceRotation(prev, "claude-opus-5", 3, fakeChain);
    expect(d.rotateTo).toBeNull();
    expect(d.newRecord).toEqual({ count: 2, lastSilentModel: "claude-opus-5" });
  });

  it("threshold reached but chain-tail: no rotation, counter keeps bumping (rotation exhausted)", () => {
    // claude-haiku-4-5 is chain tail in fakeChain (no successor).
    const prev = { count: 1, lastSilentModel: "claude-haiku-4-5" };
    const d = computeSilenceRotation(prev, "claude-haiku-4-5", 2, fakeChain);
    expect(d.rotateTo).toBeNull();
    // Bumped record persists so caller can escalate.
    expect(d.newRecord).toEqual({ count: 2, lastSilentModel: "claude-haiku-4-5" });
  });

  it("unknown model (not in chain) at threshold: no rotation target, no rotation", () => {
    const prev = { count: 1, lastSilentModel: "claude-fable-5-1" };
    const d = computeSilenceRotation(prev, "claude-fable-5-1", 2, fakeChain);
    expect(d.rotateTo).toBeNull();
    expect(d.newRecord).toEqual({ count: 2, lastSilentModel: "claude-fable-5-1" });
  });

  it("uses the default chain when no chainNext is provided", () => {
    // Default is `nextModelInChain` against CLAUDE_MODEL_FALLBACK_CHAIN.
    // claude-opus-5 → claude-opus-4-8 per the real chain (asserted
    // elsewhere in this file's nextModelInChain tests).
    const prev = { count: 1, lastSilentModel: "claude-opus-5" };
    const d = computeSilenceRotation(prev, "claude-opus-5", 2);
    expect(d.rotateTo).toBe("claude-opus-4-8");
    expect(d.newRecord).toBeNull();
  });

  it("threshold=1 → rotates on very first silence", () => {
    const d = computeSilenceRotation(undefined, "claude-opus-4-7", 1, fakeChain);
    expect(d.rotateTo).toBe("claude-opus-4-6");
    expect(d.newRecord).toBeNull();
  });
});

describe("BROKEN_MODEL_SUBSTITUTIONS content sanity — regression guard", () => {
  it("opus-4-7 is NOT substituted any more (re-probed OK on CLI 2.1.283, 2026-10-16)", () => {
    // The entry was added 2026-09-10 for the CLI 2.1.266 stdout-emit bug.
    // A two-turn stdin stream-json probe on 2.1.283 emitted every frame, so
    // the entry was removed; the recurring-silence rotation is the net.
    const entry = BROKEN_MODEL_SUBSTITUTIONS.find((s) => s.from === "claude-opus-4-7");
    expect(entry).toBeUndefined();
  });
});

/**
 * Pins the auto-fallback chain for the models the operator actually runs
 * (2026-10-17). These were captured BEFORE the registry gained the newer
 * verified models (opus-5-5, fable-5/5-1, opus-5, opus-4-7) and must stay
 * identical after: the chain is a hand-ordered constant, independent of the
 * registry and its `tier`, so "verifying" a model must never pull it into a
 * failover path or make an older model fail UP to a newer/pricier one.
 */
describe("fallback chain pins (registry verification must not move them)", () => {
  it("opus-5-5 has no auto-fallback (not in the closed chain)", () => {
    expect(nextModelInChain("claude-opus-5-5")).toBeNull();
  });

  it("opus-4-8 falls back DOWN to opus-4-7, never up to a 5.x / fable model", () => {
    expect(nextModelInChain("claude-opus-4-8")).toBe("claude-opus-4-7");
  });

  it("fable-5 and fable-5-1 have no auto-fallback", () => {
    expect(nextModelInChain("claude-fable-5")).toBeNull();
    expect(nextModelInChain("claude-fable-5-1")).toBeNull();
  });

  it("sonnet-4-6 falls back to haiku-4-5", () => {
    expect(nextModelInChain("claude-sonnet-4-6")).toBe("claude-haiku-4-5");
  });

  it("the whole chain is unchanged and contains no fable / opus-5-5 entry", () => {
    expect([...CLAUDE_MODEL_FALLBACK_CHAIN]).toEqual([
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("silence rotation off opus-5-5 / fable-5 never rotates (no successor)", () => {
    expect(computeSilenceRotation({ count: 5, lastSilentModel: "claude-opus-5-5" }, "claude-opus-5-5", 2).rotateTo).toBeNull();
    expect(computeSilenceRotation({ count: 5, lastSilentModel: "claude-fable-5" }, "claude-fable-5", 2).rotateTo).toBeNull();
  });
});
