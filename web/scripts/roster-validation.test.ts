// Tests for the RC-2 Chair-roster fail-closed validator (PLAN Task 6, willison R1).
// A valid choice passes; every drift class fails closed to the deterministic
// guardrail fallback.

import { describe, it, expect } from "vitest";
import { validateChosenRoster } from "./roster-validation.js";
import type { RankedCandidate } from "./advisor-scorer.js";

function cand(id: string, score: number): RankedCandidate {
  return { advisorId: id, score, matchedSignals: [], matchedDomains: [], crossStack: false };
}
// ranked high→low
const CANDS = [cand("dahl", 13), cand("brandur", 12), cand("abramov", 11), cand("hunt", 4), cand("fowler", 4)];

describe("validateChosenRoster", () => {
  it("accepts a valid in-pool roster within guardrails and returns it in rank order", () => {
    const v = validateChosenRoster(["abramov", "dahl", "brandur"], CANDS);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.roster).toEqual(["dahl", "brandur", "abramov"]); // rank order, not chosen order
  });

  it("fails closed on an off-pool (hallucinated) seat", () => {
    const v = validateChosenRoster(["dahl", "ghost", "brandur"], CANDS);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("off-pool");
      expect(v.offending).toEqual(["ghost"]);
      expect(v.fallback).toEqual(["dahl", "brandur", "abramov", "hunt", "fowler"]);
    }
  });

  it("fails closed on a duplicate seat", () => {
    const v = validateChosenRoster(["dahl", "dahl", "brandur"], CANDS);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("duplicate");
  });

  it("fails closed below the min when more candidates were available", () => {
    const v = validateChosenRoster(["dahl"], CANDS, 3, 11);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("below-min");
  });

  it("fails closed above the max", () => {
    const many = Array.from({ length: 13 }, (_, i) => cand(`a${i}`, 10 - i));
    const chosen = many.map((c) => c.advisorId); // 13 > 11
    const v = validateChosenRoster(chosen, many, 3, 11);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("above-max");
      expect(v.fallback).toHaveLength(11);
    }
  });

  it("fails closed on an empty Chair choice", () => {
    const v = validateChosenRoster([], CANDS);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("empty");
  });

  it("does NOT fail below-min when the candidate pool itself is thin (not the Chair's fault)", () => {
    const thin = [cand("hunt", 4), cand("fowler", 4)]; // only 2 candidates exist
    const v = validateChosenRoster(["hunt", "fowler"], thin, 3, 11);
    expect(v.ok).toBe(true);
  });
});
