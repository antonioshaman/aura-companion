/**
 * AuraBench candidate validator (P5/D1). A candidate becomes a task only if its
 * hidden tests PASS on the merge commit and FAIL on the base commit (the merge
 * commit's first parent) — i.e. the tests actually distinguish "before" from
 * "after". Anything else is excluded with a reason.
 *
 * Procedure per candidate, in a throwaway `git worktree` (never the main
 * checkout):
 *   1. worktree at merge → `bun install --frozen-lockfile` → run hidden tests.
 *      Must exit 0 (else "hidden tests fail on merge").
 *   2. detach the same worktree to base (node_modules survive as untracked),
 *      restore ONLY the hidden test files from merge, reinstall if the lockfile
 *      or package.json changed → run hidden tests. Must exit non-zero (else
 *      "hidden tests already pass on base"). The failure is classified as
 *      `missing-interface` (tests import a file/symbol the PR created) or `assertion`.
 *   3. remove the worktree.
 *
 * Results are idempotent JSONL keyed by PR number: a rerun skips PRs that
 * already have a verdict, so a long validation survives restarts.
 *
 * All process spawning goes through the injected {@link Exec}; this module is
 * unit-tested with a scripted fake. Firewall-clean. Never `server/`.
 */

import type { BaseFailureKind } from "./task.js";
import type { Candidate } from "./mine.js";

export interface ExecResult {
  code: number;
  output: string;
  timedOut: boolean;
}

export type Exec = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => ExecResult;

export interface ValidateOptions {
  /** Repo whose object store holds both commits. */
  repo: string;
  /** Absolute path of the throwaway worktree for this candidate. */
  worktree: string;
  exec: Exec;
  now?: () => Date;
  /** Per test run; a timeout counts as a failed run. */
  testTimeoutMs?: number;
  installTimeoutMs?: number;
}

export type ValidationVerdict =
  | {
      pr: number;
      ok: true;
      base_commit: string;
      merge_commit: string;
      base_failure: BaseFailureKind;
      checked_at: string;
      base_output_tail: string;
    }
  | { pr: number; ok: false; reason: string; checked_at: string; output_tail?: string };

const MISSING_INTERFACE_RE =
  /Failed to (load|resolve) (url|import)|Cannot find module|Does the file exist\?|does not provide an export named|is not exported by|__vi_import_\d+__\.[\w$]+ is not a (function|constructor)/i;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Classify a failing base run by its output. */
export function classifyBaseFailure(output: string): BaseFailureKind {
  return MISSING_INTERFACE_RE.test(output.replace(ANSI_RE, "")) ? "missing-interface" : "assertion";
}

function tail(raw: string, n = 1500): string {
  const s = raw.replace(ANSI_RE, "");
  return s.length <= n ? s : s.slice(s.length - n);
}

/** Hidden test path (repo-relative, `web/...`) → path relative to `web/`,
 *  where vitest runs. */
export function toWebRelative(path: string): string {
  return path.startsWith("web/") ? path.slice(4) : path;
}

export function validateCandidate(c: Candidate, o: ValidateOptions): ValidationVerdict {
  const now = o.now ?? (() => new Date());
  const testTimeoutMs = o.testTimeoutMs ?? 10 * 60_000;
  const installTimeoutMs = o.installTimeoutMs ?? 10 * 60_000;
  const web = `${o.worktree}/web`;
  const git = (args: string[], cwd = o.repo) => o.exec("git", args, { cwd, timeoutMs: 120_000 });
  const fail = (reason: string, out?: ExecResult): ValidationVerdict => ({
    pr: c.pr,
    ok: false,
    reason,
    checked_at: now().toISOString(),
    ...(out ? { output_tail: tail(out.output) } : {}),
  });
  const install = () => o.exec("bun", ["install", "--frozen-lockfile"], { cwd: web, timeoutMs: installTimeoutMs });
  const runHidden = () =>
    o.exec("bunx", ["vitest", "run", "--maxWorkers=2", ...c.hidden_tests.map(toWebRelative)], {
      cwd: web,
      timeoutMs: testTimeoutMs,
    });

  const parent = git(["rev-parse", `${c.merge_commit}^1`]);
  if (parent.code !== 0) return fail("merge commit has no resolvable parent", parent);
  const base = parent.output.trim();

  // A stale worktree from an interrupted run would make `add` fail.
  git(["worktree", "remove", "--force", o.worktree]);
  const added = git(["worktree", "add", "--detach", o.worktree, c.merge_commit]);
  if (added.code !== 0) return fail("git worktree add failed", added);
  try {
    const inst = install();
    if (inst.code !== 0) return fail("bun install failed on merge commit", inst);
    const onMerge = runHidden();
    if (onMerge.timedOut) return fail("hidden tests timed out on merge commit", onMerge);
    if (onMerge.code !== 0) return fail("hidden tests fail on merge commit", onMerge);

    const co = git(["checkout", "--force", "--detach", base], o.worktree);
    if (co.code !== 0) return fail("checkout of base commit failed", co);
    const restore = git(["checkout", c.merge_commit, "--", ...c.hidden_tests], o.worktree);
    if (restore.code !== 0) return fail("restoring hidden tests on base failed", restore);
    const depsChanged = git(
      ["diff", "--quiet", base, c.merge_commit, "--", "web/package.json", "web/bun.lock", "web/bun.lockb"],
      o.worktree,
    );
    if (depsChanged.code !== 0) {
      const reinst = install();
      if (reinst.code !== 0) return fail("bun install failed on base commit", reinst);
    }
    const onBase = runHidden();
    // A hang on base is ambiguous (not a clean "fails before the fix").
    if (onBase.timedOut) return fail("hidden tests time out on base commit", onBase);
    if (onBase.code === 0) return fail("hidden tests already pass on base commit", onBase);
    return {
      pr: c.pr,
      ok: true,
      base_commit: base,
      merge_commit: c.merge_commit,
      base_failure: classifyBaseFailure(onBase.output),
      checked_at: now().toISOString(),
      base_output_tail: tail(onBase.output),
    };
  } finally {
    git(["worktree", "remove", "--force", o.worktree]);
  }
}

/** PRs that already have a verdict in a results JSONL (malformed lines are
 *  ignored so a torn final write just re-validates that PR). */
export function completedPrs(jsonl: string): Set<number> {
  const done = new Set<number>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as { pr?: unknown };
      if (typeof v.pr === "number") done.add(v.pr);
    } catch {
      // torn line — ignore
    }
  }
  return done;
}
