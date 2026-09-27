// Tests for the Council PRO Economy per-seat model tier decision (spec Story 2).
// The decision is FAIL-CLOSED: a guaranteed (security/LLM) lens is ALWAYS top; a
// missing complexity signal is top; thin/absent data is top. Cheap only switches
// on when the data-derived policy proves a (seat, band) safe with enough samples.
// These tests pin every one of those branches — they are the guardrail the spec's
// "🚫 Never tier-down the fail-closed lens" boundary rides on.

import { describe, it, expect } from "vitest";
import {
  decideTier,
  emptyTierPolicy,
  policyKey,
  resolveModelForTier,
  DEFAULT_TIER_MODEL_MAP,
  MIN_SAMPLES_FOR_CHEAP,
  type TierPolicy,
} from "./tier-policy.js";
import { computeComplexity, type Complexity } from "./complexity.js";

const lowComplexity: Complexity = computeComplexity({ diffFiles: 1, diffLines: 3, surfaceCount: 0, domainBreadth: 0 });

function policyWith(seatId: string, band: Complexity["band"], cheapEligible: boolean, sampleSize: number): TierPolicy {
  return { entries: { [policyKey(seatId, band)]: { cheapEligible, sampleSize } } };
}

describe("decideTier — fail-closed boundaries", () => {
  it("ALWAYS runs a guaranteed lens on top, even with a cheap-eligible policy", () => {
    // A policy that would make this seat cheap must be overridden by guaranteed.
    const policy = policyWith("hunt", lowComplexity.band, true, 1000);
    const d = decideTier({ seatId: "hunt", guaranteed: true }, lowComplexity, policy);
    expect(d).toEqual({ tier: "top", reason: "fail-closed-lens" });
  });

  it("runs guaranteed on top even when the complexity signal is missing", () => {
    const d = decideTier({ seatId: "willison", guaranteed: true }, null);
    expect(d).toEqual({ tier: "top", reason: "fail-closed-lens" });
  });

  it("falls back to top when the complexity signal is missing (non-guaranteed)", () => {
    const d = decideTier({ seatId: "saarinen", guaranteed: false }, null);
    expect(d).toEqual({ tier: "top", reason: "missing-complexity" });
  });

  it("falls back to top with the empty (default) policy — no data, no cost-cut", () => {
    const d = decideTier({ seatId: "saarinen", guaranteed: false }, lowComplexity, emptyTierPolicy());
    expect(d).toEqual({ tier: "top", reason: "insufficient-data" });
  });

  it("uses the default empty policy when none is passed", () => {
    const d = decideTier({ seatId: "saarinen", guaranteed: false }, lowComplexity);
    expect(d.tier).toBe("top");
    expect(d.reason).toBe("insufficient-data");
  });
});

describe("decideTier — data-derived cheap", () => {
  it("runs cheap when the policy is cheap-eligible with enough samples", () => {
    const policy = policyWith("saarinen", lowComplexity.band, true, MIN_SAMPLES_FOR_CHEAP);
    const d = decideTier({ seatId: "saarinen", guaranteed: false }, lowComplexity, policy);
    expect(d).toEqual({ tier: "cheap", reason: "data-derived-cheap" });
  });

  it("stays top when the sample size is below the confidence floor", () => {
    const policy = policyWith("saarinen", lowComplexity.band, true, MIN_SAMPLES_FOR_CHEAP - 1);
    const d = decideTier({ seatId: "saarinen", guaranteed: false }, lowComplexity, policy);
    expect(d).toEqual({ tier: "top", reason: "insufficient-data" });
  });

  it("stays top when the policy entry is not cheap-eligible", () => {
    const policy = policyWith("saarinen", lowComplexity.band, false, 1000);
    const d = decideTier({ seatId: "saarinen", guaranteed: false }, lowComplexity, policy);
    expect(d).toEqual({ tier: "top", reason: "insufficient-data" });
  });

  it("stays top when the policy has an entry for a DIFFERENT band only", () => {
    // Eligible at "high" but the change is "low" → no matching entry → top.
    const policy = policyWith("saarinen", "high", true, 1000);
    const d = decideTier({ seatId: "saarinen", guaranteed: false }, lowComplexity, policy);
    expect(d.reason).toBe("insufficient-data");
  });

  // Observer STOP regression (Story 2): a malformed sampleSize must NOT slip a
  // cheap decision through. NaN/Infinity make `< MIN` evaluate false, so the
  // sample count is validated as a finite non-negative integer FIRST.
  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["negative", -5],
    ["non-integer", 25.5],
  ])("stays top when sampleSize is %s (fail-closed on garbage data)", (_label, bad) => {
    const policy: TierPolicy = { entries: { [policyKey("saarinen", lowComplexity.band)]: { cheapEligible: true, sampleSize: bad as number } } };
    const d = decideTier({ seatId: "saarinen", guaranteed: false }, lowComplexity, policy);
    expect(d).toEqual({ tier: "top", reason: "insufficient-data" });
  });

  it("stays top when cheapEligible is a non-boolean truthy value (strict check)", () => {
    const policy: TierPolicy = { entries: { [policyKey("saarinen", lowComplexity.band)]: { cheapEligible: "yes" as unknown as boolean, sampleSize: 1000 } } };
    const d = decideTier({ seatId: "saarinen", guaranteed: false }, lowComplexity, policy);
    expect(d).toEqual({ tier: "top", reason: "insufficient-data" });
  });
});

describe("resolveModelForTier", () => {
  it("maps top to null (no override — use the pipeline default top model)", () => {
    expect(resolveModelForTier("top")).toBeNull();
  });

  it("maps cheap to the cheap alias", () => {
    expect(resolveModelForTier("cheap")).toBe(DEFAULT_TIER_MODEL_MAP.cheap);
  });

  it("honours a custom tier→model map", () => {
    expect(resolveModelForTier("cheap", { cheap: "gpt-mini", top: "gpt-5" })).toBe("gpt-mini");
    expect(resolveModelForTier("top", { cheap: "gpt-mini", top: "gpt-5" })).toBe("gpt-5");
  });
});
