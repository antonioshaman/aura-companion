/**
 * Where a cell's checkout lives, and the per-project CLI state keyed on it
 * (P6/FIX-D2-3).
 *
 * Pilot 1 ran every cell in the same `<bench-root>/wt/cell`. Two problems:
 *
 *  - Claude keys per-project state (transcripts, auto-memory) on the cwd, so
 *    the Aura variants' shared bench HOME carried `projects/<cwd>` across
 *    tasks, variants and reps, while naked A got a fresh config dir per cell;
 *  - the checkout sat next to `<bench-root>/cells` (other cells' diffs and
 *    transcripts — for the same task, i.e. solutions) and two levels below
 *    `$WORK/repo` (which holds the merge commits): `ls ..` found them.
 *
 * Now every cell gets `<wt-root>/c-<16 hex>`, a fresh random directory under
 * a root that must lie outside the bench root and the repo (default: the OS
 * temp dir). The agent is not sandboxed, so those paths stay reachable by
 * absolute path; that residue is recorded per cell as a confound
 * ({@link CELL_PATH_CONFOUND}), not hidden.
 */

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { emptyMetrics } from "./agent-metrics.js";
import type { AgentRunner } from "./run-cell.js";

const CELL_DIR = /^c-[0-9a-f]{16}$/;

export const CELL_PATH_CONFOUND =
  "agent runs unsandboxed: the bench root (other cells' results) and the bench clone (holds merge commits) are not adjacent to the checkout but remain reachable by absolute path";

/** `a` is `b` or lies inside it. */
function within(a: string, b: string): boolean {
  const rel = relative(resolve(b), resolve(a));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validate the worktree root: absolute, and neither inside nor containing any
 * of `forbidden` (bench root, repo). Returns the reason when it is unusable.
 */
export function checkWorktreeRoot(wtRoot: string, forbidden: readonly string[]): string | null {
  if (!isAbsolute(wtRoot)) return `worktree root must be absolute: ${wtRoot}`;
  for (const f of forbidden) {
    if (within(wtRoot, f) || within(f, wtRoot)) return `worktree root ${wtRoot} overlaps ${f}; cells must not sit next to results or the repo`;
  }
  return null;
}

/** A fresh, unpredictable checkout path for one cell. */
export function newCellWorktree(wtRoot: string, rand: () => string = () => randomBytes(8).toString("hex")): string {
  return join(wtRoot, `c-${rand()}`);
}

/** Remove checkouts left by an interrupted run (only `c-<16 hex>` entries —
 *  never anything else that may live in the root). Returns what it removed. */
export function sweepStaleCellWorktrees(wtRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(wtRoot);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const n of names) {
    if (!CELL_DIR.test(n)) continue;
    rmSync(join(wtRoot, n), { recursive: true, force: true });
    removed.push(n);
  }
  return removed;
}

/** Claude Code's per-project directory name for a cwd (`/a/b.c` → `-a-b-c`). */
export function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface ProjectStateEvidence {
  key: string;
  /** Per-project state already existed before the agent ran (must be false). */
  preexisting: boolean;
  /** Where the cell's per-project state was moved after the run, or null. */
  archived_to: string | null;
}

/**
 * Wrap an Aura runner so its per-project Claude state is proven clean: the
 * `projects/<key>` directory of the cell's checkout must not exist before the
 * run (a pre-existing one fails the cell as `agent_error` — the agent would
 * start with another run's transcripts/memory); afterwards it is moved into
 * the cell's artifact dir, so the shared bench HOME accumulates no project
 * state and the transcripts stay with the cell. Evidence →
 * `isolation.claude_project`.
 */
export function withCleanClaudeProject(runner: AgentRunner, projectsDir: string): AgentRunner {
  return async (ctx) => {
    const key = claudeProjectKey(ctx.worktree);
    const dir = join(projectsDir, key);
    if (existsSync(dir)) {
      const evidence: ProjectStateEvidence = { key, preexisting: true, archived_to: null };
      return {
        kind: "done",
        status: "agent_error",
        metrics: emptyMetrics(),
        isolation: { claude_project: evidence },
        confounds: [],
        error: `per-project Claude state already exists for this checkout: ${dir}`,
      };
    }
    const run = await runner(ctx);
    let archived: string | null = null;
    if (existsSync(dir)) {
      archived = join(ctx.artifactDir, "claude-project");
      cpSync(dir, archived, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
    }
    if (run.kind !== "done") return run;
    const evidence: ProjectStateEvidence = { key, preexisting: false, archived_to: archived };
    return { ...run, isolation: { ...run.isolation, claude_project: evidence } };
  };
}
