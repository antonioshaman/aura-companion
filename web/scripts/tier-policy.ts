#!/usr/bin/env bun
// Council PRO Economy — per-seat model TIER decision (spec `council-pro-economy.md`,
// Story 2: complexity-tiered model selection).
//
// This module answers ONE question deterministically: for a given seat on a given
// change, does it run on the `cheap` or the `top` model tier? It is the
// mechanism; the *learning* that decides which (seat, complexity-band) pairs are
// safe to run cheap is derived from the run-stats dataset (Story 3) and passed in
// as a `TierPolicy`. The decision is FAIL-CLOSED by construction:
//
//   - a fail-closed cross-stack lens (engine `isGuaranteed` — security/refactor/
//     llm/test) ALWAYS runs `top`, regardless of policy or complexity. This is the
//     spec Boundary 🚫 "never drop or tier-down the fail-closed security/LLM lens"
//     encoded at the single decision point, so no caller can route around it.
//   - a missing/unparseable complexity signal → `top` (the safe/higher tier),
//     never the cheapest (spec AC1.4 negative).
//   - insufficient historical data for a (seat, band) → `top` (never cost-cut on
//     unknown ground — spec Boundary 🚫 "invent a threshold with no data → full").
//
// So with an EMPTY policy (the state until the dataset has accumulated and Story 3
// derives one) every seat runs `top` — i.e. installing this module changes no
// behaviour on its own. Cheap-tiering only switches on once the dataset proves a
// pair safe AND the Story 4 guardrail fixture is in place.

import type { Complexity, ComplexityBand } from "./complexity.js";
import type { ModelTier } from "./run-stats.js";

export type { ModelTier } from "./run-stats.js";

// Confidence floor: how many recorded runs a (seat, band) needs before a
// cheap-tier decision is trusted. Below it the decision falls back to `top`.
// This is a "sufficient-data" gate (exactly what the spec Boundary wants:
// insufficient data → safe/full), NOT a guessed cost threshold. Tunable; Story 3
// may derive it from the dataset's variance.
export const MIN_SAMPLES_FOR_CHEAP = 20;

export interface SeatTierInput {
  seatId: string;
  /** Engine `isGuaranteed` — fail-closed cross-stack lens. */
  guaranteed: boolean;
}

export type TierReason =
  | "fail-closed-lens" // guaranteed → always top
  | "missing-complexity" // complexity absent/unparseable → safe top
  | "insufficient-data" // no trustworthy data-derived cheap-eligibility → safe top
  | "data-derived-cheap" // dataset proves cheap safe for (seat, band)
  | "data-derived-top"; // dataset says top for (seat, band)

export interface TierDecision {
  tier: ModelTier;
  reason: TierReason;
}

/**
 * A data-derived cheap-eligibility map, keyed `"<seatId>|<band>"`. Produced by
 * Story 3 from the run-stats dataset; an entry means "for this seat at this
 * complexity band, N recorded runs support running `cheap`". Absence ⇒ no opinion
 * ⇒ fall back to `top`.
 */
export interface TierPolicyEntry {
  cheapEligible: boolean;
  /** Number of recorded runs backing this entry (gates against thin data). */
  sampleSize: number;
}
export interface TierPolicy {
  entries: Record<string, TierPolicyEntry>;
}

/** The safe default policy: no opinions ⇒ every non-guaranteed seat runs `top`. */
export function emptyTierPolicy(): TierPolicy {
  return { entries: {} };
}

export function policyKey(seatId: string, band: ComplexityBand): string {
  return `${seatId}|${band}`;
}

/**
 * Map an abstract tier to the concrete model the dispatch should pass to `Task`.
 * `top` resolves to `null` — meaning "do NOT override; use the pipeline's default
 * (top) model" — so that with the empty policy every seat runs on the default and
 * installing the mechanism changes nothing until the dataset proves a pair cheap.
 * `cheap` resolves to a cheap-tier alias (Claude Code `Task` accepts the aliases).
 */
export interface TierModelMap {
  cheap: string;
  top: string | null;
}
export const DEFAULT_TIER_MODEL_MAP: TierModelMap = { cheap: "haiku", top: null };

export function resolveModelForTier(tier: ModelTier, map: TierModelMap = DEFAULT_TIER_MODEL_MAP): string | null {
  return tier === "cheap" ? map.cheap : map.top;
}

/**
 * Decide the model tier for one seat. Pure and deterministic. `complexity` is
 * null when the signal was missing/unparseable. `policy` defaults to the empty
 * (all-`top`) policy so a caller with no dataset yet is safe by default.
 */
export function decideTier(
  seat: SeatTierInput,
  complexity: Complexity | null,
  policy: TierPolicy = emptyTierPolicy(),
): TierDecision {
  // 1. Fail-closed lens is ALWAYS top — checked FIRST so nothing below can
  //    downgrade it (spec Boundary 🚫). Even a missing complexity can't matter.
  if (seat.guaranteed) return { tier: "top", reason: "fail-closed-lens" };

  // 2. No complexity signal → safe/higher tier (spec AC1.4 negative).
  if (complexity == null) return { tier: "top", reason: "missing-complexity" };

  // 3. Consult the data-derived policy. Absent entry, thin sample, or
  //    not-cheap-eligible all fall back to top (never cheap on unknown ground).
  const entry = policy.entries[policyKey(seat.seatId, complexity.band)];
  if (!entry || entry.sampleSize < MIN_SAMPLES_FOR_CHEAP || !entry.cheapEligible) {
    return { tier: "top", reason: "insufficient-data" };
  }
  return { tier: "cheap", reason: "data-derived-cheap" };
}
