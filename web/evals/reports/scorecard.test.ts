/**
 * Tests for the scorecard renderer. The contracts: each metric shows
 * value/threshold/status; an empty corpus (zero scoreable inputs) is an
 * explicit FAIL with a "no scoreable inputs" banner, not a vacuous pass; an
 * unavailable metric renders n/a and does NOT silently fail the gate
 * (absent-vs-zero); both text and markdown forms render.
 */

import { describe, it, expect } from "vitest";
import {
  buildScorecard,
  renderScorecardText,
  renderScorecardMarkdown,
  type ScorecardMetricInput,
} from "./scorecard.js";

const metrics: ScorecardMetricInput[] = [
  { name: "stop_precision", value: 0.95, threshold: 0.9, comparator: "gte" },
  { name: "stop_recall", value: 0.8, threshold: 0.7, comparator: "gte" },
  { name: "false_stop_rate", value: 0.05, threshold: 0.1, comparator: "lte" },
];

describe("buildScorecard", () => {
  it("passes when every metric meets its threshold and inputs were scored", () => {
    const card = buildScorecard(metrics, 12);
    expect(card.passed).toBe(true);
    expect(card.noScoreableInputs).toBe(false);
    expect(card.rows.map((r) => r.status)).toEqual(["pass", "pass", "pass"]);
  });

  it("fails when any metric misses its threshold and names the failing row", () => {
    const regressed = metrics.map((m) =>
      m.name === "stop_recall" ? { ...m, value: 0.5 } : m,
    );
    const card = buildScorecard(regressed, 12);
    expect(card.passed).toBe(false);
    const recall = card.rows.find((r) => r.name === "stop_recall")!;
    expect(recall.status).toBe("fail");
  });

  it("respects the lte (ceiling) comparator for lower-is-better metrics", () => {
    const tooMany = metrics.map((m) =>
      m.name === "false_stop_rate" ? { ...m, value: 0.4 } : m,
    );
    const card = buildScorecard(tooMany, 12);
    expect(card.rows.find((r) => r.name === "false_stop_rate")!.status).toBe("fail");
    expect(card.passed).toBe(false);
  });

  it("treats zero scoreable inputs as an explicit failure, not a vacuous pass", () => {
    const card = buildScorecard(metrics, 0);
    expect(card.noScoreableInputs).toBe(true);
    expect(card.passed).toBe(false);
  });

  it("renders an unavailable metric as n/a without failing the gate", () => {
    const withUnavailable: ScorecardMetricInput[] = [
      { name: "stop_precision", value: 0.95, threshold: 0.9, comparator: "gte" },
      { name: "token_cost", value: "unavailable", threshold: 5, comparator: "lte", unit: "$" },
    ];
    const card = buildScorecard(withUnavailable, 12);
    const cost = card.rows.find((r) => r.name === "token_cost")!;
    expect(cost.status).toBe("n/a");
    // The one available metric passes → overall pass; n/a did not fail it.
    expect(card.passed).toBe(true);
  });

  it("does not pass a card where every row is n/a", () => {
    const allNa: ScorecardMetricInput[] = [
      { name: "a", value: "unavailable", threshold: 1, comparator: "gte" },
      { name: "b", value: "unavailable", threshold: 1, comparator: "lte" },
    ];
    const card = buildScorecard(allNa, 12);
    expect(card.passed).toBe(false);
  });
});

describe("renderScorecardText", () => {
  it("shows each metric, threshold, status, and an overall PASS/FAIL", () => {
    const text = renderScorecardText(buildScorecard(metrics, 12));
    expect(text).toContain("stop_precision");
    expect(text).toContain("≥ 0.9");
    expect(text).toContain("PASS");
    expect(text).toMatch(/RESULT: PASS/);
  });

  it("renders the no-scoreable-inputs banner and FAIL on an empty corpus", () => {
    const text = renderScorecardText(buildScorecard(metrics, 0));
    expect(text).toContain("no scoreable inputs");
    expect(text).toMatch(/RESULT: FAIL/);
  });
});

describe("renderScorecardMarkdown", () => {
  it("renders a markdown table with a bold result line", () => {
    const md = renderScorecardMarkdown(buildScorecard(metrics, 12));
    expect(md).toContain("| Metric | Value | Threshold | Status |");
    expect(md).toContain("stop_precision");
    expect(md).toContain("✅ pass");
    expect(md).toContain("**Result: ✅ PASS**");
  });

  it("renders the no-scoreable-inputs banner and FAIL on an empty corpus", () => {
    const md = renderScorecardMarkdown(buildScorecard(metrics, 0));
    expect(md).toContain("no scoreable inputs");
    expect(md).toContain("**Result: ❌ FAIL**");
  });
});
