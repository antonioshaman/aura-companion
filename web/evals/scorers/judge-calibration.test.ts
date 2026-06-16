/**
 * Tests for judge calibration against human labels. Contracts:
 *  - the four confusion cells count correctly (agree tp/fp, judge missed
 *    blocker, judge false alarm).
 *  - a judge `skip` on a human-labeled finding is an abstention, NOT a
 *    disagreement, and is excluded from `compared`.
 *  - a judge verdict on a finding the human never labeled tp/fp is `human_unlabeled`
 *    coverage only — and `expected_blocker_missed` labels never join (no finding).
 *  - agreement_rate is `unavailable` (not 0/1) when nothing was compared.
 */

import { describe, it, expect } from "vitest";
import { calibrateJudge } from "./judge-calibration.js";
import type { JudgeResult } from "./judge.js";
import {
  EVAL_LABEL_VERSION,
  type EvalLabelRecord,
  type EvalLabelVerdict,
} from "../schema/eval-artifact.js";

const label = (finding_id: string | undefined, verdict: EvalLabelVerdict): EvalLabelRecord => ({
  eval_label_version: EVAL_LABEL_VERSION,
  id: `lbl_${finding_id ?? "miss"}`,
  finding_id,
  session_group_id: "grp_x",
  checkpoint_id: "cp_0",
  evidence_path: "web/server/x.ts",
  verdict,
});

const result = (finding_id: string, verdict: JudgeResult["verdict"]): JudgeResult => ({
  finding_id,
  verdict,
});

describe("calibrateJudge", () => {
  it("counts the four confusion cells over joined verdicts", () => {
    const labels = [
      label("f1", "true_positive"),
      label("f2", "false_positive"),
      label("f3", "true_positive"),
      label("f4", "false_positive"),
    ];
    const results = [
      result("f1", "true_positive"), // agree tp
      result("f2", "false_positive"), // agree fp
      result("f3", "false_positive"), // judge missed a real blocker
      result("f4", "true_positive"), // judge false alarm
    ];
    const cal = calibrateJudge("scripted", results, labels);
    expect(cal.confusion.agree_true_positive).toBe(1);
    expect(cal.confusion.agree_false_positive).toBe(1);
    expect(cal.confusion.judge_missed_blocker).toBe(1);
    expect(cal.confusion.judge_false_alarm).toBe(1);
    expect(cal.compared).toBe(4);
    expect(cal.agreement_rate).toEqual({
      kind: "value",
      value: 0.5,
      numerator: 2,
      denominator: 4,
    });
  });

  it("treats a judge skip on a labeled finding as an abstention, not a disagreement", () => {
    const labels = [label("f1", "true_positive"), label("f2", "false_positive")];
    const results = [result("f1", "true_positive"), result("f2", "skip")];
    const cal = calibrateJudge("scripted", results, labels);
    expect(cal.confusion.agree_true_positive).toBe(1);
    expect(cal.confusion.judge_abstained).toBe(1);
    expect(cal.compared).toBe(1); // only f1 scored; f2 abstained
    expect(cal.agreement_rate).toMatchObject({ kind: "value", value: 1 });
  });

  it("counts judge verdicts on unlabeled findings as coverage only, and never joins expected_blocker_missed", () => {
    const labels = [
      label("f1", "true_positive"),
      label(undefined, "expected_blocker_missed"), // no finding_id → never joins
    ];
    const results = [result("f1", "true_positive"), result("f_unknown", "true_positive")];
    const cal = calibrateJudge("scripted", results, labels);
    expect(cal.confusion.agree_true_positive).toBe(1);
    expect(cal.confusion.human_unlabeled).toBe(1); // f_unknown
    expect(cal.compared).toBe(1);
  });

  it("returns unavailable agreement when nothing was compared", () => {
    const cal = calibrateJudge("scripted", [result("f1", "skip")], [label("f1", "true_positive")]);
    expect(cal.compared).toBe(0);
    expect(cal.agreement_rate.kind).toBe("unavailable");
  });
});
