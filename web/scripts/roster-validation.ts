#!/usr/bin/env bun
// RC-2 Chair-roster fail-closed validator (PLAN Task 6).
//
// Split Phase (willison R1, Fowler R1): the deterministic scorer emits candidates
// as DATA; the Chair (LLM in the skill) chooses a seated roster from that set. This
// validator is the gate that keeps the Chair honest — it confirms every chosen seat
// exists in the candidate set and the count is within guardrails, and FAILS CLOSED
// to the deterministic top-N when the Chair drifts (hallucinated id, off-pool seat,
// too few/many). The model may choose within the floor; it may never overrule it.

import {
  isGuaranteed,
  MAX_SEATS,
  MIN_SEATS,
  selectSeats,
  type RankedCandidate,
} from "./advisor-scorer";

export type RosterRejectReason =
  | "off-pool" // a chosen id is not in the candidate set (hallucinated / renamed)
  | "duplicate" // a chosen id appears twice
  | "below-min" // fewer than min seats
  | "above-max" // more than max seats
  | "missing-guaranteed" // omits a relevant cross-stack lens the composition floor guarantees
  | "empty"; // Chair returned nothing

export type RosterValidation =
  | { ok: true; roster: string[] }
  | {
      ok: false;
      reason: RosterRejectReason;
      offending: string[];
      /** Deterministic guardrail roster the caller falls back to (fail-closed). */
      fallback: string[];
    };

/**
 * Validate the Chair's chosen roster against the code-emitted candidate set.
 * `chosen` is the list of advisorIds the Chair seated. Fail-closed: any drift
 * returns `ok:false` with the deterministic `fallback` (top-N by score within
 * guardrails) so the caller ships a valid roster regardless of model behaviour.
 */
export function validateChosenRoster(
  chosen: string[],
  candidates: RankedCandidate[],
  min: number = MIN_SEATS,
  max: number = MAX_SEATS,
): RosterValidation {
  // Fail-closed fallback goes through the SAME seat-selection as the proposal path
  // (guaranteed cross-stack lens reserved before rank-fill) — NOT plain top-N — so
  // the deterministic destination is never a weaker floor than composeCouncil
  // (dahl #2 / willison #1).
  const seatedFallback = selectSeats(candidates, max);
  const fallback = seatedFallback.map((c) => c.advisorId);
  const candidateIds = new Set(candidates.map((c) => c.advisorId));

  if (chosen.length === 0) {
    return { ok: false, reason: "empty", offending: [], fallback };
  }

  const dupes = chosen.filter((id, i) => chosen.indexOf(id) !== i);
  if (dupes.length > 0) {
    return { ok: false, reason: "duplicate", offending: [...new Set(dupes)], fallback };
  }

  const offPool = chosen.filter((id) => !candidateIds.has(id));
  if (offPool.length > 0) {
    return { ok: false, reason: "off-pool", offending: offPool, fallback };
  }

  // Guardrails. below-min only fails when MORE candidates were available than the
  // Chair seated (a thin candidate pool that is itself < min is not the Chair's
  // fault — the caller surfaces "thin fingerprint" instead of failing closed).
  if (chosen.length < min && candidates.length >= min) {
    return { ok: false, reason: "below-min", offending: [], fallback };
  }
  if (chosen.length > max) {
    return { ok: false, reason: "above-max", offending: [], fallback };
  }

  // Composition-floor enforcement (hunt #4): every relevant cross-stack lens the
  // engine would seat MUST be present. The scorer reserves guaranteed lenses ahead
  // of rank-fill, so any guaranteed lens seated by `selectSeats` is un-starvable by
  // design — the Chair may not drop it. Enforcing it here (not just in the proposal)
  // closes the gap where a valid-but-lean roster silently omits the security/LLM lens.
  const chosenSet = new Set(chosen);
  const missingGuaranteed = seatedFallback
    .filter(isGuaranteed)
    .map((c) => c.advisorId)
    .filter((id) => !chosenSet.has(id));
  if (missingGuaranteed.length > 0) {
    return { ok: false, reason: "missing-guaranteed", offending: missingGuaranteed, fallback };
  }

  // Return in deterministic candidate-rank order (not the Chair's arbitrary order).
  const rank = new Map(candidates.map((c, i) => [c.advisorId, i]));
  const roster = [...chosen].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  return { ok: true, roster };
}
