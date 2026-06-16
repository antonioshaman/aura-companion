/**
 * A/B skill delta — did turning a skill ON actually help, and was it worth the
 * token cost? The motivating evidence (SWE-Skills-Bench) is blunt: most skills
 * don't move the pass rate, and some make it WORSE while still costing tokens.
 * So a skill must be measured, not assumed: run the same task suite with the
 * skill off (baseline arm) and on (candidate arm), then diff their metrics.
 *
 * This module is the DETERMINISTIC diff half — arms in, per-metric delta out.
 * It spends zero tokens: the two arms are already-computed metric bags (the
 * A/B driver that actually executes tasks with and without the skill is the
 * quota-spending part and lives off-CI / manual; it calls this to render its
 * verdict). Direction-aware like the precision comparison: `higher_better` for
 * quality metrics (task_success_rate, tests_passed), `lower_better` for cost
 * metrics (token_cost, time_to_green, human_intervention_count).
 *
 * Absent-vs-zero discipline: a metric `"unavailable"` on either arm yields a
 * `"n/a"` delta and verdict — a missing measurement is never treated as 0, an
 * improvement, or a regression. The headline tallies better/worse/same so a
 * skill that improves quality but balloons cost shows BOTH movements rather than
 * a single laundered score.
 *
 * Pure: arms in, strings out. No `server/` imports, no IO. Firewall-clean.
 */

/** A metric value, or `"unavailable"` when the arm could not measure it. */
export type ArmMetricValue = number | "unavailable";

/** Which direction is "better" for a metric. */
export type MetricDirection = "higher_better" | "lower_better";

/** Declares a metric the A/B reports on: its name, direction, and display unit. */
export interface ABMetricSpec {
  name: string;
  direction: MetricDirection;
  unit?: string;
}

/** One arm of the experiment: a label plus its measured metric values. */
export interface ArmResult {
  /** e.g. "skill-off" / "skill-on", or two skill variants. */
  label: string;
  metrics: Record<string, ArmMetricValue>;
}

export type DeltaVerdict = "better" | "worse" | "same" | "n/a";

export interface ABMetricDelta {
  name: string;
  unit?: string;
  baseline: ArmMetricValue;
  candidate: ArmMetricValue;
  /** candidate − baseline, or `"n/a"` when either arm is unavailable. */
  delta: number | "n/a";
  /** (candidate − baseline) / |baseline| as a percentage, or `"n/a"` (also when
   *  baseline is 0 — no defined percentage change from zero). */
  pct_change: number | "n/a";
  verdict: DeltaVerdict;
}

export interface ABComparison {
  baseline_label: string;
  candidate_label: string;
  rows: ABMetricDelta[];
  /** Tally across rows with a real verdict — so a quality gain AND a cost
   *  regression are both visible, never netted into one number. */
  better: number;
  worse: number;
  same: number;
  na: number;
}

function deltaFor(
  baseline: ArmMetricValue,
  candidate: ArmMetricValue,
  direction: MetricDirection,
): { delta: number | "n/a"; pct_change: number | "n/a"; verdict: DeltaVerdict } {
  if (baseline === "unavailable" || candidate === "unavailable") {
    return { delta: "n/a", pct_change: "n/a", verdict: "n/a" };
  }
  const delta = candidate - baseline;
  const pct_change = baseline === 0 ? "n/a" : (delta / Math.abs(baseline)) * 100;
  if (delta === 0) return { delta, pct_change, verdict: "same" };
  const improved = direction === "higher_better" ? delta > 0 : delta < 0;
  return { delta, pct_change, verdict: improved ? "better" : "worse" };
}

/**
 * Compare two arms over a declared metric set. Order of `specs` is preserved for
 * byte-stable rendering. A metric absent from an arm's bag is treated as
 * `"unavailable"` (→ n/a), never as 0.
 */
export function compareSkillArms(
  specs: ABMetricSpec[],
  baseline: ArmResult,
  candidate: ArmResult,
): ABComparison {
  const rows: ABMetricDelta[] = specs.map((s) => {
    const b = s.name in baseline.metrics ? baseline.metrics[s.name] : "unavailable";
    const c = s.name in candidate.metrics ? candidate.metrics[s.name] : "unavailable";
    const { delta, pct_change, verdict } = deltaFor(b, c, s.direction);
    return { name: s.name, unit: s.unit, baseline: b, candidate: c, delta, pct_change, verdict };
  });
  const tally = { better: 0, worse: 0, same: 0, na: 0 };
  for (const r of rows) {
    if (r.verdict === "better") tally.better++;
    else if (r.verdict === "worse") tally.worse++;
    else if (r.verdict === "same") tally.same++;
    else tally.na++;
  }
  return {
    baseline_label: baseline.label,
    candidate_label: candidate.label,
    rows,
    ...tally,
  };
}

function fmtValue(v: ArmMetricValue, unit?: string): string {
  if (v === "unavailable") return "n/a";
  const n = Number.isInteger(v) ? String(v) : parseFloat(v.toFixed(4)).toString();
  return `${n}${unit ?? ""}`;
}

function fmtDelta(d: number | "n/a", unit?: string): string {
  if (d === "n/a") return "n/a";
  if (d === 0) return "0";
  const rounded = parseFloat(d.toFixed(4));
  return `${rounded > 0 ? "+" : ""}${rounded}${unit ?? ""}`;
}

function fmtPct(p: number | "n/a"): string {
  if (p === "n/a") return "n/a";
  const rounded = parseFloat(p.toFixed(1));
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
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

/** Render the A/B comparison as fixed-width plain text. */
export function renderABText(cmp: ABComparison): string {
  const lines: string[] = [];
  lines.push(`A/B Skill Delta: ${cmp.baseline_label} → ${cmp.candidate_label}`);
  lines.push("=".repeat(Math.max(16, `A/B Skill Delta: ${cmp.baseline_label} → ${cmp.candidate_label}`.length)));
  const nameW = Math.max(6, ...cmp.rows.map((r) => r.name.length));
  for (const r of cmp.rows) {
    lines.push(
      `${r.name.padEnd(nameW)}  ${fmtValue(r.baseline, r.unit).padStart(10)}  ${fmtValue(r.candidate, r.unit).padStart(10)}  ${fmtDelta(r.delta, r.unit).padStart(10)}  ${fmtPct(r.pct_change).padStart(8)}  ${VERDICT_TEXT[r.verdict]}`,
    );
  }
  lines.push(`better: ${cmp.better}  worse: ${cmp.worse}  same: ${cmp.same}  n/a: ${cmp.na}`);
  return lines.join("\n");
}

/** Render the A/B comparison as a GitHub-flavored markdown table. */
export function renderABMarkdown(cmp: ABComparison): string {
  const lines: string[] = [];
  lines.push(`### A/B Skill Delta: ${cmp.baseline_label} → ${cmp.candidate_label}`);
  lines.push("");
  lines.push(`| Metric | ${cmp.baseline_label} | ${cmp.candidate_label} | Δ | % | Verdict |`);
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of cmp.rows) {
    lines.push(
      `| ${r.name} | ${fmtValue(r.baseline, r.unit)} | ${fmtValue(r.candidate, r.unit)} | ${fmtDelta(r.delta, r.unit)} | ${fmtPct(r.pct_change)} | ${VERDICT_MD[r.verdict]} |`,
    );
  }
  lines.push("");
  lines.push(`Better: ${cmp.better} · Worse: ${cmp.worse} · Same: ${cmp.same} · n/a: ${cmp.na}`);
  return lines.join("\n");
}
