// Tests for the Council PRO Economy complexity signal (spec Story 1 & 3).
// Validates: determinism (identical inputs ⇒ identical output), fail-loud
// rejection of invalid vectors, and that band monotonically follows the vector.
// The band cutoffs are provisional/observability-only — these tests pin the
// CURRENT seed behaviour so Story 3's data-derived replacement is a visible,
// intentional change, not a silent drift.

import { describe, it, expect } from "vitest";
import {
  assertComplexity,
  assertComplexitySignal,
  computeComplexity,
  provisionalBand,
  type ComplexitySignal,
} from "./complexity.js";

const zero: ComplexitySignal = { diffFiles: 0, diffLines: 0, surfaceCount: 0, domainBreadth: 0 };

describe("assertComplexitySignal", () => {
  it("accepts a valid non-negative integer vector", () => {
    expect(() => assertComplexitySignal({ diffFiles: 1, diffLines: 10, surfaceCount: 2, domainBreadth: 1 })).not.toThrow();
  });

  // Fail-loud: a float/negative/NaN slipping into the dataset would poison every
  // threshold Story 3 derives from it, so each is rejected rather than coerced.
  it.each([
    ["negative", { ...zero, diffFiles: -1 }],
    ["float", { ...zero, diffLines: 1.5 }],
    ["NaN", { ...zero, surfaceCount: NaN }],
    ["non-number", { ...zero, domainBreadth: "3" as unknown as number }],
  ])("rejects a %s field", (_label, bad) => {
    expect(() => assertComplexitySignal(bad as ComplexitySignal)).toThrow();
  });
});

describe("provisionalBand", () => {
  it("classifies a tiny single-surface change as low", () => {
    expect(provisionalBand({ diffFiles: 1, diffLines: 5, surfaceCount: 0, domainBreadth: 0 })).toBe("low");
  });

  it("classifies a mid-size multi-surface change as medium", () => {
    // 2 files + 100/50 lines + 1 surface*3 + 1 domain*3 = 2+2+3+3 = 10 ⇒ medium (>=6, <20)
    expect(provisionalBand({ diffFiles: 2, diffLines: 100, surfaceCount: 1, domainBreadth: 1 })).toBe("medium");
  });

  it("classifies a broad multi-domain change as high", () => {
    // surface*3*3 + domain*3*3 dominates ⇒ >=20
    expect(provisionalBand({ diffFiles: 5, diffLines: 400, surfaceCount: 3, domainBreadth: 3 })).toBe("high");
  });

  it("is monotonic: growing the vector never lowers the band", () => {
    const low = provisionalBand({ diffFiles: 1, diffLines: 0, surfaceCount: 0, domainBreadth: 0 });
    const mid = provisionalBand({ diffFiles: 1, diffLines: 0, surfaceCount: 2, domainBreadth: 1 });
    const high = provisionalBand({ diffFiles: 1, diffLines: 0, surfaceCount: 4, domainBreadth: 4 });
    const order = { low: 0, medium: 1, high: 2 };
    expect(order[mid]).toBeGreaterThanOrEqual(order[low]);
    expect(order[high]).toBeGreaterThanOrEqual(order[mid]);
  });
});

describe("computeComplexity", () => {
  it("preserves the raw vector and stamps the provisional source", () => {
    const c = computeComplexity({ diffFiles: 3, diffLines: 42, surfaceCount: 2, domainBreadth: 1 });
    expect(c).toMatchObject({ diffFiles: 3, diffLines: 42, surfaceCount: 2, domainBreadth: 1, bandSource: "provisional-heuristic" });
    expect(["low", "medium", "high"]).toContain(c.band);
  });

  it("is deterministic — identical inputs give identical output", () => {
    const input = { diffFiles: 4, diffLines: 88, surfaceCount: 3, domainBreadth: 2 };
    expect(computeComplexity(input)).toEqual(computeComplexity(input));
  });
});

describe("assertComplexity (read path — preserves band/bandSource)", () => {
  const valid = { diffFiles: 1, diffLines: 5, surfaceCount: 4, domainBreadth: 4, band: "high", bandSource: "data-derived" };

  it("preserves an on-disk band/bandSource verbatim, never recomputing", () => {
    // The vector is tiny (would be `low` under the heuristic) but the stored band
    // is `high` from a data-derived source — assertComplexity must trust the disk.
    const c = assertComplexity(valid);
    expect(c.band).toBe("high");
    expect(c.bandSource).toBe("data-derived");
  });

  it("rejects an unknown band", () => {
    expect(() => assertComplexity({ ...valid, band: "extreme" })).toThrow();
  });

  it("rejects an unknown bandSource", () => {
    expect(() => assertComplexity({ ...valid, bandSource: "vibes" })).toThrow();
  });

  it("rejects an invalid underlying vector", () => {
    expect(() => assertComplexity({ ...valid, diffFiles: -3 })).toThrow();
  });

  it("rejects a non-object", () => {
    expect(() => assertComplexity(null)).toThrow();
  });
});
