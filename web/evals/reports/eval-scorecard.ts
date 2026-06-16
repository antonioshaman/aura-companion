/**
 * Eval scorecard mapping — the missing wire between the precision corpus and the
 * generic {@link buildScorecard} renderer. `reports/scorecard.ts` knows how to
 * turn (value, threshold, comparator) rows into a pass/fail card in text +
 * markdown; this module decides WHICH observer-quality metrics become rows and
 * WHAT advisory floors they are held against, then hands a {@link PrecisionSummary}
 * to it. Story 2.2 ("see a single scorecard … each metric, its threshold, and
 * pass/fail, in text and markdown") for the metrics that actually matter — the
 * observer's STOP precision/recall — not just cost/latency.
 *
 * Thresholds here are ADVISORY DISPLAY floors for an at-a-glance human verdict.
 * They are deliberately NOT the blocking CI gate: `eval:replay --ci` blocks on
 * "no regression vs. the committed baseline", per the spec's decision to avoid
 * brittle fixed bars on a tiny corpus. A scorecard FAIL is a signal to look, not
 * the thing that fails the build.
 *
 * The scoreable-inputs count is the corpus's labeled-finding count: an UNLABELED
 * corpus (labels === 0) has no ground truth, so precision/recall are
 * `"unavailable"` AND the card reports "no scoreable inputs" → an explicit
 * FAIL, never a vacuous pass. This mirrors the gate's own refuse-to-pass guard.
 *
 * Pure: a summary in, a {@link Scorecard} out. No IO, no `server/` imports.
 */

import type { PrecisionSummary } from "../scorers/precision-corpus.js";
import {
  buildScorecard,
  type Scorecard,
  type ScorecardMetricInput,
} from "./scorecard.js";

/** Advisory display floors for the observer-quality scorecard. NOT the blocking
 *  gate (that is `eval:replay --ci`'s no-regression diff). Tuned to sit below
 *  the current synthetic corpus so a healthy corpus renders PASS while a real
 *  collapse (precision/recall halving, false STOPs dominating) renders FAIL. */
export const ADVISORY_THRESHOLDS = {
  stop_precision: 0.5,
  stop_recall: 0.5,
  false_stop_rate: 0.5,
} as const;

/**
 * Map a precision-corpus summary to a rendered observer-quality scorecard.
 *
 * Rows are taken from the GROUNDED tier — the severity the user actually sees
 * after the grounding gate runs — because that is the observer's effective
 * output, not its raw pre-gate claims. `scoreableInputs` is the summary's label
 * count, so an unlabeled corpus trips the renderer's empty-corpus FAIL.
 */
export function buildEvalScorecard(summary: PrecisionSummary): Scorecard {
  const metrics: ScorecardMetricInput[] = [
    {
      name: "stop_precision",
      value: summary.grounded.precision,
      threshold: ADVISORY_THRESHOLDS.stop_precision,
      comparator: "gte",
    },
    {
      name: "stop_recall",
      value: summary.grounded.recall,
      threshold: ADVISORY_THRESHOLDS.stop_recall,
      comparator: "gte",
    },
    {
      name: "false_stop_rate",
      value: summary.grounded.false_stop_rate,
      threshold: ADVISORY_THRESHOLDS.false_stop_rate,
      comparator: "lte",
    },
  ];
  return buildScorecard(metrics, summary.labels);
}
