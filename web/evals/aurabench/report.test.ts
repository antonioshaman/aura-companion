/**
 * Tests for the D3 report engine (P6/D3). They pin the rules the REPORT.md
 * numbers depend on: which cells count, how unknown cost is treated, how the
 * Aura Lift is paired against the naked baseline of the SAME provider, that
 * the bootstrap is reproducible, and that E's wall clock is shown with the
 * auto-proceed idle waits subtracted.
 */

import { describe, it, expect } from "vitest";
import type { CellRecord } from "./harness/cells.js";
import type { VariantId } from "./harness/variants.js";
import {
  autoProceedWaitMs,
  baselineOf,
  bootstrapMeanCi,
  classTable,
  layerLadder,
  loadReportCells,
  renderPerTaskTable,
  renderReportTables,
  variantRows,
} from "./report.js";

function cell(task: string, variant: VariantId, success: boolean, extra: Partial<CellRecord> = {}): CellRecord {
  return {
    v: 1,
    key: `${task}|${variant}|${extra.rep ?? 1}`,
    task_id: task,
    task_class: "bugfix",
    variant,
    rep: 1,
    status: "completed",
    success,
    hidden: null,
    regressions: null,
    diff: null,
    metrics: {
      turns: 1,
      tool_calls: 1,
      tokens_in: 1,
      tokens_out: 100,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost_usd: variant === "B" || variant === "F" ? null : 1,
      models: [],
    },
    wall_clock_ms: 600_000,
    started_at: "",
    finished_at: "",
    isolation: { violations: [] },
    confounds: [],
    ...extra,
  };
}

const jsonl = (cs: CellRecord[]) => cs.map((c) => JSON.stringify(c)).join("\n") + "\n";

describe("loadReportCells", () => {
  it("keeps the last record per key and drops cells that did not measure the variant", () => {
    // A re-run of t1|A replaces the earlier failure; harness_error and an
    // isolation violation are excluded with a reason, never counted as failures.
    const { cells, excluded } = loadReportCells(
      jsonl([
        cell("t1", "A", false),
        cell("t1", "A", true),
        cell("t2", "H", false, { status: "harness_error", error: "observer_dead: quota" }),
        cell("t3", "C", true, { isolation: { violations: ["~/.claude/skills"] } }),
        cell("t4", "C", false, { status: "timeout" }),
      ]),
    );
    expect(cells.map((c) => `${c.key}:${c.success}`)).toEqual(["t1|A|1:true", "t4|C|1:false"]);
    expect(excluded).toEqual([
      { key: "t2|H|1", reason: "harness_error: observer_dead: quota" },
      { key: "t3|C|1", reason: "isolation violations: 1" },
    ]);
  });
});

describe("loadReportCells with non-cell lines", () => {
  it("excludes records without a key instead of counting them as a phantom cell", () => {
    // Set-aside files wrap the cell as {moved_at, reason, cell}; concatenated
    // by mistake they must not become an "undefined" cell in the tables.
    const wrapped = JSON.stringify({ moved_at: "x", reason: "observer_dead", cell: cell("t1", "H", true) });
    const { cells, excluded } = loadReportCells(`${wrapped}\n${jsonl([cell("t1", "H", true)])}`);
    expect(cells).toHaveLength(1);
    expect(excluded).toEqual([{ key: "(no key)", reason: "1 line(s) are not cell records" }]);
  });
});

describe("bootstrapMeanCi", () => {
  it("is reproducible for a seed and brackets the point estimate", () => {
    const xs = [1, 0, 1, 1, 0, 1, 1, 1];
    const a = bootstrapMeanCi(xs, 2000, 9)!;
    expect(bootstrapMeanCi(xs, 2000, 9)).toEqual(a);
    expect(a.point).toBe(0.75);
    expect(a.lo).toBeLessThanOrEqual(a.point);
    expect(a.hi).toBeGreaterThanOrEqual(a.point);
  });

  it("degenerates to a point for a constant sample and to null for none", () => {
    expect(bootstrapMeanCi([1, 1, 1], 500)).toEqual({ point: 1, lo: 1, hi: 1 });
    expect(bootstrapMeanCi([], 500)).toBeNull();
  });
});

describe("variantRows", () => {
  it("measures the lift against the naked baseline of the same provider, paired on shared tasks", () => {
    // C (Claude) is compared with A, F (Codex) with B. Task t3 has C but no A,
    // so it does not enter C's paired lift.
    expect(baselineOf("C")).toBe("A");
    expect(baselineOf("H")).toBe("A");
    expect(baselineOf("F")).toBe("B");
    expect(baselineOf("A")).toBeNull();
    const rows = variantRows(
      [
        cell("t1", "A", true),
        cell("t2", "A", false),
        cell("t1", "C", true),
        cell("t2", "C", true),
        cell("t3", "C", false),
        cell("t1", "B", false),
        cell("t1", "F", true),
      ],
      500,
    );
    const c = rows.find((r) => r.variant === "C")!;
    expect(c.lift).toMatchObject({ baseline: "A", pairedTasks: 2, point: 0.5 });
    expect(rows.find((r) => r.variant === "F")!.lift).toMatchObject({ baseline: "B", pairedTasks: 1, point: 1 });
    expect(rows.find((r) => r.variant === "A")!.lift).toBeNull();
  });

  it("keeps Codex cost unknown instead of averaging it as zero", () => {
    // B never reports cost: mean, CI and $/success must all be unknown.
    const b = variantRows([cell("t1", "B", true), cell("t2", "B", true)], 200)[0]!;
    expect(b).toMatchObject({ costMean: null, costCi: null, costUnknown: 2, costPerSuccess: null });
    // A known zero-success variant has no $/success either.
    const a = variantRows([cell("t1", "A", false)], 200)[0]!;
    expect(a.costPerSuccess).toBeNull();
    expect(a.costMean).toBe(1);
  });
});

describe("variantRows with unequal reps", () => {
  it("weights every task once in the task-weighted success and reports the rep range", () => {
    // Stage 2 tops up only the hard tasks: t1 fails 3 reps, t2..t4 pass 1 rep.
    // Per cell that is 3/6 = 50%; per task it is (0 + 1 + 1 + 1) / 4 = 75%.
    const rows = variantRows(
      [
        cell("t1", "A", false),
        cell("t1", "A", false, { key: "t1|A|2", rep: 2 }),
        cell("t1", "A", false, { key: "t1|A|3", rep: 3 }),
        cell("t2", "A", true),
        cell("t3", "A", true),
        cell("t4", "A", true),
      ],
      500,
    );
    const a = rows[0]!;
    expect(a.success!.point).toBe(0.5);
    expect(a.taskSuccess!.point).toBe(0.75);
    expect(a).toMatchObject({ repsMin: 1, repsMax: 3, tasks: 4, cells: 6 });
    // Bootstrap over 4 tasks: the CI brackets the point and stays in [0, 1].
    expect(a.taskSuccess!.lo).toBeLessThanOrEqual(0.75);
    expect(a.taskSuccess!.hi).toBeGreaterThanOrEqual(0.75);
  });
});

describe("renderPerTaskTable", () => {
  it("shows ✓ / ✗N for one rep, successes/reps for several, · when not run", () => {
    // ✗N carries the number of red hidden tests; ✗0 is a zone regression only.
    const failed = (n: number) => ({ passed: false, tests_passed: 1, tests_failed: n, tampered: [] });
    const md = renderPerTaskTable([
      cell("t1", "A", true),
      cell("t1", "C", false, { hidden: failed(2) }),
      cell("t2", "A", false, { hidden: failed(0) }),
      cell("t2", "C", true),
      cell("t2", "C", false, { key: "t2|C|2", rep: 2, hidden: failed(1) }),
    ]);
    expect(md).toContain("| Task | Class | A | C |");
    expect(md).toContain("| `t1` | bugfix | ✓ | ✗2 |");
    expect(md).toContain("| `t2` | bugfix | ✗0 | 1/2 |");
    expect(renderPerTaskTable([cell("t1", "A", true), cell("t2", "C", true)])).toContain("| `t1` | bugfix | ✓ | · |");
  });
});

describe("classTable", () => {
  it("counts successes and cells per class and variant", () => {
    const t = classTable([cell("t1", "A", true), cell("t2", "A", false, { task_class: "ui" }), cell("t1", "C", true)]);
    expect([...t.keys()]).toEqual(["bugfix", "ui"]);
    expect(t.get("bugfix")!.get("A")).toEqual({ s: 1, n: 1 });
    expect(t.get("ui")!.get("A")).toEqual({ s: 0, n: 1 });
  });
});

describe("layer ladder", () => {
  it("uses only tasks with every rung and subtracts auto-proceed waits from E's wall clock", () => {
    // t2 lacks E, so the ladder is computed on t1 alone. E's cell fired
    // auto-proceed 3× at 120 s idle → 6 min of its 16 min are waiting.
    const e = cell("t1", "E", true, { wall_clock_ms: 16 * 60_000, isolation: { violations: [], layer_evidence: { auto_proceed_fires: 3 } } });
    expect(autoProceedWaitMs(e)).toBe(360_000);
    // Only E has the auto-proceed layer; the same evidence on D subtracts nothing.
    expect(autoProceedWaitMs({ ...e, variant: "D" })).toBe(0);
    const { tasks, rows } = layerLadder(
      [cell("t1", "A", false), cell("t1", "C", true), cell("t1", "D", true), e, cell("t2", "A", true), cell("t2", "C", true)],
      300,
    );
    expect(tasks).toEqual(["t1"]);
    expect(rows.map((r) => r.variant)).toEqual(["A", "C", "D", "E"]);
    expect(rows[1]!.deltaSuccess!.point).toBe(1);
    expect(rows[0]!.deltaSuccess).toBeNull();
    expect(rows[3]).toMatchObject({ wallMinMean: 16, wallMinNetMean: 10 });
  });
});

describe("renderReportTables", () => {
  it("renders all three tables and marks Codex cost unknown", () => {
    const md = renderReportTables([cell("t1", "A", true), cell("t1", "B", true), cell("t1", "C", true)], 200);
    expect(md).toContain("### R1.");
    expect(md).toContain("### R2.");
    expect(md).toContain("### R3.");
    expect(md).toContain("### R4. Per task");
    expect(md).toMatch(/\| B \| naked Codex \| 1 \| 1 \| 1\/1 \(100%\) .*\| unknown \|/);
  });
});
