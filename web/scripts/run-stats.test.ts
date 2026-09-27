// Tests for the Council PRO Economy persistent run-stats store (spec Story 1).
// Validates the record round-trip (build → write → read), fail-loud validation
// of every field class, schema-version invalidation, path-traversal defence on a
// caller-supplied runId, and the reader's malformed-file tolerance. Writes go to
// an isolated temp dir so the developer's real ~/.companion is never touched.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRunStats,
  recordRunStats,
  readRunStats,
  parseRunStats,
  resolveStatsDir,
  RUN_STATS_SCHEMA_VERSION,
  type RunStatsInput,
  type SeatStat,
} from "./run-stats.js";

function seat(overrides: Partial<SeatStat> = {}): SeatStat {
  return {
    seatId: "hunt",
    guaranteed: true,
    tier: "top",
    model: "claude-opus-4-8",
    findings: [{ id: "fnd_1", priority: "P1", survived: true }],
    ...overrides,
  };
}

function input(overrides: Partial<RunStatsInput> = {}): RunStatsInput {
  return {
    skill: "council-review-aura",
    engineVersion: "rc2",
    complexity: { diffFiles: 2, diffLines: 40, surfaceCount: 1, domainBreadth: 1 },
    seats: [seat()],
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "council-stats-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildRunStats", () => {
  it("fills schemaVersion, a uuid runId, a server ts, and the provisional band", () => {
    const rec = buildRunStats(input());
    expect(rec.schemaVersion).toBe(RUN_STATS_SCHEMA_VERSION);
    expect(rec.runId).toMatch(/[0-9a-f-]{36}/);
    expect(typeof rec.ts).toBe("number");
    expect(rec.complexity.bandSource).toBe("provisional-heuristic");
    expect(rec.seats[0].guaranteed).toBe(true);
  });

  it("honours caller-supplied runId and ts (idempotency / determinism)", () => {
    const rec = buildRunStats(input({ runId: "run-123", ts: 42 }));
    expect(rec.runId).toBe("run-123");
    expect(rec.ts).toBe(42);
  });

  // Fail-loud validation — each invalid class throws rather than reaching disk.
  it("rejects an empty seats array", () => {
    expect(() => buildRunStats(input({ seats: [] }))).toThrow();
  });

  it("rejects an unknown tier", () => {
    expect(() => buildRunStats(input({ seats: [seat({ tier: "medium" as unknown as SeatStat["tier"] })] }))).toThrow();
  });

  it("rejects an unknown finding priority", () => {
    expect(() =>
      buildRunStats(input({ seats: [seat({ findings: [{ id: "x", priority: "P0" as unknown as "P1", survived: true }] })] })),
    ).toThrow();
  });

  it("rejects a non-boolean survived flag", () => {
    expect(() =>
      buildRunStats(input({ seats: [seat({ findings: [{ id: "x", priority: "P1", survived: "yes" as unknown as boolean }] })] })),
    ).toThrow();
  });

  it("rejects an invalid complexity vector (delegates to complexity validator)", () => {
    expect(() => buildRunStats(input({ complexity: { diffFiles: -1, diffLines: 0, surfaceCount: 0, domainBreadth: 0 } }))).toThrow();
  });

  // Bounds enforcement — an unbounded blob must be rejected before it reaches disk
  // (spec §Boundaries; each cap in run-stats.ts). These throw-path cases are the
  // ones most likely to regress silently since nothing else exercises them.
  it("rejects an over-long skill string (MAX_STR)", () => {
    expect(() => buildRunStats(input({ skill: "x".repeat(513) }))).toThrow();
  });

  it("rejects an over-long model string (MAX_STR)", () => {
    expect(() => buildRunStats(input({ seats: [seat({ model: "m".repeat(513) })] }))).toThrow();
  });

  it("rejects too many seats (MAX_SEATS)", () => {
    const many = Array.from({ length: 65 }, (_, i) => seat({ seatId: `s${i}`, guaranteed: false, tier: "top", findings: [] }));
    expect(() => buildRunStats(input({ seats: many }))).toThrow();
  });

  it("rejects too many findings per seat (MAX_FINDINGS_PER_SEAT)", () => {
    const findings = Array.from({ length: 513 }, (_, i) => ({ id: `f${i}`, priority: "P3" as const, survived: false }));
    expect(() => buildRunStats(input({ seats: [seat({ findings })] }))).toThrow();
  });

  it("rejects a non-boolean guaranteed flag", () => {
    expect(() => buildRunStats(input({ seats: [seat({ guaranteed: "yes" as unknown as boolean })] }))).toThrow();
  });
});

describe("recordRunStats → readRunStats round-trip", () => {
  it("writes one file per run and reads it back intact", () => {
    const a = recordRunStats(input({ runId: "run-a", ts: 1 }), { dir });
    const b = recordRunStats(input({ runId: "run-b", ts: 2 }), { dir });
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(2);
    const { runs, malformed, skippedSchema } = readRunStats({ dir });
    expect(malformed).toBe(0);
    expect(skippedSchema).toBe(0);
    const ids = runs.map((r) => r.runId).sort();
    expect(ids).toEqual(["run-a", "run-b"]);
    expect(runs.find((r) => r.runId === "run-a")).toMatchObject({ skill: a.skill, seats: a.seats });
    void b;
  });

  it("persists across 'sessions' — a fresh read of the same dir sees prior runs", () => {
    recordRunStats(input({ runId: "prior" }), { dir });
    // simulate a new session: a brand-new read call against the same dir
    expect(readRunStats({ dir }).runs.map((r) => r.runId)).toContain("prior");
  });

  it("rejects an over-cap record at write time (MAX_RECORD_BYTES)", () => {
    // 64 seats × 512 findings comfortably exceeds the 256KB record cap; the write
    // must throw rather than persist a runaway blob.
    const findings = Array.from({ length: 512 }, (_, i) => ({ id: `finding-number-${i}`, priority: "P3" as const, survived: false }));
    const seats = Array.from({ length: 64 }, (_, i) => seat({ seatId: `seat${i}`, guaranteed: false, tier: "top", findings }));
    expect(() => recordRunStats(input({ seats }), { dir })).toThrow(/exceeds/);
  });

  it("writes the file with mode 0o600 (not group/other readable)", () => {
    recordRunStats(input({ runId: "perm" }), { dir });
    const name = readdirSync(dir).find((n) => n.endsWith(".json"))!;
    const mode = statSync(join(dir, name)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("reader invalidation + tolerance", () => {
  it("invalidates records with a mismatched schemaVersion", () => {
    const rec = buildRunStats(input({ runId: "stale" }));
    writeFileSync(join(dir, "stale.json"), JSON.stringify({ ...rec, schemaVersion: 999 }));
    const res = readRunStats({ dir });
    expect(res.runs).toHaveLength(0);
    expect(res.skippedSchema).toBe(1);
    // ...but includeStaleSchema surfaces it for migration tooling
    expect(readRunStats({ dir, includeStaleSchema: true }).runs).toHaveLength(1);
  });

  it("counts malformed files without throwing (a corrupt file never breaks a read)", () => {
    writeFileSync(join(dir, "garbage.json"), "{ not valid json");
    writeFileSync(join(dir, "wrong-shape.json"), JSON.stringify({ hello: "world" }));
    recordRunStats(input({ runId: "good" }), { dir });
    const res = readRunStats({ dir });
    expect(res.runs.map((r) => r.runId)).toEqual(["good"]);
    expect(res.malformed).toBe(2);
  });

  it("returns empty for a non-existent dir", () => {
    expect(readRunStats({ dir: join(dir, "does-not-exist") })).toEqual({ runs: [], malformed: 0, skippedSchema: 0 });
  });
});

describe("parseRunStats", () => {
  it("reports malformed json", () => {
    expect(parseRunStats("nope")).toEqual({ ok: false, reason: "malformed" });
  });

  // A genuinely different schema (renamed/removed field) is the real reason to
  // bump the version; it must be classified stale-schema, NOT malformed disk
  // corruption — the version check runs before the current-shape validators.
  it("reports a mismatched schemaVersion as stale-schema (not malformed)", () => {
    const rec = buildRunStats(input({ runId: "stale" }));
    expect(parseRunStats(JSON.stringify({ ...rec, schemaVersion: 7 }))).toEqual({ ok: false, reason: "stale-schema" });
  });

  it("with includeStaleSchema, validates a differently-versioned record and preserves its schemaVersion", () => {
    const rec = buildRunStats(input({ runId: "keep" }));
    const parsed = parseRunStats(JSON.stringify({ ...rec, schemaVersion: 7 }), { includeStaleSchema: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.record.schemaVersion).toBe(7);
  });

  // P1 regression: the reader must PRESERVE the on-disk band/bandSource, never
  // recompute them from today's seed weights — otherwise retuning complexity.ts
  // silently reinterprets history and a data-derived band gets relabelled.
  it("preserves on-disk complexity band/bandSource instead of recomputing them", () => {
    const rec = buildRunStats(input({ runId: "band" }));
    // A band the provisional heuristic would NOT produce for this tiny vector,
    // plus a data-derived source — proves the reader trusts the disk.
    const onDisk = { ...rec, complexity: { ...rec.complexity, band: "high", bandSource: "data-derived" } };
    const parsed = parseRunStats(JSON.stringify(onDisk));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.record.complexity.band).toBe("high");
      expect(parsed.record.complexity.bandSource).toBe("data-derived");
    }
  });

  it("rejects an on-disk record with an invalid band as malformed", () => {
    const rec = buildRunStats(input({ runId: "badband" }));
    const onDisk = { ...rec, complexity: { ...rec.complexity, band: "extreme" } };
    expect(parseRunStats(JSON.stringify(onDisk))).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("path-traversal defence", () => {
  it("sanitizes a caller-supplied runId so it cannot escape the stats dir", () => {
    recordRunStats(input({ runId: "../../etc/evil", ts: 5 }), { dir });
    // Every written file stays directly inside `dir`; no traversal segment leaks.
    const names = readdirSync(dir);
    expect(names.every((n) => !n.includes("/") && !n.includes(".."))).toBe(true);
    // The record is still readable and retains its ORIGINAL (unsanitized) runId
    // in the payload — only the filename is sanitized.
    const stored = readFileSync(join(dir, names.find((n) => n.endsWith(".json"))!), "utf8");
    expect(JSON.parse(stored).runId).toBe("../../etc/evil");
  });
});

describe("resolveStatsDir", () => {
  it("prefers an explicit override over the env and default", () => {
    expect(resolveStatsDir("/tmp/x")).toBe("/tmp/x");
  });

  it("falls back to COMPANION_COUNCIL_STATS_DIR when set", () => {
    const prev = process.env.COMPANION_COUNCIL_STATS_DIR;
    process.env.COMPANION_COUNCIL_STATS_DIR = "/tmp/env-stats";
    try {
      expect(resolveStatsDir()).toBe("/tmp/env-stats");
    } finally {
      if (prev === undefined) delete process.env.COMPANION_COUNCIL_STATS_DIR;
      else process.env.COMPANION_COUNCIL_STATS_DIR = prev;
    }
  });

  // Adversarial: with BOTH the override arg and the env var set, the override must
  // win (proves the `??` ordering, not just each source in isolation).
  it("override beats a simultaneously-set env var", () => {
    const prev = process.env.COMPANION_COUNCIL_STATS_DIR;
    process.env.COMPANION_COUNCIL_STATS_DIR = "/tmp/env-stats";
    try {
      expect(resolveStatsDir("/tmp/override-wins")).toBe("/tmp/override-wins");
    } finally {
      if (prev === undefined) delete process.env.COMPANION_COUNCIL_STATS_DIR;
      else process.env.COMPANION_COUNCIL_STATS_DIR = prev;
    }
  });
});
