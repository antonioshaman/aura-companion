/**
 * The AuraBench ablation loop (P6/D2). Plans task × variant × rep cells,
 * skips every key already in the results JSONL, and runs the rest one at a
 * time (concurrency 1: prod shares this 8 GB box):
 *
 *  - before each cell, holds while the subscription usage gate is closed
 *    (weekly / 5-hour ceiling, fail-closed — see `usage-ceiling.ts`),
 *    rechecking every 15 min, then waits while MemAvailable < 1.5 GB;
 *  - a FATAL gate (prod's Claude OAuth dead, P6/FIX-D2-CLAUDE-AUTH) is
 *    re-confirmed a few times a minute apart and then STOPS the run
 *    (`stoppedOnAuth`) — never a silent multi-hour hold;
 *  - a cell that hits a usage limit is NOT recorded: the driver sleeps until
 *    the reset (see `limitSleepMs`) and retries the SAME cell — a multi-day
 *    run survives limits and restarts without duplicating finished cells;
 *  - after each recorded cell, reports progress (`cells_done`/`cells_total`)
 *    so the caller can mirror it into `STATE.bench`.
 *
 * All effects are injected; unit-tested. Firewall-clean.
 */

import { limitSleepMs, type LimitHit } from "./agent-metrics.js";
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
  /** Subscription usage + auth gate, asked before every cell start (retries included). */
  usageGate?: (cell: PlannedCell) => Promise<UsageGate>;
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
}

export const MIN_AVAILABLE_KB = 1.5 * 1024 * 1024;

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
}

export async function runAblation(d: DriverDeps): Promise<DriverSummary> {
  const plan = planCells(d.taskIds, d.variants, d.reps);
  const done = completedCellKeys(d.readResults());
  const planned = new Set(plan.map((c) => c.key));
  let doneCount = [...done].filter((k) => planned.has(k)).length;
  const summary: DriverSummary = { total: plan.length, done: doneCount, recorded: 0, limitPauses: 0, usageHolds: 0, stoppedOnLimit: null, stoppedOnAuth: null };
  d.onProgress?.({ done: doneCount, total: plan.length });
  const maxRetries = d.maxLimitRetries ?? 50;
  d.log(`[aurabench] ${doneCount}/${plan.length} cells already recorded`);

  for (const cell of plan) {
    if (done.has(cell.key)) continue;
    if (d.maxCells !== undefined && summary.recorded >= d.maxCells) break;
    let retries = 0;
    for (;;) {
      if (d.usageGate) {
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
      const started = d.now();
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
      if (++retries > maxRetries) {
        summary.stoppedOnLimit = out.limit;
        d.log(`[aurabench] ${cell.key}: ${maxRetries} limit retries exhausted — stopping (rerun resumes here)`);
        return summary;
      }
      const ms = limitSleepMs(out.limit, d.now());
      d.log(`[aurabench] ${cell.key}: usage limit (${out.limit.message.slice(0, 120)}) — sleeping ${Math.round(ms / 60_000)} min`);
      await d.sleep(ms);
    }
  }
  return summary;
}
