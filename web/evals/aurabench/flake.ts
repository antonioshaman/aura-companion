/**
 * AuraBench hidden-test stability check (P6/FIX-D2-5). Validation (P5/D1) ran
 * the hidden tests ONCE on the merge commit; a flaky test there turns an agent
 * cell into a coin toss (a correct fix scores as a failure, or a timing-lucky
 * wrong one as a pass). Every task's hidden tests therefore run N times (default
 * 3) on the merge commit in a throwaway worktree; any non-zero exit or timeout
 * makes the task unstable and it leaves the corpus.
 *
 * Results are idempotent JSONL keyed by task id + merge commit. All process
 * spawning goes through the injected {@link Exec} (same seam as validate.ts);
 * unit-tested with a scripted fake. Firewall-clean. Never `server/`.
 */

import { toWebRelative, type Exec } from "./validate.js";

export interface StabilityTarget {
  id: string;
  merge_commit: string;
  hidden_tests: string[];
}

export interface StabilityOptions {
  repo: string;
  /** Absolute path of the throwaway worktree for this task. */
  worktree: string;
  exec: Exec;
  /** Consecutive runs that must all pass. */
  runs?: number;
  now?: () => Date;
  testTimeoutMs?: number;
  installTimeoutMs?: number;
}

export interface StabilityRun {
  code: number;
  timedOut: boolean;
  /** Tail of the output — kept only for failed runs. */
  output_tail?: string;
}

export interface StabilityVerdict {
  id: string;
  merge_commit: string;
  /** `false` when setup (worktree/install) failed — the task is unproven, not flaky. */
  setup_ok: boolean;
  runs: StabilityRun[];
  passed: number;
  stable: boolean;
  reason?: string;
  checked_at: string;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function tail(raw: string, n = 1500): string {
  const s = raw.replace(ANSI_RE, "");
  return s.length <= n ? s : s.slice(s.length - n);
}

export function checkMergeStability(t: StabilityTarget, o: StabilityOptions): StabilityVerdict {
  const runs = o.runs ?? 3;
  const now = o.now ?? (() => new Date());
  const web = `${o.worktree}/web`;
  const git = (args: string[]) => o.exec("git", args, { cwd: o.repo, timeoutMs: 120_000 });
  const verdict = (setup_ok: boolean, results: StabilityRun[], reason?: string): StabilityVerdict => {
    const passed = results.filter((r) => r.code === 0 && !r.timedOut).length;
    return {
      id: t.id,
      merge_commit: t.merge_commit,
      setup_ok,
      runs: results,
      passed,
      stable: setup_ok && passed === runs,
      ...(reason ? { reason } : {}),
      checked_at: now().toISOString(),
    };
  };

  git(["worktree", "remove", "--force", o.worktree]);
  const added = git(["worktree", "add", "--detach", o.worktree, t.merge_commit]);
  if (added.code !== 0) return verdict(false, [], `git worktree add failed: ${tail(added.output, 300)}`);
  try {
    const inst = o.exec("bun", ["install", "--frozen-lockfile"], { cwd: web, timeoutMs: o.installTimeoutMs ?? 600_000 });
    if (inst.code !== 0) return verdict(false, [], `bun install failed: ${tail(inst.output, 300)}`);
    const results: StabilityRun[] = [];
    for (let i = 0; i < runs; i++) {
      const r = o.exec("bunx", ["vitest", "run", "--maxWorkers=2", ...t.hidden_tests.map(toWebRelative)], {
        cwd: web,
        timeoutMs: o.testTimeoutMs ?? 600_000,
      });
      const ok = r.code === 0 && !r.timedOut;
      results.push({ code: r.code, timedOut: r.timedOut, ...(ok ? {} : { output_tail: tail(r.output) }) });
    }
    const v = verdict(true, results);
    return v.stable ? v : { ...v, reason: `hidden tests passed ${v.passed}/${runs} runs on the merge commit` };
  } finally {
    git(["worktree", "remove", "--force", o.worktree]);
  }
}

/** Key of a finished verdict: a rerun skips it, a changed merge commit does not. */
export function stabilityKey(v: { id: string; merge_commit: string }): string {
  return `${v.id}@${v.merge_commit}`;
}

/** Latest verdict per key from a results JSONL (torn lines are ignored). */
export function readStabilityVerdicts(jsonl: string): Map<string, StabilityVerdict> {
  const out = new Map<string, StabilityVerdict>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as StabilityVerdict;
      if (typeof v.id === "string" && typeof v.merge_commit === "string") out.set(stabilityKey(v), v);
    } catch {
      // torn line — ignore
    }
  }
  return out;
}
