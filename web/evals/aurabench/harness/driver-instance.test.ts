/**
 * Tests for the ablation driver and the bench-instance environment (Story D2:
 * "limit exhausted → wait for the reset and continue from the same place
 * without duplicating finished cells"; "the agent is isolated from the prod
 * service, prod sessions and the prod checkout").
 *
 * Validates:
 *   - finished keys are skipped; new records are appended exactly once;
 *   - a limit hit sleeps (until the parsed reset) and retries the SAME cell;
 *     exhausting retries stops the run resumably without a record;
 *   - the memory gate waits while MemAvailable < 1.5 GB;
 *   - `maxCells` bounds a pilot; progress is reported after every record;
 *   - the instance env: its own HOME/TMPDIR/recordings/stats/origin, reaper
 *     off, loopback only, AURA_* stripped — and the prod port is refused.
 */

import { describe, it, expect } from "vitest";
import { runAblation, type DriverDeps } from "./driver.js";
import { CELL_RECORD_VERSION, type CellRecord } from "./cells.js";
import { emptyMetrics } from "./agent-metrics.js";
import type { CellOutcome } from "./run-cell.js";
import { BENCH_PORT, PROD_PORT, benchInstanceEnv, benchInstancePaths } from "./bench-instance.js";
import { benchChildEnv } from "./proc.js";

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

function driver(outcomes: Record<string, CellOutcome[]>, extra: Partial<DriverDeps> = {}) {
  const appended: string[] = [];
  const sleeps: number[] = [];
  const ran: string[] = [];
  const progress: string[] = [];
  let clock = 0;
  const d: DriverDeps = {
    taskIds: ["t1", "t2"],
    variants: ["A", "C"],
    reps: 1,
    readResults: () => "",
    appendResult: (r) => appended.push(r.key),
    runCell: async (c) => {
      ran.push(c.key);
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
    onProgress: (p) => progress.push(`${p.done}/${p.total}`),
    ...extra,
  };
  return { d, appended, sleeps, ran, progress };
}

describe("runAblation", () => {
  it("skips finished cells and appends each new record once", async () => {
    const done = JSON.stringify(rec("t1|A|1")) + "\n";
    const { d, appended, ran, progress } = driver({}, { readResults: () => done });
    const s = await runAblation(d);
    expect(ran).toEqual(["t1|C|1", "t2|A|1", "t2|C|1"]);
    expect(appended).toEqual(ran);
    expect(s).toMatchObject({ total: 4, done: 4, recorded: 3, limitPauses: 0 });
    expect(progress).toEqual(["1/4", "2/4", "3/4", "4/4"]);
  });

  it("on a limit, sleeps until the reset and retries the same cell", async () => {
    const limit: CellOutcome = { kind: "limit", limit: { resetAt: 10 * 60_000, message: "usage limit" } };
    const { d, ran, sleeps, appended } = driver({ "t1|C|1": [limit] });
    const s = await runAblation(d);
    expect(ran.slice(0, 3)).toEqual(["t1|A|1", "t1|C|1", "t1|C|1"]);
    expect(sleeps).toEqual([11 * 60_000]);
    expect(appended.filter((k) => k === "t1|C|1")).toHaveLength(1);
    expect(s.limitPauses).toBe(1);
  });

  it("stops resumably (no record) after too many limit retries", async () => {
    const limit: CellOutcome = { kind: "limit", limit: { resetAt: null, message: "429" } };
    const { d, appended } = driver({ "t1|A|1": [limit, limit, limit] }, { maxLimitRetries: 2 });
    const s = await runAblation(d);
    expect(s.stoppedOnLimit).not.toBeNull();
    expect(appended).toEqual([]);
  });

  it("waits for memory before a cell", async () => {
    const mem = [1024, 1024, 8 * 1024 * 1024];
    const { d, sleeps } = driver({}, { memAvailableKb: () => mem.shift() ?? 8 * 1024 * 1024, maxCells: 1 });
    await runAblation(d);
    expect(sleeps).toEqual([30_000, 30_000]);
  });

  it("maxCells bounds the number of newly recorded cells", async () => {
    const { d, appended } = driver({}, { maxCells: 2 });
    await runAblation(d);
    expect(appended).toEqual(["t1|A|1", "t1|C|1"]);
  });
});

describe("bench instance env", () => {
  const paths = benchInstancePaths("/work/bench");

  it("isolates HOME, TMPDIR, recordings, council stats, origin; reaper off; loopback", () => {
    const env = benchInstanceEnv({ PATH: "/bin", HOME: "/home/u", AURA_SILENT_STDIO_TIMEOUT_MS: "1", COMPANION_TELEMETRY: "1" }, paths);
    expect(env).toMatchObject({
      HOME: "/work/bench/aura-home",
      TMPDIR: "/work/bench/aura-home/tmp",
      PORT: String(BENCH_PORT),
      HOST: "127.0.0.1",
      COMPANION_RECORDINGS_DIR: "/work/bench/recordings",
      COMPANION_COUNCIL_STATS_DIR: "/work/bench/council-stats",
      COMPANION_ALLOWED_ORIGIN: `http://127.0.0.1:${BENCH_PORT}`,
      COMPANION_ORPHAN_REAPER: "off",
      PATH: "/bin",
    });
    // Prod's AURA_* tuning and COMPANION_* settings never leak into the bench.
    expect(env.AURA_SILENT_STDIO_TIMEOUT_MS).toBeUndefined();
    expect(env.COMPANION_TELEMETRY).toBeUndefined();
  });

  it("refuses the prod port", () => {
    expect(() => benchInstanceEnv({}, paths, PROD_PORT)).toThrow(/prod port/);
  });

  it("benchChildEnv strips nested-session markers and applies extras last", () => {
    const env = benchChildEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: "/x", CODEX_THREAD_ID: "t", AURA_X: "1", KEEP: "k" }, { CLAUDE_CONFIG_DIR: "/cell" });
    expect(env).toMatchObject({ KEEP: "k", CLAUDE_CONFIG_DIR: "/cell", CI: "1" });
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "AURA_X"]) expect(env[k]).toBeUndefined();
  });
});
