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
import { buildEvalScorecard, ADVISORY_THRESHOLDS } from "./eval-scorecard.js";
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
