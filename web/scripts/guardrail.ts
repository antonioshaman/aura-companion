#!/usr/bin/env bun
// Council PRO Economy — the non-negotiable quality-floor guardrail (spec
// `council-pro-economy.md`, Story 4). A hermetic, deterministic gate that proves
// the economy optimizations (data-derived tier policy + reduced-depth thresholds)
// never trade away a P1 or the fail-closed security/LLM lens.
//
// It CANNOT run the LLM council in CI, so it does not re-derive review quality;
// instead it verifies the DECISION outputs against the seeded dataset, encoding
// the spec's three hard invariants:
//
//   A. Zero P1 regression — a (seat, band) that has EVER produced a surviving P1
//      in the dataset must NOT be cheap-tiered (the seat that catches P1s stays on
//      the top model in that band).
//   B. Fail-closed lens untouchable — a guaranteed (security/llm/refactor/test)
//      seat resolves to `top` for every band, regardless of policy.
//   C. Reduced depth never covers a P1 bucket — the derived depth ceiling sits
//      strictly BELOW the smallest change that ever produced a surviving P1.
//
// The `--ci` entrypoint loads the checked-in synthetic fixture and exits non-zero
// on any violation (zero LLM calls) — the load-bearing gate. `deriveTierPolicy`/
// `deriveDepthThresholds` can be INJECTED so a test can prove the guardrail
// actually catches a deliberately-unsafe policy, not just that today's derivation
// happens to be safe.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CouncilRunStats } from "./run-stats.js";
import { parseRunStats } from "./run-stats.js";
import type { Complexity, ComplexityBand } from "./complexity.js";
import {
  decideTier,
  type TierPolicy,
} from "./tier-policy.js";
import {
  deriveTierPolicy,
  deriveDepthThresholds,
  type DepthThresholds,
  type DeriveOptions,
} from "./stats-derive.js";

export interface GuardrailViolation {
  kind: "p1-seat-demoted" | "guaranteed-tiered-down" | "depth-covers-p1";
  detail: string;
}

export interface GuardrailInputs {
  /** Injectable for tests; defaults to the data-derived policy. */
  tierPolicy?: TierPolicy;
  /** Injectable for tests; defaults to the data-derived thresholds. */
  depth?: DepthThresholds;
  deriveOptions?: DeriveOptions;
}

// A representative Complexity carrying a specific band. The tier decision only
// reads `.band`, so the raw vector is a filler.
function complexityForBand(band: ComplexityBand): Complexity {
  return { diffFiles: 0, diffLines: 0, surfaceCount: 0, domainBreadth: 0, band, bandSource: "data-derived" };
}

/**
 * Check the three quality-floor invariants against a dataset. Returns every
 * violation (empty = the floor holds). Pure.
 */
export function checkGuardrail(runs: CouncilRunStats[], inputs?: GuardrailInputs): GuardrailViolation[] {
  const tierPolicy = inputs?.tierPolicy ?? deriveTierPolicy(runs, inputs?.deriveOptions);
  const depth = inputs?.depth ?? deriveDepthThresholds(runs, inputs?.deriveOptions);
  const violations: GuardrailViolation[] = [];

  // Aggregate per (seat, band): did it ever produce a surviving P1? is it guaranteed?
  interface Agg { guaranteed: boolean; hasSurvivingP1: boolean; }
  const perSeatBand = new Map<string, Agg & { seatId: string; band: ComplexityBand }>();
  let minSurvivingP1Lines = Number.POSITIVE_INFINITY;
  let minSurvivingP1Files = Number.POSITIVE_INFINITY;

  for (const r of runs) {
    const band = r.complexity.band;
    let runHasSurvivingP1 = false;
    for (const s of r.seats) {
      const key = `${s.seatId}|${band}`;
      let a = perSeatBand.get(key);
      if (!a) {
        a = { seatId: s.seatId, band, guaranteed: false, hasSurvivingP1: false };
        perSeatBand.set(key, a);
      }
      if (s.guaranteed) a.guaranteed = true;
      for (const f of s.findings) {
        if (f.survived && f.priority === "P1") {
          a.hasSurvivingP1 = true;
          runHasSurvivingP1 = true;
        }
      }
    }
    if (runHasSurvivingP1) {
      minSurvivingP1Lines = Math.min(minSurvivingP1Lines, r.complexity.diffLines);
      minSurvivingP1Files = Math.min(minSurvivingP1Files, r.complexity.diffFiles);
    }
  }

  for (const a of perSeatBand.values()) {
    const decision = decideTier({ seatId: a.seatId, guaranteed: a.guaranteed }, complexityForBand(a.band), tierPolicy);
    // Invariant B: a guaranteed lens must never be tiered below top.
    if (a.guaranteed && decision.tier !== "top") {
      violations.push({
        kind: "guaranteed-tiered-down",
        detail: `guaranteed lens ${a.seatId} resolved to ${decision.tier} in band ${a.band} (must be top)`,
      });
    }
    // Invariant A: a seat that has produced a surviving P1 must not be cheap-tiered here.
    if (a.hasSurvivingP1 && decision.tier === "cheap") {
      violations.push({
        kind: "p1-seat-demoted",
        detail: `seat ${a.seatId} produced a surviving P1 in band ${a.band} but was tier-down to cheap`,
      });
    }
  }

  // Invariant C: the reduced-depth ceiling must sit strictly below the smallest
  // surviving-P1 change size.
  if (depth.reducedDepthMaxLines !== null && Number.isFinite(minSurvivingP1Lines)) {
    if (depth.reducedDepthMaxLines >= minSurvivingP1Lines) {
      violations.push({
        kind: "depth-covers-p1",
        detail: `reducedDepthMaxLines=${depth.reducedDepthMaxLines} >= smallest surviving-P1 diffLines=${minSurvivingP1Lines}`,
      });
    }
  }
  if (depth.reducedDepthMaxFiles !== null && Number.isFinite(minSurvivingP1Files)) {
    if (depth.reducedDepthMaxFiles >= minSurvivingP1Files) {
      violations.push({
        kind: "depth-covers-p1",
        detail: `reducedDepthMaxFiles=${depth.reducedDepthMaxFiles} >= smallest surviving-P1 diffFiles=${minSurvivingP1Files}`,
      });
    }
  }

  return violations;
}

/** Load the checked-in synthetic guardrail fixture. */
export function loadGuardrailFixture(path?: string): CouncilRunStats[] {
  // `import.meta.url` (not Bun-only `import.meta.dir`) so the path resolves under
  // both `bun scripts/guardrail.ts` and the vitest/node test runner.
  const abs = path ?? fileURLToPath(new URL("./__fixtures__/council-economy/guardrail-runs.json", import.meta.url));
  const raw = JSON.parse(readFileSync(abs, "utf8")) as unknown[];
  const runs: CouncilRunStats[] = [];
  for (const entry of raw) {
    const parsed = parseRunStats(JSON.stringify(entry));
    if (!parsed.ok) throw new Error(`guardrail fixture: invalid run record (${parsed.reason})`);
    runs.push(parsed.record);
  }
  return runs;
}

if (import.meta.main) {
  const isCi = process.argv.includes("--ci");
  if (!isCi) {
    console.error("usage: guardrail.ts --ci   (loads the checked-in fixture and fails on any violation)");
    process.exit(2);
  }
  try {
    const runs = loadGuardrailFixture();
    const violations = checkGuardrail(runs);
    if (violations.length === 0) {
      console.log(JSON.stringify({ ok: true, runs: runs.length, violations: 0 }));
      process.exit(0);
    }
    console.error(JSON.stringify({ ok: false, violations }, null, 2));
    process.exit(1);
  } catch (e) {
    console.error(`guardrail: ${(e as Error).message}`);
    process.exit(1);
  }
}
