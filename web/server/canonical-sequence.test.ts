/**
 * Bidirectional pipeline Story 1.1 — canonical 8-step orchestrator
 * sequence. Tests assert DEEP-EQUALITY against the spec list, not
 * substring; substring tests would silently pass on reordering or
 * step drops (feedback_i18n_test_assert_key_not_substring sibling).
 *
 * Locking the slug + intent shape makes "did we ship the announcement?"
 * a one-line check from any future consumer (start-of-session banner,
 * out-of-sequence WARN detector, audit log enricher).
 *
 * 9 → 8 steps in aura-meta-diet A1: the competing learning skill was removed
 * so `/learn` is the single learning-capture step. The deep-equality lock
 * also guards against the removed slug creeping back in.
 */

import { describe, expect, it } from "vitest";
import {
  CANONICAL_ORCHESTRATOR_SEQUENCE,
  CANONICAL_SEQUENCE_LENGTH,
} from "./canonical-sequence.js";

describe("CANONICAL_ORCHESTRATOR_SEQUENCE", () => {
  it("has exactly 8 steps (spec lock)", () => {
    expect(CANONICAL_SEQUENCE_LENGTH).toBe(8);
    expect(CANONICAL_ORCHESTRATOR_SEQUENCE).toHaveLength(8);
  });

  it("emits the 8 slugs in spec order (deep-equality, not substring)", () => {
    const slugs = CANONICAL_ORCHESTRATOR_SEQUENCE.map((s) => s.slug);
    expect(slugs).toEqual([
      "/prime",
      "/spec-writer",
      "/council-plan",
      "/council-implement",
      "/council-review",
      "/test-architect",
      "/learn",
      "/self-reflect",
    ]);
  });

  it("preserves a stable 1-indexed step number aligned with slug position", () => {
    CANONICAL_ORCHESTRATOR_SEQUENCE.forEach((step, idx) => {
      expect(step.index).toBe(idx + 1);
    });
  });

  it("every step carries non-empty intent text ≤80 chars (start-banner readability)", () => {
    for (const step of CANONICAL_ORCHESTRATOR_SEQUENCE) {
      expect(step.intent.length).toBeGreaterThan(0);
      expect(step.intent.length).toBeLessThanOrEqual(80);
    }
  });

  it("is a frozen array (defends against accidental in-place mutation)", () => {
    expect(Object.isFrozen(CANONICAL_ORCHESTRATOR_SEQUENCE)).toBe(true);
  });
});
