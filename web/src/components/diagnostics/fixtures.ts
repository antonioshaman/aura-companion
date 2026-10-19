/** Shared fixtures for the Diagnostics component tests. */
import type { DiagnosticsOverview, KbAnalysisStatus, KbFinding } from "../../api.js";

export const NOW = Date.parse("2026-10-19T12:00:00Z");
const MIN = 60_000;

export function overview(over: Partial<DiagnosticsOverview> = {}): DiagnosticsOverview {
  return {
    generatedAt: NOW,
    backend: {
      status: "available",
      fetchedAt: NOW,
      data: { pid: 4242, uptimeMs: 3 * 3_600_000, version: "0.99.0", bunVersion: "1.4.3", snapshot: { sessions: 3, browsers: 1, rss: "120.0MB" }, lastLoggedAt: NOW - 2 * MIN },
    },
    pairs: {
      status: "available",
      fetchedAt: NOW,
      data: [
        {
          sessionGroupId: "grp_1",
          status: "active",
          pairing: "claude+codex",
          lastCheckpointAt: NOW - 25 * MIN,
          lastWakeAt: NOW - 24 * MIN,
          halves: [
            { sessionId: "orch-1", role: "orchestrator", backendType: "claude", state: "connected", pid: 11, exitCode: null, lastInboundFrameAt: NOW - 10_000 },
            { sessionId: "obs-1", role: "observer", backendType: "codex", state: "connected", pid: 22, exitCode: null, lastInboundFrameAt: NOW - 20 * MIN },
          ],
        },
      ],
    },
    drift: {
      status: "available",
      fetchedAt: NOW,
      data: {
        events: [
          { ts: NOW - 5 * MIN, event: "silent_stdio_drift.detected", sessionId: "s1", reason: "jsonl mtime 26s newer", fields: { mtimeDeltaMs: 26358 } },
          { ts: NOW - 10 * MIN, event: "silent_stdio_drift.withheld_open_tool_call", sessionId: "s1", fields: { toolCallStartedAtMs: NOW - 11 * MIN } },
          { ts: NOW - 3 * 60 * MIN, event: "silent_stdio_drift.reply_recovered", sessionId: "s2", fields: {} },
        ],
        windowStart: NOW - 6 * 60 * MIN,
        wrapped: false,
        capacity: 500,
        totalInWindow: 3,
      },
    },
    contextAdvisory: { status: "available", fetchedAt: NOW, data: [{ sessionId: "s1", backendType: "claude", advisory: { tier: "handoff", milestoneBytes: 12 * 1024 * 1024, at: NOW - MIN } }] },
    usage: {
      status: "available",
      fetchedAt: NOW,
      data: {
        globalStats: { ok: false, lastOkAt: NOW - 3 * 60 * MIN, failure: { kind: "kv-quota", httpStatus: 429, since: Date.parse("2026-10-19T11:02:00") } },
        usageLimits: { ok: true, lastOkAt: NOW - MIN, failure: null },
      },
    },
    ...over,
  };
}

export const FINDINGS: KbFinding[] = [
  {
    entryId: "got-017",
    signals: [{ signal: "never-used", criterion: "usageCount 0, not in usage.log, created 2026-07-02 (109 days ≥ 30)" }],
    suggested: "archive",
    entry: {
      id: "got-017", file: "gotchas.jsonl", type: "gotcha", fact: "Fact 17", recommendation: "Do 17", confidence: "medium",
      tags: [], affectedFiles: [{ path: "web/gone.ts", exists: false }], provenance: [], createdAt: "2026-07-02T00:00:00Z",
      usage: 0, helpfulCount: 0, outdatedReports: 0, promoted: false,
    },
  },
  {
    entryId: "got-040",
    signals: [{ signal: "duplicate", criterion: "identical normalised fact", partnerId: "got-041", similarity: 1 }],
    suggested: "merge",
    entry: {
      id: "got-040", file: "gotchas.jsonl", type: "gotcha", fact: "Same fact", recommendation: "", confidence: "low",
      tags: [], affectedFiles: [], provenance: [], createdAt: null, usage: 0, helpfulCount: 0, outdatedReports: 0, promoted: false,
    },
  },
];

export function kbStatus(over: Partial<KbAnalysisStatus> = {}): KbAnalysisStatus {
  return {
    inFlight: null,
    lastRun: { runId: "run-1", at: NOW - 2 * 86_400_000, trigger: "entries" },
    lastFailure: null,
    autoTriggerSuppressed: false,
    progress: { newEntries: 3, newEntriesThreshold: 10, sessions: 7, sessionsThreshold: 25, ageDays: 2, maxAgeDays: 14, dueInDays: 12, due: false, reason: null },
    health: { total: 152, used: 2, helpful: 9, promoted: 1, stale: 3, neverSurfaced: 150, idle: 0, parseErrors: 0 },
    memoryReportEnabled: false,
    report: {
      status: "available",
      fetchedAt: NOW,
      data: { schemaVersion: 1, runId: "run-1", generatedAt: NOW - 2 * 86_400_000, trigger: "entries", kbEntryCount: 152, kbParseErrors: 0, findings: FINDINGS, mergeTasks: [], memory: null },
    },
    decisions: {},
    ...over,
  };
}
