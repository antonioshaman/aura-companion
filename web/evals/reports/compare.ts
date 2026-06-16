/**
 * Cross-variant comparison — a pure delta report between two precision summaries
 * (e.g. baseline `claude+claude` vs candidate `claude+codex`, or this branch vs
 * `main`). It answers one question per metric: "did the candidate move the
 * grounded observer-quality number in the right direction, and by how much?"
 *
 * This is an ADVISORY report, never a gate. The CI gate stays no-regression on
 * the committed baseline (`eval:replay --ci`). `eval:compare` is a side-by-side
 * lens a maintainer reads when deciding between two variants — it has no exit-code
 * authority and runs zero LLM calls (both inputs are already-scored summaries).
 *
 * Absent-vs-zero discipline carries through: when EITHER side of a metric is
 * `"unavailable"`, the delta is `"n/a"` and the verdict is `"n/a"` — a missing
 * number is never silently treated as 0, and never counted as an improvement or
 * a regression.
 *
 * Pure: summaries in, strings out. No `server/` imports, no IO. Firewall-clean.
 */

import type { PrecisionSummary, SerialRatio, SerialTier } from "../scorers/precision-corpus.js";

/** Which direction is "better" for a metric. `higher_better` = precision/recall
 *  (a floor); `lower_better` = false_stop_rate (a ceiling). */
export type MetricDirection = "higher_better" | "lower_better";

/** A metric's movement from baseline to candidate, reduced to a verdict. */
export type DeltaVerdict = "better" | "worse" | "same" | "n/a";

export interface MetricDelta {
  /** Metric name as it should appear in the row. */
  name: string;
  baseline: SerialRatio;
  candidate: SerialRatio;
  /** candidate − baseline, or `"n/a"` when either side is unavailable. */
  delta: number | "n/a";
  verdict: DeltaVerdict;
}

interface MetricSpec {
  name: string;
  pick: (t: SerialTier) => SerialRatio;
  direction: MetricDirection;
}

/** The grounded-tier metrics the comparison reports, in display order. Grounded
 *  (post-gate) is the user-visible severity, the same tier `eval:scorecard`
 *  surfaces — so the two reports never disagree about which number matters. */
const GROUNDED_METRICS: MetricSpec[] = [
  { name: "stop_precision", pick: (t) => t.precision, direction: "higher_better" },
  { name: "stop_recall", pick: (t) => t.recall, direction: "higher_better" },
  { name: "false_stop_rate", pick: (t) => t.false_stop_rate, direction: "lower_better" },
];

function deltaVerdict(
  baseline: SerialRatio,
  candidate: SerialRatio,
  direction: MetricDirection,
): { delta: number | "n/a"; verdict: DeltaVerdict } {
  if (baseline === "unavailable" || candidate === "unavailable") {
    return { delta: "n/a", verdict: "n/a" };
  }
  const delta = candidate - baseline;
  if (delta === 0) return { delta, verdict: "same" };
  const improved = direction === "higher_better" ? delta > 0 : delta < 0;
  return { delta, verdict: improved ? "better" : "worse" };
}

/**
 * Compute the grounded-tier metric deltas from baseline → candidate. One row per
 * {@link GROUNDED_METRICS} entry; order is stable for byte-stable rendering.
 */
export function compareSummaries(
  baseline: PrecisionSummary,
  candidate: PrecisionSummary,
): MetricDelta[] {
  return GROUNDED_METRICS.map((m) => {
    const b = m.pick(baseline.grounded);
    const c = m.pick(candidate.grounded);
    const { delta, verdict } = deltaVerdict(b, c, m.direction);
    return { name: m.name, baseline: b, candidate: c, delta, verdict };
  });
}

function fmtRatio(r: SerialRatio): string {
  if (r === "unavailable") return "n/a";
  return Number.isInteger(r) ? String(r) : parseFloat(r.toFixed(4)).toString();
}

function fmtDelta(d: number | "n/a"): string {
  if (d === "n/a") return "n/a";
  if (d === 0) return "0";
  const rounded = parseFloat(d.toFixed(4));
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

const VERDICT_TEXT: Record<DeltaVerdict, string> = {
  better: "BETTER",
  worse: "WORSE",
  same: "same",
  "n/a": "n/a",
};

const VERDICT_MD: Record<DeltaVerdict, string> = {
  better: "🟢 better",
  worse: "🔴 worse",
  same: "⚪ same",
  "n/a": "➖ n/a",
};

/** Render the comparison as fixed-width plain text for a terminal/log. */
export function renderComparisonText(rows: MetricDelta[]): string {
  const lines: string[] = [];
  lines.push("Eval Comparison (grounded)");
  lines.push("==========================");
  const nameW = Math.max(6, ...rows.map((r) => r.name.length));
  const baseW = Math.max(8, ...rows.map((r) => fmtRatio(r.baseline).length));
  const candW = Math.max(9, ...rows.map((r) => fmtRatio(r.candidate).length));
  const deltaW = Math.max(5, ...rows.map((r) => fmtDelta(r.delta).length));
  for (const r of rows) {
    lines.push(
      `${r.name.padEnd(nameW)}  ${fmtRatio(r.baseline).padStart(baseW)}  ${fmtRatio(r.candidate).padStart(candW)}  ${fmtDelta(r.delta).padStart(deltaW)}  ${VERDICT_TEXT[r.verdict]}`,
    );
  }
  return lines.join("\n");
}

/** Render the comparison as a GitHub-flavored markdown table. */
export function renderComparisonMarkdown(rows: MetricDelta[]): string {
  const lines: string[] = [];
  lines.push("### Eval Comparison (grounded)");
  lines.push("");
  lines.push("| Metric | Baseline | Candidate | Δ | Verdict |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(
      `| ${r.name} | ${fmtRatio(r.baseline)} | ${fmtRatio(r.candidate)} | ${fmtDelta(r.delta)} | ${VERDICT_MD[r.verdict]} |`,
    );
  }
  return lines.join("\n");
}
