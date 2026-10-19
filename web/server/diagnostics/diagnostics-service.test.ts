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

function service(extra: { groups?: unknown[]; bridgeSessions?: unknown[]; launcherSession?: (id: string) => unknown } = {}) {
  const sessions: Record<string, { state: { num_turns: number; backend_type: string } }> = {
    "claude-1": { state: { num_turns: 2, backend_type: "claude" } },
    "codex-1": { state: { num_turns: 1, backend_type: "codex" } },
    "empty-1": { state: { num_turns: 0, backend_type: "claude" } },
  };
  const feed = new DriftFeed();
  const svc = createDiagnosticsService({
    launcher: { getSession: extra.launcherSession ?? (() => undefined) } as never,
    wsBridge: {
      getSession: (id: string) =>
        sessions[id] ?? (id.startsWith("orch") || id.startsWith("obs") ? { backendAdapter: { getLastCliFrameReceivedMs: () => 1234 } } : undefined),
      getAllSessions: () => extra.bridgeSessions ?? [],
    } as never,
    orchestrator: {
      getAllGroupsForBootstrap: () => (extra.groups ?? []) as never,
      getGroupLastCheckpointAt: () => 999,
    },
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

describe("createDiagnosticsService — suppliers and routes", () => {
  it("builds pairs (frame time, checkpoint, wake sentinel) and context advisories from the real wiring", async () => {
    const { svc } = service({
      groups: [{ sessionGroupId: "grp_1", primarySessionId: "orch-1", observerSessionId: "obs-1", pairing: "claude+codex", status: "active" }],
      launcherSession: (id) => ({ backendType: id === "obs-1" ? "codex" : "claude", state: "connected", pid: 7, exitCode: null, cwd: base }),
      bridgeSessions: [
        { session_id: "s1", backend_type: "codex", context_advisory: { tier: "handoff", signal: "codex_compactions", milestone: 2, at: 1 } },
        { session_id: "s2", context_advisory: null },
      ],
    });
    try {
      const ov = svc.routes.overview();
      if (ov.pairs.status !== "available") throw new Error("pairs unavailable");
      expect(ov.pairs.data[0]).toMatchObject({ sessionGroupId: "grp_1", lastCheckpointAt: 999, lastWakeAt: null });
      expect(ov.pairs.data[0].halves.map((h) => [h.role, h.backendType, h.lastInboundFrameAt])).toEqual([
        ["orchestrator", "claude", 1234],
        ["observer", "codex", 1234],
      ]);
      expect(ov.contextAdvisory.status === "available" && ov.contextAdvisory.data).toEqual([
        { sessionId: "s1", backendType: "codex", advisory: { tier: "handoff", signal: "codex_compactions", milestone: 2, at: 1 } },
      ]);
      expect(ov.backend.status === "available" && ov.backend.data.version).toBe("test");
    } finally {
      await svc.dispose();
    }
  });

  it("a supplier that throws marks only its card unavailable", async () => {
    const { svc } = service({
      groups: [{ sessionGroupId: "grp_1", primarySessionId: "orch-1", observerSessionId: "obs-1", pairing: "x", status: "active" }],
      launcherSession: () => {
        throw new Error("launcher down");
      },
    });
    try {
      const ov = svc.routes.overview();
      expect(ov.pairs).toMatchObject({ status: "unavailable", reason: "source-error" });
      expect(ov.drift.status).toBe("available");
    } finally {
      await svc.dispose();
    }
  });

  it("runs an analysis and applies a keep decision through the route deps", async () => {
    writeFileSync(join(base, "kb", "gotchas.jsonl"), JSON.stringify({ id: "got-old", fact: "old fact", usageCount: 0, createdAt: "2026-01-01T00:00:00Z" }) + "\n");
    const { svc } = service();
    try {
      expect(svc.routes.requestRun({ includeMemory: false }).kind).toBe("started");
      await svc.runner._waitForRun();
      expect(svc.routes.isRunning()).toBe(false);
      const report = svc.routes.currentReport();
      expect(report?.findings.map((f) => f.entryId)).toEqual(["got-old"]);
      const v = svc.routes.validate({ runId: report!.runId, decisions: [{ entryId: "got-old", decision: "keep" }] }, report);
      if (!v.ok) throw new Error(v.error);
      expect(svc.routes.apply(v)).toEqual({ ok: true, applied: [{ entryId: "got-old", decision: "keep" }] });
      svc.routes.afterDecisions();
      expect(svc.routes.status().decisions["got-old"]).toMatchObject({ decision: "keep" });
    } finally {
      await svc.dispose();
    }
  });
});
