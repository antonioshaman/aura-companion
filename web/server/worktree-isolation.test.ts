/**
 * Worktree isolation — decision logic + real git operations on temp repos.
 *
 * Context: parallel agents sharing one working tree broke prod (a sibling's
 * `git add` swept up unfinished work; a sibling switched the branch of a
 * checkout services ran from). These tests pin the default-isolation policy
 * and, above all, the "never delete uncommitted work" cleanup guarantee.
 * Git calls are NOT mocked: each test builds a throwaway repo in tmpdir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseIsolationMode,
  decideIsolation,
  findLiveSessionsInTree,
  isPathInside,
  listSystemdServiceDirs,
  servicesRunningFrom,
  createIsolatedWorktree,
  cleanupIsolatedWorktree,
  commitsBeyondBase,
  previewIsolation,
  getWorktreesBaseDir,
  buildWorktreeSlug,
  WorktreeIsolationError,
  type LiveSessionLike,
} from "./worktree-isolation.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

let tmp: string;
let repo: string;
let baseDir: string;

/** Fresh repo with one commit + a `src/` subdir, and a worktree base dir OUTSIDE it. */
function makeRepo(): void {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "aura-iso-")));
  repo = join(tmp, "myrepo");
  baseDir = join(tmp, "worktrees");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, "src", "a.txt"), "a\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
}

function session(id: string, cwd: string, extra: Partial<LiveSessionLike> = {}): LiveSessionLike {
  return { sessionId: id, cwd, state: "connected", ...extra };
}

beforeEach(() => makeRepo());
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("parseIsolationMode", () => {
  it("accepts the three modes and treats absent as undefined", () => {
    expect(parseIsolationMode(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseIsolationMode("auto")).toEqual({ ok: true, value: "auto" });
    expect(parseIsolationMode("isolate")).toEqual({ ok: true, value: "isolate" });
    expect(parseIsolationMode("shared")).toEqual({ ok: true, value: "shared" });
  });
  it("rejects anything else (no silent fallback to a mode the user didn't pick)", () => {
    expect(parseIsolationMode("yes").ok).toBe(false);
    expect(parseIsolationMode(true).ok).toBe(false);
  });
});

describe("decideIsolation", () => {
  // The core policy: only `auto` + a live sibling isolates implicitly; a lone
  // session in a repo keeps today's behaviour.
  it.each([
    ["auto", 0, false, "single_session"],
    ["auto", 1, true, "live_sibling"],
    ["auto", 3, true, "live_sibling"],
    ["isolate", 0, true, "explicit_isolate"],
    ["shared", 5, false, "explicit_shared"],
  ] as const)("mode=%s siblings=%d → isolate=%s (%s)", (mode, n, isolate, reason) => {
    expect(decideIsolation({ mode, liveSiblingCount: n })).toEqual({ isolate, reason });
  });
});

describe("isPathInside", () => {
  it("is segment-aware (sibling prefix is NOT inside)", () => {
    expect(isPathInside("/a/b/c", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/bc", "/a/b")).toBe(false);
  });
});

describe("findLiveSessionsInTree", () => {
  it("counts live Claude AND Codex sessions in the same tree, including subdirs", () => {
    const live = findLiveSessionsInTree(repo, [
      session("claude-1", repo, { backendType: "claude" }),
      session("codex-1", join(repo, "src"), { backendType: "codex" }),
    ]);
    expect(live.map((s) => s.sessionId).sort()).toEqual(["claude-1", "codex-1"]);
  });

  it("ignores exited, archived, excluded and out-of-tree sessions", () => {
    const live = findLiveSessionsInTree(
      repo,
      [
        session("exited", repo, { state: "exited" }),
        session("archived", repo, { archived: true }),
        session("self", repo),
        session("elsewhere", tmp),
      ],
      undefined,
      "self",
    );
    expect(live).toEqual([]);
  });

  it("treats a session already in a linked worktree as a DIFFERENT tree", () => {
    // Edge case: a worktree nested INSIDE the repo dir (Claude Code's own
    // .claude/worktrees) is path-inside but has its own toplevel.
    const nested = join(repo, ".wt", "x");
    git(["worktree", "add", "-q", "-b", "nested", nested], repo);
    const live = findLiveSessionsInTree(repo, [session("in-nested", nested)]);
    expect(live).toEqual([]);
  });
});

describe("systemd service detection", () => {
  it("parses WorkingDirectory from units and drop-ins, and matches paths inside them", () => {
    const unitDir = join(tmp, "units");
    mkdirSync(join(unitDir, "web.service.d"), { recursive: true });
    writeFileSync(join(unitDir, "bot.service"), `[Service]\nWorkingDirectory=${repo}\nExecStart=/bin/true\n`);
    writeFileSync(join(unitDir, "web.service.d", "override.conf"), `[Service]\nWorkingDirectory=-${tmp}/srv\n`);
    writeFileSync(join(unitDir, "root.service"), "[Service]\nWorkingDirectory=/\n");
    const services = listSystemdServiceDirs([unitDir, join(tmp, "missing-dir")]);
    expect(services).toEqual(
      expect.arrayContaining([
        { unit: "bot.service", dir: repo },
        { unit: "web.service", dir: `${tmp}/srv` },
      ]),
    );
    expect(servicesRunningFrom(join(repo, "src"), services)).toEqual(["bot.service"]);
    // A unit running from "/" must not flag every path on the box.
    expect(servicesRunningFrom(join(tmp, "other"), services)).toEqual([]);
  });
});

describe("createIsolatedWorktree (real git)", () => {
  it("creates aura/<slug> from HEAD outside the repo, mirroring the cwd subdir", () => {
    const head = git(["rev-parse", "HEAD"], repo);
    const wt = createIsolatedWorktree({ cwd: join(repo, "src"), baseDir, slug: "s1" });
    expect(wt.worktreePath).toBe(join(baseDir, "myrepo", "s1"));
    expect(wt.branch).toBe("aura/s1");
    expect(wt.baseCommit).toBe(head);
    expect(wt.cwd).toBe(join(wt.worktreePath, "src"));
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], wt.worktreePath)).toBe("aura/s1");
    // The shared tree's branch is untouched (the incident: a sibling's branch switch).
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
  });

  it("does not carry over uncommitted changes from the shared tree", () => {
    writeFileSync(join(repo, "src", "a.txt"), "half-done edit by another agent\n");
    const wt = createIsolatedWorktree({ cwd: repo, baseDir, slug: "s2" });
    expect(git(["status", "--porcelain"], wt.worktreePath)).toBe("");
  });

  it("picks a fresh name when the slug is taken", () => {
    const a = createIsolatedWorktree({ cwd: repo, baseDir, slug: "dup" });
    const b = createIsolatedWorktree({ cwd: repo, baseDir, slug: "dup" });
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(b.branch).toBe("aura/dup-2");
  });

  it("refuses a base dir inside the repository", () => {
    expect(() => createIsolatedWorktree({ cwd: repo, baseDir: join(repo, ".wt"), slug: "x" })).toThrow(
      WorktreeIsolationError,
    );
  });

  it("refuses non-repos with a 400", () => {
    try {
      createIsolatedWorktree({ cwd: tmp, baseDir, slug: "x" });
      expect.unreachable();
    } catch (e) {
      expect((e as WorktreeIsolationError).status).toBe(400);
    }
  });
});

describe("cleanupIsolatedWorktree (real git) — never loses work", () => {
  it("removes a clean worktree and its commit-less branch", () => {
    const wt = createIsolatedWorktree({ cwd: repo, baseDir, slug: "clean" });
    const r = cleanupIsolatedWorktree({ ...wt });
    expect(r).toEqual({ removed: true, branchDeleted: true });
    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(git(["branch", "--list", "aura/clean"], repo)).toBe("");
  });

  it("KEEPS a worktree with modified tracked files", () => {
    const wt = createIsolatedWorktree({ cwd: repo, baseDir, slug: "dirty" });
    writeFileSync(join(wt.worktreePath, "src", "a.txt"), "changed\n");
    const r = cleanupIsolatedWorktree({ ...wt });
    expect(r).toMatchObject({ removed: false, retained: "dirty" });
    expect(existsSync(join(wt.worktreePath, "src", "a.txt"))).toBe(true);
  });

  it("KEEPS a worktree with only untracked files", () => {
    const wt = createIsolatedWorktree({ cwd: repo, baseDir, slug: "untracked" });
    writeFileSync(join(wt.worktreePath, "new.txt"), "new\n");
    expect(cleanupIsolatedWorktree({ ...wt })).toMatchObject({ removed: false, retained: "dirty" });
    expect(existsSync(join(wt.worktreePath, "new.txt"))).toBe(true);
  });

  it("removes a clean worktree but keeps a branch that carries commits", () => {
    const wt = createIsolatedWorktree({ cwd: repo, baseDir, slug: "committed" });
    writeFileSync(join(wt.worktreePath, "feature.txt"), "x\n");
    git(["add", "."], wt.worktreePath);
    git(["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "work"], wt.worktreePath);
    expect(commitsBeyondBase(repo, wt.branch, wt.baseCommit)).toBe(1);
    const r = cleanupIsolatedWorktree({ ...wt });
    expect(r).toEqual({ removed: true, branchDeleted: false, branchKept: "aura/committed" });
    expect(git(["branch", "--list", "aura/committed"], repo)).toContain("aura/committed");
  });

  it("keeps the branch when the base commit is unknown (assume work exists)", () => {
    const wt = createIsolatedWorktree({ cwd: repo, baseDir, slug: "nobase" });
    const r = cleanupIsolatedWorktree({ ...wt, baseCommit: undefined });
    expect(r).toMatchObject({ removed: true, branchDeleted: false });
  });

  it("prunes a worktree whose directory is already gone", () => {
    const wt = createIsolatedWorktree({ cwd: repo, baseDir, slug: "gone" });
    rmSync(wt.worktreePath, { recursive: true, force: true });
    expect(cleanupIsolatedWorktree({ ...wt })).toMatchObject({ removed: true });
    expect(git(["worktree", "list"], repo)).not.toContain("gone");
  });
});

describe("previewIsolation", () => {
  it("recommends shared for a lone session and isolate when a sibling is live", () => {
    expect(previewIsolation(repo, [], { baseDir, services: [] })).toMatchObject({
      isGitRepo: true,
      repoRoot: repo,
      recommended: "shared",
      liveSessions: [],
    });
    const p = previewIsolation(join(repo, "src"), [session("s1", repo, { name: "Fix bug", backendType: "codex" })], {
      baseDir,
      services: [],
    });
    expect(p.recommended).toBe("isolate");
    expect(p.liveSessions).toEqual([{ sessionId: "s1", name: "Fix bug", backendType: "codex" }]);
  });

  it("warns when the worktree dir is inside a systemd service dir, and names units running from the repo", () => {
    const p = previewIsolation(repo, [], {
      baseDir,
      services: [
        { unit: "app.service", dir: tmp },
        { unit: "bot.service", dir: repo },
      ],
    });
    expect(p.warnings.join("\n")).toContain("app.service");
    expect(p.repoServiceUnits.sort()).toEqual(["app.service", "bot.service"]);
  });

  it("reports non-repos as not git", () => {
    expect(previewIsolation(tmp, [], { baseDir, services: [] })).toMatchObject({ isGitRepo: false, recommended: "shared" });
  });
});

describe("config helpers", () => {
  it("COMPANION_WORKTREES_DIR overrides the base dir (with ~ expansion)", () => {
    expect(getWorktreesBaseDir({ COMPANION_WORKTREES_DIR: "/srv/wt" })).toBe("/srv/wt");
    expect(getWorktreesBaseDir({ COMPANION_WORKTREES_DIR: "~/wt" })).toMatch(/\/wt$/);
    expect(getWorktreesBaseDir({})).toMatch(/worktrees$/);
  });

  it("buildWorktreeSlug is timestamp + hex suffix (branch-name safe)", () => {
    const slug = buildWorktreeSlug(new Date(2026, 9, 12, 8, 5, 9), () => 0.5);
    expect(slug).toBe("20261012-080509-7fff");
    expect(slug).toMatch(/^[A-Za-z0-9-]+$/);
  });
});
