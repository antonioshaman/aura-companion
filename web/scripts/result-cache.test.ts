// Tests for the Council PRO Economy skip-if-unchanged result cache (spec Story 2).
// Validates the hash (deterministic, order-independent, collision-resistant,
// deletion-sensitive), the put→get hit round-trip, and every invalidation path
// (schema/engine version, staleness with an injected clock, changed hash) so a
// cache hit can never silently serve stale or cross-version findings. Isolated
// temp dir — the developer's real ~/.companion is never touched.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hashFileSet,
  hashFilesOnDisk,
  putCachedResult,
  getCachedResult,
  resolveCacheDir,
  cacheFileName,
  RESULT_CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_MAX_AGE_MS,
  type CacheFinding,
  type PutCacheInput,
} from "./result-cache.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "council-cache-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const findings: CacheFinding[] = [{ id: "f1", priority: "P1", summary: "a real problem" }];
function put(overrides: Partial<PutCacheInput> = {}) {
  return putCachedResult(
    { skill: "council-review-aura", engineVersion: "rc2", seatId: "hunt", filesHash: "abc", findings, ...overrides },
    { dir },
  );
}

describe("hashFileSet", () => {
  it("is deterministic and order-independent", () => {
    const a = hashFileSet([{ path: "x.ts", content: "1" }, { path: "y.ts", content: "2" }]);
    const b = hashFileSet([{ path: "y.ts", content: "2" }, { path: "x.ts", content: "1" }]);
    expect(a).toBe(b);
  });

  it("changes when content changes", () => {
    const a = hashFileSet([{ path: "x.ts", content: "1" }]);
    const b = hashFileSet([{ path: "x.ts", content: "2" }]);
    expect(a).not.toBe(b);
  });

  it("is collision-resistant across the path/content boundary (length-delimited)", () => {
    // Without length delimiting, {"ab",""} and {"a","b"} could concatenate equal.
    const a = hashFileSet([{ path: "ab", content: "" }]);
    const b = hashFileSet([{ path: "a", content: "b" }]);
    expect(a).not.toBe(b);
  });
});

describe("hashFilesOnDisk", () => {
  it("changes the hash when a previously-present file is deleted (no false hit)", () => {
    writeFileSync(join(dir, "a.ts"), "content-a");
    writeFileSync(join(dir, "b.ts"), "content-b");
    const withBoth = hashFilesOnDisk(dir, ["a.ts", "b.ts"]);
    rmSync(join(dir, "b.ts"));
    const afterDelete = hashFilesOnDisk(dir, ["a.ts", "b.ts"]);
    expect(afterDelete).not.toBe(withBoth);
  });
});

describe("put → get round-trip", () => {
  it("returns a hit for a matching skill/seat/hash within bounds", () => {
    put();
    const lookup = getCachedResult("council-review-aura", "hunt", "abc", { dir, engineVersion: "rc2" });
    expect(lookup.hit).toBe(true);
    if (lookup.hit) expect(lookup.result.findings).toEqual(findings);
  });

  it("persists across 'sessions' — a fresh get against the same dir hits", () => {
    put();
    // second, independent lookup call = a new session reading the same cache dir
    expect(getCachedResult("council-review-aura", "hunt", "abc", { dir, engineVersion: "rc2" }).hit).toBe(true);
  });
});

describe("invalidation (typed misses)", () => {
  it("misses when no entry exists", () => {
    expect(getCachedResult("council-review-aura", "hunt", "nope", { dir, engineVersion: "rc2" })).toEqual({
      hit: false,
      reason: "miss",
    });
  });

  it("misses on a different file hash (unchanged-file trigger only)", () => {
    put({ filesHash: "hash-v1" });
    expect(getCachedResult("council-review-aura", "hunt", "hash-v2", { dir, engineVersion: "rc2" }).hit).toBe(false);
  });

  it("invalidates on an engine-version mismatch", () => {
    put({ engineVersion: "rc2" });
    const lookup = getCachedResult("council-review-aura", "hunt", "abc", { dir, engineVersion: "rc3" });
    expect(lookup).toEqual({ hit: false, reason: "version" });
  });

  it("invalidates a wrong-schema entry on read", () => {
    const rec = put();
    // Overwrite the file with a bumped schemaVersion.
    writeFileSync(join(dir, cacheFileName(rec.skill, rec.seatId, rec.filesHash)), JSON.stringify({ ...rec, schemaVersion: 999 }));
    expect(getCachedResult("council-review-aura", "hunt", "abc", { dir, engineVersion: "rc2" })).toEqual({
      hit: false,
      reason: "schema",
    });
  });

  it("invalidates an entry older than the staleness bound (injected clock)", () => {
    const rec = put({ ts: 1000 });
    // now is just past the max age relative to the entry ts → stale.
    const now = 1000 + DEFAULT_CACHE_MAX_AGE_MS + 1;
    expect(getCachedResult("council-review-aura", "hunt", "abc", { dir, engineVersion: "rc2", nowMs: now })).toEqual({
      hit: false,
      reason: "stale",
    });
    // ...but within the bound it still hits.
    const nowFresh = 1000 + DEFAULT_CACHE_MAX_AGE_MS - 1;
    expect(getCachedResult("council-review-aura", "hunt", "abc", { dir, engineVersion: "rc2", nowMs: nowFresh }).hit).toBe(true);
    void rec;
  });

  it("reports malformed json as a typed miss (never throws)", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, cacheFileName("council-review-aura", "hunt", "abc")), "{ not json");
    expect(getCachedResult("council-review-aura", "hunt", "abc", { dir, engineVersion: "rc2" })).toEqual({
      hit: false,
      reason: "malformed",
    });
  });
});

describe("put validation (fail-loud)", () => {
  it("rejects an unknown finding priority", () => {
    expect(() => put({ findings: [{ id: "x", priority: "P0" as unknown as "P1", summary: "s" }] })).toThrow();
  });

  it("rejects an empty skill", () => {
    expect(() => put({ skill: "" })).toThrow();
  });
});

describe("resolveCacheDir", () => {
  it("prefers an explicit override, then env", () => {
    expect(resolveCacheDir("/tmp/o")).toBe("/tmp/o");
    const prev = process.env.COMPANION_COUNCIL_CACHE_DIR;
    process.env.COMPANION_COUNCIL_CACHE_DIR = "/tmp/envcache";
    try {
      expect(resolveCacheDir()).toBe("/tmp/envcache");
      expect(resolveCacheDir("/tmp/o")).toBe("/tmp/o"); // override still wins
    } finally {
      if (prev === undefined) delete process.env.COMPANION_COUNCIL_CACHE_DIR;
      else process.env.COMPANION_COUNCIL_CACHE_DIR = prev;
    }
  });

  it("exposes the current schema version", () => {
    expect(RESULT_CACHE_SCHEMA_VERSION).toBe(1);
  });
});
