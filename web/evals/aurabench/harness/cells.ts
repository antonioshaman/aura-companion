/**
 * AuraBench cell = (task × variant × repetition). One JSONL line per finished
 * cell in `$WORK/bench/results/cells.jsonl`; the key makes the run idempotent:
 * a restarted run skips every key that already has a record, so a multi-day
 * ablation survives restarts and subscription-limit pauses without
 * duplicating work.
 *
 * A cell that hit a usage limit is NOT a result — it is never written, and the
 * runner retries it after the limit resets. A cell that ran into the 60-min
 * wall clock IS a result (`status: "timeout"`, counted as a failure).
 *
 * Firewall-clean. Never `server/`.
 */

import type { AuraBenchClass } from "../task.js";
import type { VariantId } from "./variants.js";

export const CELL_RECORD_VERSION = 1 as const;

export type CellStatus =
  /** Agent finished on its own. */
  | "completed"
  /** Hit the per-cell wall clock (60 min) — a failure, not a retry. */
  | "timeout"
  /** Agent process / session failed (crash, spawn error, error result). */
  | "agent_error"
  /** The harness itself failed before the agent could run (worktree, install). */
  | "harness_error";

export interface AgentMetrics {
  turns: number | null;
  tool_calls: number;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  /** API-equivalent USD (Claude: `total_cost_usd`; Codex: null — priced in D3 from tokens).
   *  Every numeric field here: null = UNKNOWN, never averaged as 0. */
  cost_usd: number | null;
  /** Model(s) the agent reported actually using (init frame / session /
   *  Codex rollout); [] = unknown, never back-filled from the pinned model. */
  models: string[];
}

export interface HiddenTestOutcome {
  /** Every hidden test file ran and vitest exited 0. */
  passed: boolean;
  tests_passed: number;
  tests_failed: number;
  /** Hidden test files the agent had modified before they were restored. */
  tampered: string[];
}

export interface RegressionOutcome {
  /** Test files that were green on the pristine base and are red now. */
  regressed: string[];
  /** Test files run after the agent (vitest `related` of the changed sources, minus hidden tests). */
  checked: number;
  /** Checked files with no baseline verdict (outside the baseline zone / new files). */
  unknown: number;
}

export interface DiffStats {
  files_touched: number;
  loc_added: number;
  loc_removed: number;
  files: string[];
}

export interface CellRecord {
  v: typeof CELL_RECORD_VERSION;
  key: string;
  task_id: string;
  task_class: AuraBenchClass;
  variant: VariantId;
  rep: number;
  status: CellStatus;
  /** completed AND hidden tests passed AND no regressions. */
  success: boolean;
  hidden: HiddenTestOutcome | null;
  regressions: RegressionOutcome | null;
  diff: DiffStats | null;
  metrics: AgentMetrics;
  wall_clock_ms: number;
  started_at: string;
  finished_at: string;
  /** Isolation proof (naked: init-frame facts; aura: bench instance facts). */
  isolation: Record<string, unknown>;
  /** Known confounds for this cell (e.g. `~/.codex/AGENTS.md` present). */
  confounds: string[];
  error?: string;
}

export function cellKey(taskId: string, variant: VariantId, rep: number): string {
  return `${taskId}|${variant}|${rep}`;
}

export interface PlannedCell {
  key: string;
  taskId: string;
  variant: VariantId;
  rep: number;
}

/**
 * Cell order: repetition-major, then task, then variant — so a partial run
 * (limits, restarts) still has every variant of the same task×rep side by
 * side, instead of all reps of variant A before any of B.
 */
export function planCells(taskIds: readonly string[], variants: readonly VariantId[], reps: number): PlannedCell[] {
  const out: PlannedCell[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const taskId of taskIds) {
      for (const variant of variants) out.push({ key: cellKey(taskId, variant, rep), taskId, variant, rep });
    }
  }
  return out;
}

/** Keys with a record in a results JSONL. Torn / malformed lines are ignored
 *  (that cell simply reruns). */
export function completedCellKeys(jsonl: string): Set<string> {
  const done = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as { key?: unknown; v?: unknown };
      if (v.v === CELL_RECORD_VERSION && typeof v.key === "string") done.add(v.key);
    } catch {
      // torn line — ignore
    }
  }
  return done;
}
