/**
 * Tests for the naked-Claude isolation proof (P6/D2 RUNBOOK: "proof of
 * isolation — the stream-json init frame: no user skills/hooks").
 *
 * Validates that each leak channel is reported as its own violation (user
 * skills, non-builtin plugins, MCP servers, hook events, auto-memory inside
 * the real ~/.claude, Aura project skills, auto-memory keyed on a project
 * other than the cell checkout), that a clean frame passes with the evidence retained,
 * and that a missing init frame can never count as isolated.
 */

import { describe, it, expect } from "vitest";
import { NAKED_SCRUB_PATHS, checkNakedClaudeIsolation, claudeProjectKey } from "./isolation.js";

const clean = {
  type: "system",
  subtype: "init",
  model: "claude-x",
  claude_code_version: "2.1.283",
  skills: ["update-config", "simplify"],
  plugins: [{ name: "agents-md", path: "builtin", source: "agents-md@builtin" }],
  mcp_servers: [],
  agents: ["general-purpose"],
  memory_paths: { auto: "/bench/cells/t/A-1/claude-config/projects/x/memory/" },
};
const opts = { userSkillNames: ["council-review-aura", "prime"], realClaudeDir: "/home/u/.claude", hookEvents: 0 };

describe("checkNakedClaudeIsolation", () => {
  it("passes a clean init frame and keeps the evidence", () => {
    const v = checkNakedClaudeIsolation(clean, opts);
    expect(v.isolated).toBe(true);
    expect(v.violations).toEqual([]);
    expect(v.evidence).toMatchObject({ claude_code_version: "2.1.283", skills: clean.skills, hook_events: 0 });
  });

  it("reports every leak channel separately", () => {
    const v = checkNakedClaudeIsolation(
      {
        ...clean,
        skills: [...clean.skills, "council-review-aura"],
        plugins: [...clean.plugins, { name: "x", path: "/home/u/.claude/plugins/x" }],
        mcp_servers: [{ name: "claude.ai Gmail", status: "connected" }],
        memory_paths: { auto: "/home/u/.claude/projects/-wt/memory/" },
      },
      { ...opts, hookEvents: 3 },
    );
    expect(v.isolated).toBe(false);
    expect(v.violations).toHaveLength(5);
    expect(v.violations.join("\n")).toMatch(/council-review-aura/);
    expect(v.violations.join("\n")).toMatch(/3 hook/);
  });

  // Pilot regression: the cell was a linked `git worktree`, so Claude Code
  // resolved the project to the MAIN repo — its `.claude/skills` (impeccable
  // skills such as `adapt`, `polish`) showed up in a "naked" run and memory
  // was keyed on `-home-auracomp-aura-diet-repo`. Only `harden` was caught,
  // by coincidence (it is also a user skill). Both signals must now fail.
  it("flags Aura project skills and auto-memory keyed on another checkout", () => {
    const cwd = "/home/u/bench/wt/cell";
    const v = checkNakedClaudeIsolation(
      { ...clean, skills: [...clean.skills, "adapt", "polish"], memory_paths: { auto: "/bench/cells/t/A-1/claude-config/projects/-home-u-repo/memory/" } },
      { ...opts, projectSkillNames: ["adapt", "polish", "prime"], cwd },
    );
    expect(v.isolated).toBe(false);
    expect(v.violations).toEqual([
      "Aura project skills visible: adapt, polish",
      expect.stringMatching(/^auto-memory keyed on another project \(expected \/projects\/-home-u-bench-wt-cell\/\)/),
    ]);
    // The same frame keyed on the cell itself, without project skills, is clean.
    const ok = checkNakedClaudeIsolation(
      { ...clean, memory_paths: { auto: "/bench/cells/t/A-1/claude-config/projects/-home-u-bench-wt-cell/memory/" } },
      { ...opts, projectSkillNames: ["adapt"], cwd },
    );
    expect(ok.violations).toEqual([]);
  });

  it("claudeProjectKey mirrors Claude Code's project dir naming", () => {
    expect(claudeProjectKey("/home/auracomp/aura-diet/repo")).toBe("-home-auracomp-aura-diet-repo");
    expect(claudeProjectKey("/home/a_b/wt.cell/")).toBe("-home-a-b-wt-cell");
  });

  it("never treats a missing init frame as isolated", () => {
    expect(checkNakedClaudeIsolation(null, opts).isolated).toBe(false);
  });

  it("the scrub list covers the Aura instruction surfaces", () => {
    for (const p of ["CLAUDE.md", "AGENTS.md", ".agents", ".council", ".claude"]) {
      expect(NAKED_SCRUB_PATHS).toContain(p);
    }
  });
});
