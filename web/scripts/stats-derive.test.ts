// Tests for Council PRO Economy derivations (spec Story 3): data-derived tier
// policy + review-depth thresholds. Every assertion pins a fail-closed property —
// thin data yields NO cheap-eligibility / NO reduced depth, a guaranteed lens is
// never demoted, and the depth ceiling sits strictly below the smallest P1 change.

import { describe, it, expect } from "vitest";
import { deriveTierPolicy, deriveDepthThresholds } from "./stats-derive.js";
import { decideTier, policyKey, MIN_SAMPLES_FOR_CHEAP } from "./tier-policy.js";
import { computeComplexity, type Complexity } from "./complexity.js";
import type { CouncilRunStats, SeatStat, FindingStat } from "./run-stats.js";

let seq = 0;
function run(opts: {
  band?: "low" | "medium" | "high";
  diffLines?: number;
  diffFiles?: number;
  seats: SeatStat[];
}): CouncilRunStats {
  // Build a complexity whose provisional band matches the requested band by
  // feeding a vector; but tests that care about band set it explicitly via the
  // vector below. For band-agnostic tests we just use the computed band.
  const complexity: Complexity = computeComplexity({
    diffFiles: opts.diffFiles ?? 1,
    diffLines: opts.diffLines ?? 5,
    surfaceCount: 0,
    domainBreadth: 0,
  });
  return {
    schemaVersion: 1,
    runId: `run-${seq++}`,
    ts: seq,
    skill: "council-review-aura",
    engineVersion: "rc2",
    complexity,
    seats: opts.seats,
  };
}

function seat(seatId: string, findings: FindingStat[], guaranteed = false, tier: "cheap" | "top" = "top"): SeatStat {
  return { seatId, guaranteed, tier, model: "m", findings };
}

const P1 = (id: string, survived = true): FindingStat => ({ id, priority: "P1", survived });
const P2 = (id: string, survived = true): FindingStat => ({ id, priority: "P2", survived });
const P3 = (id: string, survived = true): FindingStat => ({ id, priority: "P3", survived });

describe("deriveTierPolicy", () => {
  it("returns an empty policy on thin data (below minSamples)", () => {
    const runs = [run({ seats: [seat("saarinen", [])] }), run({ seats: [seat("saarinen", [])] })];
    expect(deriveTierPolicy(runs, { minSamples: 5 }).entries).toEqual({});
  });

  it("marks a seat cheap-eligible when >=minSamples runs produced zero surviving P1/P2", () => {
    // 3 runs, seat only ever produced P3 (or nothing) → top was wasted → demote-eligible.
    const runs = [
      run({ seats: [seat("saarinen", [P3("a")])] }),
      run({ seats: [seat("saarinen", [])] }),
      run({ seats: [seat("saarinen", [P3("b", false)])] }),
    ];
    const policy = deriveTierPolicy(runs, { minSamples: 3 });
    const band = runs[0].complexity.band;
    expect(policy.entries[policyKey("saarinen", band)]).toEqual({ cheapEligible: true, sampleSize: 3 });
  });

  it("does NOT mark a seat cheap-eligible if it produced any surviving P1/P2", () => {
    const runs = [
      run({ seats: [seat("saarinen", [P3("a")])] }),
      run({ seats: [seat("saarinen", [P1("crit")])] }), // one surviving P1 → keep top
      run({ seats: [seat("saarinen", [])] }),
    ];
    expect(deriveTierPolicy(runs, { minSamples: 3 }).entries).toEqual({});
  });

  it("ignores a DISCARDED (survived:false) P1 — only surviving high findings keep a seat on top", () => {
    const runs = [
      run({ seats: [seat("saarinen", [P1("x", false)])] }),
      run({ seats: [seat("saarinen", [P1("y", false)])] }),
      run({ seats: [seat("saarinen", [P3("z")])] }),
    ];
    const band = runs[0].complexity.band;
    expect(deriveTierPolicy(runs, { minSamples: 3 }).entries[policyKey("saarinen", band)]).toEqual({
      cheapEligible: true,
      sampleSize: 3,
    });
  });

  it("NEVER marks a guaranteed (fail-closed) lens cheap-eligible, even with zero high findings", () => {
    const runs = [
      run({ seats: [seat("hunt", [], true)] }),
      run({ seats: [seat("hunt", [], true)] }),
      run({ seats: [seat("hunt", [], true)] }),
    ];
    expect(deriveTierPolicy(runs, { minSamples: 3 }).entries).toEqual({});
  });

  it("feeds decideTier: a derived entry flips a non-guaranteed seat to cheap", () => {
    // End-to-end with the REAL confidence floor: decideTier gates on the module's
    // own MIN_SAMPLES_FOR_CHEAP, so the derived sampleSize must clear it. This is
    // the honest integration — derive proposes, decideTier independently gates.
    const runs = Array.from({ length: MIN_SAMPLES_FOR_CHEAP }, () => run({ seats: [seat("saarinen", [P3("a")])] }));
    const policy = deriveTierPolicy(runs); // default minSamples == MIN_SAMPLES_FOR_CHEAP
    const complexity = runs[0].complexity;
    expect(decideTier({ seatId: "saarinen", guaranteed: false }, complexity, policy)).toEqual({
      tier: "cheap",
      reason: "data-derived-cheap",
    });
    // ...but the SAME policy must still force a guaranteed seat to top.
    expect(decideTier({ seatId: "saarinen", guaranteed: true }, complexity, policy).tier).toBe("top");
  });

  it("a derive floor BELOW decideTier's floor yields entries decideTier won't honor (fail-closed)", () => {
    // Guards the two-floor interaction: derive with a small minSamples records a
    // low sampleSize; decideTier's hard floor still refuses it → top. Safe.
    const runs = [
      run({ seats: [seat("saarinen", [])] }),
      run({ seats: [seat("saarinen", [P3("a")])] }),
      run({ seats: [seat("saarinen", [])] }),
    ];
    const policy = deriveTierPolicy(runs, { minSamples: 3 });
    expect(decideTier({ seatId: "saarinen", guaranteed: false }, runs[0].complexity, policy).reason).toBe("insufficient-data");
  });
});

describe("deriveDepthThresholds", () => {
  it("returns null (full roster) on thin data", () => {
    const runs = [run({ diffLines: 10, seats: [seat("s", [])] })];
    expect(deriveDepthThresholds(runs, { minSamples: 5 })).toMatchObject({
      reducedDepthMaxLines: null,
      reducedDepthMaxFiles: null,
    });
  });

  it("returns null when no surviving P1 exists to bound the ceiling", () => {
    const runs = [
      run({ diffLines: 10, seats: [seat("s", [P2("a")])] }),
      run({ diffLines: 20, seats: [seat("s", [P3("b")])] }),
      run({ diffLines: 30, seats: [seat("s", [])] }),
    ];
    expect(deriveDepthThresholds(runs, { minSamples: 3 }).reducedDepthMaxLines).toBeNull();
  });

  it("pins the ceiling strictly below the smallest change that produced a surviving P1", () => {
    const runs = [
      run({ diffFiles: 2, diffLines: 40, seats: [seat("s", [P1("big")])] }), // P1 at 40 lines / 2 files
      run({ diffFiles: 5, diffLines: 100, seats: [seat("s", [P1("bigger")])] }),
      run({ diffFiles: 1, diffLines: 8, seats: [seat("s", [P3("tiny")])] }),
    ];
    const t = deriveDepthThresholds(runs, { minSamples: 3 });
    expect(t.reducedDepthMaxLines).toBe(39); // 40 - 1
    expect(t.reducedDepthMaxFiles).toBe(1); // 2 - 1
    expect(t.sampleSize).toBe(3);
  });

  // Observer STOP regression (Story 3): a surviving P1 at a zero-size change means
  // no reduced-depth band is ever safe — must fail closed to null, not clamp to 0.
  it("fails closed (null) when a surviving P1 occurred at zero lines", () => {
    const runs = [
      run({ diffFiles: 1, diffLines: 0, seats: [seat("s", [P1("zero-line")])] }),
      run({ diffFiles: 3, diffLines: 50, seats: [seat("s", [P3("a")])] }),
      run({ diffFiles: 2, diffLines: 30, seats: [seat("s", [])] }),
    ];
    expect(deriveDepthThresholds(runs, { minSamples: 3 }).reducedDepthMaxLines).toBeNull();
    expect(deriveDepthThresholds(runs, { minSamples: 3 }).reducedDepthMaxFiles).toBeNull();
  });

  it("fails closed (null) when a surviving P1 occurred at zero files", () => {
    const runs = [
      run({ diffFiles: 0, diffLines: 5, seats: [seat("s", [P1("zero-file")])] }),
      run({ diffFiles: 3, diffLines: 50, seats: [seat("s", [P3("a")])] }),
      run({ diffFiles: 2, diffLines: 30, seats: [seat("s", [])] }),
    ];
    expect(deriveDepthThresholds(runs, { minSamples: 3 }).reducedDepthMaxFiles).toBeNull();
  });

  it("ignores discarded P1s when bounding the ceiling (only surviving P1 counts)", () => {
    const runs = [
      run({ diffLines: 5, seats: [seat("s", [P1("discarded", false)])] }),
      run({ diffLines: 50, seats: [seat("s", [P1("real", true)])] }),
      run({ diffLines: 9, seats: [seat("s", [P3("x")])] }),
    ];
    // Only the surviving P1 at 50 lines bounds the ceiling → 49, NOT 4.
    expect(deriveDepthThresholds(runs, { minSamples: 3 }).reducedDepthMaxLines).toBe(49);
  });
});
