/**
 * Tests for the three-layer observer-precision scorer (Task 5). The cases pin
 * the contracts that make this a real quality metric and not a vanity number:
 *   - precision/recall computed from human labels, joined on
 *     (checkpoint_id, evidence_path, issue_class)
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
  partial: Partial<ScorableFinding> & Pick<ScorableFinding, "evidence_path" | "issue_class">,
): ScorableFinding {
  return {
    checkpoint_id: "cp0",
    raw_severity: "STOP",
    grounded_severity: "STOP",
    ...partial,
  };
}

function label(
  verdict: EvalLabelRecord["verdict"],
  evidence_path: string,
  issue_class: string,
  checkpoint_id = "cp0",
): EvalLabelRecord {
  return {
    eval_label_version: EVAL_LABEL_VERSION,
    id: `lbl_${evidence_path}_${issue_class}`,
    session_group_id: "grp",
    checkpoint_id,
    evidence_path,
    issue_class,
    verdict,
  };
}

describe("scoreObserverPrecision — raw layer precision", () => {
  it("computes precision and false-stop-rate from labeled STOPs", () => {
    const findings = [
      finding({ evidence_path: "a.ts", issue_class: "real-bug" }),
      finding({ evidence_path: "b.ts", issue_class: "noise" }),
      finding({ evidence_path: "c.ts", issue_class: "real-bug" }),
    ];
    const labels = [
      label("true_positive", "a.ts", "real-bug"),
      label("false_positive", "b.ts", "noise"),
      label("true_positive", "c.ts", "real-bug"),
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
      finding({ evidence_path: "a.ts", issue_class: "real-bug" }),
      finding({ evidence_path: "z.ts", issue_class: "unjudged" }),
    ];
    const labels = [label("true_positive", "a.ts", "real-bug")];
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
        evidence_path: "ghost.ts",
        issue_class: "ungrounded",
        raw_severity: "STOP",
        grounded_severity: "NOTE",
      }),
    ];
    const labels = [label("false_positive", "ghost.ts", "ungrounded")];
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
        evidence_path: "real.ts",
        issue_class: "true-blocker",
        raw_severity: "STOP",
        grounded_severity: "NOTE",
      }),
    ];
    const labels = [label("true_positive", "real.ts", "true-blocker")];
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
      finding({ evidence_path: "x.ts", issue_class: "b1", raw_severity: "STOP", grounded_severity: "NOTE" }),
      finding({ evidence_path: "y.ts", issue_class: "b2", raw_severity: "STOP", grounded_severity: "NOTE" }),
    ];
    const labels = [
      label("true_positive", "x.ts", "b1"),
      label("true_positive", "y.ts", "b2"),
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
    const findings = [finding({ evidence_path: "a.ts", issue_class: "caught" })];
    const labels = [
      label("true_positive", "a.ts", "caught"),
      label("expected_blocker_missed", "missed1.ts", "race"),
      label("expected_blocker_missed", "missed2.ts", "leak"),
    ];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.missed_blockers).toBe(2);
    // recall = 1 caught / (1 caught + 2 missed)
    expect(s.raw.recall).toMatchObject({ kind: "value", numerator: 1, denominator: 3 });
  });

  it("recall is unavailable when there are no known blockers at all", () => {
    const findings = [finding({ evidence_path: "a.ts", issue_class: "noise" })];
    const labels = [label("false_positive", "a.ts", "noise")];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.raw.recall.kind).toBe("unavailable");
  });
});

describe("scoreObserverPrecision — orphan labels", () => {
  it("surfaces TP/FP labels that matched no emitted finding", () => {
    const findings = [finding({ evidence_path: "a.ts", issue_class: "real" })];
    const labels = [
      label("true_positive", "a.ts", "real"),
      label("false_positive", "phantom.ts", "never-emitted"),
    ];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.orphan_verdict_labels).toBe(1);
  });

  it("does not count expected_blocker_missed as an orphan (it has no finding by design)", () => {
    const findings: ScorableFinding[] = [];
    const labels = [label("expected_blocker_missed", "m.ts", "race")];
    const s = scoreObserverPrecision(findings, labels);
    expect(s.orphan_verdict_labels).toBe(0);
    expect(s.missed_blockers).toBe(1);
  });
});
