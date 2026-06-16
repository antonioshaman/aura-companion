/**
 * Tests for the cross-variant comparison report. Contracts:
 *  - grounded-tier precision/recall use higher_better; false_stop_rate uses
 *    lower_better — so the SAME numeric drop is "worse" for a floor metric and
 *    "better" for the ceiling metric.
 *  - equal values render "same" with a 0 delta.
 *  - when EITHER side is "unavailable" the delta and verdict are both "n/a"
 *    (absent-vs-zero — a missing number is never treated as 0 / improvement /
 *    regression).
 *  - both text and markdown forms render every row.
 */

import { describe, it, expect } from "vitest";
import {
  compareSummaries,
  renderComparisonText,
  renderComparisonMarkdown,
  type MetricDelta,
} from "./compare.js";
import type { PrecisionSummary, SerialTier } from "../scorers/precision-corpus.js";

function tier(over: Partial<SerialTier>): SerialTier {
  return {
    surfaced: 0,
    true_positive: 0,
    false_positive: 0,
    unlabeled: 0,
    precision: "unavailable",
    false_stop_rate: "unavailable",
    recall: "unavailable",
    ...over,
  };
}

function summary(grounded: SerialTier): PrecisionSummary {
  return {
    raw: tier({}),
    grounded,
    delta: {
      downgraded: 0,
      downgraded_false_positive: 0,
      downgraded_true_positive: 0,
      downgraded_unlabeled: 0,
    },
    missed_blockers: 0,
    orphan_verdict_labels: 0,
    sidecars: 1,
    findings: 1,
    labels: 1,
  };
}

const byName = (rows: MetricDelta[], name: string): MetricDelta =>
  rows.find((r) => r.name === name)!;

describe("compareSummaries", () => {
  it("marks a precision/recall increase 'better' and false_stop_rate increase 'worse'", () => {
    const base = summary(tier({ precision: 0.5, recall: 0.5, false_stop_rate: 0.2 }));
    const cand = summary(tier({ precision: 0.7, recall: 0.6, false_stop_rate: 0.3 }));
    const rows = compareSummaries(base, cand);

    const prec = byName(rows, "stop_precision");
    expect(prec.verdict).toBe("better");
    expect(prec.delta).toBeCloseTo(0.2, 10);

    const recall = byName(rows, "stop_recall");
    expect(recall.verdict).toBe("better");

    const fsr = byName(rows, "false_stop_rate");
    expect(fsr.verdict).toBe("worse"); // ceiling metric: higher is worse
    expect(fsr.delta).toBeCloseTo(0.1, 10);
  });

  it("marks a precision decrease 'worse' and a false_stop_rate decrease 'better'", () => {
    const base = summary(tier({ precision: 0.8, recall: 0.8, false_stop_rate: 0.4 }));
    const cand = summary(tier({ precision: 0.6, recall: 0.8, false_stop_rate: 0.1 }));
    const rows = compareSummaries(base, cand);

    expect(byName(rows, "stop_precision").verdict).toBe("worse");
    expect(byName(rows, "stop_recall").verdict).toBe("same");
    expect(byName(rows, "stop_recall").delta).toBe(0);
    expect(byName(rows, "false_stop_rate").verdict).toBe("better"); // ceiling: lower is better
  });

  it("returns n/a delta and verdict when either side is unavailable", () => {
    const base = summary(tier({ precision: "unavailable", recall: 0.5, false_stop_rate: 0.2 }));
    const cand = summary(tier({ precision: 0.9, recall: "unavailable", false_stop_rate: 0.2 }));
    const rows = compareSummaries(base, cand);

    const prec = byName(rows, "stop_precision");
    expect(prec.delta).toBe("n/a");
    expect(prec.verdict).toBe("n/a");

    const recall = byName(rows, "stop_recall");
    expect(recall.delta).toBe("n/a");
    expect(recall.verdict).toBe("n/a");

    // false_stop_rate is present on both sides and equal → same
    expect(byName(rows, "false_stop_rate").verdict).toBe("same");
  });
});

describe("renderComparisonText / renderComparisonMarkdown", () => {
  const base = summary(tier({ precision: 0.5, recall: 0.5, false_stop_rate: 0.2 }));
  const cand = summary(tier({ precision: 0.7, recall: "unavailable", false_stop_rate: 0.1 }));
  const rows = compareSummaries(base, cand);

  it("text form lists every grounded metric with a verdict", () => {
    const text = renderComparisonText(rows);
    expect(text).toContain("stop_precision");
    expect(text).toContain("stop_recall");
    expect(text).toContain("false_stop_rate");
    expect(text).toContain("BETTER");
    expect(text).toContain("n/a"); // recall unavailable on candidate side
  });

  it("markdown form renders a table row per metric", () => {
    const md = renderComparisonMarkdown(rows);
    expect(md).toContain("| Metric | Baseline | Candidate | Δ | Verdict |");
    expect(md.match(/\| stop_precision \|/)).not.toBeNull();
    expect(md).toContain("🟢 better");
    expect(md).toContain("➖ n/a");
  });
});
