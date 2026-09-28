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
 *     off, loopback only, AURA_* stripped — and the prod port is refused;
 *   - FIX-D2-2: the bench copy of the skills is re-pointed from the prod API
 *     (`localhost:3456`, which the `/council-*` checkpoint emit hardcodes) to
 *     the bench instance, and the real `~/.claude/skills` is never touched.
 */

import { describe, it, expect } from "vitest";
import { runAblation, type DriverDeps } from "./driver.js";
import { CELL_RECORD_VERSION, type CellRecord } from "./cells.js";
import { emptyMetrics } from "./agent-metrics.js";
import type { CellOutcome } from "./run-cell.js";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BENCH_PORT,
  PROD_PORT,
  benchInstanceEnv,
  benchInstancePaths,
  prepareBenchHome,
  rewriteSkillProdUrls,
} from "./bench-instance.js";
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
    // Prod's AURA_* tuning never leaks into the bench.
    expect(env.AURA_SILENT_STDIO_TIMEOUT_MS).toBeUndefined();
  });

  // P6/FIX-D2-1: the settings default is telemetryEnabled=true, so pilot-1
  // bench/smoke instances heartbeated into the public install counter.
  // Telemetry is forced OFF (fail-closed) whatever the parent env says.
  it("forces telemetry off and points the stats URL at a dead end, even if the parent enables it", () => {
    for (const parent of [{}, { COMPANION_TELEMETRY: "1" }, { COMPANION_TELEMETRY: "true", COMPANION_STATS_URL: "https://stats.example" }]) {
      const env = benchInstanceEnv(parent, paths);
      expect(env.COMPANION_TELEMETRY).toBe("0");
      expect(env.COMPANION_STATS_URL).toBe("http://127.0.0.1:9");
    }
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

describe("bench skills point at the bench instance (FIX-D2-2)", () => {
  // Shapes taken from the live council-*-aura skills: scheme'd, bare and ws.
  const SKILL = [
    "1. Run `curl -fsS http://localhost:3456/api/sessions`.",
    'curl -fsS -X POST localhost:3456/api/council/x -d "$P"',
    "connect to `ws://127.0.0.1:3456/ws` and",
    "prod diagnostic: `ss -tlnp 'sport = :3456'`", // no host → not an API URL, left alone
    "http://localhost:34567/other", // a different port is not the prod port
  ].join("\n");

  it("rewrites every prod host:port in text files, keeps the scheme, reports 0 remaining", () => {
    const dir = mkdtempSync(join(tmpdir(), "aurabench-skills-"));
    mkdirSync(join(dir, "council-implement-aura", "references"), { recursive: true });
    writeFileSync(join(dir, "council-implement-aura", "SKILL.md"), SKILL);
    writeFileSync(join(dir, "council-implement-aura", "references", "ops.md"), "see localhost:3456/api/sessions");
    writeFileSync(join(dir, "council-implement-aura", "logo.png"), "localhost:3456"); // not a text skill file
    const r = rewriteSkillProdUrls(dir, BENCH_PORT);
    expect(r).toEqual({ files: 2, replaced: 4, remaining: 0 });
    const out = readFileSync(join(dir, "council-implement-aura", "SKILL.md"), "utf8");
    expect(out).toContain(`curl -fsS http://127.0.0.1:${BENCH_PORT}/api/sessions`);
    expect(out).toContain(`POST 127.0.0.1:${BENCH_PORT}/api/council/x`);
    expect(out).toContain(`ws://127.0.0.1:${BENCH_PORT}/ws`);
    expect(out).toContain("sport = :3456");
    expect(out).toContain("http://localhost:34567/other");
    expect(readFileSync(join(dir, "council-implement-aura", "logo.png"), "utf8")).toBe("localhost:3456");
  });

  it("prepareBenchHome rewrites only the bench copy; the real skills stay byte-identical", () => {
    const real = mkdtempSync(join(tmpdir(), "aurabench-realhome-"));
    mkdirSync(join(real, ".claude", "skills", "council-plan-aura"), { recursive: true });
    writeFileSync(join(real, ".claude", ".credentials.json"), "{}");
    writeFileSync(join(real, ".claude", "skills", "council-plan-aura", "SKILL.md"), SKILL);
    const bench = benchInstancePaths(mkdtempSync(join(tmpdir(), "aurabench-root-")));
    const { skillUrlRewrites } = prepareBenchHome(bench, real, BENCH_PORT);
    expect(skillUrlRewrites).toMatchObject({ files: 1, replaced: 3, remaining: 0 });
    expect(readFileSync(join(real, ".claude", "skills", "council-plan-aura", "SKILL.md"), "utf8")).toBe(SKILL);
    expect(readFileSync(join(bench.home, ".claude", "skills", "council-plan-aura", "SKILL.md"), "utf8")).not.toMatch(/localhost:3456\b/);
  });
});
