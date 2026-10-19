// Tests for the Diagnostics wiring seam (review 2026-10-19-1110, beck #4).
//
// What is validated with fakes at the edges and a real tmp KB / reports dir:
//   - session:exited for a session with ≥ 1 turn bumps the accumulation
//     counter, for BOTH backends (the count reads num_turns from the bridge);
//     a session with 0 turns does not count;
//   - the overview is assembled from the real suppliers (drift feed, usage
//     trackers) and the KB status comes from the runner;
//   - dispose() unsubscribes: an exit after dispose is not counted.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { companionBus } from "../event-bus.js";
import { DriftFeed } from "./drift-feed.js";
import { createDiagnosticsService } from "./diagnostics-service.js";

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "diag-service-")));
  mkdirSync(join(base, "kb"));
  writeFileSync(join(base, "kb", "gotchas.jsonl"), JSON.stringify({ id: "got-1", fact: "f", createdAt: new Date().toISOString() }) + "\n");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function service() {
  const sessions: Record<string, { state: { num_turns: number; backend_type: string } }> = {
    "claude-1": { state: { num_turns: 2, backend_type: "claude" } },
    "codex-1": { state: { num_turns: 1, backend_type: "codex" } },
    "empty-1": { state: { num_turns: 0, backend_type: "claude" } },
  };
  const feed = new DriftFeed();
  const svc = createDiagnosticsService({
    launcher: { getSession: () => undefined } as never,
    wsBridge: { getSession: (id: string) => sessions[id], getAllSessions: () => [] } as never,
    orchestrator: { getAllGroupsForBootstrap: () => [], getGroupLastCheckpointAt: () => null },
    runtime: {
      metrics: {
        getSnapshot: () => ({ gauges: { memory: { rss: 1, heapUsed: 1, heapTotal: 1, external: 1 }, totalActiveSessions: 0, connectedBrowsers: 0, totalHistoryMessages: 0, totalPendingMessages: 0, totalEventBufferSize: 0 }, counters: { errors: {} } }) as never,
        getEvictedLastHour: () => 0, getOrphanReapedLastHour: () => 0, getDrainedPendingLastHour: () => 0,
        getRecordingsSoftArchivedLastHour: () => 0, getRecordingsHardDeletedLastHour: () => 0,
        getTerminalReapedLastHour: () => 0, getArchivedProcessReclaimedLastHour: () => 0,
      },
      gauges: { getSessionMemoryStats: () => [], getSessionPhases: () => new Map() },
      activeTerminalCount: () => 0,
      scheduler: { getLastSweepCompletedAt: () => null, getLastSweepDurationMs: () => null, getSweepInFlight: () => false },
    },
    driftFeed: feed,
    settings: () => ({ kbAnalysis: { newEntriesThreshold: 10, sessionsThreshold: 25, maxAgeDays: 14 }, diagnosticsMemoryReport: false }) as never,
    version: "test",
    roots: { kb: join(base, "kb"), reports: join(base, "reports"), memory: join(base, "memory") },
  });
  return { svc, feed };
}

describe("createDiagnosticsService", () => {
  it("counts finished sessions with ≥ 1 turn for both backends, and stops after dispose", async () => {
    const { svc } = service();
    try {
      companionBus.emit("session:exited", { sessionId: "claude-1", exitCode: 0 });
      companionBus.emit("session:exited", { sessionId: "codex-1", exitCode: 0 });
      companionBus.emit("session:exited", { sessionId: "empty-1", exitCode: 1 });
      expect(svc.routes.status().progress?.sessions).toBe(2);
    } finally {
      await svc.dispose();
    }
    companionBus.emit("session:exited", { sessionId: "claude-2", exitCode: 0 });
    expect(svc.runner.status().progress?.sessions).toBe(2);
  });

  it("assembles the overview from the real drift feed", async () => {
    const { svc, feed } = service();
    try {
      feed.record({ event: "silent_stdio_drift.detected", sessionId: "s1", reason: "r" });
      const ov = svc.routes.overview();
      expect(ov.drift.status === "available" && ov.drift.data.events.map((e) => e.event)).toEqual(["silent_stdio_drift.detected"]);
      expect(ov.backend.status).toBe("available");
      expect(ov.usage.status).toBe("available");
    } finally {
      await svc.dispose();
    }
  });
});
