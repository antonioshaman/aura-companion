/**
 * Judge calibration — how well does a {@link Judge}'s verdict match the HUMAN
 * ground truth? This is the gate on trusting an LLM-as-judge at all: an
 * uncalibrated judge is just a second opinion of unknown quality, and the whole
 * point of human labels is that they are the reference, not the model.
 *
 * The comparison is restricted to the population both sides can speak to: a
 * human `true_positive`/`false_positive` verdict ON an emitted finding (joined
 * by `finding_id`). `expected_blocker_missed` labels are deliberately excluded
 * — they have no emitted finding for a judge to evaluate, so they belong to
 * recall scoring, not judge calibration. A judge `skip` is counted as an
 * abstention, never folded into agreement or disagreement — coercing an honest
 * abstention into a verdict would flatter or punish the judge for a decision it
 * explicitly declined to make.
 *
 * Output is a confusion matrix plus an agreement {@link Ratio} that is
 * `unavailable` (not 0, not 1) when the judge rendered a verdict on nothing —
 * the same absent-vs-zero discipline the precision scorer uses, so an empty
 * calibration can never read as perfect agreement.
 *
 * Pure + firewall-clean: labels + judge results in, a flat summary out. Imports
 * only sibling eval types. Never `server/`.
 */

import type { EvalLabelRecord } from "../schema/eval-artifact.js";
import type { Ratio } from "./observer-precision.js";
import type { JudgeResult } from "./judge.js";

/** The four confusion-matrix cells over the binary {human, judge} verdict, plus
 *  abstention/coverage bookkeeping. */
export interface JudgeConfusion {
  /** Human true_positive AND judge true_positive — judge correctly confirmed. */
  agree_true_positive: number;
  /** Human false_positive AND judge false_positive — judge correctly rejected. */
  agree_false_positive: number;
  /** Human true_positive BUT judge false_positive — judge cleared a real blocker. */
  judge_missed_blocker: number;
  /** Human false_positive BUT judge true_positive — judge raised a false alarm. */
  judge_false_alarm: number;
  /** Judge abstained (`skip`) on a finding the human DID label — excluded from
   *  agreement, surfaced so low coverage is visible. */
  judge_abstained: number;
  /** Judge rendered a verdict on a finding the human has NOT labeled tp/fp —
   *  no ground truth to score against, counted for coverage only. */
  human_unlabeled: number;
}

export interface JudgeCalibration {
  judge_id: string;
  confusion: JudgeConfusion;
  /** Findings where BOTH sides rendered a tp/fp verdict (the scored set). */
  compared: number;
  /** (agree_tp + agree_fp) / compared — `unavailable` when compared === 0. */
  agreement_rate: Ratio;
}

const HUMAN_BINARY = new Set(["true_positive", "false_positive"]);

function ratio(numerator: number, denominator: number, whyEmpty: string): Ratio {
  if (denominator === 0) return { kind: "unavailable", why: whyEmpty };
  return { kind: "value", value: numerator / denominator, numerator, denominator };
}

/**
 * Calibrate a judge's verdicts against human labels. `judgeResults` and
 * `humanLabels` are joined by `finding_id`; only labels whose verdict is a
 * binary tp/fp participate (expected_blocker_missed is dropped — no finding to
 * judge). The judge's own `skip` is bookkept as an abstention.
 */
export function calibrateJudge(
  judgeId: string,
  judgeResults: JudgeResult[],
  humanLabels: EvalLabelRecord[],
): JudgeCalibration {
  const humanByFinding = new Map<string, "true_positive" | "false_positive">();
  for (const l of humanLabels) {
    if (l.finding_id && HUMAN_BINARY.has(l.verdict)) {
      humanByFinding.set(l.finding_id, l.verdict as "true_positive" | "false_positive");
    }
  }

  const confusion: JudgeConfusion = {
    agree_true_positive: 0,
    agree_false_positive: 0,
    judge_missed_blocker: 0,
    judge_false_alarm: 0,
    judge_abstained: 0,
    human_unlabeled: 0,
  };

  for (const r of judgeResults) {
    const human = humanByFinding.get(r.finding_id);
    if (!human) {
      confusion.human_unlabeled++;
      continue;
    }
    if (r.verdict === "skip") {
      confusion.judge_abstained++;
      continue;
    }
    if (human === "true_positive" && r.verdict === "true_positive") confusion.agree_true_positive++;
    else if (human === "false_positive" && r.verdict === "false_positive") confusion.agree_false_positive++;
    else if (human === "true_positive" && r.verdict === "false_positive") confusion.judge_missed_blocker++;
    else confusion.judge_false_alarm++; // human fp, judge tp
  }

  const compared =
    confusion.agree_true_positive +
    confusion.agree_false_positive +
    confusion.judge_missed_blocker +
    confusion.judge_false_alarm;
  const agreed = confusion.agree_true_positive + confusion.agree_false_positive;

  return {
    judge_id: judgeId,
    confusion,
    compared,
    agreement_rate: ratio(agreed, compared, "judge rendered no tp/fp verdict on any labeled finding"),
  };
}
