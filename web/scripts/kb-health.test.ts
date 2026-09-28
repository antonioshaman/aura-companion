// Tests for the KB lifecycle engine (spec `aura-meta-diet.md`, Story A2).
//
// Every test builds a throwaway KB in a tmp dir — the real `.agents/knowledge`
// is never touched. The four Story A2 acceptance criteria each have a dedicated
// test below (report fields, /prime persistence, prune-to-archive after 20 idle
// sessions, corrupt-line handling); the rest pin the edge cases that make those
// criteria safe (raw-line preservation, no instant pruning of new entries,
// promoted entries exempt, unknown ids).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeHealth,
  formatHealth,
  loadKb,
  pruneKb,
  readUsageState,
  recordPrime,
  runCli,
  USAGE_STATE_FILE,
} from "./kb-health.js";

let dir: string;

function entry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "gotcha",
    fact: `fact ${id}`,
    recommendation: "r",
    confidence: "high",
    provenance: [],
    tags: [],
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
    const h = computeHealth(loadKb(dir), readUsageState(dir));
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

  it("missing counters count as zero (older rows predate the counter fields)", () => {
    writeStore("gotchas.jsonl", [{ id: "old-1", type: "gotcha", confidence: "high" }]);
    const h = computeHealth(loadKb(dir), readUsageState(dir));
    expect(h).toMatchObject({ total: 1, used: 0, neverSurfaced: 1, stale: 0 });
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
    expect(computeHealth(load, readUsageState(dir)).total).toBe(2);

    const r = cli(["report"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("gotchas.jsonl:2");
    expect(r.out).toContain("total           2");
  });

  it("a lifecycle rewrite preserves the corrupt line verbatim instead of dropping it", () => {
    // record rewrites the store; the broken row must survive so a human can fix
    // it — silently dropping it would be data loss disguised as a counter bump.
    writeStore("gotchas.jsonl", [entry("got-1"), "{not json"]);
    recordPrime(dir, ["got-1"]);
    const lines = readFileSync(join(dir, "gotchas.jsonl"), "utf8").split("\n");
    expect(lines[1]).toBe("{not json");
  });
});

describe("record (AC: /prime surfacing bumps the counter and persists it)", () => {
  it("increments usageCount, stamps the session and persists to disk", () => {
    writeStore("gotchas.jsonl", [entry("got-1", { usageCount: 2 }), entry("got-2")]);
    const r = recordPrime(dir, ["got-1"], new Date("2026-09-28T00:00:00Z"));
    expect(r).toEqual({ primeSessions: 1, surfaced: ["got-1"], unknown: [] });

    // Re-read from disk: persistence is the whole point of the AC.
    const [g1, g2] = readStore("gotchas.jsonl");
    expect(g1).toMatchObject({ usageCount: 3, lastSurfacedSession: 1, lastSurfacedAt: "2026-09-28T00:00:00.000Z" });
    // Content timestamp is NOT a usage signal — surfacing must not bump it.
    expect(g1.updatedAt).toBeUndefined();
    // Not surfaced: starts being tracked this session, counter untouched.
    expect(g2).toMatchObject({ usageCount: 0, trackedSinceSession: 1 });
    expect(JSON.parse(readFileSync(join(dir, USAGE_STATE_FILE), "utf8"))).toEqual({ primeSessions: 1 });
  });

  it("an empty surfacing still counts as a session (idle clock advances)", () => {
    writeStore("gotchas.jsonl", [entry("got-1")]);
    recordPrime(dir, []);
    recordPrime(dir, []);
    expect(readUsageState(dir).primeSessions).toBe(2);
    expect(readStore("gotchas.jsonl")[0].trackedSinceSession).toBe(1);
  });

  it("leaves untouched rows byte-identical (no whole-file reformat)", () => {
    const spaced = '{"id": "got-9", "type": "gotcha", "usageCount": 0, "lastSurfacedSession": 0}';
    writeStore("gotchas.jsonl", [spaced, entry("got-1")]);
    recordPrime(dir, ["got-1"]);
    expect(readFileSync(join(dir, "gotchas.jsonl"), "utf8").split("\n")[0]).toBe(spaced);
  });

  it("CLI record reports unknown ids with exit 1 but still records the known ones", () => {
    writeStore("gotchas.jsonl", [entry("got-1")]);
    const r = cli(["record", "got-1", "nope-1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("nope-1");
    expect(readStore("gotchas.jsonl")[0].usageCount).toBe(1);
  });
});

describe("prune (AC: 20 consecutive unsurfaced sessions → archived with reason, not deleted)", () => {
  it("archives an entry after 20 idle sessions and keeps the recently-surfaced one", () => {
    writeStore("gotchas.jsonl", [entry("got-idle"), entry("got-live")]);
    recordPrime(dir, []); // session 1 stamps trackedSinceSession=1 on both
    for (let s = 2; s <= 21; s++) recordPrime(dir, s === 21 ? ["got-live"] : []);
    // got-idle: 21 - 1 = 20 sessions without surfacing → at threshold.
    const r = pruneKb(dir, { now: new Date("2026-10-01T00:00:00Z") });
    expect(r.archived.map((a) => a.id)).toEqual(["got-idle"]);

    expect(readStore("gotchas.jsonl").map((e) => e.id)).toEqual(["got-live"]);
    const archived = readStore("archive/gotchas.jsonl");
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ id: "got-idle", archivedAt: "2026-10-01T00:00:00.000Z" });
    expect(archived[0].archiveReason).toMatch(/20 consecutive sessions/);
  });

  it("does not prune at 19 idle sessions (threshold is inclusive at 20)", () => {
    writeStore("gotchas.jsonl", [entry("got-1", { trackedSinceSession: 0 })]);
    writeFileSync(join(dir, USAGE_STATE_FILE), JSON.stringify({ primeSessions: 19 }));
    expect(pruneKb(dir).archived).toEqual([]);
  });

  it("never prunes an untracked entry (e.g. just appended by /learn)", () => {
    // No lastSurfacedSession / trackedSinceSession → idle age 0, however old the clock.
    writeStore("gotchas.jsonl", [entry("got-new")]);
    writeFileSync(join(dir, USAGE_STATE_FILE), JSON.stringify({ primeSessions: 500 }));
    expect(pruneKb(dir).archived).toEqual([]);
  });

  it("exempts promoted entries — they are history by design, not dead weight", () => {
    writeStore("gotchas.jsonl", [entry("got-p", { promoted: true, trackedSinceSession: 0 })]);
    writeFileSync(join(dir, USAGE_STATE_FILE), JSON.stringify({ primeSessions: 100 }));
    expect(pruneKb(dir).archived).toEqual([]);
  });

  it("appends to an existing archive instead of overwriting it", () => {
    writeStore("gotchas.jsonl", [entry("got-a", { trackedSinceSession: 0 })]);
    writeFileSync(join(dir, USAGE_STATE_FILE), JSON.stringify({ primeSessions: 20 }));
    pruneKb(dir);
    writeStore("gotchas.jsonl", [entry("got-b", { trackedSinceSession: 0 })]);
    pruneKb(dir);
    expect(readStore("archive/gotchas.jsonl").map((e) => e.id)).toEqual(["got-a", "got-b"]);
  });

  it("--dry-run lists candidates without touching disk", () => {
    writeStore("gotchas.jsonl", [entry("got-a", { trackedSinceSession: 0 })]);
    writeFileSync(join(dir, USAGE_STATE_FILE), JSON.stringify({ primeSessions: 20 }));
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
  });

  it("fails closed on a malformed usage-state file", () => {
    writeStore("gotchas.jsonl", [entry("got-1")]);
    writeFileSync(join(dir, USAGE_STATE_FILE), JSON.stringify({ primeSessions: -1 }));
    expect(() => readUsageState(dir)).toThrow(/non-negative integer/);
  });
});
