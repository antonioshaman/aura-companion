/**
 * Accumulation trigger for the KB analyzer (spec §3.2; plan Task 11, AC4/AC5).
 *
 * Pure: the same progress struct feeds the KB card ("3/10 entries · 7/25
 * sessions · due in ≤12 days"), the once-a-day "not due" log line and the
 * API, so the numbers come from exactly one place.
 */

import { entriesOf, type KbLoad } from "../knowledge/kb-store.js";
import type { AccumulationProgress } from "./diagnostics-types.js";
import type { KbAnalysisSettings } from "./kb-analysis-settings.js";

const DAY = 86_400_000;

/** Entries created or updated after `sinceMs` (by their own timestamps — a git checkout rewrites file mtimes). */
export function countNewEntries(load: KbLoad, sinceMs: number | null): number {
  const entries = entriesOf(load);
  if (sinceMs === null) return entries.length;
  return entries.filter((e) => {
    const c = typeof e.createdAt === "string" ? Date.parse(e.createdAt) : NaN;
    const u = typeof e.updatedAt === "string" ? Date.parse(e.updatedAt) : NaN;
    return (Number.isFinite(c) && c > sinceMs) || (Number.isFinite(u) && u > sinceMs);
  }).length;
}

export function evaluateTrigger(input: {
  lastRunAt: number | null;
  newEntries: number;
  sessions: number;
  now: number;
  thresholds: KbAnalysisSettings;
}): AccumulationProgress {
  const { lastRunAt, newEntries, sessions, now, thresholds } = input;
  // Never analysed: due by age, so the first report exists right away.
  const ageDays = lastRunAt === null ? thresholds.maxAgeDays : Math.max(0, Math.floor((now - lastRunAt) / DAY));
  const reason: AccumulationProgress["reason"] =
    newEntries >= thresholds.newEntriesThreshold
      ? "entries"
      : sessions >= thresholds.sessionsThreshold
        ? "sessions"
        : ageDays >= thresholds.maxAgeDays
          ? "age"
          : null;
  return {
    newEntries,
    newEntriesThreshold: thresholds.newEntriesThreshold,
    sessions,
    sessionsThreshold: thresholds.sessionsThreshold,
    ageDays,
    maxAgeDays: thresholds.maxAgeDays,
    dueInDays: Math.max(0, thresholds.maxAgeDays - ageDays),
    due: reason !== null,
    reason,
  };
}

/** The exact KB-card wording for AC4. */
export function formatProgress(p: AccumulationProgress): string {
  const due = p.due ? "due now" : `due in ≤${p.dueInDays} days`;
  return `${p.newEntries}/${p.newEntriesThreshold} entries · ${p.sessions}/${p.sessionsThreshold} sessions · ${due}`;
}
