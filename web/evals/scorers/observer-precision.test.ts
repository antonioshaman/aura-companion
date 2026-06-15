/**
 * Tests for the three-layer observer-precision scorer (Task 5). The cases pin
 * the contracts that make this a real quality metric and not a vanity number:
 *   - precision/recall computed from human labels, joined on the finding's
 *     stable `finding_id` (`efnd_<hex>`) — an identity join, never a
 *     re-worded-claim collision
 *   - the delta layer correctly attributes grounding downgrades to
 *     helped-precision (FP silenced) vs hurt-recall (TP silenced)
 *   - the wake-version-drift trap: all-downgraded must read as unavailable
 *     precision + collapsed recall, NEVER a phantom perfect score
 *   - recall counts expected_blocker_missed as a set-difference
 *   - orphan TP/FP labels (no matching finding) surface, not silently dropped
 */

import { describe, it, expect } from "vitest";
import {
  scoreObserverPrecision,
  type ScorableFinding,
} from "./observer-precision.js";
import { EVAL_LABEL_VERSION, type EvalLabelRecord } from "../schema/eval-artifact.js";

function finding(
  partial: Partial<ScorableFinding> & Pick<ScorableFinding, "id" | "evidence_path">,
): ScorableFinding {
  return {
    checkpoint_id: "cp0",
    raw_severity: "STOP",
    grounded_severity: "STOP",
    ...partial,
  };
}

/** A tp/fp verdict label joined to its finding by `finding_id`. */
function verdict(
  v: "true_positive" | "false_positive",
  finding_id: string,
  evidence_path: string,
): EvalLabelRecord {
  return {
    eval_label_version: EVAL_LABEL_VERSION,
    id: `lbl_${finding_id}`,
    session_group_id: "grp",
    checkpoint_id: "cp0",
    evidence_path,
    verdict: v,
    finding_id,
  };
}

/** An expected_blocker_missed label — by construction has NO finding_id. */
function missed(evidence_path: string, issue_class: string): EvalLabelRecord {
  return {
    eval_label_version: EVAL_LABEL_VERSION,
    id: `lbl_missed_${evidence_path}_${issue_class}`,
    session_group_id: "grp",
    checkpoint_id: "cp0",
    evidence_path,
    issue_class,
    verdict: "expected_blocker_missed",
  };
}

describe("scoreObserverPrecision — raw layer precision", () => {
  it("computes precision and false-stop-rate from labeled STOPs", () => {
    const findings = [
      finding({ id: "efnd_a", evidence_path: "a.ts" }),
      finding({ id: "efnd_b", evidence_path: "b.ts" }),
      finding({ id: "efnd_c", evidence_path: "c.ts" }),
    ];
    const labels = [
      verdict("true_positive", "efnd_a", "a.ts"),
      verdict("false_positive", "efnd_b", "b.ts"),
      verdict("true_positive", "efnd_c", "c.ts"),
    ];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.raw.surfaced).toBe(3);
    expect(s.raw.true_positive).toBe(2);
    expect(s.raw.false_positive).toBe(1);
    expect(s.raw.precision).toMatchObject({ kind: "value", numerator: 2, denominator: 3 });
    expect(s.raw.false_stop_rate).toMatchObject({ kind: "value", numerator: 1, denominator: 3 });
  });

  it("excludes unlabeled surfaced STOPs from the precision denominator", () => {
    const findings = [
      finding({ id: "efnd_a", evidence_path: "a.ts" }),
      finding({ id: "efnd_z", evidence_path: "z.ts" }),
    ];
    const labels = [verdict("true_positive", "efnd_a", "a.ts")];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.raw.unlabeled).toBe(1);
    expect(s.raw.precision).toMatchObject({ kind: "value", numerator: 1, denominator: 1 });
  });
});

describe("scoreObserverPrecision — delta layer (grounding attribution)", () => {
  it("attributes a downgraded false positive as grounding HELPING precision", () => {
    // Raw STOP, grounded to NOTE, labeled false_positive: the gate did its job.
    const findings = [
      finding({
        id: "efnd_ghost",
        evidence_path: "ghost.ts",
        raw_severity: "STOP",
        grounded_severity: "NOTE",
      }),
    ];
    const labels = [verdict("false_positive", "efnd_ghost", "ghost.ts")];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.delta.downgraded).toBe(1);
    expect(s.delta.downgraded_false_positive).toBe(1);
    expect(s.delta.downgraded_true_positive).toBe(0);
    // raw precision counts the FP; grounded layer no longer surfaces it.
    expect(s.raw.false_positive).toBe(1);
    expect(s.grounded.surfaced).toBe(0);
  });

  it("attributes a downgraded true positive as grounding HURTING recall", () => {
    const findings = [
      finding({
        id: "efnd_real",
        evidence_path: "real.ts",
        raw_severity: "STOP",
        grounded_severity: "NOTE",
      }),
    ];
    const labels = [verdict("true_positive", "efnd_real", "real.ts")];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.delta.downgraded_true_positive).toBe(1);
    expect(s.delta.downgraded_false_positive).toBe(0);
    // grounded layer lost a real blocker.
    expect(s.grounded.true_positive).toBe(0);
  });
});

describe("scoreObserverPrecision — wake-version-drift trap", () => {
  it("all-downgraded reads as unavailable precision + collapsed recall, not a phantom 1.0", () => {
    // Two real blockers raw-emitted as STOP, both downgraded to NOTE by a
    // manifest mismatch. The grounded layer must NOT look perfect.
    const findings = [
      finding({ id: "efnd_x", evidence_path: "x.ts", raw_severity: "STOP", grounded_severity: "NOTE" }),
      finding({ id: "efnd_y", evidence_path: "y.ts", raw_severity: "STOP", grounded_severity: "NOTE" }),
    ];
    const labels = [
      verdict("true_positive", "efnd_x", "x.ts"),
      verdict("true_positive", "efnd_y", "y.ts"),
    ];
    const s = scoreObserverPrecision(findings, labels);
    // Nothing surfaced grounded → precision has no denominator → unavailable.
    expect(s.grounded.surfaced).toBe(0);
    expect(s.grounded.precision.kind).toBe("unavailable");
    // Recall collapsed: 0 caught of 2 known → 0, NOT unavailable, NOT 1.
    expect(s.grounded.recall).toMatchObject({ kind: "value", value: 0, numerator: 0, denominator: 2 });
  });
});

describe("scoreObserverPrecision — recall as set-difference", () => {
  it("counts expected_blocker_missed in the recall denominator", () => {
    const findings = [finding({ id: "efnd_a", evidence_path: "a.ts" })];
    const labels = [
      verdict("true_positive", "efnd_a", "a.ts"),
      missed("missed1.ts", "race"),
      missed("missed2.ts", "leak"),
    ];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.missed_blockers).toBe(2);
    // recall = 1 caught / (1 caught + 2 missed)
    expect(s.raw.recall).toMatchObject({ kind: "value", numerator: 1, denominator: 3 });
  });

  it("recall is unavailable when there are no known blockers at all", () => {
    const findings = [finding({ id: "efnd_a", evidence_path: "a.ts" })];
    const labels = [verdict("false_positive", "efnd_a", "a.ts")];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.raw.recall.kind).toBe("unavailable");
  });
});

describe("scoreObserverPrecision — orphan labels", () => {
  it("surfaces TP/FP labels that matched no emitted finding", () => {
    const findings = [finding({ id: "efnd_a", evidence_path: "a.ts" })];
    const labels = [
      verdict("true_positive", "efnd_a", "a.ts"),
      verdict("false_positive", "efnd_phantom", "phantom.ts"),
    ];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.orphan_verdict_labels).toBe(1);
  });

  it("does not count expected_blocker_missed as an orphan (it has no finding by design)", () => {
    const findings: ScorableFinding[] = [];
    const labels = [missed("m.ts", "race")];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.orphan_verdict_labels).toBe(0);
    expect(s.missed_blockers).toBe(1);
  });
});
