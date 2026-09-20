// Tests for the shared EC-7 fs primitives (PLAN Task 3) — the realpath/symlink/
// `..`-reject/sort-before-cap/size-cap guards that BOTH the fingerprinter and the
// catalog loader delegate to. Beck #5: these were "green by absence" (no test file
// at all) despite being the security-load-bearing choke point. Each test drives a
// real failure branch on a tmp workspace.

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveMarker,
  assertResolvedWithinRoot,
  readText,
  enumerateCandidatePrefixes,
  resolveRoot,
  MAX_CANDIDATE_SUBDIRS,
} from "./marker-fs.js";

const roots: string[] = [];
function newRoot(): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "markerfs-")));
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  roots.length = 0;
});

describe("resolveMarker — EC-7 escape guard", () => {
  it("a non-existent marker is ok (presence is the caller's concern)", () => {
    const r = newRoot();
    const res = resolveMarker(r, "package.json");
    expect(res.ok).toBe(true);
  });

  it("rejects an absolute path as out_of_bounds", () => {
    const r = newRoot();
    const res = resolveMarker(r, "/etc/passwd");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("out_of_bounds");
  });

  it("rejects a `..` path SEGMENT as out_of_bounds", () => {
    const r = newRoot();
    const res = resolveMarker(r, "../escape/package.json");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("out_of_bounds");
  });

  it("does NOT false-reject a legitimate `foo..bar` name (segment, not substring — ritchie B-9)", () => {
    const r = newRoot();
    mkdirSync(join(r, "foo..bar"));
    writeFileSync(join(r, "foo..bar", "package.json"), "{}");
    const res = resolveMarker(r, "foo..bar/package.json");
    expect(res.ok).toBe(true);
  });

  it("rejects a symlink leaf as symlink", () => {
    const r = newRoot();
    writeFileSync(join(r, "real.json"), "{}");
    symlinkSync(join(r, "real.json"), join(r, "link.json"));
    const res = resolveMarker(r, "link.json");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("symlink");
  });

  it("rejects a path that resolves OUTSIDE the root as out_of_bounds", () => {
    const r = newRoot();
    const outside = newRoot();
    writeFileSync(join(outside, "secret"), "x");
    // a symlinked DIR whose leaf resolves out of bounds
    symlinkSync(outside, join(r, "escape"), "dir");
    const res = assertResolvedWithinRoot(join(r, "escape", "secret"), r);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("out_of_bounds");
  });
});

describe("readText — size cap", () => {
  it("refuses a file over the cap before reading (size_exceeded)", () => {
    const r = newRoot();
    writeFileSync(join(r, "big.json"), "x".repeat(100));
    const res = readText(join(r, "big.json"), 10);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("size_exceeded");
  });
  it("reads a within-cap file and strips a BOM", () => {
    const r = newRoot();
    writeFileSync(join(r, "s.json"), "﻿{}");
    const res = readText(join(r, "s.json"), 1024);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe("{}");
  });
});

describe("enumerateCandidatePrefixes — sort-before-cap + symlink skip", () => {
  it("sorts lexicographically and truncates deterministically at the cap (ritchie B-4)", () => {
    const r = newRoot();
    // Create more than the cap of eligible subdirs with sortable names.
    const n = MAX_CANDIDATE_SUBDIRS + 10;
    for (let i = 0; i < n; i++) mkdirSync(join(r, `d${String(i).padStart(3, "0")}`));
    const res = enumerateCandidatePrefixes(r);
    expect(res.truncated).toBe(true);
    expect(res.prefixes).toHaveLength(MAX_CANDIDATE_SUBDIRS);
    // Deterministic: the FIRST cap-many names in code-point order.
    expect(res.prefixes[0]).toBe("d000");
    const sorted = [...res.prefixes].sort();
    expect(res.prefixes).toEqual(sorted);
  });
  it("excludes hidden dirs and RECORDS a symlinked subdir as a failure (ritchie #3)", () => {
    const r = newRoot();
    mkdirSync(join(r, "real"));
    mkdirSync(join(r, ".hidden"));
    const outside = newRoot();
    symlinkSync(outside, join(r, "linked"), "dir");
    const res = enumerateCandidatePrefixes(r);
    expect(res.prefixes).toContain("real");
    expect(res.prefixes).not.toContain(".hidden");
    expect(res.prefixes).not.toContain("linked");
    // The symlinked subdir is not silently dropped — it is surfaced.
    expect(res.failures.some((f) => f.name.includes("linked") && f.reason === "symlink")).toBe(true);
  });

  it("no FALSE truncation: exactly-cap eligible dirs + any number of ineligible ones → truncated false (ritchie #5)", () => {
    const r = newRoot();
    // Exactly the cap of eligible dirs — no eligible overflow exists.
    for (let i = 0; i < MAX_CANDIDATE_SUBDIRS; i++) mkdirSync(join(r, `d${String(i).padStart(3, "0")}`));
    // Ineligible entries (hidden + skip-listed) must NOT count toward the cap and
    // must NOT trip the "scan was capped" advisory — truncation now trips only on a
    // genuinely-skipped ELIGIBLE dir, not on loop re-entry at the cap boundary.
    mkdirSync(join(r, ".zz-hidden"));
    mkdirSync(join(r, "node_modules")); // SKIP_SUBDIRS member
    mkdirSync(join(r, "__pycache__")); // SKIP_SUBDIRS member
    const res = enumerateCandidatePrefixes(r);
    expect(res.prefixes).toHaveLength(MAX_CANDIDATE_SUBDIRS);
    expect(res.truncated).toBe(false);
  });

  it("DOES truncate when an eligible dir overflows the cap", () => {
    const r = newRoot();
    for (let i = 0; i < MAX_CANDIDATE_SUBDIRS + 3; i++) mkdirSync(join(r, `d${String(i).padStart(3, "0")}`));
    const res = enumerateCandidatePrefixes(r);
    expect(res.prefixes).toHaveLength(MAX_CANDIDATE_SUBDIRS);
    expect(res.truncated).toBe(true);
  });
});

describe("resolveRoot", () => {
  it("returns null for a non-existent root", () => {
    expect(resolveRoot(join(tmpdir(), "definitely-not-here-xyz-123"))).toBeNull();
  });
});
