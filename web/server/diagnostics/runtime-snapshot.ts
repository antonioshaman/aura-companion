/**
 * The runtime snapshot behind the 5-minute `[diagnostics] Runtime snapshot`
 * log line AND the Diagnostics page's Backend card (plan Task 5; fowler 9,
 * dahl). One builder, so the log and the page cannot drift.
 *
 * EC-19: the payload key names are operator-facing API (log analysers and
 * alerts grep them). They are pinned as literals in this file by
 * `index-diagnostics-emit.test.ts` — rename only together with that canary.
 */

import type { GaugeDataProvider, MetricsCollector } from "../metrics-collector.js";

export interface RuntimeSnapshotDeps {
  metrics: Pick<
    MetricsCollector,
    | "getSnapshot"
    | "getEvictedLastHour"
    | "getOrphanReapedLastHour"
    | "getDrainedPendingLastHour"
    | "getRecordingsSoftArchivedLastHour"
    | "getRecordingsHardDeletedLastHour"
    | "getTerminalReapedLastHour"
    | "getArchivedProcessReclaimedLastHour"
  >;
  gauges: GaugeDataProvider;
  activeTerminalCount: () => number;
  scheduler: {
    getLastSweepCompletedAt(): number | null;
    getLastSweepDurationMs(): number | null;
    getSweepInFlight(): boolean;
  };
}

export interface RuntimeSnapshot {
  /** Exactly the object the 5-minute tick logs. */
  payload: Record<string, string | number | boolean | null>;
  /** Inputs the tick's memory-pressure WARN needs. */
  totalActiveSessions: number;
  unevictedArchivedCount: number;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

export function buildRuntimeSnapshot(deps: RuntimeSnapshotDeps): RuntimeSnapshot {
  const snap = deps.metrics.getSnapshot(deps.gauges);
  const mem = snap.gauges.memory;
  const sessionStats = deps.gauges.getSessionMemoryStats();
  const topSessions = [...sessionStats]
    .sort((a, b) => b.historyLen - a.historyLen)
    .slice(0, 3)
    .map((s) => `${s.id.slice(0, 8)}(h=${s.historyLen},b=${s.browsers})`)
    .join(", ");

  // PLAN T6: proxy for "archived rows still in the wsBridge.sessions Map that
  // Phase H eviction will reclaim." totalActiveSessions counts phase !=
  // "terminated"; the Map total includes terminated/archived rows.
  const unevictedArchivedCount = Math.max(0, sessionStats.length - snap.gauges.totalActiveSessions);

  const payload = {
    rss: `${mb(mem.rss)}MB`,
    heap: `${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB`,
    external: `${mb(mem.external)}MB`,
    sessions: snap.gauges.totalActiveSessions,
    browsers: snap.gauges.connectedBrowsers,
    historyMsgs: snap.gauges.totalHistoryMessages,
    pendingMsgs: snap.gauges.totalPendingMessages,
    eventBuffer: snap.gauges.totalEventBufferSize,
    errors: Object.values(snap.counters.errors).reduce((a, b) => a + b, 0),
    topSessions: topSessions || "none",
    // ── PLAN T6: cleanup-subsystem counters (Phase B projection methods) ──
    evictedLastHour: deps.metrics.getEvictedLastHour(),
    orphanReapedLastHour: deps.metrics.getOrphanReapedLastHour(),
    drainedPendingLastHour: deps.metrics.getDrainedPendingLastHour(),
    recordingsSoftArchivedLastHour: deps.metrics.getRecordingsSoftArchivedLastHour(),
    recordingsHardDeletedLastHour: deps.metrics.getRecordingsHardDeletedLastHour(),
    // ── reclamation plan T8: PTY-terminal observability ──
    terminalCount: deps.activeTerminalCount(),
    terminalReapedLastHour: deps.metrics.getTerminalReapedLastHour(),
    archivedProcessReclaimedLastHour: deps.metrics.getArchivedProcessReclaimedLastHour(),
    // ── PLAN T6: sweep-status fields (Phase C accessors on the scheduler) ──
    lastSweepCompletedAt: deps.scheduler.getLastSweepCompletedAt(),
    lastSweepDurationMs: deps.scheduler.getLastSweepDurationMs(),
    sweepInFlight: deps.scheduler.getSweepInFlight(),
  };
  return { payload, totalActiveSessions: snap.gauges.totalActiveSessions, unevictedArchivedCount };
}

/** When the 5-minute tick last logged a snapshot — the Backend card shows it. */
let lastLoggedAt: number | null = null;
export function noteRuntimeSnapshotLogged(at: number): void {
  lastLoggedAt = at;
}
export function getRuntimeSnapshotLoggedAt(): number | null {
  return lastLoggedAt;
}
