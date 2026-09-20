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
  applyGuardrails,
  MAX_SEATS,
  MIN_SEATS,
  type RankedCandidate,
} from "./advisor-scorer";

export type RosterRejectReason =
  | "off-pool" // a chosen id is not in the candidate set (hallucinated / renamed)
  | "duplicate" // a chosen id appears twice
  | "below-min" // fewer than min seats
  | "above-max" // more than max seats
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
  const fallback = applyGuardrails(candidates, min, max).map((c) => c.advisorId);
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

  // Return in deterministic candidate-rank order (not the Chair's arbitrary order).
  const rank = new Map(candidates.map((c, i) => [c.advisorId, i]));
  const roster = [...chosen].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  return { ok: true, roster };
}
