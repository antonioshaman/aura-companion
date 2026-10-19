// Tests for the KB lifecycle engine (spec `aura-meta-diet.md`, Story A2, plus the
// FIX-A2-1 telemetry/content split).
//
// Every test builds a throwaway KB in a tmp dir — the real `.agents/knowledge`
// is never touched. The four Story A2 acceptance criteria each have a dedicated
// test below (report fields, /prime persistence, prune-to-archive after 20 idle
// sessions, corrupt-line handling); the rest pin the edge cases that make those
// criteria safe (raw-line preservation, no instant pruning of new entries,
// promoted entries exempt, unknown ids). FIX-A2-1 adds: `record` never writes a
// store (stores stay content-only, so /prime cannot dirty a git checkout), and
// concurrent `record` processes lose no session.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeHealth,
  formatHealth,
  indexUsage,
  loadKb,
  pruneKb,
  readUsageLog,
  recordPrime,
  runCli,
  USAGE_LOG_FILE,
} from "./kb-health.js";

let dir: string;

// Entries are "created" well before any test session so every logged session
// counts toward idle age unless a test overrides `createdAt`.
function entry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "gotcha",
    fact: `fact ${id}`,
    recommendation: "r",
    confidence: "high",
    provenance: [],
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    usageCount: 0,
    helpfulCount: 0,
    outdatedReports: 0,
    ...extra,
  };
}

function writeStore(file: string, rows: (object | string)[]) {
  writeFileSync(
    join(dir, file),
    rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n",
  );
}

function readStore(file: string, base = dir): Record<string, unknown>[] {
  return readFileSync(join(base, file), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

// Seed `n` empty prime sessions directly in the log (one per day from
// 2026-02-01), i.e. what `n` /prime runs that surfaced nothing would leave.
function seedEmptySessions(n: number) {
  const lines: string[] = [];
  for (let k = 0; k < n; k++) {
    const at = new Date(Date.UTC(2026, 1, 1 + k)).toISOString();
    lines.push(JSON.stringify({ session: `s${k + 1}`, at, ids: [] }));
  }
  writeFileSync(join(dir, USAGE_LOG_FILE), lines.map((l) => `${l}\n`).join(""));
}

function health() {
  return computeHealth(loadKb(dir), readUsageLog(dir));
}

function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli([...argv, "--kb-dir", dir], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-health-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("report (AC: total, used≥1, helpful≥1, promoted, stale, never-surfaced, confidence)", () => {
  it("counts every lifecycle bucket across all stores", () => {
    writeStore("gotchas.jsonl", [
      entry("got-1", { usageCount: 3, helpfulCount: 1 }),
      entry("got-2", { confidence: "medium" }),
      // stale via /evolve rule 1: ≥2 outdated reports, not out-weighed by confirmations
      entry("got-3", { outdatedReports: 2, helpfulCount: 1, usageCount: 1 }),
    ]);
    writeStore("patterns.jsonl", [
      entry("pat-1", { promoted: true, confidence: "low" }),
      // stale via /evolve rule 2: surfaced ≥10 times, never confirmed helpful
      entry("pat-2", { usageCount: 10 }),
    ]);
    const h = health();
    expect(h).toMatchObject({
      total: 5,
      used: 3,
      helpful: 2,
      promoted: 1,
      stale: 2,
      neverSurfaced: 2,
      confidence: { high: 3, medium: 1, low: 1 },
      errors: [],
    });
    expect(h.usedRatio).toBeCloseTo(0.6);
    const text = formatHealth(h);
    for (const label of ["total", "used>=1", "helpful>=1", "promoted", "stale", "never-surfaced", "confidence"]) {
      expect(text).toContain(label);
    }
  });

  it("usage = frozen store baseline + logged surfacings (both feed used and stale)", () => {
    // got-1 has a pre-log baseline of 9; one logged surfacing makes 10 → stale
    // by /evolve rule 2. got-2 is only ever surfaced via the log → used.
    writeStore("gotchas.jsonl", [entry("got-1", { usageCount: 9 }), entry("got-2"), entry("got-3")]);
    recordPrime(dir, ["got-1", "got-2"]);
    expect(health()).toMatchObject({ total: 3, used: 2, neverSurfaced: 1, stale: 1, primeSessions: 1 });
  });

  it("missing counters count as zero (older rows predate the counter fields)", () => {
    writeStore("gotchas.jsonl", [{ id: "old-1", type: "gotcha", confidence: "high" }]);
    expect(health()).toMatchObject({ total: 1, used: 0, neverSurfaced: 1, stale: 0 });
  });

  it("CLI report exits 0 on a clean KB and supports --json", () => {
    writeStore("gotchas.jsonl", [entry("got-1")]);
    const r = cli(["report", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).total).toBe(1);
  });
});

describe("corrupt JSONL (AC: reported with line number, rest processed, non-zero exit)", () => {
  it("reports the bad line by file:line and still counts the valid entries", () => {
    writeStore("gotchas.jsonl", [entry("got-1"), "{not json", entry("got-2"), '["array"]']);
    const load = loadKb(dir);
    expect(load.errors.map((e) => `${e.file}:${e.line}`)).toEqual(["gotchas.jsonl:2", "gotchas.jsonl:4"]);
    expect(computeHealth(load, readUsageLog(dir)).total).toBe(2);

    const r = cli(["report"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("gotchas.jsonl:2");
    expect(r.out).toContain("total           2");
  });

  it("a lifecycle rewrite preserves the corrupt line verbatim instead of dropping it", () => {
    // prune rewrites the store; the broken row must survive so a human can fix
    // it — silently dropping it would be data loss disguised as housekeeping.
    writeStore("gotchas.jsonl", [entry("got-1"), "{not json"]);
    seedEmptySessions(20);
    expect(pruneKb(dir).archived.map((a) => a.id)).toEqual(["got-1"]);
    expect(readFileSync(join(dir, "gotchas.jsonl"), "utf8")).toBe("{not json\n");
  });
});

describe("record (AC: /prime surfacing bumps the counter and persists it)", () => {
  it("appends one log line per /prime and the counter survives a re-read from disk", () => {
    writeStore("gotchas.jsonl", [entry("got-1", { usageCount: 2 }), entry("got-2")]);
    const r = recordPrime(dir, ["got-1"], { now: new Date("2026-09-28T00:00:00Z"), session: "sess-a" });
    expect(r).toEqual({ session: "sess-a", surfaced: ["got-1"], unknown: [] });

    // Persistence is the whole point of the AC: a fresh read sees usage 2 + 1.
    const log = readUsageLog(dir);
    expect(log.records).toEqual([{ session: "sess-a", at: "2026-09-28T00:00:00.000Z", ids: ["got-1"] }]);
    expect(health()).toMatchObject({ used: 1, neverSurfaced: 1, primeSessions: 1 });
    expect(cli(["report", "--json"]).out).toContain('"used": 1');
  });

  it("never writes a store: /prime leaves the tracked jsonl byte-identical (FIX-A2-1)", () => {
    // Stores are git-tracked and live in the prod checkout; any counter write
    // there dirties the tree and races other /prime runs. Content-only means no
    // usageCount bump, no lastSurfaced*/trackedSince* stamp, no reformat.
    const spaced = '{"id": "got-9", "type": "gotcha", "usageCount": 0}';
    writeStore("gotchas.jsonl", [spaced, entry("got-1")]);
    const before = readFileSync(join(dir, "gotchas.jsonl"), "utf8");
    recordPrime(dir, ["got-1", "got-9"]);
    recordPrime(dir, []);
    expect(readFileSync(join(dir, "gotchas.jsonl"), "utf8")).toBe(before);
    expect(before).not.toMatch(/lastSurfaced|trackedSince/);
  });

  it("an empty surfacing still counts as a session (idle clock advances)", () => {
    writeStore("gotchas.jsonl", [entry("got-1")]);
    recordPrime(dir, []);
    recordPrime(dir, []);
    expect(readUsageLog(dir).records).toHaveLength(2);
    expect(health().primeSessions).toBe(2);
  });

  it("duplicate ids in one call count once (one /prime = at most one surfacing per entry)", () => {
    writeStore("gotchas.jsonl", [entry("got-1")]);
    recordPrime(dir, ["got-1", "got-1"]);
    expect(readUsageLog(dir).records[0].ids).toEqual(["got-1"]);
    expect(indexUsage(readUsageLog(dir)).counts.get("got-1")).toBe(1);
  });

  it("CLI record reports unknown ids with exit 1 but still records the known ones", () => {
    writeStore("gotchas.jsonl", [entry("got-1")]);
    const r = cli(["record", "got-1", "nope-1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("nope-1");
    // Unknown ids are not logged — the log only names real entries.
    expect(readUsageLog(dir).records[0].ids).toEqual(["got-1"]);
    expect(health().used).toBe(1);
  });

  it("concurrent /prime processes lose no session (O_APPEND, no read-modify-write)", async () => {
    // Two Council sessions priming in the same checkout is normal on the prod
    // box. Spawn real processes so the writes genuinely race; the A2 design
    // (rewrite store + usage-state) lost increments here.
    const N = 12;
    writeStore("gotchas.jsonl", Array.from({ length: N }, (_, k) => entry(`got-${k}`)));
    const script = join(import.meta.dirname, "kb-health.ts");
    const codes = await Promise.all(
      Array.from(
        { length: N },
        (_, k) =>
          new Promise<number | null>((res, rej) => {
            const p = spawn("bun", [script, "record", "--kb-dir", dir, `got-${k}`, "got-0"], { stdio: "ignore" });
            p.on("error", rej);
            p.on("exit", res);
          }),
      ),
    );
    expect(codes).toEqual(Array(N).fill(0));
    const log = readUsageLog(dir);
    expect(log.errors).toEqual([]); // no torn / interleaved line
    expect(log.records).toHaveLength(N);
    const h = health();
    expect(h.primeSessions).toBe(N);
    expect(h.used).toBe(N); // every got-k surfaced at least once
    // got-0 is named by every process: N surfacings, none lost.
    expect(log.records.filter((r) => r.ids.includes("got-0"))).toHaveLength(N);
  }, 30_000);
});

describe("prune (AC: 20 consecutive unsurfaced sessions → archived with reason, not deleted)", () => {
  it("archives an entry after 20 idle sessions and keeps the recently-surfaced one", () => {
    writeStore("gotchas.jsonl", [entry("got-idle"), entry("got-live")]);
    for (let s = 1; s <= 20; s++) {
      recordPrime(dir, s === 20 ? ["got-live"] : [], { now: new Date(Date.UTC(2026, 1, s)) });
    }
    // got-idle: 20 sessions without surfacing → at threshold.
    const r = pruneKb(dir, { now: new Date("2026-10-01T00:00:00Z") });
    expect(r.archived.map((a) => a.id)).toEqual(["got-idle"]);

    expect(readStore("gotchas.jsonl").map((e) => e.id)).toEqual(["got-live"]);
    const archived = readStore("archive/gotchas.jsonl");
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ id: "got-idle", archivedAt: "2026-10-01T00:00:00.000Z" });
    expect(archived[0].archiveReason).toMatch(/20 consecutive sessions/);
  });

  it("does not prune at 19 idle sessions (threshold is inclusive at 20)", () => {
    writeStore("gotchas.jsonl", [entry("got-1")]);
    seedEmptySessions(19);
    expect(pruneKb(dir).archived).toEqual([]);
  });

  it("idle age restarts at the last surfacing", () => {
    writeStore("gotchas.jsonl", [entry("got-1")]);
    for (let s = 1; s <= 25; s++) recordPrime(dir, s === 10 ? ["got-1"] : [], { now: new Date(Date.UTC(2026, 1, s)) });
    // Surfaced at session 10 → only 15 idle sessions since.
    expect(pruneKb(dir, { dryRun: true }).archived).toEqual([]);
    expect(pruneKb(dir, { dryRun: true, threshold: 15 }).archived.map((a) => a.id)).toEqual(["got-1"]);
  });

  it("never instantly prunes a new entry (e.g. just appended by /learn)", () => {
    // Sessions logged before the entry's createdAt do not count toward its idle
    // age — no stamp in the store needed.
    writeStore("gotchas.jsonl", [entry("got-new", { createdAt: "2026-09-01T00:00:00Z" })]);
    // 500 daily sessions from 2026-02-01 → only those dated on/after Sep 1 count.
    seedEmptySessions(500);
    const log = readUsageLog(dir);
    const after = log.records.filter((r) => Date.parse(r.at) >= Date.parse("2026-09-01T00:00:00Z")).length;
    expect(pruneKb(dir, { threshold: after + 1 }).archived).toEqual([]);
    expect(pruneKb(dir, { dryRun: true, threshold: after }).archived.map((a) => a.id)).toEqual(["got-new"]);
  });

  it("never prunes an entry with no createdAt and no surfacing (idle age unknown → 0)", () => {
    writeStore("gotchas.jsonl", [{ id: "old-1", type: "gotcha" }]);
    seedEmptySessions(100);
    expect(pruneKb(dir).archived).toEqual([]);
  });

  it("exempts promoted entries — they are history by design, not dead weight", () => {
    writeStore("gotchas.jsonl", [entry("got-p", { promoted: true })]);
    seedEmptySessions(100);
    expect(pruneKb(dir).archived).toEqual([]);
  });

  it("appends to an existing archive instead of overwriting it", () => {
    writeStore("gotchas.jsonl", [entry("got-a")]);
    seedEmptySessions(20);
    pruneKb(dir);
    writeStore("gotchas.jsonl", [entry("got-b")]);
    pruneKb(dir);
    expect(readStore("archive/gotchas.jsonl").map((e) => e.id)).toEqual(["got-a", "got-b"]);
  });

  it("--dry-run lists candidates without touching disk", () => {
    writeStore("gotchas.jsonl", [entry("got-a")]);
    seedEmptySessions(20);
    const r = cli(["prune", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("would archive 1");
    expect(existsSync(join(dir, "archive"))).toBe(false);
    expect(readStore("gotchas.jsonl")).toHaveLength(1);
  });
});

describe("CLI argument handling", () => {
  it("rejects unknown commands, options and bad thresholds with exit 2", () => {
    writeStore("gotchas.jsonl", [entry("got-1")]);
    expect(cli(["frobnicate"]).code).toBe(2);
    expect(cli(["report", "--bogus"]).code).toBe(2);
    expect(cli(["prune", "--threshold", "0"]).code).toBe(2);
    expect(cli(["record", "--session", ""]).code).toBe(2);
  });

  it("fails closed on a malformed usage-log line: reported, not counted, report exits 1", () => {
    // A line `record` could not have written (bad JSON, negative shape, bad
    // time) must not advance the idle clock — that could prune live entries.
    writeStore("gotchas.jsonl", [entry("got-1")]);
    writeFileSync(
      join(dir, USAGE_LOG_FILE),
      [
        JSON.stringify({ session: "a", at: "2026-02-01T00:00:00Z", ids: ["got-1"] }),
        "{torn",
        JSON.stringify({ session: "b", at: "not-a-date", ids: [] }),
        JSON.stringify({ session: "c", at: "2026-02-02T00:00:00Z", ids: [1] }),
      ].join("\n") + "\n",
    );
    const log = readUsageLog(dir);
    expect(log.records).toHaveLength(1);
    expect(log.errors.map((e) => `${e.file}:${e.line}`)).toEqual(["usage.log:2", "usage.log:3", "usage.log:4"]);
    const r = cli(["report"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("usage.log:2");
    expect(r.out).toContain("prime sessions recorded: 1");
  });
});
