// Tests for the Diagnostics overview aggregator (plan Task 8; AC3 + spec §3.5).
//
// What is validated:
//   - one throwing supplier marks ONLY its card unavailable (reason + since);
//     the other cards stay available — the page never blanks because one
//     source failed;
//   - lists are capped at the producer;
//   - a fully populated fixture (every list at its cap, long reasons) still
//     serialises under the 50 KB budget, so a future field addition that
//     breaks the budget fails here loudly.

import { describe, expect, it, vi } from "vitest";
import {
  buildDiagnosticsOverview,
  OVERVIEW_BUDGET_BYTES,
  OVERVIEW_MAX_ADVISORIES,
  OVERVIEW_MAX_DRIFT_EVENTS,
  OVERVIEW_MAX_PAIRS,
  type DiagnosticsOverviewDeps,
} from "./overview.js";

const NOW = 1_792_400_000_000;

function fullDeps(): DiagnosticsOverviewDeps {
  const longReason = "jsonl mtime 26s newer than bun's last frame (age 3s) while jsonl actively writing; 4 undelivered".padEnd(200, "x");
  return {
    now: () => NOW,
    runtime: () => ({
      pid: 12345,
      uptimeMs: 123456789,
      version: "0.99.0",
      bunVersion: "1.4.3",
      snapshot: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`key${i}`, `value-${i}-xxxxxxxxxx`])),
      lastLoggedAt: NOW - 60_000,
    }),
    pairs: () =>
      Array.from({ length: OVERVIEW_MAX_PAIRS + 10 }, (_, i) => ({
        sessionGroupId: `grp_${"a".repeat(32)}${i}`,
        status: "degraded",
        deadRole: "observer",
        degradedReason: "wake_produced_no_review",
        pairing: "claude+codex",
        lastCheckpointAt: NOW - i,
        lastWakeAt: NOW - i,
        halves: (["orchestrator", "observer"] as const).map((role) => ({
          sessionId: "00000000-0000-0000-0000-000000000000",
          role,
          backendType: "codex",
          state: "connected",
          pid: 99999,
          exitCode: 137,
          lastInboundFrameAt: NOW - 1000,
        })),
      })),
    drift: () => ({
      events: Array.from({ length: OVERVIEW_MAX_DRIFT_EVENTS + 50 }, (_, i) => ({
        ts: NOW - i,
        event: "silent_stdio_drift.withheld_open_tool_call",
        sessionId: "00000000-0000-0000-0000-000000000000",
        reason: longReason,
        fields: { trigger: "drift", pendingMessages: 0, mtimeDeltaMs: 26358.36, bunLastFrameMs: NOW, undeliveredAssistantRecords: 4, cliVersion: "2.1.283", subagentActive: false },
      })),
      windowStart: NOW - 86_400_000,
      wrapped: true,
      capacity: 500,
    }),
    contextAdvisories: () =>
      Array.from({ length: OVERVIEW_MAX_ADVISORIES + 5 }, () => ({
        sessionId: "00000000-0000-0000-0000-000000000000",
        backendType: "claude",
        advisory: { tier: "handoff", signal: "jsonl_bytes", milestone: 12_000_000, at: NOW },
      })),
    usage: () => ({
      globalStats: { ok: false, lastOkAt: NOW - 3_600_000, failure: { kind: "kv-quota", httpStatus: 429, since: NOW - 600_000 } },
      usageLimits: { ok: true, lastOkAt: NOW - 1000, failure: null },
    }),
  };
}

describe("buildDiagnosticsOverview", () => {
  it("isolates a failing supplier to its own card", () => {
    const onSupplierError = vi.fn();
    const deps = fullDeps();
    const out = buildDiagnosticsOverview({
      ...deps,
      pairs: () => {
        throw new Error("coordinator down");
      },
      onSupplierError,
    });
    expect(out.pairs).toEqual({ status: "unavailable", reason: "source-error", since: NOW });
    expect(out.backend.status).toBe("available");
    expect(out.drift.status).toBe("available");
    expect(out.usage.status).toBe("available");
    expect(onSupplierError).toHaveBeenCalledWith("pairs", expect.any(Error));
  });

  it("caps every list at the producer", () => {
    const out = buildDiagnosticsOverview(fullDeps());
    const avail = <T,>(s: { status: string; data?: T }) => (s as { data: T }).data;
    expect(avail<unknown[]>(out.pairs)).toHaveLength(OVERVIEW_MAX_PAIRS);
    expect(avail<{ events: unknown[] }>(out.drift).events).toHaveLength(OVERVIEW_MAX_DRIFT_EVENTS);
    expect(avail<{ totalInWindow?: number }>(out.drift).totalInWindow).toBe(OVERVIEW_MAX_DRIFT_EVENTS + 50);
    expect(avail<unknown[]>(out.contextAdvisory)).toHaveLength(OVERVIEW_MAX_ADVISORIES);
  });

  it("a fully populated overview stays under the 50 KB budget", () => {
    const bytes = Buffer.byteLength(JSON.stringify(buildDiagnosticsOverview(fullDeps())), "utf8");
    expect(bytes, `overview is ${bytes} bytes`).toBeLessThanOrEqual(OVERVIEW_BUDGET_BYTES);
  });
});
