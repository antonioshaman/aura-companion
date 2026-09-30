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

import { isAuraBenchClass, type AuraBenchClass } from "../task.js";
import type { DietOverlayEvidence } from "./diet-overlay.js";
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
  /** Prompt tokens of the orchestrator's FIRST model call (input + cache read
   *  + cache write) — the size of the standing context (system prompt,
   *  CLAUDE.md, skills list, …) before any work. The DIET-AB metric; Claude
   *  only (Codex reports usage per turn, not per call). Absent/null = unknown. */
  context_first_call?: number | null;
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
  /** sha256 of the task prompt the agent was given. A record whose sha no
   *  longer matches the corpus measured a different task and must not be
   *  reused (see {@link staleCellRecords}). Absent on pre-D2-full records. */
  prompt_sha256?: string;
  /** DIET-AB: which control-file version was overlaid on the checkout
   *  (see `diet-overlay.ts`). Absent = the task's own historical files. */
  diet_overlay?: DietOverlayEvidence;
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

export interface StaleCellRecords {
  /** Records stamped with a prompt sha that differs from the current prompt. */
  mismatched: { key: string; recorded: string; current: string }[];
  /** Records of a selected task with no prompt stamp (legacy) — reuse unproven. */
  unstamped: string[];
}

/**
 * Reuse guard: the cell key has no prompt hash, so a rewritten prompt would
 * silently count an old run as done. Only tasks in `currentSha` are checked
 * (records of unselected tasks are not this run's business).
 */
export function staleCellRecords(jsonl: string, currentSha: ReadonlyMap<string, string>): StaleCellRecords {
  const out: StaleCellRecords = { mismatched: [], unstamped: [] };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let v: Partial<CellRecord>;
    try {
      v = JSON.parse(line) as Partial<CellRecord>;
    } catch {
      continue; // torn line — reruns anyway
    }
    if (v.v !== CELL_RECORD_VERSION || typeof v.key !== "string" || typeof v.task_id !== "string") continue;
    const current = currentSha.get(v.task_id);
    if (current === undefined) continue;
    if (typeof v.prompt_sha256 !== "string") out.unstamped.push(v.key);
    else if (v.prompt_sha256 !== current) out.mismatched.push({ key: v.key, recorded: v.prompt_sha256, current });
  }
  return out;
}

/**
 * `--timeout-min-class architecture=120,debug=90` → minutes per task class.
 * Fail-closed: an unknown class or a non-positive / non-numeric value is an
 * error, never a silently dropped override.
 */
export function parseClassTimeouts(
  spec: string | undefined,
): { ok: true; minutes: Partial<Record<AuraBenchClass, number>> } | { ok: false; reason: string } {
  const minutes: Partial<Record<AuraBenchClass, number>> = {};
  if (spec === undefined || spec.trim() === "") return { ok: true, minutes };
  for (const part of spec.split(",")) {
    const m = /^\s*([a-z]+)\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!m) return { ok: false, reason: `bad --timeout-min-class entry "${part}" (want class=minutes)` };
    const [, cls, min] = m;
    if (!isAuraBenchClass(cls)) return { ok: false, reason: `unknown task class "${cls}" in --timeout-min-class` };
    const n = Number(min);
    if (!(n > 0)) return { ok: false, reason: `--timeout-min-class ${cls} must be > 0 minutes` };
    minutes[cls] = n;
  }
  return { ok: true, minutes };
}
