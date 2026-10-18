/**
 * handoff-files — the filename contract + conservative pruning of
 * continue-in-new handoff briefs.
 *
 * What these tests pin (council plan 2026-10-17, AC3):
 *  - the pattern is EXACT: an operator's hand-written `.aura-handoff-2026-10-17.md`
 *    (date only) and every near-miss shape must fail, the builder's output must pass;
 *  - the pure selector applies the retention rules as a CONJUNCTION
 *    (outside newest-N AND older than 7 days by both name-timestamp and mtime);
 *  - the FS wrapper touches only regular files matching the pattern directly
 *    inside cwd — symlinks, nested dirs and operator notes survive — and never throws.
 * Mutants each named test kills (EC-42, verified by hand during review
 * 2026-10-17): loosening the regex, AND→OR, ordering by mtime instead of the
 * embedded timestamp, ageing by mtime alone, ageing by name alone, following
 * symlinks, dropping the per-file failure isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HANDOFF_PRUNE_POLICY,
  HANDOFF_FILE_PATTERN,
  buildHandoffFilename,
  parseHandoffTimestamp,
  pruneHandoffFiles,
  selectHandoffFilesToPrune,
} from "./handoff-files.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0); // 2026-10-17T12:00:00Z

/** Endpoint-format name for a moment `ageMs` before NOW. */
function nameAgo(ageMs: number): string {
  return buildHandoffFilename(new Date(NOW - ageMs));
}

describe("HANDOFF_FILE_PATTERN + buildHandoffFilename", () => {
  it("round-trips: the builder's output matches the pattern and parses back to the same second", () => {
    const d = new Date("2026-10-17T16:58:46.789Z");
    const name = buildHandoffFilename(d);
    expect(name).toBe(".aura-handoff-2026-10-17T16-58-46.md");
    expect(HANDOFF_FILE_PATTERN.test(name)).toBe(true);
    expect(parseHandoffTimestamp(name)).toBe(Date.UTC(2026, 9, 17, 16, 58, 46));
  });

  it("rejects every near-miss shape — above all the operator's date-only notes", () => {
    const rejected = [
      ".aura-handoff-2026-10-17.md", // operator's hand-written note (date only)
      ".aura-handoff-2026-10-17T.md",
      ".aura-handoff-2026-10-17T16-58.md",
      ".aura-handoff-2026-05-21T013747.md", // legacy fixture: no dashes in the time
      ".aura-handoff-2026-10-17T16-58-46.MD",
      ".aura-handoff-2026-10-17T16-58-46.md ",
      ".aura-handoff-2026-10-17T16-58-46.md~",
      ".aura-handoff-2026-10-17T16-58-46.md.tmp",
      "aura-handoff-2026-10-17T16-58-46.md", // no leading dot
      "x.aura-handoff-2026-10-17T16-58-46.md",
      ".aura-handoff-2026-10-17T16:58:46.md",
      "",
    ];
    for (const name of rejected) {
      expect(HANDOFF_FILE_PATTERN.test(name), name).toBe(false);
      expect(parseHandoffTimestamp(name), name).toBeNull();
    }
  });

  it("parse rejects a well-shaped but impossible date", () => {
    expect(parseHandoffTimestamp(".aura-handoff-2026-13-01T00-00-00.md")).toBeNull();
    expect(parseHandoffTimestamp(".aura-handoff-2026-02-31T00-00-00.md")).toBeNull();
    expect(parseHandoffTimestamp(".aura-handoff-2026-10-17T24-00-00.md")).toBeNull();
  });

  it("builder throws on an invalid date instead of producing a junk name", () => {
    expect(() => buildHandoffFilename(new Date(NaN))).toThrow(/invalid date/);
  });
});

describe("selectHandoffFilesToPrune (pure)", () => {
  const entry = (ageMs: number, mtimeAgeMs = ageMs) => ({ name: nameAgo(ageMs), mtimeMs: NOW - mtimeAgeMs });

  it("exactly keepNewest matching files → nothing, however old", () => {
    const entries = [entry(40 * DAY), entry(30 * DAY), entry(20 * DAY)];
    expect(selectHandoffFilesToPrune(entries, NOW).prune).toEqual([]);
  });

  it("4 files, the oldest 6d23h beyond the keep window → nothing (age rule not met)", () => {
    const entries = [entry(DAY), entry(2 * DAY), entry(3 * DAY), entry(7 * DAY - 60 * 60 * 1000)];
    expect(selectHandoffFilesToPrune(entries, NOW).prune).toEqual([]);
  });

  it("4 files, the oldest 7d+1s → exactly that one", () => {
    const old = entry(7 * DAY + 1000);
    const entries = [entry(DAY), old, entry(2 * DAY), entry(3 * DAY)];
    expect(selectHandoffFilesToPrune(entries, NOW).prune).toEqual([old]);
  });

  it("age is the MORE RECENT of name timestamp and mtime: a touched old brief is protected", () => {
    // 4 files by name age: 1d, 2d, 3d, 30d. The 30d one was touched today —
    // it is outside the newest-3 by name, but max(name, mtime) = today, so it
    // is younger than 7 days and stays. Kills the "age by name only" mutant.
    const touched = entry(30 * DAY, 0);
    const entries = [entry(DAY), entry(2 * DAY), entry(3 * DAY), touched];
    expect(selectHandoffFilesToPrune(entries, NOW).prune).toEqual([]);
    // Same set but the 30d file's mtime is also 30d → pruned.
    const stale = entry(30 * DAY);
    expect(selectHandoffFilesToPrune([entry(DAY), entry(2 * DAY), entry(3 * DAY), stale], NOW).prune).toEqual([stale]);
  });

  it("the keep window is ordered by the embedded timestamp, not mtime", () => {
    // Names 1d, 2d, 10d, 20d; the 20d file was touched today. By NAME the
    // newest 3 are 1d/2d/10d, so 20d is the only one outside the window — and
    // its fresh mtime protects it → nothing pruned. Ordering by mtime would put
    // 20d inside the window and push 10d (mtime 10d, > 7 days) out → the 10d
    // brief would be deleted. Kills the "sort by mtime" mutant (beck #1).
    const entries = [entry(DAY), entry(2 * DAY), entry(10 * DAY), entry(20 * DAY, 0)];
    expect(selectHandoffFilesToPrune(entries, NOW).prune).toEqual([]);
  });

  it("a brief whose NAME is recent is kept even if its mtime is old", () => {
    // Names 1d, 1.2d, 1.5d, 2d; the 2d file's mtime is 10 days old (restored
    // backup / clock stepped). max(name, mtime) = 2d < 7d → kept. Ageing by
    // mtime alone would delete it. Kills the "age by mtime only" mutant.
    const entries = [entry(DAY), entry(1.2 * DAY), entry(1.5 * DAY), entry(2 * DAY, 10 * DAY)];
    expect(selectHandoffFilesToPrune(entries, NOW).prune).toEqual([]);
  });

  it("a future-dated file is kept (it sorts newest and is not older than minAge)", () => {
    const future = entry(-DAY);
    const entries = [future, entry(10 * DAY), entry(11 * DAY), entry(12 * DAY), entry(13 * DAY)];
    const { prune } = selectHandoffFilesToPrune(entries, NOW);
    expect(prune).not.toContainEqual(future);
    // Newest 3 = future, 10d, 11d; the 12d and 13d files are beyond the keep
    // window AND older than 7 days → both pruned, oldest first.
    expect(prune).toEqual([entries[4], entries[3]]);
  });

  it("the just-written file (exclude) is never pruned even if it sorts old", () => {
    // Clock stepped back: the "new" file carries a 20-day-old name.
    const justWritten = entry(20 * DAY);
    const entries = [entry(DAY), entry(2 * DAY), entry(3 * DAY), justWritten];
    expect(selectHandoffFilesToPrune(entries, NOW, { exclude: justWritten.name }).prune).toEqual([]);
    // Without the exclusion the same file IS pruned — proves the branch is live.
    expect(selectHandoffFilesToPrune(entries, NOW).prune).toEqual([justWritten]);
  });

  it("unparseable names are never candidates and never count toward the keep window", () => {
    const entries = [
      { name: ".aura-handoff-2026-10-17.md", mtimeMs: NOW - 40 * DAY },
      { name: "notes.md", mtimeMs: NOW - 40 * DAY },
      entry(10 * DAY),
      entry(11 * DAY),
      entry(12 * DAY),
    ];
    expect(selectHandoffFilesToPrune(entries, NOW).prune).toEqual([]);
  });

  it("caps deletions per call and reports it, oldest first", () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry((10 + i) * DAY));
    const policy = { ...DEFAULT_HANDOFF_PRUNE_POLICY, maxDeletions: 5 };
    const { prune, capped } = selectHandoffFilesToPrune(entries, NOW, { policy });
    expect(capped).toBe(true);
    expect(prune).toHaveLength(5);
    // Oldest first: the 39d file leads.
    expect(prune[0]!.name).toBe(nameAgo(39 * DAY));
  });
});

describe("pruneHandoffFiles (filesystem)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "handoff-prune-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Create `name` in `dir` with both mtime and (if endpoint-shaped) name age = ageMs. */
  function touch(name: string, ageMs: number, body = "x") {
    const p = join(dir, name);
    writeFileSync(p, body);
    const t = (NOW - ageMs) / 1000;
    utimesSync(p, t, t);
    return p;
  }

  it("deletes only stale endpoint-format regular files; operator notes, symlinks and nested dirs survive", () => {
    const stale = nameAgo(30 * DAY);
    touch(stale, 30 * DAY);
    touch(nameAgo(DAY), DAY);
    touch(nameAgo(2 * DAY), 2 * DAY);
    touch(nameAgo(3 * DAY), 3 * DAY);
    // Operator's hand-written note: date-only name, very old — must survive.
    touch(".aura-handoff-2026-01-01.md", 200 * DAY);
    // Symlink whose NAME matches the pattern, pointing at a precious file — skipped, not followed.
    const precious = touch("precious.md", 200 * DAY, "do not delete");
    symlinkSync(precious, join(dir, nameAgo(60 * DAY)));
    // Nested directory with a stale endpoint file inside — never recursed into.
    mkdirSync(join(dir, "sub"));
    const nested = join(dir, "sub", nameAgo(50 * DAY));
    writeFileSync(nested, "nested");
    utimesSync(nested, (NOW - 50 * DAY) / 1000, (NOW - 50 * DAY) / 1000);

    const result = pruneHandoffFiles({ cwd: dir, sessionId: "s1", nowMs: NOW });

    expect(result.deleted).toEqual([stale]);
    expect(result.failed).toEqual([]);
    const left = readdirSync(dir).sort();
    expect(left).not.toContain(stale);
    expect(left).toContain(".aura-handoff-2026-01-01.md");
    expect(left).toContain("precious.md");
    expect(left).toContain(nameAgo(60 * DAY)); // the symlink itself is untouched
    expect(readdirSync(join(dir, "sub"))).toHaveLength(1);
  });

  it("`keep` (the file this request wrote) is never deleted", () => {
    const keep = nameAgo(20 * DAY); // clock-skew shape: new file, old name
    touch(keep, 20 * DAY);
    touch(nameAgo(DAY), DAY);
    touch(nameAgo(2 * DAY), 2 * DAY);
    touch(nameAgo(3 * DAY), 3 * DAY);
    const result = pruneHandoffFiles({ cwd: dir, sessionId: "s1", nowMs: NOW, keep });
    expect(result.deleted).toEqual([]);
    expect(readdirSync(dir)).toContain(keep);
  });

  it("logs one structured handoff.pruned line per deletion (basename + numeric age, no contents)", async () => {
    const { log } = await import("./logger.js");
    const info = vi.spyOn(log, "info");
    try {
      const stale = nameAgo(30 * DAY);
      touch(stale, 30 * DAY, "SECRET CONTENT");
      for (let i = 1; i <= 3; i++) touch(nameAgo(i * DAY), i * DAY);
      pruneHandoffFiles({ cwd: dir, sessionId: "s1", nowMs: NOW });
      const pruned = info.mock.calls.filter((c) => (c[2] as { event?: string })?.event === "handoff.pruned");
      expect(pruned).toHaveLength(1);
      expect(pruned[0]![2]).toMatchObject({ event: "handoff.pruned", sessionId: "s1", cwd: dir, file: stale });
      expect(typeof (pruned[0]![2] as { ageMs: unknown }).ageMs).toBe("number");
      expect(JSON.stringify(pruned[0])).not.toContain("SECRET CONTENT");
    } finally {
      info.mockRestore();
    }
  });

  // Per-file isolation: one unlink failing must not stop the rest, must land
  // in `failed`, and must be logged with its errno (beck P3 / ritchie B-3).
  // A read-only directory makes every unlink fail with EACCES; root ignores
  // directory permissions, so the test is skipped when running as root.
  it.skipIf(process.getuid?.() === 0)("a directory where unlink fails: every candidate is reported failed with an errno, nothing thrown", async () => {
    const { log } = await import("./logger.js");
    const warn = vi.spyOn(log, "warn");
    const a = nameAgo(30 * DAY);
    const b = nameAgo(40 * DAY);
    touch(a, 30 * DAY);
    touch(b, 40 * DAY);
    for (let i = 1; i <= 3; i++) touch(nameAgo(i * DAY), i * DAY);
    chmodSync(dir, 0o500);
    try {
      const result = pruneHandoffFiles({ cwd: dir, sessionId: "s1", nowMs: NOW });
      expect(result.deleted).toEqual([]);
      expect(result.failed.sort()).toEqual([a, b].sort());
      const failures = warn.mock.calls.filter((c) => (c[2] as { event?: string })?.event === "handoff.prune_failed");
      expect(failures).toHaveLength(2);
      expect(failures.every((c) => typeof (c[2] as { code?: unknown }).code === "string")).toBe(true);
      expect(readdirSync(dir)).toEqual(expect.arrayContaining([a, b]));
    } finally {
      chmodSync(dir, 0o700);
      warn.mockRestore();
    }
  });

  it("never throws: a missing cwd yields an empty result", () => {
    const result = pruneHandoffFiles({ cwd: join(dir, "does-not-exist"), sessionId: "s1", nowMs: NOW });
    expect(result).toEqual({ deleted: [], failed: [], capped: false });
  });
});
