/**
 * D3 report engine (P6/D3): aggregates bench cells (`results/cells.jsonl`)
 * into the tables of `docs/aurabench/REPORT.md` — success rate, Aura Lift
 * against the naked baseline of the same provider, cost, per-class success,
 * and the A→C→D→E layer ladder — with percentile-bootstrap 95% CIs.
 *
 * Rules:
 * - Last record per key wins (a re-run replaces the earlier verdict).
 * - `harness_error` cells and cells with isolation violations are excluded:
 *   they did not measure the variant. `timeout` / `agent_error` count as
 *   failures (RUNBOOK: a timeout is a failure, not a retry).
 * - Unknown metrics (null — Codex cost) stay unknown; never averaged as 0.
 * - The bootstrap is seeded, so the same cells always print the same report.
 *
 * Pure. Firewall-clean.
 */

import type { CellRecord } from "./harness/cells.js";
import { knownStats } from "./harness/metric-stats.js";
import { VARIANTS, VARIANT_IDS, type VariantId } from "./harness/variants.js";

export interface LoadedCells {
  cells: CellRecord[];
  /** Keys dropped because the cell did not measure its variant. */
  excluded: { key: string; reason: string }[];
}

export function loadReportCells(jsonl: string): LoadedCells {
  const last = new Map<string, CellRecord>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as CellRecord;
    last.set(rec.key, rec);
  }
  const cells: CellRecord[] = [];
  const excluded: LoadedCells["excluded"] = [];
  for (const rec of last.values()) {
    const violations = (rec.isolation as { violations?: unknown[] } | undefined)?.violations;
    if (rec.status === "harness_error") excluded.push({ key: rec.key, reason: `harness_error: ${rec.error ?? "?"}` });
    else if (Array.isArray(violations) && violations.length > 0)
      excluded.push({ key: rec.key, reason: `isolation violations: ${violations.length}` });
    else cells.push(rec);
  }
  return { cells, excluded };
}

/** mulberry32 — small seeded PRNG so the CIs are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Ci {
  point: number;
  lo: number;
  hi: number;
}

/** Percentile bootstrap of the mean; null for an empty sample. */
export function bootstrapMeanCi(values: readonly number[], iters = 10_000, seed = 1): Ci | null {
  const n = values.length;
  if (n === 0) return null;
  const point = values.reduce((s, v) => s + v, 0) / n;
  const rnd = seededRandom(seed);
  const means = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += values[Math.floor(rnd() * n)]!;
    means[i] = s / n;
  }
  means.sort();
  return { point, lo: means[Math.floor(0.025 * (iters - 1))]!, hi: means[Math.ceil(0.975 * (iters - 1))]! };
}

/** The naked variant a lift is measured against: same orchestrator provider. */
export function baselineOf(v: VariantId): VariantId | null {
  const variant = VARIANTS[v];
  if (variant.mode === "naked") return null;
  return variant.provider === "claude" ? "A" : "B";
}

/** Per-task success rate (mean over reps) — the unit of pairing. */
function taskRates(cells: readonly CellRecord[], v: VariantId): Map<string, number> {
  const acc = new Map<string, { s: number; n: number }>();
  for (const c of cells) {
    if (c.variant !== v) continue;
    const a = acc.get(c.task_id) ?? { s: 0, n: 0 };
    a.s += c.success ? 1 : 0;
    a.n++;
    acc.set(c.task_id, a);
  }
  return new Map([...acc].map(([t, a]) => [t, a.s / a.n]));
}

export interface VariantRow {
  variant: VariantId;
  label: string;
  cells: number;
  tasks: number;
  successes: number;
  success: Ci | null;
  /** Paired (same tasks) success difference vs {@link baselineOf}; bootstrap over tasks. */
  lift: (Ci & { baseline: VariantId; pairedTasks: number }) | null;
  costMean: number | null;
  costCi: Ci | null;
  costUnknown: number;
  /** Total known cost / successes; null when cost is unknown or no success. */
  costPerSuccess: number | null;
  wallMinMean: number | null;
  tokensOutMean: number | null;
}

export function variantRows(cells: readonly CellRecord[], iters = 10_000): VariantRow[] {
  const rows: VariantRow[] = [];
  for (const v of VARIANT_IDS) {
    const mine = cells.filter((c) => c.variant === v);
    if (mine.length === 0) continue;
    const successes = mine.filter((c) => c.success).length;
    const cost = knownStats(mine.map((c) => c.metrics.cost_usd));
    const knownCosts = mine.map((c) => c.metrics.cost_usd).filter((x): x is number => typeof x === "number");
    const base = baselineOf(v);
    let lift: VariantRow["lift"] = null;
    if (base) {
      const mineRates = taskRates(cells, v);
      const baseRates = taskRates(cells, base);
      const diffs = [...mineRates].filter(([t]) => baseRates.has(t)).map(([t, r]) => r - baseRates.get(t)!);
      const ci = bootstrapMeanCi(diffs, iters, 7);
      if (ci) lift = { ...ci, baseline: base, pairedTasks: diffs.length };
    }
    rows.push({
      variant: v,
      label: VARIANTS[v].label,
      cells: mine.length,
      tasks: new Set(mine.map((c) => c.task_id)).size,
      successes,
      success: bootstrapMeanCi(
        mine.map((c) => (c.success ? 1 : 0)),
        iters,
        3,
      ),
      lift,
      costMean: cost.mean,
      costCi: knownCosts.length === mine.length ? bootstrapMeanCi(knownCosts, iters, 5) : null,
      costUnknown: cost.unknown,
      costPerSuccess: cost.sum !== null && cost.unknown === 0 && successes > 0 ? cost.sum / successes : null,
      wallMinMean: knownStats(mine.map((c) => c.wall_clock_ms / 60_000)).mean,
      tokensOutMean: knownStats(mine.map((c) => c.metrics.tokens_out)).mean,
    });
  }
  return rows;
}

/** successes / cells per class × variant. */
export function classTable(cells: readonly CellRecord[]): Map<string, Map<VariantId, { s: number; n: number }>> {
  const out = new Map<string, Map<VariantId, { s: number; n: number }>>();
  for (const c of cells) {
    const row = out.get(c.task_class) ?? new Map<VariantId, { s: number; n: number }>();
    const a = row.get(c.variant) ?? { s: 0, n: 0 };
    a.s += c.success ? 1 : 0;
    a.n++;
    row.set(c.variant, a);
    out.set(c.task_class, row);
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** Idle time E spends waiting for auto-proceed: fires × idle threshold (a lower bound). */
export function autoProceedWaitMs(c: CellRecord): number {
  const variant = VARIANTS[c.variant];
  const idleMs = variant.mode === "aura" ? (variant.autoProceedOnIdle?.idleMs ?? 0) : 0;
  const fires = (c.isolation as { layer_evidence?: { auto_proceed_fires?: unknown } } | undefined)?.layer_evidence
    ?.auto_proceed_fires;
  return typeof fires === "number" && fires > 0 ? fires * idleMs : 0;
}

export const LAYER_LADDER: readonly VariantId[] = ["A", "C", "D", "E"];

export interface LadderRow {
  variant: VariantId;
  successes: number;
  cells: number;
  costMean: number | null;
  wallMinMean: number | null;
  /** Wall clock minus auto-proceed idle waits (equals wallMinMean when the layer is off). */
  wallMinNetMean: number | null;
  /** Paired success / cost difference vs the previous rung; bootstrap over tasks. */
  deltaSuccess: Ci | null;
  deltaCost: Ci | null;
}

/** A→C→D→E on the tasks that have every rung — each step adds one layer. */
export function layerLadder(cells: readonly CellRecord[], iters = 10_000): { tasks: string[]; rows: LadderRow[] } {
  const byTask = new Map<string, Set<VariantId>>();
  for (const c of cells) byTask.set(c.task_id, (byTask.get(c.task_id) ?? new Set()).add(c.variant));
  const tasks = [...byTask].filter(([, s]) => LAYER_LADDER.every((v) => s.has(v))).map(([t]) => t).sort();
  const inLadder = cells.filter((c) => tasks.includes(c.task_id));
  const perTask = (v: VariantId, f: (c: CellRecord) => number | null) => {
    const m = new Map<string, number[]>();
    for (const c of inLadder) {
      if (c.variant !== v) continue;
      const x = f(c);
      if (x === null) continue;
      m.set(c.task_id, [...(m.get(c.task_id) ?? []), x]);
    }
    return new Map([...m].map(([t, xs]) => [t, xs.reduce((s, x) => s + x, 0) / xs.length]));
  };
  const paired = (a: Map<string, number>, b: Map<string, number>, seed: number) =>
    bootstrapMeanCi(
      [...b].filter(([t]) => a.has(t)).map(([t, x]) => x - a.get(t)!),
      iters,
      seed,
    );
  const rows: LadderRow[] = LAYER_LADDER.map((v, i) => {
    const mine = inLadder.filter((c) => c.variant === v);
    const prev = i > 0 ? LAYER_LADDER[i - 1]! : null;
    const succ = (c: CellRecord) => (c.success ? 1 : 0);
    const cost = (c: CellRecord) => c.metrics.cost_usd;
    return {
      variant: v,
      successes: mine.filter((c) => c.success).length,
      cells: mine.length,
      costMean: knownStats(mine.map(cost)).mean,
      wallMinMean: knownStats(mine.map((c) => c.wall_clock_ms / 60_000)).mean,
      wallMinNetMean: knownStats(mine.map((c) => (c.wall_clock_ms - autoProceedWaitMs(c)) / 60_000)).mean,
      deltaSuccess: prev ? paired(perTask(prev, succ), perTask(v, succ), 11 + i) : null,
      deltaCost: prev ? paired(perTask(prev, cost), perTask(v, cost), 21 + i) : null,
    };
  });
  return { tasks, rows };
}

// ── Markdown ────────────────────────────────────────────────────────────────

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pp = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}`;
const usd = (x: number | null) => (x === null ? "unknown" : `$${x.toFixed(2)}`);
const sUsd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const num = (x: number | null, d = 1) => (x === null ? "—" : x.toFixed(d));

export function renderReportTables(cells: readonly CellRecord[], iters = 10_000): string {
  const out: string[] = [];
  out.push("### R1. Success, Aura Lift, cost by variant", "");
  out.push(
    "| Variant | Label | Cells | Tasks | Success | 95% CI | Lift vs naked (pp) | Lift 95% CI | Paired tasks | Mean cost | Cost 95% CI | $ / success | Mean wall (min) |",
  );
  out.push("|---|---|---:|---:|---:|---|---:|---|---:|---:|---|---:|---:|");
  for (const r of variantRows(cells, iters)) {
    const s = r.success!;
    out.push(
      `| ${r.variant} | ${r.label} | ${r.cells} | ${r.tasks} | ${r.successes}/${r.cells} (${pct(s.point)}) | ${pct(s.lo)}–${pct(s.hi)} | ` +
        (r.lift ? `${pp(r.lift.point)} vs ${r.lift.baseline} | ${pp(r.lift.lo)}…${pp(r.lift.hi)} | ${r.lift.pairedTasks}` : "— | — | —") +
        ` | ${r.costUnknown === r.cells ? "unknown" : usd(r.costMean)} | ${r.costCi ? `${usd(r.costCi.lo)}–${usd(r.costCi.hi)}` : "—"} | ${usd(r.costPerSuccess)} | ${num(r.wallMinMean)} |`,
    );
  }
  out.push("");

  out.push("### R2. Success by class (successes / cells)", "");
  const present = VARIANT_IDS.filter((v) => cells.some((c) => c.variant === v));
  out.push(`| Class | ${present.join(" | ")} |`, `|---|${present.map(() => "---:").join("|")}|`);
  for (const [cls, row] of classTable(cells)) {
    out.push(`| ${cls} | ${present.map((v) => (row.get(v) ? `${row.get(v)!.s}/${row.get(v)!.n}` : "—")).join(" | ")} |`);
  }
  out.push("");

  const ladder = layerLadder(cells, iters);
  out.push(`### R3. Layer ladder A→C→D→E (${ladder.tasks.length} tasks with all four rungs)`, "");
  out.push(
    "| Rung | Adds | Success | Δ success vs previous (pp, 95% CI) | Mean cost | Δ cost vs previous (95% CI) | Wall (min) | Wall excl. auto-proceed waits (min) |",
  );
  out.push("|---|---|---:|---|---:|---|---:|---:|");
  const adds: Record<string, string> = { A: "naked Claude", C: "+ knowledge", D: "+ observer (claude+claude)", E: "+ council skills + auto-proceed" };
  for (const r of ladder.rows) {
    out.push(
      `| ${r.variant} | ${adds[r.variant]} | ${r.successes}/${r.cells} | ` +
        (r.deltaSuccess ? `${pp(r.deltaSuccess.point)} (${pp(r.deltaSuccess.lo)}…${pp(r.deltaSuccess.hi)})` : "—") +
        ` | ${usd(r.costMean)} | ` +
        (r.deltaCost ? `${sUsd(r.deltaCost.point)} (${sUsd(r.deltaCost.lo)}…${sUsd(r.deltaCost.hi)})` : "—") +
        ` | ${num(r.wallMinMean)} | ${num(r.wallMinNetMean)} |`,
    );
  }
  out.push("");
  return out.join("\n");
}
