#!/usr/bin/env bun
// Council PRO Economy — derive the adaptive levers FROM the recorded run dataset
// (spec `council-pro-economy.md`, Story 3: data-derived tier policy + review-depth
// thresholds). Pure functions over an array of CouncilRunStats; the caller reads
// the dataset via `readRunStats` and passes it in.
//
// Both derivations are FAIL-CLOSED on thin data (spec Boundary 🚫 "invent a
// threshold with no data → fall back to full"):
//   - fewer than `minSamples` observations ⇒ NO cheap-eligibility / NO reduced
//     depth (the full, top-tier roster runs);
//   - a guaranteed (fail-closed security/LLM/refactor/test) lens is NEVER marked
//     cheap-eligible;
//   - the depth ceiling is pinned strictly BELOW the smallest change that has ever
//     produced a surviving P1, so reduced depth can never cover a size band where a
//     P1 has historically appeared.
//
// The output `TierPolicy` feeds `decideTier` (Story 2); it does not itself switch
// cheap-tiering on — that also requires the Story 4 guardrail fixture to pass.

import type { CouncilRunStats } from "./run-stats.js";
import {
  MIN_SAMPLES_FOR_CHEAP,
  policyKey,
  type TierPolicy,
  type TierPolicyEntry,
} from "./tier-policy.js";

export interface DeriveOptions {
  /** Confidence floor: minimum observations before a data-derived opinion is trusted. */
  minSamples?: number;
}

interface SeatBandAgg {
  runs: number;
  /** Count of SURVIVING P1/P2 findings this seat produced in this band. */
  survivingHigh: number;
  /** True if the seat was ever a guaranteed (fail-closed) lens in this band. */
  guaranteedEver: boolean;
}

function isHigh(priority: string): boolean {
  return priority === "P1" || priority === "P2";
}

/**
 * Derive the cheap-eligibility policy for `decideTier`. A (seat, band) becomes
 * cheap-eligible only when, across ≥ `minSamples` runs, the seat produced ZERO
 * surviving P1/P2 findings there — i.e. the top model was adding no
 * guardrail-class value, so the cheap tier is a safe demotion candidate (spec
 * AC1.3: "a seat whose top-tier findings were consistently trivial is eligible
 * for demotion"). Guaranteed lenses are never eligible. Self-correcting: once a
 * cheap run yields a surviving P1/P2, `survivingHigh` goes non-zero and the entry
 * drops (promote back to top).
 */
export function deriveTierPolicy(runs: CouncilRunStats[], opts?: DeriveOptions): TierPolicy {
  const min = opts?.minSamples ?? MIN_SAMPLES_FOR_CHEAP;
  const agg = new Map<string, SeatBandAgg>();
  for (const r of runs) {
    const band = r.complexity.band;
    for (const s of r.seats) {
      const key = policyKey(s.seatId, band);
      let a = agg.get(key);
      if (!a) {
        a = { runs: 0, survivingHigh: 0, guaranteedEver: false };
        agg.set(key, a);
      }
      a.runs += 1;
      if (s.guaranteed) a.guaranteedEver = true;
      for (const f of s.findings) {
        if (f.survived && isHigh(f.priority)) a.survivingHigh += 1;
      }
    }
  }
  const entries: Record<string, TierPolicyEntry> = {};
  for (const [key, a] of agg) {
    if (a.guaranteedEver) continue; // fail-closed lens is never cheap-eligible
    if (a.runs >= min && a.survivingHigh === 0) {
      entries[key] = { cheapEligible: true, sampleSize: a.runs };
    }
  }
  return { entries };
}

export interface DepthThresholds {
  /**
   * A reduced roster is safe for a change whose `diffLines` is <= this. `null`
   * means "insufficient data — run the FULL roster" (fail-closed).
   */
  reducedDepthMaxLines: number | null;
  /** Same, for `diffFiles`. */
  reducedDepthMaxFiles: number | null;
  /** Observations backing the derivation. */
  sampleSize: number;
}

/**
 * Derive the review-depth thresholds from the dataset. The reduced-depth ceiling
 * is pinned strictly below the SMALLEST change that has ever produced a surviving
 * P1 — so a change small enough to fall under the ceiling is one where no P1 has
 * ever been seen. Fail-closed to `null` (full roster) when there are fewer than
 * `minSamples` runs, or when no surviving P1 exists yet to bound the ceiling
 * (zero-P1 data is ambiguous, not proof of safety).
 *
 * NOTE: reduced depth only ever drops NON-guaranteed, low-rank seats. The
 * security/LLM/refactor/test lenses are seated by the engine's composition floor
 * regardless of any depth threshold, and a security-relevant path always seats the
 * security lens (spec Boundary 🚫) — that is enforced at selection time, not here.
 */
export function deriveDepthThresholds(runs: CouncilRunStats[], opts?: DeriveOptions): DepthThresholds {
  const min = opts?.minSamples ?? MIN_SAMPLES_FOR_CHEAP;
  const insufficient: DepthThresholds = {
    reducedDepthMaxLines: null,
    reducedDepthMaxFiles: null,
    sampleSize: runs.length,
  };
  if (runs.length < min) return insufficient;

  const withSurvivingP1 = runs.filter((r) =>
    r.seats.some((s) => s.findings.some((f) => f.survived && f.priority === "P1")),
  );
  if (withSurvivingP1.length === 0) return insufficient; // nothing to bound the ceiling

  const minP1Lines = Math.min(...withSurvivingP1.map((r) => r.complexity.diffLines));
  const minP1Files = Math.min(...withSurvivingP1.map((r) => r.complexity.diffFiles));
  return {
    reducedDepthMaxLines: Math.max(0, minP1Lines - 1),
    reducedDepthMaxFiles: Math.max(0, minP1Files - 1),
    sampleSize: runs.length,
  };
}
