// Tests for the shared runtime snapshot builder (plan Task 5).
//
// What is validated: the builder returns exactly the key set the 5-minute log
// line has always carried (EC-19 — operator-facing API), formats memory in MB,
// ranks the top three sessions by history length, and derives the
// "unevicted archived" count the memory-pressure WARN needs.

import { describe, expect, it } from "vitest";
import { buildRuntimeSnapshot, type RuntimeSnapshotDeps } from "./runtime-snapshot.js";

function deps(): RuntimeSnapshotDeps {
  const stats = [
    { id: "aaaaaaaa-1", browsers: 1, historyLen: 5, eventBufferLen: 0, pendingMsgs: 0 },
    { id: "bbbbbbbb-2", browsers: 0, historyLen: 50, eventBufferLen: 0, pendingMsgs: 0 },
    { id: "cccccccc-3", browsers: 2, historyLen: 20, eventBufferLen: 0, pendingMsgs: 0 },
    { id: "dddddddd-4", browsers: 0, historyLen: 1, eventBufferLen: 0, pendingMsgs: 0 },
  ];
  return {
    metrics: {
      getSnapshot: () =>
        ({
          gauges: {
            memory: { rss: 100 * 1024 * 1024, heapUsed: 10 * 1024 * 1024, heapTotal: 20 * 1024 * 1024, external: 1024 * 1024 },
            totalActiveSessions: 3,
            connectedBrowsers: 3,
            totalHistoryMessages: 76,
            totalPendingMessages: 0,
            totalEventBufferSize: 0,
          },
          counters: { errors: { a: 1, b: 2 } },
        }) as never,
      getEvictedLastHour: () => 1,
      getOrphanReapedLastHour: () => 2,
      getDrainedPendingLastHour: () => 3,
      getRecordingsSoftArchivedLastHour: () => 4,
      getRecordingsHardDeletedLastHour: () => 5,
      getTerminalReapedLastHour: () => 6,
      getArchivedProcessReclaimedLastHour: () => 7,
    },
    gauges: { getSessionMemoryStats: () => stats, getSessionPhases: () => new Map() },
    activeTerminalCount: () => 2,
    scheduler: { getLastSweepCompletedAt: () => 123, getLastSweepDurationMs: () => 45, getSweepInFlight: () => false },
  };
}

describe("buildRuntimeSnapshot", () => {
  it("returns the documented log payload keys and values", () => {
    const r = buildRuntimeSnapshot(deps());
    expect(Object.keys(r.payload).sort()).toEqual(
      [
        "rss", "heap", "external", "sessions", "browsers", "historyMsgs", "pendingMsgs", "eventBuffer", "errors",
        "topSessions", "evictedLastHour", "orphanReapedLastHour", "drainedPendingLastHour",
        "recordingsSoftArchivedLastHour", "recordingsHardDeletedLastHour", "terminalCount", "terminalReapedLastHour",
        "archivedProcessReclaimedLastHour", "lastSweepCompletedAt", "lastSweepDurationMs", "sweepInFlight",
      ].sort(),
    );
    expect(r.payload).toMatchObject({ rss: "100.0MB", heap: "10.0/20.0MB", errors: 3, terminalCount: 2, sweepInFlight: false });
    expect(r.payload.topSessions).toBe("bbbbbbbb(h=50,b=0), cccccccc(h=20,b=2), aaaaaaaa(h=5,b=1)");
    expect(r.unevictedArchivedCount).toBe(1);
    expect(r.totalActiveSessions).toBe(3);
  });
});
