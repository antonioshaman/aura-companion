/**
 * Tests for per-cell checkout paths and the clean-Claude-project wrapper
 * (P6/FIX-D2-3). Real temp directories; no CLI or LLM.
 *
 * Validates:
 *   - the worktree root is rejected when relative, inside the bench root or
 *     the repo, or containing either (pilot 1's `<bench-root>/wt/cell` sat next
 *     to other cells' results and under `$WORK/repo`); a sibling root is fine;
 *   - every cell gets a distinct `c-<16 hex>` path (so Claude's per-project
 *     state, keyed on the cwd, cannot carry over between cells);
 *   - the stale-checkout sweep removes only `c-<16 hex>` entries;
 *   - `claudeProjectKey` reproduces the key Claude used in pilot 1;
 *   - the wrapper fails the cell (without running the agent) when per-project
 *     state for the checkout already exists, and otherwise moves the state
 *     the run created into the cell's artifacts (also on a limit), leaving
 *     nothing behind in the shared projects dir.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuraBenchTask } from "../task.js";
import { emptyMetrics } from "./agent-metrics.js";
import {
  checkWorktreeRoot,
  claudeProjectKey,
  newCellWorktree,
  sweepStaleCellWorktrees,
  withCleanClaudeProject,
} from "./cell-paths.js";
import type { AgentContext, AgentRun } from "./run-cell.js";
import { VARIANTS } from "./variants.js";

describe("checkWorktreeRoot", () => {
  const forbidden = ["/w/bench", "/w/repo"];
  it("accepts a root outside the bench root and the repo", () => {
    expect(checkWorktreeRoot("/tmp/aurabench-wt", forbidden)).toBeNull();
    // A sibling whose name merely shares a prefix is not "inside".
    expect(checkWorktreeRoot("/w/bench-wt", forbidden)).toBeNull();
  });
  it("rejects a relative root", () => {
    expect(checkWorktreeRoot("wt", forbidden)).toMatch(/absolute/);
  });
  it("rejects the pilot-1 layout (inside the bench root) and a root inside the repo", () => {
    expect(checkWorktreeRoot("/w/bench/wt", forbidden)).toMatch(/overlaps \/w\/bench/);
    expect(checkWorktreeRoot("/w/repo/tmp", forbidden)).toMatch(/overlaps \/w\/repo/);
  });
  it("rejects a root that contains the bench root or the repo", () => {
    expect(checkWorktreeRoot("/w", forbidden)).toMatch(/overlaps/);
  });
});

describe("newCellWorktree", () => {
  it("gives every cell a distinct random path under the root", () => {
    const a = newCellWorktree("/tmp/wt");
    const b = newCellWorktree("/tmp/wt");
    expect(a).toMatch(/^\/tmp\/wt\/c-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe("sweepStaleCellWorktrees", () => {
  it("removes only c-<16 hex> checkouts; a missing root is a no-op", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-sweep-"));
    mkdirSync(join(root, "c-0123456789abcdef", "web"), { recursive: true });
    mkdirSync(join(root, "c-short"));
    writeFileSync(join(root, "notes.txt"), "keep");
    expect(sweepStaleCellWorktrees(root)).toEqual(["c-0123456789abcdef"]);
    expect(readdirSync(root).sort()).toEqual(["c-short", "notes.txt"]);
    expect(sweepStaleCellWorktrees(join(root, "absent"))).toEqual([]);
  });
});

describe("claudeProjectKey", () => {
  it("matches the per-project dir Claude created for pilot 1's shared checkout", () => {
    expect(claudeProjectKey("/home/auracomp/aura-diet/bench/wt/cell")).toBe("-home-auracomp-aura-diet-bench-wt-cell");
    expect(claudeProjectKey("/tmp/aurabench-wt/c-0123456789abcdef")).toBe("-tmp-aurabench-wt-c-0123456789abcdef");
  });
});

describe("withCleanClaudeProject", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "clean-proj-"));
    const projects = join(root, "projects");
    const artifactDir = join(root, "cells", "t", "C-1");
    mkdirSync(projects, { recursive: true });
    mkdirSync(artifactDir, { recursive: true });
    const worktree = join(root, "wt", "c-0123456789abcdef");
    const ctx: AgentContext = {
      task: { id: "t" } as AuraBenchTask,
      variant: VARIANTS.C,
      worktree,
      timeoutMs: 1_000,
      artifactDir,
    };
    return { projects, artifactDir, ctx, projectDir: join(projects, claudeProjectKey(worktree)) };
  };
  const done: AgentRun = { kind: "done", status: "completed", metrics: emptyMetrics(), isolation: { a: 1 }, confounds: [] };

  it("refuses to run the agent when the checkout already has per-project state", async () => {
    const s = setup();
    mkdirSync(join(s.projectDir, "memory"), { recursive: true });
    let ran = false;
    const r = await withCleanClaudeProject(async () => {
      ran = true;
      return done;
    }, s.projects)(s.ctx);
    expect(ran).toBe(false);
    expect(r).toMatchObject({ kind: "done", status: "agent_error", isolation: { claude_project: { preexisting: true } } });
  });

  it("moves the state the run created into the cell's artifacts and records it", async () => {
    const s = setup();
    const r = await withCleanClaudeProject(async () => {
      // What the CLI does during the session: write a transcript.
      mkdirSync(s.projectDir, { recursive: true });
      writeFileSync(join(s.projectDir, "session.jsonl"), "{}\n");
      return done;
    }, s.projects)(s.ctx);
    const archived = join(s.artifactDir, "claude-project");
    expect(r).toMatchObject({
      kind: "done",
      isolation: { a: 1, claude_project: { key: claudeProjectKey(s.ctx.worktree), preexisting: false, archived_to: archived } },
    });
    expect(readFileSync(join(archived, "session.jsonl"), "utf8")).toBe("{}\n");
    // Nothing left behind for a later cell to inherit.
    expect(existsSync(s.projectDir)).toBe(false);
  });

  it("a run that wrote no project state records archived_to: null", async () => {
    const s = setup();
    const r = await withCleanClaudeProject(async () => done, s.projects)(s.ctx);
    expect(r).toMatchObject({ isolation: { claude_project: { preexisting: false, archived_to: null } } });
  });

  it("a limit is passed through unchanged, but the state is still cleared (the retry must start clean)", async () => {
    const s = setup();
    const limit: AgentRun = { kind: "limit", limit: { resetAt: 1, message: "usage limit" } };
    const r = await withCleanClaudeProject(async () => {
      mkdirSync(s.projectDir, { recursive: true });
      return limit;
    }, s.projects)(s.ctx);
    expect(r).toBe(limit);
    expect(existsSync(s.projectDir)).toBe(false);
  });
});
