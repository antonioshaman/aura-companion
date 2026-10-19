#!/usr/bin/env bun
// RC-2 stack-accurate brief construction (PLAN Task 7, willison R3/R4).
//
// The load-bearing rule (R3): an advisor's brief names the DETECTED-STACK tokens
// it actually covers (matchedSignals ∩ fingerprint), injected from the SAME
// fingerprint object for every seat — never the advisor's full declared signal
// set. That alone kills "advise for the advisor's default framework": vanrossum
// seated on a FastAPI repo gets `fastapi` in its focus and never `aiogram`,
// because aiogram is not in the fingerprint (the 0-aiogram success metric).
//
// The contradiction flag (R4) is the secondary, COMPUTED guard: when a framework-
// specialist advisor is seated with NONE of its frameworks in the fingerprint, the
// brief emits a visible MISMATCH flag pointing at the detected frameworks — the
// safety branch is deterministic, not left to model judgement.

import type { Fingerprint } from "./fingerprint";
import type { AdvisorProfile, Vocabulary } from "./capability-catalog";

export interface BriefContext {
  advisorId: string;
  /** Multi-line detected-stack summary — identical string injected into every brief. */
  detectedStack: string;
  /** Fingerprint signals this advisor covers — the focus of its advice. */
  adviseOn: string[];
  /** The framework subset of adviseOn (what framework its advice should target). */
  frameworkFocus: string[];
  /** Non-null when the advisor is a framework specialist seated with no matching framework. */
  mismatchFlag: string | null;
}

const DIMENSION_ORDER = [
  "languages",
  "runtimes",
  "frameworks",
  "datastores",
  "orm-migrations",
  "infra",
  "surfaces",
] as const;

/** Deterministic multi-line detected-stack context (willison R3 — one per fingerprint). */
export function buildDetectedStackContext(fingerprint: Fingerprint): string {
  if (fingerprint.kind === "needs-confirmation") {
    return "DETECTED STACK: (none — stack unconfirmed; ask the developer)";
  }
  const lines: string[] = ["DETECTED STACK:"];
  for (const dim of DIMENSION_ORDER) {
    const tokens = fingerprint.byDimension[dim];
    if (tokens.length > 0) lines.push(`  ${dim}: ${tokens.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Build the stack-accurate brief context for one seated advisor. `matchedSignals`
 * comes from the scorer's RankedCandidate for this advisor.
 */
export function buildAdvisorBrief(
  profile: AdvisorProfile,
  matchedSignals: string[],
  fingerprint: Fingerprint,
  vocab: Vocabulary,
): BriefContext {
  const frameworkFocus = matchedSignals.filter((s) => vocab.frameworks.has(s)).sort();
  const advisorFrameworks = profile.signals.filter((s) => vocab.frameworks.has(s)).sort();

  let mismatchFlag: string | null = null;
  if (advisorFrameworks.length > 0 && frameworkFocus.length === 0) {
    const detected = fingerprint.byDimension.frameworks;
    const detectedStr = detected.length > 0 ? detected.join(", ") : "no framework detected";
    mismatchFlag =
      `MISMATCH: this advisor specialises in [${advisorFrameworks.join(", ")}] but none are in the detected stack ` +
      `([${detectedStr}]). Advise for the detected stack — do NOT assume [${advisorFrameworks.join(", ")}].`;
  }

  return {
    advisorId: profile.id,
    detectedStack: buildDetectedStackContext(fingerprint),
    adviseOn: [...matchedSignals].sort(),
    frameworkFocus,
    mismatchFlag,
  };
}
