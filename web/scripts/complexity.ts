#!/usr/bin/env bun
// Council PRO Economy — the complexity signal (spec `council-pro-economy.md`,
// Story 1 & 3 foundation).
//
// "Complexity" is a COMPUTED signal, never a model's self-report (spec
// Assumption): diff size (files + lines) × surface count × changed-domain
// breadth. Pure and deterministic — identical inputs ⇒ identical output, no
// Date/randomness/locale (mirrors the RC-2 engine's determinism discipline,
// dahl #7).
//
// The band cutoffs here are PROVISIONAL / observability-only and MUST NOT gate
// any cost decision on their own — doing so would "invent a threshold with no
// data" (spec Boundary 🚫). They exist so a recorded run carries a coarse label
// for grouping while the dataset is still being collected. Story 3 replaces
// provisional bands with thresholds DERIVED from the recorded run dataset;
// `bandSource` stamps which regime produced a record's band so a data-derived
// reclassification is never confused with the seed heuristic.

export type ComplexityBand = "low" | "medium" | "high";
export type BandSource = "provisional-heuristic" | "data-derived";

/** The raw, authoritative complexity vector. Bands are derived FROM this. */
export interface ComplexitySignal {
  /** Number of changed files in the diff under review. */
  diffFiles: number;
  /** Added + deleted lines across the diff. */
  diffLines: number;
  /** Distinct product/stack surfaces the change touches (fingerprint surfaces). */
  surfaceCount: number;
  /** Distinct changed domains (closed-vocab council domains). */
  domainBreadth: number;
}

export interface Complexity extends ComplexitySignal {
  band: ComplexityBand;
  bandSource: BandSource;
}

const SIGNAL_FIELDS = ["diffFiles", "diffLines", "surfaceCount", "domainBreadth"] as const;

/**
 * Validate a raw vector: every field must be a finite, non-negative integer.
 * Fail-loud (throw) rather than coercing — a NaN/float/negative slipping into
 * the dataset silently would poison every threshold Story 3 later derives from
 * it (matches the catalog loader's reject-don't-coerce ethos).
 */
export function assertComplexitySignal(v: ComplexitySignal): void {
  for (const f of SIGNAL_FIELDS) {
    const n = v[f];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw new Error(
        `complexity: ${f} must be a non-negative integer, got ${JSON.stringify(n)}`,
      );
    }
  }
}

// Provisional weights: surface/domain breadth dominates raw line churn (a 3-line
// change spanning 3 surfaces is riskier than a 300-line change in one file).
// Line churn is discounted heavily (÷50) so a mechanical rename does not inflate
// the band. These are SEED constants, deliberately coarse — NOT a load-bearing
// threshold (see the file header). Story 3 owns the data-derived replacement.
const W_FILES = 1;
const W_LINES = 1 / 50;
const W_SURFACE = 3;
const W_DOMAIN = 3;
const LOW_MAX = 6; // score < LOW_MAX ⇒ low
const MEDIUM_MAX = 20; // LOW_MAX ≤ score < MEDIUM_MAX ⇒ medium; else high

/** Provisional, observability-only band. Do NOT use to gate a cost decision. */
export function provisionalBand(v: ComplexitySignal): ComplexityBand {
  assertComplexitySignal(v);
  const score =
    v.diffFiles * W_FILES +
    v.diffLines * W_LINES +
    v.surfaceCount * W_SURFACE +
    v.domainBreadth * W_DOMAIN;
  if (score < LOW_MAX) return "low";
  if (score < MEDIUM_MAX) return "medium";
  return "high";
}

/**
 * Compute the full complexity from a raw vector, stamping the provisional band
 * and its source. The vector is the authoritative record; the band is a coarse
 * grouping label.
 */
export function computeComplexity(v: ComplexitySignal): Complexity {
  return {
    diffFiles: v.diffFiles,
    diffLines: v.diffLines,
    surfaceCount: v.surfaceCount,
    domainBreadth: v.domainBreadth,
    band: provisionalBand(v),
    bandSource: "provisional-heuristic",
  };
}
