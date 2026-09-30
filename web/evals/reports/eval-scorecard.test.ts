/**
 * Tests for the precision-corpus → scorecard mapping. The contracts:
 *
 *   1. the GROUNDED tier's stop_precision/stop_recall/false_stop_rate become the
 *      three scorecard rows (the user-visible, post-gate observer quality);
 *   2. the committed synthetic corpus renders a PASS card in both text and
 *      markdown — proof the wire actually surfaces real metrics, not a stub;
 *   3. an UNLABELED corpus (labels === 0) yields "no scoreable inputs" → FAIL,
 *      never a vacuous pass, mirroring the CI gate's refuse-to-pass guard;
 *   4. a metric below its advisory floor flips the card to FAIL and names the row.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { scorePrecisionCorpus, type PrecisionSummary } from "../scorers/precision-corpus.js";
import {
  buildEvalScorecard,
  ADVISORY_THRESHOLDS,
  evidenceVerdict,
  groundingRecallRegression,
  MIN_LABELED_STOPS,
  renderEvidenceVerdict,
  renderGroundingBeforeAfter,
} from "./eval-scorecard.js";
import { renderScorecardMarkdown, renderScorecardText } from "./scorecard.js";

const CORPUS_DIR = fileURLToPath(new URL("../__fixtures__/precision", import.meta.url));

describe("buildEvalScorecard on the committed precision corpus", () => {
  it("maps the grounded tier into precision/recall/false_stop_rate rows that PASS", () => {
    const { summary } = scorePrecisionCorpus(CORPUS_DIR);
    const card = buildEvalScorecard(summary);
    expect(card.rows.map((r) => r.name)).toEqual([
      "stop_precision",
      "stop_recall",
      "false_stop_rate",
    ]);
    // Healthy synthetic corpus sits above the advisory floors → overall PASS.
    expect(card.noScoreableInputs).toBe(false);
    expect(card.passed).toBe(true);
    expect(card.scoreableInputs).toBe(summary.labels);
  });

  it("renders the real metrics in both text and markdown", () => {
    const { summary } = scorePrecisionCorpus(CORPUS_DIR);
    const card = buildEvalScorecard(summary);

    const text = renderScorecardText(card);
    expect(text).toContain("stop_precision");
    expect(text).toContain("stop_recall");
    expect(text).toMatch(/RESULT: PASS/);

    const md = renderScorecardMarkdown(card);
    expect(md).toContain("| Metric | Value | Threshold | Status |");
    expect(md).toContain("stop_recall");
    expect(md).toContain("**Result: ✅ PASS**");
  });
});

describe("buildEvalScorecard guards", () => {
  it("treats an unlabeled corpus (labels === 0) as no scoreable inputs → FAIL", () => {
    const { summary } = scorePrecisionCorpus(CORPUS_DIR);
    // Same findings, but strip the ground-truth labels: precision/recall become
    // unavailable and there is nothing to score against → explicit FAIL.
    const unlabeled: PrecisionSummary = {
      ...summary,
      labels: 0,
      grounded: { ...summary.grounded, precision: "unavailable", recall: "unavailable" },
    };
    const card = buildEvalScorecard(unlabeled);
    expect(card.noScoreableInputs).toBe(true);
    expect(card.passed).toBe(false);
  });

  it("fails the card and names the row when a metric drops below its advisory floor", () => {
    const { summary } = scorePrecisionCorpus(CORPUS_DIR);
    const regressed: PrecisionSummary = {
      ...summary,
      grounded: { ...summary.grounded, recall: ADVISORY_THRESHOLDS.stop_recall - 0.1 },
    };
    const card = buildEvalScorecard(regressed);
    expect(card.passed).toBe(false);
    expect(card.rows.find((r) => r.name === "stop_recall")!.status).toBe("fail");
  });
});

// B2 before/after output + the recall guard the CI gate enforces.
describe("B2 grounding before/after", () => {
  it("renders every gate stage for the committed corpus, in text and markdown", () => {
    const { summary } = scorePrecisionCorpus(CORPUS_DIR);
    const text = renderGroundingBeforeAfter(summary);
    for (const stage of ["raw", "path-only, before B2", "path + lines, after B2", "banner"]) {
      expect(text).toContain(stage);
    }
    expect(text).toContain(`false_stop_rate=${(summary.grounded.false_stop_rate as number).toFixed(3)}`);
    expect(renderGroundingBeforeAfter(summary, true).split("\n")[0]).toMatch(/^\| stage \|/);
  });

  it("the committed corpus: line grounding lowers false STOPs without losing recall", () => {
    const { summary } = scorePrecisionCorpus(CORPUS_DIR);
    expect(groundingRecallRegression(summary)).toBeNull();
    expect(summary.grounded.recall).toEqual(summary.grounded_path_only.recall);
    expect(summary.grounded.false_stop_rate).toBeLessThan(summary.grounded_path_only.false_stop_rate as number);
  });

  it("flags a summary where the full gate surfaced fewer true positives than path-only", () => {
    const { summary } = scorePrecisionCorpus(CORPUS_DIR);
    const regressed: PrecisionSummary = {
      ...summary,
      grounded: { ...summary.grounded, true_positive: summary.grounded_path_only.true_positive - 1 },
    };
    expect(groundingRecallRegression(regressed)).toMatch(/silenced real blockers/);
  });
});


// B3 sufficiency verdict: with < 100 labeled STOPs no conclusion about the
// observer may be stated, however good the precision number looks.
describe("evidenceVerdict (B3)", () => {
  it("marks usefulness UNPROVEN and the >90% gate NOT EVALUATED below 100 labeled STOPs, even at precision 1.0", () => {
    const v = evidenceVerdict(MIN_LABELED_STOPS - 1, 1);
    expect(v).toEqual({ labeled_stops: 99, observer_useful: "unproven", stop_precision_gate: "not_evaluated" });
    const text = renderEvidenceVerdict(v);
    expect(text).toContain("Observer is useful: UNPROVEN (99/100 labeled STOPs)");
    expect(text).toContain("gate STOP precision > 90%: NOT EVALUATED (99/100 labeled STOPs)");
  });

  it("stays not evaluated at 100 labels when precision is unavailable", () => {
    expect(evidenceVerdict(100, "unavailable").stop_precision_gate).toBe("not_evaluated");
  });

  it("evaluates the gate strictly (> 0.9) once 100 STOPs are labeled", () => {
    // Exactly 90% is NOT above the gate — boundary is strict.
    expect(evidenceVerdict(100, 0.9)).toMatchObject({ observer_useful: "not_supported", stop_precision_gate: "fail" });
    expect(evidenceVerdict(150, 0.95)).toMatchObject({ observer_useful: "supported", stop_precision_gate: "pass" });
  });

  it("renders a markdown table with both claims", () => {
    const md = renderEvidenceVerdict(evidenceVerdict(3, 0.5), true);
    expect(md).toContain("| Observer is useful | UNPROVEN (3/100 labeled STOPs) |");
    expect(md).toContain("| gate: STOP precision > 90% | NOT EVALUATED (3/100 labeled STOPs) |");
  });
});
