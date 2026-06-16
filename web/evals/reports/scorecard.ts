/**
 * Scorecard renderer — turns a set of scored metrics into a single pass/fail
 * verdict, rendered in both plain text (terminal) and markdown (PR comment /
 * job summary). Two contracts matter:
 *
 *  1. Every metric shows its value, its threshold, and its own pass/fail, so a
 *     maintainer decides the whole run at a glance.
 *  2. A run with ZERO scoreable inputs (every recording was unlabeled or
 *     excluded) renders an explicit "no scoreable inputs" verdict and is a
 *     FAILURE, never a vacuous pass — an empty corpus must not green a gate.
 *
 * Absent-vs-zero discipline carries through: a metric whose value is
 * `"unavailable"` renders as `n/a` and is excluded from the pass/fail tally
 * (it does not silently fail the gate, nor does it count as a pass). The
 * empty-corpus trigger is a separate, explicit input count — not inferred from
 * unavailable metrics.
 *
 * Pure: strings in, strings out. No `server/` imports, no IO. Firewall-clean.
 */

/** Comparison direction for a threshold. `gte` = a floor (higher is better,
 *  e.g. precision); `lte` = a ceiling (lower is better, e.g. false_stop_rate). */
export type ScorecardComparator = "gte" | "lte";

export interface ScorecardMetricInput {
  /** Metric name as it should appear in the row. */
  name: string;
  /** Measured value, or `"unavailable"` when the run could not compute it. */
  value: number | "unavailable";
  /** Threshold the value is compared against. */
  threshold: number;
  comparator: ScorecardComparator;
  /** Optional unit suffix for display only (e.g. "%", "ms", "$"). */
  unit?: string;
}

export type ScorecardRowStatus = "pass" | "fail" | "n/a";

export interface ScorecardRow extends ScorecardMetricInput {
  status: ScorecardRowStatus;
}

export interface Scorecard {
  rows: ScorecardRow[];
  /** How many inputs (recordings/labels) were actually scoreable this run. */
  scoreableInputs: number;
  /** True when no input could be scored → explicit failure, not a vacuous pass. */
  noScoreableInputs: boolean;
  /** Overall verdict. */
  passed: boolean;
}

function evaluateRow(m: ScorecardMetricInput): ScorecardRowStatus {
  if (m.value === "unavailable") return "n/a";
  const meets = m.comparator === "gte" ? m.value >= m.threshold : m.value <= m.threshold;
  return meets ? "pass" : "fail";
}

/**
 * Build a scorecard from metrics + the count of inputs that were scoreable.
 *
 * `scoreableInputs === 0` is the empty-corpus trigger: the run is a failure
 * regardless of metric rows. Otherwise the run passes iff no metric row failed
 * AND at least one metric row passed (an all-`n/a` card does not pass).
 */
export function buildScorecard(
  metrics: ScorecardMetricInput[],
  scoreableInputs: number,
): Scorecard {
  const rows: ScorecardRow[] = metrics.map((m) => ({ ...m, status: evaluateRow(m) }));
  const noScoreableInputs = scoreableInputs <= 0;
  const anyFail = rows.some((r) => r.status === "fail");
  const anyPass = rows.some((r) => r.status === "pass");
  const passed = !noScoreableInputs && !anyFail && anyPass;
  return { rows, scoreableInputs, noScoreableInputs, passed };
}

/** Display-format a metric number: integers verbatim, otherwise rounded to 4
 *  decimals with trailing zeros trimmed (0.6666666666666666 → "0.6667"). The
 *  rounding is DISPLAY-ONLY — pass/fail in {@link evaluateRow} uses the raw
 *  value, so a near-threshold metric is never flattered across the line. */
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return parseFloat(n.toFixed(4)).toString();
}

function fmtValue(m: ScorecardMetricInput): string {
  if (m.value === "unavailable") return "n/a";
  return `${fmtNum(m.value)}${m.unit ?? ""}`;
}

function fmtThreshold(m: ScorecardMetricInput): string {
  const op = m.comparator === "gte" ? "≥" : "≤";
  return `${op} ${m.threshold}${m.unit ?? ""}`;
}

const STATUS_TEXT: Record<ScorecardRowStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  "n/a": "n/a",
};

const STATUS_MD: Record<ScorecardRowStatus, string> = {
  pass: "✅ pass",
  fail: "❌ fail",
  "n/a": "➖ n/a",
};

/** Render the scorecard as fixed-width plain text for a terminal/log. */
export function renderScorecardText(card: Scorecard): string {
  const lines: string[] = [];
  lines.push("Eval Scorecard");
  lines.push("==============");
  if (card.noScoreableInputs) {
    lines.push("no scoreable inputs — every recording was unlabeled or excluded");
    lines.push("RESULT: FAIL");
    return lines.join("\n");
  }
  const nameW = Math.max(6, ...card.rows.map((r) => r.name.length));
  const valW = Math.max(5, ...card.rows.map((r) => fmtValue(r).length));
  const thrW = Math.max(9, ...card.rows.map((r) => fmtThreshold(r).length));
  for (const r of card.rows) {
    lines.push(
      `${r.name.padEnd(nameW)}  ${fmtValue(r).padStart(valW)}  ${fmtThreshold(r).padStart(thrW)}  ${STATUS_TEXT[r.status]}`,
    );
  }
  lines.push(`scoreable inputs: ${card.scoreableInputs}`);
  lines.push(`RESULT: ${card.passed ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

/** Render the scorecard as a GitHub-flavored markdown table. */
export function renderScorecardMarkdown(card: Scorecard): string {
  const lines: string[] = [];
  lines.push("### Eval Scorecard");
  if (card.noScoreableInputs) {
    lines.push("");
    lines.push("> **no scoreable inputs** — every recording was unlabeled or excluded.");
    lines.push("");
    lines.push("**Result: ❌ FAIL**");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("| Metric | Value | Threshold | Status |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of card.rows) {
    lines.push(`| ${r.name} | ${fmtValue(r)} | ${fmtThreshold(r)} | ${STATUS_MD[r.status]} |`);
  }
  lines.push("");
  lines.push(`Scoreable inputs: ${card.scoreableInputs}`);
  lines.push("");
  lines.push(`**Result: ${card.passed ? "✅ PASS" : "❌ FAIL"}**`);
  return lines.join("\n");
}
