/**
 * Shared test fixtures for the council-panel live-runner tests (real git in a
 * temp dir). Test-only; not imported by runtime code.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AsyncExec } from "../harness/run-cell.js";

export const TEST_GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false"];

export const realExec: AsyncExec = async (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeoutMs });
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: false };
};

export const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", [...TEST_GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repo shaped like a council-panel case: base, head (the PR), fix (later). */
export function makeCaseRepo(root: string): { repo: string; base: string; head: string; fix: string } {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  const put = (path: string, body: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  };
  put("web/server/a.ts", "export const a = 1;\n");
  put(".council/prompts/observer-system.md", "runtime prompt\n");
  put(".council/review-output/2026-01-01-0000/FINAL-REVIEW.md", "old review\n");
  put("docs/history/HANDOFF.md", "old handoff\n");
  // Repo-shipped skill, named like a real user skill, plus the .claude/skills symlink to it.
  put(".agents/skills/harden/SKILL.md", "---\nname: harden\n---\n");
  mkdirSync(join(repo, ".claude/skills"), { recursive: true });
  symlinkSync("../../.agents/skills/harden", join(repo, ".claude/skills/harden"));
  symlinkSync("CLAUDE.md", join(repo, "AGENTS.md"));
  put("CLAUDE.md", "rules\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  put("web/server/a.ts", "export const a = 2; // racy\n");
  put(".council/review-output/2026-02-02-0000/FINAL-REVIEW.md", "ANSWERKEY review of the PR\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the PR");
  const head = git(repo, "rev-parse", "HEAD");
  put("web/server/a.ts", "export const a = 3; // FIXSECRET\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the fix");
  const fix = git(repo, "rev-parse", "HEAD");
  return { repo, base, head, fix };
}
