import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CheckpointLineSnapshots,
  SNAPSHOT_MAX_CHECKPOINTS_PER_GROUP,
  SNAPSHOT_MAX_FILE_BYTES,
  changedLineRanges,
  splitLines,
} from "./observer-line-snapshots.js";

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
});
