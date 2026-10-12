/**
 * Worktree isolation — "one live session per working tree" by default.
 *
 * Why: parallel agents sharing one working tree broke production twice
 * (om_event_bot df8c0f68 — `git add` swept up a sibling agent's unfinished
 * change → ImportError on start; aura-companion — a sibling switched the
 * branch of the shared prod checkout under another agent's uncommitted fix).
 * Services on those boxes run straight from the working tree, so a shared
 * tree turns one agent's half-done edit into another agent's deploy.
 *
 * Policy (see `decideIsolation`):
 *   - `shared`  → always work in the requested tree (legacy behaviour).
 *   - `isolate` → always create a dedicated worktree.
 *   - `auto`    → create a dedicated worktree only when ANOTHER live Aura
 *                 session already uses the same working tree. A lone session
 *                 in a repo is unchanged.
 *
 * Safety rails:
 *   - the worktree base dir must be outside the repo (else refuse);
 *   - creating a worktree inside a directory a systemd service runs from
 *     produces a warning (preview + progress + log), never silently;
 *   - cleanup never removes a worktree with uncommitted/untracked changes
 *     (it is kept and reported as retained) and only deletes the session
 *     branch when it carries no commits beyond the commit it was cut from.
 *
 * All git calls use execFileSync with argv arrays (no shell), so paths and
 * branch names never reach a shell parser.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { COMPANION_HOME } from "./paths.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type IsolationMode = "auto" | "isolate" | "shared";

export const ISOLATION_MODES: readonly IsolationMode[] = ["auto", "isolate", "shared"];

/** Minimal session shape needed to detect live siblings (Claude AND Codex). */
export interface LiveSessionLike {
  sessionId: string;
  cwd: string;
  state: "starting" | "connected" | "running" | "exited";
  archived?: boolean;
  name?: string;
  backendType?: string;
}

export type IsolationReason =
  | "explicit_isolate"
  | "explicit_shared"
  | "live_sibling"
  | "single_session";

export interface IsolationDecision {
  isolate: boolean;
  reason: IsolationReason;
}

export interface SystemdServiceDir {
  /** Unit file name, e.g. `aura-companion.service` */
  unit: string;
  /** Absolute WorkingDirectory= of the unit */
  dir: string;
}

export interface IsolatedWorktree {
  worktreePath: string;
  /** Session cwd inside the worktree (mirrors the subdir of the original cwd). */
  cwd: string;
  branch: string;
  baseCommit: string;
  repoRoot: string;
}

export interface IsolationPreview {
  isGitRepo: boolean;
  repoRoot: string | null;
  /** Other live Aura sessions (any backend) whose cwd is in the same working tree. */
  liveSessions: Array<{ sessionId: string; name?: string; backendType?: string }>;
  /** What `auto` would do for this cwd right now. */
  recommended: "isolate" | "shared";
  worktreesBaseDir: string;
  /** Human-readable warnings (systemd service dirs, base dir problems). */
  warnings: string[];
  /** systemd units running from the shared tree (why isolation matters here). */
  repoServiceUnits: string[];
}

// ─── Mode parsing ───────────────────────────────────────────────────────────

export function parseIsolationMode(
  raw: unknown,
): { ok: true; value: IsolationMode | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === "string" && (ISOLATION_MODES as readonly string[]).includes(raw)) {
    return { ok: true, value: raw as IsolationMode };
  }
  return { ok: false, error: `Invalid isolation: ${JSON.stringify(raw)} (expected auto | isolate | shared)` };
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/** Base directory for session worktrees. Override with COMPANION_WORKTREES_DIR. */
export function getWorktreesBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.COMPANION_WORKTREES_DIR?.trim();
  if (raw) return resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
  return join(COMPANION_HOME, "worktrees");
}

function normalize(p: string): string {
  let out = resolve(p);
  try {
    out = realpathSync(out);
  } catch {
    // Non-existent path — keep the lexical form.
  }
  return out.length > 1 ? out.replace(/\/+$/, "") : out;
}

/** True when `child` equals `parent` or lies beneath it (path-segment aware). */
export function isPathInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  if (c === p) return true;
  return c.startsWith(p === sep ? p : p + sep);
}

// ─── Git helpers ────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitSafe(args: string[], cwd: string): string | null {
  try {
    if (!existsSync(cwd)) return null;
    const out = git(args, cwd);
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}

/** Top-level dir of the working tree containing `cwd` (null when not a repo). */
export function gitToplevel(cwd: string): string | null {
  const top = gitSafe(["rev-parse", "--show-toplevel"], cwd);
  return top ? normalize(top) : null;
}

// ─── Decision logic ─────────────────────────────────────────────────────────

/**
 * Live Aura sessions whose cwd resolves to the same working tree as
 * `treeRoot`. Uses git's toplevel per session (not a path prefix) so a
 * nested linked worktree (e.g. `.claude/worktrees/x` inside the repo) is
 * correctly treated as a DIFFERENT tree.
 */
export function findLiveSessionsInTree(
  treeRoot: string,
  sessions: readonly LiveSessionLike[],
  resolveToplevel: (cwd: string) => string | null = gitToplevel,
  excludeSessionId?: string,
): LiveSessionLike[] {
  const root = normalize(treeRoot);
  const cache = new Map<string, string | null>();
  return sessions.filter((s) => {
    if (s.sessionId === excludeSessionId) return false;
    if (s.archived || s.state === "exited" || !s.cwd) return false;
    // Cheap pre-filter: a cwd outside the tree cannot share it.
    if (!isPathInside(s.cwd, root)) return false;
    if (!cache.has(s.cwd)) cache.set(s.cwd, resolveToplevel(s.cwd));
    const top = cache.get(s.cwd);
    return top !== null && top !== undefined && normalize(top) === root;
  });
}

/** Pure decision: should a new session get its own worktree? */
export function decideIsolation(input: { mode: IsolationMode; liveSiblingCount: number }): IsolationDecision {
  if (input.mode === "shared") return { isolate: false, reason: "explicit_shared" };
  if (input.mode === "isolate") return { isolate: true, reason: "explicit_isolate" };
  return input.liveSiblingCount > 0
    ? { isolate: true, reason: "live_sibling" }
    : { isolate: false, reason: "single_session" };
}

// ─── systemd detection ──────────────────────────────────────────────────────

export function defaultUnitDirs(): string[] {
  const fromEnv = process.env.COMPANION_SYSTEMD_UNIT_DIRS;
  if (fromEnv !== undefined) return fromEnv.split(":").filter(Boolean);
  return [
    "/etc/systemd/system",
    "/run/systemd/system",
    "/lib/systemd/system",
    "/usr/lib/systemd/system",
    join(homedir(), ".config", "systemd", "user"),
  ];
}

function readUnitWorkingDirs(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*WorkingDirectory\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    let dir = m[1].replace(/^-/, "");
    if (dir === "~") dir = homedir();
    if (dir.startsWith("/")) dirs.push(dir);
  }
  return dirs;
}

/**
 * Scan systemd unit files (+ `*.service.d/*.conf` drop-ins) for
 * `WorkingDirectory=`. Best-effort and read-only: unreadable dirs are skipped.
 */
export function listSystemdServiceDirs(unitDirs: string[] = defaultUnitDirs()): SystemdServiceDir[] {
  const out: SystemdServiceDir[] = [];
  for (const base of unitDirs) {
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(base, name);
      if (name.endsWith(".service")) {
        for (const dir of readUnitWorkingDirs(full)) out.push({ unit: name, dir });
      } else if (name.endsWith(".service.d")) {
        let dropins: string[] = [];
        try {
          if (statSync(full).isDirectory()) dropins = readdirSync(full);
        } catch {
          dropins = [];
        }
        for (const d of dropins) {
          if (!d.endsWith(".conf")) continue;
          for (const dir of readUnitWorkingDirs(join(full, d))) {
            out.push({ unit: name.replace(/\.d$/, ""), dir });
          }
        }
      }
    }
  }
  return out;
}

/** Units whose WorkingDirectory contains `path` (path is inside the service dir). */
export function servicesRunningFrom(path: string, services: readonly SystemdServiceDir[]): string[] {
  const units = new Set<string>();
  for (const s of services) {
    if (s.dir === "/") continue; // a unit running from / says nothing useful
    if (isPathInside(path, s.dir)) units.add(s.unit);
  }
  return [...units];
}

// ─── Worktree creation ──────────────────────────────────────────────────────

export function buildWorktreeSlug(now: Date = new Date(), rand: () => number = Math.random): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.floor(rand() * 0xffff).toString(16).padStart(4, "0");
  return `${stamp}-${suffix}`;
}

/** Sanitised repo dir name (never contains a separator or `..`). */
function repoDirName(repoRoot: string): string {
  const name = basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, "_");
  return name && name !== "." && name !== ".." ? name : "repo";
}

export function planWorktreeTarget(repoRoot: string, baseDir: string, slug: string): { path: string; branch: string } {
  return { path: join(baseDir, repoDirName(repoRoot), slug), branch: `aura/${slug}` };
}

export class WorktreeIsolationError extends Error {
  constructor(message: string, public readonly status: number = 500) {
    super(message);
    this.name = "WorktreeIsolationError";
  }
}

/**
 * Create a dedicated worktree on a fresh `aura/<slug>` branch cut from the
 * current HEAD of the tree containing `cwd`. Uncommitted changes in the
 * shared tree are deliberately NOT copied — they belong to whoever made them.
 */
export function createIsolatedWorktree(opts: {
  cwd: string;
  baseDir?: string;
  slug?: string;
}): IsolatedWorktree {
  const repoRoot = gitToplevel(opts.cwd);
  if (!repoRoot) throw new WorktreeIsolationError(`Not a git repository: ${opts.cwd}`, 400);
  const baseDir = normalize(opts.baseDir ?? getWorktreesBaseDir());
  if (isPathInside(baseDir, repoRoot)) {
    throw new WorktreeIsolationError(
      `Worktree base dir ${baseDir} is inside the repository ${repoRoot}; set COMPANION_WORKTREES_DIR to a directory outside the repo`,
      400,
    );
  }
  const baseCommit = gitSafe(["rev-parse", "--verify", "HEAD"], repoRoot);
  if (!baseCommit) throw new WorktreeIsolationError(`Repository ${repoRoot} has no commits yet; cannot branch a worktree`, 400);

  const baseSlug = opts.slug ?? buildWorktreeSlug();
  let target = planWorktreeTarget(repoRoot, baseDir, baseSlug);
  for (let i = 2; existsSync(target.path) || gitSafe(["rev-parse", "--verify", `refs/heads/${target.branch}`], repoRoot); i++) {
    if (i > 50) throw new WorktreeIsolationError("Could not find a free worktree name", 500);
    target = planWorktreeTarget(repoRoot, baseDir, `${baseSlug}-${i}`);
  }

  mkdirSync(join(baseDir, repoDirName(repoRoot)), { recursive: true });
  try {
    git(["worktree", "add", "-b", target.branch, target.path, baseCommit], repoRoot);
  } catch (e) {
    throw new WorktreeIsolationError(
      `git worktree add failed: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }

  // Keep the session in the same sub-directory it asked for.
  const rel = relative(repoRoot, normalize(opts.cwd));
  const sessionCwd = rel && !rel.startsWith("..") ? join(target.path, rel) : target.path;
  return {
    worktreePath: target.path,
    cwd: existsSync(sessionCwd) ? sessionCwd : target.path,
    branch: target.branch,
    baseCommit,
    repoRoot,
  };
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

export function isTreeDirty(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const status = gitSafe(["status", "--porcelain"], worktreePath);
  // A failing `git status` is treated as dirty: never delete what we can't inspect.
  return status === null || status.length > 0;
}

/** Commits on `branch` not reachable from `baseCommit` (0 when unknown branch). */
export function commitsBeyondBase(repoRoot: string, branch: string, baseCommit: string | undefined): number {
  if (!gitSafe(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot)) return 0;
  if (!baseCommit) return Number.POSITIVE_INFINITY; // unknown base → assume work exists
  const n = gitSafe(["rev-list", "--count", `${baseCommit}..refs/heads/${branch}`], repoRoot);
  return n === null ? Number.POSITIVE_INFINITY : Number.parseInt(n, 10) || 0;
}

export type IsolatedCleanupResult =
  | { removed: true; branchDeleted: boolean; branchKept?: string }
  | { removed: false; retained: "dirty" | "error"; reason: string };

/**
 * Remove an isolated worktree ONLY when clean. Never forced: uncommitted or
 * untracked files mean the worktree is kept (`retained: "dirty"`). The
 * session branch is deleted only when it has no commits beyond its base;
 * otherwise the branch is kept so committed work survives.
 */
export function cleanupIsolatedWorktree(m: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit?: string;
}): IsolatedCleanupResult {
  if (existsSync(m.worktreePath)) {
    if (isTreeDirty(m.worktreePath)) {
      return { removed: false, retained: "dirty", reason: "Worktree has uncommitted changes; kept" };
    }
    try {
      git(["worktree", "remove", m.worktreePath], m.repoRoot);
    } catch (e) {
      return { removed: false, retained: "error", reason: e instanceof Error ? e.message : String(e) };
    }
  } else {
    gitSafe(["worktree", "prune"], m.repoRoot);
  }
  if (commitsBeyondBase(m.repoRoot, m.branch, m.baseCommit) === 0) {
    const deleted = gitSafe(["branch", "-D", m.branch], m.repoRoot) !== null;
    return { removed: true, branchDeleted: deleted };
  }
  return { removed: true, branchDeleted: false, branchKept: m.branch };
}

// ─── Preview (for the New Session UI) ───────────────────────────────────────

export function previewIsolation(
  cwd: string,
  sessions: readonly LiveSessionLike[],
  opts: {
    resolveToplevel?: (cwd: string) => string | null;
    services?: readonly SystemdServiceDir[];
    baseDir?: string;
  } = {},
): IsolationPreview {
  const resolveTop = opts.resolveToplevel ?? gitToplevel;
  const baseDir = opts.baseDir ?? getWorktreesBaseDir();
  const repoRoot = resolveTop(cwd);
  if (!repoRoot) {
    return {
      isGitRepo: false,
      repoRoot: null,
      liveSessions: [],
      recommended: "shared",
      worktreesBaseDir: baseDir,
      warnings: [],
      repoServiceUnits: [],
    };
  }
  const live = findLiveSessionsInTree(repoRoot, sessions, resolveTop);
  const services = opts.services ?? listSystemdServiceDirs();
  const warnings: string[] = [];
  const baseUnits = servicesRunningFrom(baseDir, services);
  if (baseUnits.length > 0) {
    warnings.push(
      `Worktrees would be created inside ${baseDir}, which systemd service ${baseUnits.join(", ")} runs from. Set COMPANION_WORKTREES_DIR elsewhere.`,
    );
  }
  if (isPathInside(baseDir, repoRoot)) {
    warnings.push(`Worktree base dir ${baseDir} is inside this repository; isolation will be refused.`);
  }
  const repoServiceUnits = servicesRunningFrom(repoRoot, services);
  return {
    isGitRepo: true,
    repoRoot,
    liveSessions: live.map((s) => ({ sessionId: s.sessionId, name: s.name, backendType: s.backendType })),
    recommended: decideIsolation({ mode: "auto", liveSiblingCount: live.length }).isolate ? "isolate" : "shared",
    worktreesBaseDir: baseDir,
    warnings,
    repoServiceUnits,
  };
}
