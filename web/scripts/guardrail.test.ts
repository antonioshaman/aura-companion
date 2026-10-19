// Tests for the Council PRO Economy quality-floor guardrail (spec Story 4).
// Two duties: (1) the checked-in fixture must PASS the real derivation (proving the
// levers are safe on representative data, and that cheap-tiering is not trivially
// off), and (2) the guardrail must DETECT a deliberately-unsafe policy/depth
// (proving it's a real gate, not a rubber stamp). If it could only ever pass it
// would teach its operator to ignore it.

import { describe, it, expect } from "vitest";
import { checkGuardrail, loadGuardrailFixture } from "./guardrail.js";
import { deriveTierPolicy } from "./stats-derive.js";
import { policyKey, type TierPolicy } from "./tier-policy.js";

const fixture = loadGuardrailFixture();

describe("guardrail — the fixture is safe under the real derivation", () => {
  it("reports zero violations on the checked-in fixture", () => {
    expect(checkGuardrail(fixture)).toEqual([]);
  });

  // Guards against a trivial pass: the derivation must ACTUALLY have turned cheap
  // on for the safe seat (saarinen|low, 22 runs, only P3). If it didn't, the
  // fixture's "0 violations" would prove nothing about the P1-seat protection.
  it("actually derived a cheap-eligible entry (pass is non-trivial)", () => {
    const policy = deriveTierPolicy(fixture);
    expect(policy.entries[policyKey("saarinen", "low")]).toMatchObject({ cheapEligible: true });
  });
});

describe("guardrail — detects unsafe optimizations", () => {
  it("catches a policy that tier-downs a seat which produced a surviving P1", () => {
    // abramov|medium produced a surviving P1 in the fixture — force it cheap.
    const unsafe: TierPolicy = {
      entries: { [policyKey("abramov", "medium")]: { cheapEligible: true, sampleSize: 9999 } },
    };
    const violations = checkGuardrail(fixture, { tierPolicy: unsafe });
    expect(violations.some((v) => v.kind === "p1-seat-demoted")).toBe(true);
  });

  it("catches a depth ceiling that reaches into a P1 size bucket", () => {
    // Smallest surviving-P1 change in the fixture is 40 lines / 2 files; a ceiling
    // at 40 lines covers that bucket.
    const violations = checkGuardrail(fixture, {
      depth: { reducedDepthMaxLines: 40, reducedDepthMaxFiles: 5, sampleSize: 25 },
    });
    expect(violations.some((v) => v.kind === "depth-covers-p1")).toBe(true);
  });

  it("holds invariant B: even a policy marking a guaranteed lens cheap resolves to top (decideTier enforces it)", () => {
    // hunt is guaranteed in the fixture. An injected cheap entry for it must NOT
    // produce a violation, because decideTier forces guaranteed → top regardless.
    const unsafe: TierPolicy = {
      entries: { [policyKey("hunt", "low")]: { cheapEligible: true, sampleSize: 9999 } },
    };
    const violations = checkGuardrail(fixture, { tierPolicy: unsafe });
    expect(violations.some((v) => v.kind === "guaranteed-tiered-down")).toBe(false);
  });
});
