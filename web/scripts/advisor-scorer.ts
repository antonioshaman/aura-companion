#!/usr/bin/env bun
// RC-2 deterministic advisor scorer + guardrails (PLAN Task 5 — the spine).
//
// Pure function of (fingerprint signals × feature domains × capability profiles).
// Emits ranked candidates as DATA; the Chair (LLM) chooses within this set and is
// validated fail-closed against it (Task 6). No floats, no Date, no randomness,
// no reliance on Map/Set iteration order leaking to output — identical inputs ⇒
// byte-identical ranking (dahl #7). Tie-break is total: score desc, then advisorId
// lexicographic, so equal-score advisors always resolve to one fixed order.
//
// `any`-signal advisors (hunt, fowler, willison, beck) are cross-stack: they are
// eligible on every fingerprint via a baseline, so a security/refactor/test/LLM
// lens stays structurally seatable and cannot be starved out by a poisoned
// fingerprint (hunt #4 composition floor). The max cap bounds subprocess fan-out.

import type { Fingerprint } from "./fingerprint";
import type { AdvisorProfile } from "./capability-catalog";

export const MIN_SEATS = 3;
export const MAX_SEATS = 11;

// Fixed, boring weights (Carmack / Fowler R7: no tunable DSL). Domain relevance
// to THIS feature is weighted slightly above raw stack-signal overlap.
const W_SIGNAL = 2;
const W_DOMAIN = 3;
// Baseline for a cross-stack (`any`) lens so it is always a candidate.
const CROSS_STACK_BASELINE = 1;

const WILDCARD = "any";

// Locale-INDEPENDENT ordering. `String.prototype.localeCompare` resolves against
// the runtime's ICU collation (orders `-`/`_` differently from code points, and
// can shift across Bun/ICU versions) — a determinism leak the exact-roster tests
// exist to prevent (dahl #4). Every sort in the engine uses this one comparator so
// ordering is a function of the inputs alone. Do NOT reintroduce localeCompare.
export function cmpCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface RankedCandidate {
  advisorId: string;
  score: number;
  /** Concrete fingerprint signals this advisor covers (excludes the `any` wildcard). */
  matchedSignals: string[];
  /** Feature domains this advisor covers. */
  matchedDomains: string[];
  /** True when the advisor declared the `any` cross-stack signal. */
  crossStack: boolean;
}

function intersectSorted(a: string[], b: Set<string>): string[] {
  return a.filter((t) => b.has(t)).sort();
}

/**
 * Score every profile against the fingerprint + the feature's domains. Returns
 * only CANDIDATES (score > 0) — an advisor with capabilities but zero signal AND
 * zero domain overlap is excluded, never seated on a quota (spec 🚫). Sorted by
 * score desc, then advisorId asc (total, deterministic).
 *
 * `featureDomains` is a closed-vocab subset the caller derives from the feature
 * brief; pass all domains for a maximally-broad feature. It is structured input,
 * not free text, so scoring stays deterministic.
 */
export function scoreAdvisors(
  fingerprint: Fingerprint,
  featureDomains: string[],
  profiles: AdvisorProfile[],
): RankedCandidate[] {
  const fpSignals = new Set(fingerprint.signals);
  const featureDom = new Set(featureDomains.map((d) => d.toLowerCase()));

  const candidates: RankedCandidate[] = [];
  for (const p of profiles) {
    const crossStack = p.signals.includes(WILDCARD);
    const concreteSignals = p.signals.filter((s) => s !== WILDCARD);
    const matchedSignals = intersectSorted(concreteSignals, fpSignals);
    const matchedDomains = intersectSorted(p.domains, featureDom);

    let score = matchedSignals.length * W_SIGNAL + matchedDomains.length * W_DOMAIN;
    if (crossStack) score += CROSS_STACK_BASELINE;

    if (score <= 0) continue; // no overlap → not a candidate (no quota padding)
    candidates.push({ advisorId: p.id, score, matchedSignals, matchedDomains, crossStack });
  }

  candidates.sort((a, b) => b.score - a.score || cmpCodePoint(a.advisorId, b.advisorId));
  return candidates;
}

/**
 * Drop redundant duplicates (dahl #8): if two candidates cover the EXACT same
 * matched-signal set AND matched-domain set, the lower-ranked one is redundant.
 * Genuine lane-splits (different matched sets) are preserved. Pure over the
 * already-sorted list.
 */
export function dedupRedundant(ranked: RankedCandidate[]): RankedCandidate[] {
  const seen = new Set<string>();
  const out: RankedCandidate[] = [];
  for (const c of ranked) {
    // Cross-stack (`any`) lenses are NEVER deduped against each other. On a narrow
    // feature all four collapse to the identical key `"|"` (empty matchedSignals —
    // the `any` wildcard is excluded — and empty matchedDomains), which would drop
    // all but the alphabetical survivor from `ranked`, and thus from `crowdedOut`
    // too — the exact silent starve of the security/LLM lens the composition floor
    // exists to prevent (hunt #1). Each is a distinct advisor; keep them all so the
    // guarantee partition + crowded-out surfacing can see every one.
    if (c.crossStack) {
      out.push(c);
      continue;
    }
    const key = c.matchedSignals.join(",") + "|" + c.matchedDomains.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Apply the seat guardrails to a ranked candidate list. Returns the seated set:
 * at least `min` (if that many candidates exist), at most `max`. The list is
 * assumed already ranked+deduped; this just clamps. Because cross-stack lenses
 * always score > 0, a real catalog yields ≥4 candidates, so the min floor is
 * naturally satisfiable without quota-padding zero-relevance advisors.
 */
export function applyGuardrails(
  ranked: RankedCandidate[],
  min: number = MIN_SEATS,
  max: number = MAX_SEATS,
): RankedCandidate[] {
  if (ranked.length <= max) return ranked.slice();
  return ranked.slice(0, max);
  // NOTE: if ranked.length < min there is nothing to pad with that has any
  // relevance; seating a zero-score advisor would violate the "no quota" rule.
  // The caller surfaces "council smaller than min — thin fingerprint" instead.
}

export interface Composition {
  seated: RankedCandidate[];
  /**
   * Ranked candidates that scored > 0 but fell below the max cap. Surfaced so
   * the Chair/UI can tell the developer who was crowded out — the hunt #4
   * mitigation: a security/adversarial lens stays a candidate and its exclusion
   * is VISIBLE (never a silent starve), so it can be added back via veto/add
   * (AC3.5).
   */
  crowdedOut: RankedCandidate[];
  /** True when fewer than `min` relevant candidates existed (caller should note it). */
  belowMin: boolean;
  cappedAtMax: boolean;
}

// Variant B (composition guarantee): a cross-stack (`any`) lens is SEATED, not
// merely a candidate, whenever its domain is relevant to THIS feature (its
// matchedDomains is non-empty). The universal lenses (security / refactor / llm /
// test) were in every fixed panel, so this restores the AC1.4 back-compat
// superset for them and satisfies hunt #4 (a relevant security lens can never be
// crowded out by stack-signal matchers), while a narrow feature that doesn't
// touch a lens's domain still leaves it unseated (adaptivity preserved).
export function isGuaranteed(c: RankedCandidate): boolean {
  return c.crossStack && c.matchedDomains.length > 0;
}

/**
 * The single seat-selection algorithm (dahl #2 / willison #1: one floor, one
 * source of truth). Reserve seats for the relevant cross-stack lenses first, then
 * fill the rest by rank up to the cap, and present in overall rank order. Used by
 * BOTH `composeCouncil` (the proposal path) AND `roster-validation`'s fail-closed
 * fallback, so the deterministic destination can never be a weaker floor than the
 * proposal. `ranked` is assumed already scored+deduped.
 */
export function selectSeats(
  ranked: RankedCandidate[],
  max: number = MAX_SEATS,
): RankedCandidate[] {
  const guaranteed = ranked.filter(isGuaranteed);
  const rest = ranked.filter((c) => !isGuaranteed(c));
  const seated: RankedCandidate[] = [];
  for (const c of guaranteed) {
    if (seated.length >= max) break;
    seated.push(c);
  }
  for (const c of rest) {
    if (seated.length >= max) break;
    seated.push(c);
  }
  seated.sort((a, b) => b.score - a.score || cmpCodePoint(a.advisorId, b.advisorId));
  return seated;
}

/** Convenience: score → dedup → guardrail in one deterministic pass. */
export function composeCouncil(
  fingerprint: Fingerprint,
  featureDomains: string[],
  profiles: AdvisorProfile[],
  min: number = MIN_SEATS,
  max: number = MAX_SEATS,
): Composition {
  const ranked = dedupRedundant(scoreAdvisors(fingerprint, featureDomains, profiles));
  const seated = selectSeats(ranked, max);
  const seatedIds = new Set(seated.map((c) => c.advisorId));
  return {
    seated,
    crowdedOut: ranked.filter((c) => !seatedIds.has(c.advisorId)),
    belowMin: seated.length < min,
    cappedAtMax: ranked.length > max,
  };
}
