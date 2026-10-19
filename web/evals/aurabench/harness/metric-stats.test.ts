/**
 * Tests for knownStats (P6/FIX-D2-4). Validates that unknown metrics (null —
 * e.g. Codex cost, which Codex never reports) are excluded from the mean and
 * reported as a count, instead of being averaged in as zeros, and that an
 * all-unknown column yields a null mean (not 0 or NaN).
 */

import { describe, it, expect } from "vitest";
import { knownStats } from "./metric-stats.js";

describe("knownStats", () => {
  it("averages only known values and counts the unknown ones", () => {
    // Zero is a KNOWN value and counts; null/undefined/NaN are unknown.
    expect(knownStats([2, null, 4, undefined, Number.NaN, 0])).toEqual({ n: 6, known: 3, unknown: 3, mean: 2, sum: 6 });
  });

  it("all unknown → mean and sum null, never 0", () => {
    expect(knownStats([null, null])).toEqual({ n: 2, known: 0, unknown: 2, mean: null, sum: null });
    expect(knownStats([])).toEqual({ n: 0, known: 0, unknown: 0, mean: null, sum: null });
  });
});
