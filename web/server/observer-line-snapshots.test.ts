import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CheckpointLineSnapshots,
  SNAPSHOT_MAX_BYTES_PER_CHECKPOINT,
  SNAPSHOT_MAX_CHECKPOINTS_PER_GROUP,
  SNAPSHOT_MAX_FILE_BYTES,
  changedLineRanges,
  splitLines,
} from "./observer-line-snapshots.js";

// FIX-B2-1: record every path the module under test opens or reads whole, so
// the size-before-read tests can prove an oversized artifact is never read.
// Pass-through to the real fs — every other test is unaffected.
const fsReads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      fsReads.paths.push(String(path));
      return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.readFileSync,
    openSync: ((path: unknown, ...rest: unknown[]) => {
      fsReads.paths.push(String(path));
      return (real.openSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.openSync,
  };
});

// B2 (meta-diet): host-side source of line facts for grounding. These tests
// pin the honesty rules — unknown baselines are `null`, never "unchanged";
// a checkpoint's snapshot is frozen against later edits; out-of-workspace or
// unreadable content yields no facts.

describe("splitLines", () => {
  it("does not count a trailing newline as a line and strips CR", () => {
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("changedLineRanges", () => {
  it("reports modified and added lines of the new content, merged into ranges", () => {
    expect(changedLineRanges(["a", "b", "c", "d"], ["a", "B", "c", "d", "e", "f"])).toEqual([[2, 2], [5, 6]]);
  });

  it("reports nothing for identical content and nothing for pure deletions", () => {
    expect(changedLineRanges(["a", "b"], ["a", "b"])).toEqual([]);
    expect(changedLineRanges(["a", "b", "c"], ["a", "c"])).toEqual([]);
  });
});

describe("CheckpointLineSnapshots", () => {
  let root: string;
  const write = (rel: string, content: string) => writeFileSync(join(root, rel), content);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "line-snap-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("has unknown changed ranges on the first capture and real ranges on the next", () => {
    const snaps = new CheckpointLineSnapshots();
    write("a.ts", "one\ntwo\nthree\n");
    snaps.capture("g", "c1", root, ["a.ts"]);
    expect(snaps.providerFor("g", "c1", root)("a.ts")?.changedRanges).toBeNull();

    write("a.ts", "one\nTWO\nthree\n");
    snaps.capture("g", "c2", root, ["a.ts"]);
    const f = snaps.providerFor("g", "c2", root)("a.ts");
    expect(f?.changedRanges).toEqual([[2, 2]]);
    expect(f?.lineCount).toBe(3);
    expect(f?.lineText(2)).toBe("TWO");
  });

  // The review answers the checkpoint, not whatever the orchestrator wrote next.
  it("freezes a checkpoint's lines against later edits", () => {
    const snaps = new CheckpointLineSnapshots();
    write("a.ts", "one\ntwo\n");
    snaps.capture("g", "c1", root, ["a.ts"]);
    write("a.ts", "rewritten\n");
    const f = snaps.providerFor("g", "c1", root)("a.ts");
    expect(f?.lineCount).toBe(2);
    expect(f?.lineText(2)).toBe("two");
  });

  // A failsafe re-scan of the same checkpoint must not collapse the diff
  // base to N-vs-N (which would make every line "unchanged").
  it("ignores a second capture of the same checkpoint id", () => {
    const snaps = new CheckpointLineSnapshots();
    write("a.ts", "one\n");
    snaps.capture("g", "c1", root, ["a.ts"]);
    write("a.ts", "one\ntwo\n");
    snaps.capture("g", "c2", root, ["a.ts"]);
    snaps.capture("g", "c2", root, ["a.ts"]);
    expect(snaps.providerFor("g", "c2", root)("a.ts")?.changedRanges).toEqual([[2, 2]]);
  });

  it("falls back to the live file with unknown changes for an uncaptured checkpoint", () => {
    const snaps = new CheckpointLineSnapshots();
    write("a.ts", "x\ny\n");
    const f = snaps.providerFor("g", "never-captured", root)("a.ts");
    expect(f?.lineCount).toBe(2);
    expect(f?.changedRanges).toBeNull();
  });

  it("yields no facts for missing, escaping, binary, or oversized files", () => {
    const snaps = new CheckpointLineSnapshots();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "line-snap-out-")));
    try {
      writeFileSync(join(outside, "secret"), "s\n");
      symlinkSync(join(outside, "secret"), join(root, "link"));
      writeFileSync(join(root, "bin"), Buffer.from([1, 0, 2]));
      writeFileSync(join(root, "big"), "x".repeat(SNAPSHOT_MAX_FILE_BYTES + 1));
      snaps.capture("g", "c1", root, ["missing.ts", "link", "bin", "big"]);
      const p = snaps.providerFor("g", "c1", root);
      for (const rel of ["missing.ts", "link", "bin", "big", "../etc/passwd"]) expect(p(rel)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("evicts the oldest checkpoint past the ring size and forgets a group", () => {
    const snaps = new CheckpointLineSnapshots();
    write("a.ts", "v0\n");
    for (let i = 0; i <= SNAPSHOT_MAX_CHECKPOINTS_PER_GROUP; i++) {
      write("a.ts", `v${i}\n`);
      snaps.capture("g", `c${i}`, root, ["a.ts"]);
    }
    write("a.ts", "live\nlive\n");
    // c0 was evicted → live fallback (2 lines, unknown changes).
    expect(snaps.providerFor("g", "c0", root)("a.ts")?.lineCount).toBe(2);
    expect(snaps.providerFor("g", `c${SNAPSHOT_MAX_CHECKPOINTS_PER_GROUP}`, root)("a.ts")?.lineCount).toBe(1);
    snaps.forget("g");
    expect(snaps.providerFor("g", `c${SNAPSHOT_MAX_CHECKPOINTS_PER_GROUP}`, root)("a.ts")?.lineText(1)).toBe("live");
  });

  // FIX-B2-1 (supervisor review): capture runs synchronously on every
  // checkpoint for up to 200 paths. The size cap must be enforced from a stat
  // BEFORE the file is opened — previously the whole file was read into memory
  // and only then compared to the cap, so a huge artifact blocked the event
  // loop. A sparse 64 MB file is cheap on disk but would cost a 64 MB read.
  it("never opens or reads a file above the size cap (size is checked first)", () => {
    const big = join(root, "huge.log");
    writeFileSync(big, "");
    truncateSync(big, 64 * 1024 * 1024);
    write("small.ts", "ok\n");
    fsReads.paths.length = 0;
    const snaps = new CheckpointLineSnapshots();
    snaps.capture("g", "c1", root, ["huge.log", "small.ts"]);
    const p = snaps.providerFor("g", "c1", root);
    expect(p("huge.log")).toBeNull();
    // Live-read fallback path (uncaptured checkpoint) is bounded the same way.
    expect(snaps.providerFor("g", "other", root)("huge.log")).toBeNull();
    expect(p("small.ts")?.lineText(1)).toBe("ok");
    expect(fsReads.paths.filter((x) => x.endsWith("huge.log"))).toEqual([]);
    expect(fsReads.paths.some((x) => x.endsWith("small.ts"))).toBe(true);
  });

  // A file exactly at the cap is still within limits (boundary is inclusive).
  it("snapshots a file exactly at the size cap", () => {
    write("edge.txt", "y".repeat(SNAPSHOT_MAX_FILE_BYTES - 1) + "\n");
    const snaps = new CheckpointLineSnapshots();
    snaps.capture("g", "c1", root, ["edge.txt"]);
    expect(snaps.providerFor("g", "c1", root)("edge.txt")?.lineCount).toBe(1);
  });

  // Non-regular files are rejected from the stat alone: opening a FIFO with
  // no writer would block the event loop forever.
  it("rejects a FIFO without opening it", () => {
    execFileSync("mkfifo", [join(root, "pipe")]);
    fsReads.paths.length = 0;
    const snaps = new CheckpointLineSnapshots();
    snaps.capture("g", "c1", root, ["pipe"]);
    expect(snaps.providerFor("g", "c1", root)("pipe")).toBeNull();
    expect(fsReads.paths.filter((x) => x.endsWith("pipe"))).toEqual([]);
  });

  // The per-capture byte budget bounds the total synchronous read of one
  // checkpoint (200 paths × 512 KB would otherwise be ~100 MB). A path past
  // the budget is NOT recorded as unreadable (that would mark a STOP citing
  // it as weak evidence); it is left unsnapshotted → live-read facts with
  // unknown changed ranges, and its old baseline is dropped so the next
  // capture cannot fold two checkpoints' edits into one diff.
  it("stops snapshotting past the per-checkpoint byte budget without marking paths unreadable", () => {
    const chunk = "z".repeat(SNAPSHOT_MAX_FILE_BYTES - 1) + "\n";
    const n = Math.floor(SNAPSHOT_MAX_BYTES_PER_CHECKPOINT / SNAPSHOT_MAX_FILE_BYTES);
    const fill = Array.from({ length: n }, (_, i) => `fill${i}.txt`);
    for (const f of fill) write(f, chunk);
    write("late.ts", "v1\n");
    const snaps = new CheckpointLineSnapshots();
    // Baseline for late.ts from an earlier, small checkpoint.
    snaps.capture("g", "c0", root, ["late.ts"]);
    write("late.ts", "v2\n");
    fsReads.paths.length = 0;
    snaps.capture("g", "c1", root, [...fill, "late.ts"]);
    // Budget exhausted by the fill files → late.ts never opened in capture.
    expect(fsReads.paths.filter((x) => x.endsWith("late.ts"))).toEqual([]);
    const lateFacts = snaps.providerFor("g", "c1", root)("late.ts");
    expect(lateFacts?.lineText(1)).toBe("v2");
    expect(lateFacts?.changedRanges).toBeNull();
    expect(snaps.providerFor("g", "c1", root)("fill0.txt")?.lineCount).toBe(1);
    // Baseline was dropped: the next capture of late.ts has unknown changes.
    write("late.ts", "v3\n");
    snaps.capture("g", "c2", root, ["late.ts"]);
    expect(snaps.providerFor("g", "c2", root)("late.ts")?.changedRanges).toBeNull();
  });
});
