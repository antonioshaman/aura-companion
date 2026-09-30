/**
 * Evidence resolver (P3/FIX-B3-1): a code claim is shown with the code AT THE
 * CHECKPOINT and the code NOW. Built on a throwaway git repo with pinned
 * commit dates so "at-or-before the review" is deterministic:
 *
 *   t1 main: v1 · t2 review happens · t3 main: v2 (the "fix") · feature
 *   branch: a file that never reached main before the review.
 *
 * The load-bearing property is that the checkpoint side NEVER shows a commit
 * made after the review — a later commit may already contain the fix, which
 * would make a true finding look false.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapWorkspace, resolveEvidence, resolveSnippet, sliceLines } from "./evidence-source.js";

let repo: string;
const T1 = "2026-01-01T10:00:00Z";
const REVIEW = "2026-01-01T12:00:00Z";
const T3 = "2026-01-01T14:00:00Z";

function git(args: string[], date?: string): void {
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    stdio: "ignore",
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "evidence-src-"));
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.ts"), "line1\nconst v = 1;\nline3\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "v1"], T1);
  // Feature branch: file exists only there before the review.
  git(["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(repo, "feat.ts"), "feature code\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "feat"], T1);
  git(["checkout", "-q", "main"]);
  // After the review: the fix lands on main.
  writeFileSync(join(repo, "a.ts"), "line1\nconst v = 2;\nline3\n");
  writeFileSync(join(repo, "late.ts"), "created after review\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "v2"], T3);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("resolveEvidence", () => {
  it("shows the code at the review commit AND the current code, which differ", () => {
    const ev = resolveEvidence(repo, "a.ts", [2, 2], REVIEW, 0);
    expect(ev.atCheckpoint?.snippet).toBe("▶    2  const v = 1;");
    expect(ev.atCheckpoint?.note).toContain("at-or-before the review");
    expect(ev.current?.snippet).toBe("▶    2  const v = 2;");
  });

  it("falls back to a feature branch that had the file before the review", () => {
    const ev = resolveEvidence(repo, "feat.ts", [1, 1], REVIEW, 0);
    expect(ev.atCheckpoint?.snippet).toBe("▶    1  feature code");
    expect(ev.atCheckpoint?.note).toContain("any branch");
    // Not in the working tree (main checked out).
    expect(ev.current).toBeNull();
  });

  it("never uses a commit made after the review", () => {
    const ev = resolveEvidence(repo, "late.ts", [1, 1], REVIEW, 0);
    expect(ev.atCheckpoint).toBeNull();
    expect(ev.missing.join(" ")).toContain("uncommitted at review time");
    expect(ev.current?.snippet).toContain("created after review");
  });

  it("refuses paths escaping the workspace on both sides", () => {
    const ev = resolveEvidence(repo, "../etc/passwd", [1, 1], REVIEW, 0);
    expect(ev.atCheckpoint).toBeNull();
    expect(ev.current).toBeNull();
  });

  it("degrades to a reason when the recording had no cwd", () => {
    const ev = resolveEvidence("", "a.ts", [1, 1], REVIEW, 0);
    expect(ev).toEqual({ atCheckpoint: null, current: null, missing: ["workspace unknown (no cwd recorded)"] });
  });

  it("resolveSnippet (label-sheet) prefers the checkpoint copy, then warns on drift", () => {
    expect(resolveSnippet(repo, "a.ts", [2, 2], REVIEW, 0).snippet).toBe("▶    2  const v = 1;");
    expect(resolveSnippet(repo, "late.ts", [1, 1], REVIEW, 0).note).toContain("may have drifted");
  });
});

describe("sliceLines", () => {
  it("marks the evidence range and clamps context to the file", () => {
    expect(sliceLines(["a", "b", "c"], [2, 2], 5)).toBe("     1  a\n▶    2  b\n     3  c");
  });
});

describe("mapWorkspace", () => {
  const maps: [string, string][] = [["/root/aura-companion", "/work/repo"]];
  it("rewrites the prefix on whole path segments only", () => {
    expect(mapWorkspace("/root/aura-companion", maps)).toBe("/work/repo");
    expect(mapWorkspace("/root/aura-companion/web", maps)).toBe("/work/repo/web");
    expect(mapWorkspace("/root/aura-companion-old", maps)).toBe("/root/aura-companion-old");
  });
});
