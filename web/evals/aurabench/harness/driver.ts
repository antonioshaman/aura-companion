/**
 * The AuraBench ablation loop (P6/D2). Plans task × variant × rep cells,
 * skips every key already in the results JSONL, and runs the rest one at a
 * time (concurrency 1: prod shares this 8 GB box):
 *
 *  - before each cell, holds while the subscription usage gate is closed
 *    (weekly / 5-hour ceiling, fail-closed — see `usage-ceiling.ts`),
 *    rechecking every 15 min, then waits while MemAvailable < 1.5 GB and
 *    while free disk < 5 GB (P6/DISK-GATE: bench codex-homes filled `/`,
 *    shared with prod, on 2026-10-06); cells that do not use Claude
 *    (`isClaudeCell` false) skip the usage gate;
 *  - a FATAL gate (prod's Claude OAuth dead, P6/FIX-D2-CLAUDE-AUTH) is
 *    re-confirmed a few times a minute apart and then STOPS the run
 *    (`stoppedOnAuth`) — never a silent multi-hour hold;
 *  - a cell that hits a usage limit is NOT recorded: the driver sleeps until
 *    the reset (see `limitSleepMs`) and retries the SAME cell — a multi-day
 *    run survives limits and restarts without duplicating finished cells;
 *  - after each recorded cell, reports progress (`cells_done`/`cells_total`)
 *    so the caller can mirror it into `STATE.bench`;
 *  - Codex quota (P6/FIX-CODEX-QUOTA, optional `codex` dep): a Codex cell
 *    starts only while the daily Codex budget is open and no Codex limit is
 *    pending. A Codex limit pauses EVERY Codex cell until its reset; Codex
 *    cells are deferred to the end of the plan and the Claude-only cells run
 *    on. When only deferred Codex cells remain, the driver sleeps (≤ 6 h at a
 *    time) until the Codex window opens; a budget of 0 stops the run
 *    resumably (`stoppedOnCodex`).
 *
 * All effects are injected; unit-tested. Firewall-clean.
 */

import { limitSleepMs, type LimitHit } from "./agent-metrics.js";
import { codexBudgetOpensAt } from "./codex-quota.js";
import { completedCellKeys, planCells, type CellRecord, type PlannedCell } from "./cells.js";
import type { CellOutcome } from "./run-cell.js";
import type { VariantId } from "./variants.js";
import { USAGE_HOLD_POLL_MS, formatUsageHold, type UsageGate } from "./usage-ceiling.js";

export interface DriverDeps {
  taskIds: readonly string[];
  variants: readonly VariantId[];
  reps: number;
  /** Current results JSONL text ("" if none). */
  readResults: () => string;
  appendResult: (rec: CellRecord) => void;
  runCell: (cell: PlannedCell) => Promise<CellOutcome>;
  memAvailableKb: () => number;
  /** Free KB on the bench filesystem; absent = no disk gate. */
  diskAvailableKb?: () => number;
  /** Subscription usage + auth gate, asked before every cell start (retries included). */
  usageGate?: (cell: PlannedCell) => Promise<UsageGate>;
  /**
   * Cells that spend the Claude subscription; only these ask `usageGate`.
   * Absent = every cell is gated (fail-closed). A Codex-only cell (B, F, G)
   * must not wait on the Claude weekly ceiling (P6/CODEX-ONLY-GATE).
   */
  isClaudeCell?: (cell: PlannedCell) => boolean;
  /** Consecutive fatal gate answers before the run stops (default 3). */
  fatalConfirmations?: number;
  /** Pause between fatal re-checks (default 60 s). */
  fatalRecheckMs?: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  onProgress?: (p: { done: number; total: number }) => void;
  /** Stop after this many newly recorded cells (pilot / smoke runs). */
  maxCells?: number;
  /** Consecutive limit hits on one cell before the driver gives up (exit, resumable). */
  maxLimitRetries?: number;
  /** Codex quota guard (see the header); absent = Codex cells are not gated. */
  codex?: CodexQuotaDeps;
}

export interface CodexQuotaDeps {
  isCodexCell: (cell: PlannedCell) => boolean;
  /** Max Codex cell starts per rolling 24 h (0 = none). */
  dailyCells: number;
  /** Epoch-ms of earlier Codex cell starts (the shared ledger). */
  starts: () => number[];
  noteStart: (at: number) => void;
}

/** Longest single sleep while only deferred Codex cells remain. */
export const CODEX_MAX_HOLD_MS = 6 * 3_600_000;
/** Pause after a Codex limit that carried no reset time. */
export const CODEX_UNKNOWN_RESET_MS = 20 * 60_000;

export const MIN_AVAILABLE_KB = 1.5 * 1024 * 1024;
/** Free disk below which no cell starts — the bench shares `/` with prod. */
export const MIN_DISK_AVAILABLE_KB = 5 * 1024 * 1024;
export const DISK_WAIT_MS = 5 * 60_000;

export interface DriverSummary {
  total: number;
  done: number;
  recorded: number;
  limitPauses: number;
  /** Number of 15-min usage-ceiling holds. */
  usageHolds: number;
  stoppedOnLimit: LimitHit | null;
  /** Why the run stopped on a confirmed fatal gate (prod auth dead), else null. */
  stoppedOnAuth: string | null;
  /** Codex cells left unrun because the Codex budget is 0 (resumable). */
  stoppedOnCodex: number;
  /** Sleeps spent waiting for the Codex window with only Codex cells left. */
  codexHolds: number;
}

/** `new Date(Infinity).toISOString()` throws — a budget of 0 opens never. */
const isoOrNever = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString() : "never (budget 0)");

export async function runAblation(d: DriverDeps): Promise<DriverSummary> {
  const plan = planCells(d.taskIds, d.variants, d.reps);
  const done = completedCellKeys(d.readResults());
  const planned = new Set(plan.map((c) => c.key));
  let doneCount = [...done].filter((k) => planned.has(k)).length;
  const summary: DriverSummary = {
    total: plan.length,
    done: doneCount,
    recorded: 0,
    limitPauses: 0,
    usageHolds: 0,
    stoppedOnLimit: null,
    stoppedOnAuth: null,
    stoppedOnCodex: 0,
    codexHolds: 0,
  };
  d.onProgress?.({ done: doneCount, total: plan.length });
  const maxRetries = d.maxLimitRetries ?? 50;
  d.log(`[aurabench] ${doneCount}/${plan.length} cells already recorded`);

  const codex = d.codex;
  let codexPausedUntil = 0;
  const codexOpensAt = (): number =>
    codex ? Math.max(codexPausedUntil, codexBudgetOpensAt(codex.starts(), codex.dailyCells, d.now())) : 0;
  const queue = plan.filter((c) => !done.has(c.key));
  const deferred: PlannedCell[] = [];
  const limitRetries = new Map<string, number>();
  let deferLogged = false;

  for (;;) {
    if (queue.length === 0) {
      if (deferred.length === 0) break;
      if (d.maxCells !== undefined && summary.recorded >= d.maxCells) break;
      const opens = codexOpensAt();
      if (opens === Number.POSITIVE_INFINITY) {
        summary.stoppedOnCodex = deferred.length;
        d.log(`[aurabench] ${deferred.length} Codex cells left, AURABENCH_CODEX_DAILY_CELLS=0 — stopping (rerun resumes them)`);
        return summary;
      }
      const wait = opens - d.now();
      if (wait > 0) {
        const ms = Math.min(CODEX_MAX_HOLD_MS, wait + 60_000);
        summary.codexHolds++;
        d.log(`[aurabench] only Codex cells left (${deferred.length}); Codex window opens ${new Date(opens).toISOString()} — sleeping ${Math.round(ms / 60_000)} min`);
        await d.sleep(ms);
      }
      queue.push(...deferred.splice(0));
      deferLogged = false;
      continue;
    }
    const cell = queue.shift()!;
    if (d.maxCells !== undefined && summary.recorded >= d.maxCells) break;
    const isCodex = codex?.isCodexCell(cell) ?? false;
    if (isCodex && codexOpensAt() > d.now()) {
      if (!deferLogged) {
        d.log(`[aurabench] Codex cells paused until ${isoOrNever(codexOpensAt())} — deferring them, Claude cells continue`);
        deferLogged = true;
      }
      deferred.push(cell);
      continue;
    }
    for (;;) {
      if (d.usageGate && (d.isClaudeCell?.(cell) ?? true)) {
        let fatalSeen = 0;
        for (let g = await d.usageGate(cell); !g.ok; g = await d.usageGate(cell)) {
          if (g.fatal) {
            if (++fatalSeen >= (d.fatalConfirmations ?? 3)) {
              summary.stoppedOnAuth = g.reason;
              d.log(`[aurabench] STOP: ${g.reason} (confirmed ${fatalSeen}x) — a human must restore prod auth; rerun resumes at ${cell.key}`);
              return summary;
            }
            d.log(`[aurabench] fatal gate (${g.reason}) — re-checking (${fatalSeen}/${d.fatalConfirmations ?? 3})`);
            await d.sleep(d.fatalRecheckMs ?? 60_000);
            continue;
          }
          fatalSeen = 0;
          summary.usageHolds++;
          d.log(formatUsageHold(g));
          await d.sleep(USAGE_HOLD_POLL_MS);
        }
      }
      while (d.memAvailableKb() < MIN_AVAILABLE_KB) {
        d.log("[aurabench] MemAvailable < 1.5 GB — waiting 30s");
        await d.sleep(30_000);
      }
      while (d.diskAvailableKb && d.diskAvailableKb() < MIN_DISK_AVAILABLE_KB) {
        d.log("[aurabench] free disk < 5 GB — waiting 5 min");
        await d.sleep(DISK_WAIT_MS);
      }
      const started = d.now();
      if (isCodex) codex!.noteStart(started);
      const out = await d.runCell(cell);
      if (out.kind === "record") {
        d.appendResult(out.record);
        done.add(cell.key);
        doneCount++;
        summary.recorded++;
        summary.done = doneCount;
        d.onProgress?.({ done: doneCount, total: plan.length });
        const r = out.record;
        d.log(
          `[aurabench] ${cell.key} ${r.status}${r.success ? " SUCCESS" : ""} ` +
            `(${Math.round((d.now() - started) / 1000)}s) ${doneCount}/${plan.length}`,
        );
        break;
      }
      summary.limitPauses++;
      const retries = (limitRetries.get(cell.key) ?? 0) + 1;
      limitRetries.set(cell.key, retries);
      if (retries > maxRetries) {
        summary.stoppedOnLimit = out.limit;
        d.log(`[aurabench] ${cell.key}: ${maxRetries} limit retries exhausted — stopping (rerun resumes here)`);
        return summary;
      }
      if (codex && out.limit.provider === "codex") {
        // Pause every Codex cell, not just this one; Claude cells run on.
        // A reset already past (clock skew) still pauses ≥ 1 min — no hot retry loop.
        codexPausedUntil = Math.max(codexPausedUntil, out.limit.resetAt ?? d.now() + CODEX_UNKNOWN_RESET_MS, d.now() + 60_000);
        d.log(`[aurabench] ${cell.key}: Codex usage limit (${out.limit.message.slice(0, 120)}) — Codex cells paused until ${new Date(codexPausedUntil).toISOString()}`);
        deferLogged = true;
        deferred.push(cell);
        break;
      }
      const ms = limitSleepMs(out.limit, d.now());
      d.log(`[aurabench] ${cell.key}: usage limit (${out.limit.message.slice(0, 120)}) — sleeping ${Math.round(ms / 60_000)} min`);
      await d.sleep(ms);
    }
  }
  return summary;
}
