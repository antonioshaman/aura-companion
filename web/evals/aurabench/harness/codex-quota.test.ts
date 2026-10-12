/**
 * P6/FIX-CODEX-QUOTA. On 2026-10-01 the bench used up the weekly Codex quota
 * that prod's Codex observers share, then burned BENCH-H cells as
 * `observer_dead` on the refusal below. These tests pin:
 *
 *   - parsing of the REAL refusal string (absolute "try again at <date>"),
 *     and the zone / year edge cases of that parser;
 *   - the observer half of a Council cell reporting that refusal → a
 *     Codex-tagged limit (a pause), not a dead-observer result;
 *   - `AURABENCH_CODEX_DAILY_CELLS` parsing (invalid → default, never
 *     unlimited) and the rolling-24 h start budget;
 *   - the driver: a Codex limit pauses EVERY Codex cell until the reset while
 *     the Claude cells keep running, then the Codex cells resume; a budget of
 *     0 stops resumably; ledger starts are written for each Codex start.
 */

import { describe, it, expect } from "vitest";
import { detectLimit, emptyMetrics, parseTryAgainAt } from "./agent-metrics.js";
import { AuraSessionTracker } from "./aura-session-tracker.js";
import {
  CODEX_WINDOW_MS,
  DEFAULT_CODEX_DAILY_CELLS,
  codexBudgetOpensAt,
  codexDailyCellsFromEnv,
  parseCodexLedger,
  variantUsesCodex,
} from "./codex-quota.js";
import { CELL_RECORD_VERSION, type CellRecord } from "./cells.js";
import { runAblation, type DriverDeps } from "./driver.js";
import type { CellOutcome } from "./run-cell.js";

// Verbatim from bench/bench-h/results/cells.jsonl (2026-10-01).
const REAL =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 4th, 2026 11:56 PM.";
const RESET = Date.UTC(2026, 9, 4, 23, 56);
const NOW = Date.UTC(2026, 9, 1, 16, 30);

describe("Codex refusal parsing", () => {
  it("the real string is a limit that resets at the absolute UTC instant", () => {
    expect(detectLimit(REAL, NOW)).toEqual({ resetAt: RESET, message: REAL.slice(0, 300) });
  });

  it("year optional: next such date; a date long past rolls to next year", () => {
    expect(parseTryAgainAt("try again at Oct 4th 11:56 PM", NOW)).toBe(RESET);
    expect(parseTryAgainAt("try again at Jan 2nd, 9:05 AM", NOW)).toBe(Date.UTC(2027, 0, 2, 9, 5));
  });

  it("24-hour clock and explicit UTC are read; a foreign zone is not guessed", () => {
    expect(parseTryAgainAt("try again at Oct 4, 2026 23:56 UTC", NOW)).toBe(RESET);
    expect(parseTryAgainAt("try again at Oct 4, 2026 11:56 PM PST", NOW)).toBeNull();
    // A following lower-case word is not a zone.
    expect(parseTryAgainAt("try again at Oct 4, 2026 23:56 and retry", NOW)).toBe(RESET);
  });

  it("nonsense times / months are rejected", () => {
    expect(parseTryAgainAt("try again at Foo 4, 2026 11:56 PM", NOW)).toBeNull();
    expect(parseTryAgainAt("try again at Oct 4, 2026 13:56 PM", NOW)).toBeNull();
    expect(parseTryAgainAt("try again at Oct 4, 2026 11:76", NOW)).toBeNull();
  });
});

describe("observer quota in a Council cell", () => {
  const errorResult = (text: string) => ({ type: "result", data: { subtype: "error_during_execution", is_error: true, result: text } });

  // BENCH-H: the Codex observer's two turns both ended on REAL. Before the
  // fix the cell became harness_error observer_dead; now the tracker exposes
  // a Codex-tagged limit the runner turns into a pause.
  it("an observer error result with the refusal sets a codex observerLimit", () => {
    const t = new AuraSessionTracker("p", ["o"], 10);
    t.onMessage("o", { type: "session_init", session: { backend_type: "codex" } }, 0);
    t.onMessage("o", errorResult(REAL), NOW);
    expect(t.observerLimit).toMatchObject({ provider: "codex", resetAt: RESET });
    expect(t.observerHealth()).toMatchObject({ ok_results: 0, error_results: 1 });
    // The primary is unaffected: its own limit stays null.
    expect(t.limit).toBeNull();
  });

  it("an observer `error` frame with the refusal counts too; a plain error does not", () => {
    const t = new AuraSessionTracker("p", ["o"], 10, "codex");
    t.onMessage("o", { type: "error", message: "HTTP 400 model not supported" }, NOW);
    expect(t.observerLimit).toBeNull();
    t.onMessage("o", { type: "error", message: REAL }, NOW);
    expect(t.observerLimit).toMatchObject({ provider: "codex" });
  });

  it("a primary limit is tagged with the primary's backend", () => {
    const t = new AuraSessionTracker("p", [], 10);
    t.promptSent(0);
    t.onMessage("p", errorResult("You've hit your session limit · resets 12:10am (UTC)"), NOW);
    expect(t.limit).toMatchObject({ provider: "claude" });
  });
});

describe("Codex budget", () => {
  it("variants that spend Codex quota: B, F, G (primary) and H (observer)", () => {
    expect((["A", "B", "C", "D", "E", "F", "G", "H"] as const).filter(variantUsesCodex)).toEqual(["B", "F", "G", "H"]);
  });

  it("AURABENCH_CODEX_DAILY_CELLS: non-negative integer, else the default (never unlimited)", () => {
    expect(codexDailyCellsFromEnv({})).toBe(DEFAULT_CODEX_DAILY_CELLS);
    expect(codexDailyCellsFromEnv({ AURABENCH_CODEX_DAILY_CELLS: " 5 " })).toBe(5);
    expect(codexDailyCellsFromEnv({ AURABENCH_CODEX_DAILY_CELLS: "0" })).toBe(0);
    for (const bad of ["", "abc", "-1", "2.5", "Infinity", "1e3"]) {
      expect(codexDailyCellsFromEnv({ AURABENCH_CODEX_DAILY_CELLS: bad })).toBe(DEFAULT_CODEX_DAILY_CELLS);
    }
  });

  it("ledger parse ignores torn lines", () => {
    expect(parseCodexLedger(`${NOW}\n17594\nxx\n${NOW + 1}`)).toEqual([NOW, NOW + 1]);
  });

  it("rolling 24 h: under budget → now; at budget → when the cap-th newest start ages out; 0 → never", () => {
    const h = 3_600_000;
    const starts = [NOW - 30 * h, NOW - 20 * h, NOW - 10 * h, NOW - h];
    expect(codexBudgetOpensAt(starts, 4, NOW)).toBe(NOW); // only 3 in window
    expect(codexBudgetOpensAt(starts, 3, NOW)).toBe(NOW - 20 * h + CODEX_WINDOW_MS);
    expect(codexBudgetOpensAt(starts, 1, NOW)).toBe(NOW - h + CODEX_WINDOW_MS);
    expect(codexBudgetOpensAt([], 0, NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});

const rec = (key: string): CellRecord => {
  const [task_id, variant, rep] = key.split("|");
  return {
    v: CELL_RECORD_VERSION,
    key,
    task_id: task_id!,
    task_class: "bugfix",
    variant: variant as "A",
    rep: Number(rep),
    status: "completed",
    success: true,
    hidden: null,
    regressions: null,
    diff: null,
    metrics: emptyMetrics(),
    wall_clock_ms: 1,
    started_at: "",
    finished_at: "",
    isolation: {},
    confounds: [],
  };
};

function driver(outcomes: Record<string, CellOutcome[]>, dailyCells: number, extra: Partial<DriverDeps> = {}) {
  const ran: string[] = [];
  const appended: string[] = [];
  const sleeps: number[] = [];
  const ledger: number[] = [];
  let clock = NOW;
  const d: DriverDeps = {
    taskIds: ["t1", "t2"],
    variants: ["C", "H"],
    reps: 1,
    readResults: () => "",
    appendResult: (r) => appended.push(r.key),
    runCell: async (c) => {
      ran.push(c.key);
      clock += 60_000;
      const q = outcomes[c.key];
      return q && q.length ? q.shift()! : { kind: "record", record: rec(c.key) };
    },
    memAvailableKb: () => 8 * 1024 * 1024,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: () => {},
    codex: {
      isCodexCell: (c) => variantUsesCodex(c.variant),
      dailyCells,
      starts: () => ledger,
      noteStart: (at) => ledger.push(at),
    },
    ...extra,
  };
  return { d, ran, appended, sleeps, ledger };
}

describe("runAblation with the Codex guard", () => {
  const codexLimit: CellOutcome = { kind: "limit", limit: { resetAt: RESET, message: REAL, provider: "codex" } };

  it("a Codex limit defers every Codex cell; Claude cells run on; Codex resumes after the reset", async () => {
    const { d, ran, appended, sleeps, ledger } = driver({ "t1|H|1": [codexLimit] }, 12);
    const s = await runAblation(d);
    // t1|H hits the limit; t2|H is NOT tried (paused), t2|C still runs.
    expect(ran).toEqual(["t1|C|1", "t1|H|1", "t2|C|1", "t1|H|1", "t2|H|1"]);
    expect(appended.sort()).toEqual(["t1|C|1", "t1|H|1", "t2|C|1", "t2|H|1"]);
    // Only-Codex-left holds in ≤ 6 h steps until past the reset.
    expect(sleeps.every((ms) => ms <= 6 * 3_600_000)).toBe(true);
    expect(d.now()).toBeGreaterThan(RESET);
    expect(s).toMatchObject({ limitPauses: 1, stoppedOnLimit: null, stoppedOnCodex: 0, done: 4 });
    expect(s.codexHolds).toBe(sleeps.length);
    // Every Codex START is in the ledger, the limited one included.
    expect(ledger).toHaveLength(3);
  });

  it("a Claude limit in the same plan still sleeps and retries that cell (old behaviour)", async () => {
    const claudeLimit: CellOutcome = { kind: "limit", limit: { resetAt: NOW + 10 * 60_000, message: "session limit", provider: "claude" } };
    const { d, ran } = driver({ "t1|C|1": [claudeLimit] }, 12);
    await runAblation(d);
    expect(ran.slice(0, 2)).toEqual(["t1|C|1", "t1|C|1"]);
  });

  it("the daily budget caps Codex starts and the rest wait for the window", async () => {
    const { d, ran, ledger } = driver({}, 1, { taskIds: ["t1", "t2", "t3"] });
    const s = await runAblation(d);
    // One H start per 24 h: H cells are spaced a day apart, C cells unaffected.
    expect(ran.slice(0, 4)).toEqual(["t1|C|1", "t1|H|1", "t2|C|1", "t3|C|1"]);
    expect(ledger).toHaveLength(3);
    expect(ledger[1]! - ledger[0]!).toBeGreaterThanOrEqual(CODEX_WINDOW_MS);
    expect(s.done).toBe(6);
  });

  it("budget 0: Claude cells run, Codex cells stop resumably (nothing recorded for them)", async () => {
    const { d, appended, ledger } = driver({}, 0);
    const s = await runAblation(d);
    expect(appended).toEqual(["t1|C|1", "t2|C|1"]);
    expect(ledger).toEqual([]);
    expect(s.stoppedOnCodex).toBe(2);
  });
});
