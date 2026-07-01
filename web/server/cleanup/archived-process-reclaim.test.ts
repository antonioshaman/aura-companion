import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  sweepArchivedProcesses,
  DEFAULT_RECLAIM_CONCURRENCY,
  MAX_RECLAIM_CONCURRENCY,
  type ReclaimLauncherView,
  type ReclaimSweepDeps,
} from "./archived-process-reclaim.js";
import type { CleanupConfig } from "./cleanup-config.js";
import {
  __resetCleanupCountersForTests,
  __getCleanupEventStoreSizeForTests,
} from "./cleanup-events.js";

// archived-process-reclaim coverage contract:
//   1. archived + alive (connected/running) + pid → launcher.kill routed,
//      returns true → reclaimed + cleanup-event recorded + info log.
//   2. kill declines (returns false: EC-45 pid dead/reused) → no event,
//      no reclaim, row deferred.
//   3. Predicate gates: not-archived / exited / no-pid rows are skipped and
//      NEVER routed to kill (exited is the eviction tier's job).
//   4. evictionGrace disabled (=0) → whole sweep short-circuits, no kills.
//   5. kill throwing on one row does NOT abort the pass — captured as error,
//      siblings still processed.
//   6. Backend-TS R6: the launcher snapshot is taken exactly ONCE per pass.
//   7. concurrency clamp: <1 → 1, >MAX → MAX, all rows still processed.

const enabledConfig: CleanupConfig = {
  evictionGrace: { enabled: true, ms: 24 * 60 * 60 * 1000 },
  archiveTtl: { enabled: false },
  recordingsSoftTtl: { enabled: false },
  recordingsHardTtl: { enabled: false },
  logsTtl: { enabled: false },
  memoryPressureWarn: { enabled: false },
  terminalOrphanGrace: { enabled: false },
};

const disabledConfig: CleanupConfig = {
  ...enabledConfig,
  evictionGrace: { enabled: false },
};

let infoEvents: string[];
let warnEvents: string[];

beforeEach(async () => {
  __resetCleanupCountersForTests();
  infoEvents = [];
  warnEvents = [];

  const loggerModule = await import("../logger.js");
  vi.spyOn(loggerModule.log, "info").mockImplementation((_, __, payload) => {
    infoEvents.push(((payload ?? {}) as { event?: string }).event ?? "");
  });
  vi.spyOn(loggerModule.log, "warn").mockImplementation((_, __, payload) => {
    warnEvents.push(((payload ?? {}) as { event?: string }).event ?? "");
  });
  vi.spyOn(loggerModule.log, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a deps object with a spied killSession + getLauncherSessions. */
function makeDeps(
  sessions: ReclaimLauncherView[],
  killImpl: (sessionId: string) => Promise<boolean>,
  overrides: Partial<ReclaimSweepDeps> = {},
): ReclaimSweepDeps & {
  killSession: ReturnType<typeof vi.fn>;
  getLauncherSessions: ReturnType<typeof vi.fn>;
} {
  return {
    getLauncherSessions: vi.fn(() => sessions),
    killSession: vi.fn(killImpl),
    ...overrides,
  } as ReclaimSweepDeps & {
    killSession: ReturnType<typeof vi.fn>;
    getLauncherSessions: ReturnType<typeof vi.fn>;
  };
}

describe("sweepArchivedProcesses", () => {
  it("reclaims an archived, still-connected session with a live pid", async () => {
    const sessions: ReclaimLauncherView[] = [
      { sessionId: "s1", pid: 4242, archived: true, state: "connected" },
    ];
    const deps = makeDeps(sessions, async () => true);

    const summary = await sweepArchivedProcesses(enabledConfig, deps);

    expect(deps.killSession).toHaveBeenCalledTimes(1);
    expect(deps.killSession).toHaveBeenCalledWith("s1");
    expect(summary.reclaimed).toBe(1);
    expect(summary.scanned).toBe(1);
    // EC-21: exactly one cleanup event recorded in the shared store.
    expect(__getCleanupEventStoreSizeForTests()).toBe(1);
    expect(infoEvents).toContain("archived_process_reclaim.reclaimed");
  });

  it("reclaims an archived 'running' session too (state != exited)", async () => {
    const sessions: ReclaimLauncherView[] = [
      { sessionId: "s1", pid: 10, archived: true, state: "running" },
    ];
    const deps = makeDeps(sessions, async () => true);

    const summary = await sweepArchivedProcesses(enabledConfig, deps);

    expect(deps.killSession).toHaveBeenCalledWith("s1");
    expect(summary.reclaimed).toBe(1);
  });

  it("records NO event when launcher.kill declines (pid dead/reused)", async () => {
    const sessions: ReclaimLauncherView[] = [
      { sessionId: "s1", pid: 4242, archived: true, state: "connected" },
    ];
    const deps = makeDeps(sessions, async () => false);

    const summary = await sweepArchivedProcesses(enabledConfig, deps);

    expect(deps.killSession).toHaveBeenCalledWith("s1");
    expect(summary.reclaimed).toBe(0);
    expect(summary.skippedKillDeclined).toBe(1);
    expect(__getCleanupEventStoreSizeForTests()).toBe(0);
  });

  it("skips non-archived rows without routing to kill", async () => {
    const sessions: ReclaimLauncherView[] = [
      { sessionId: "live", pid: 4242, archived: false, state: "connected" },
      { sessionId: "undef", pid: 99, state: "connected" }, // archived undefined
    ];
    const deps = makeDeps(sessions, async () => true);

    const summary = await sweepArchivedProcesses(enabledConfig, deps);

    expect(deps.killSession).not.toHaveBeenCalled();
    expect(summary.skippedNotArchived).toBe(2);
    expect(summary.reclaimed).toBe(0);
  });

  it("skips archived+exited rows (that is the eviction tier's job)", async () => {
    const sessions: ReclaimLauncherView[] = [
      { sessionId: "s1", pid: 4242, archived: true, state: "exited" },
    ];
    const deps = makeDeps(sessions, async () => true);

    const summary = await sweepArchivedProcesses(enabledConfig, deps);

    expect(deps.killSession).not.toHaveBeenCalled();
    expect(summary.skippedExited).toBe(1);
  });

  it("skips archived rows with no live pid", async () => {
    const sessions: ReclaimLauncherView[] = [
      { sessionId: "nopid", archived: true, state: "connected" },
      { sessionId: "zeropid", pid: 0, archived: true, state: "connected" },
    ];
    const deps = makeDeps(sessions, async () => true);

    const summary = await sweepArchivedProcesses(enabledConfig, deps);

    expect(deps.killSession).not.toHaveBeenCalled();
    expect(summary.skippedNoPid).toBe(2);
  });

  it("short-circuits entirely when evictionGrace is disabled", async () => {
    const sessions: ReclaimLauncherView[] = [
      { sessionId: "s1", pid: 4242, archived: true, state: "connected" },
    ];
    const deps = makeDeps(sessions, async () => true);

    const summary = await sweepArchivedProcesses(disabledConfig, deps);

    expect(deps.killSession).not.toHaveBeenCalled();
    expect(summary.reclaimed).toBe(0);
    expect(summary.scanned).toBe(1);
    expect(infoEvents).toContain("archived_process_reclaim.sweep.disabled");
  });

  it("continues past a kill that throws, capturing it as an error", async () => {
    const sessions: ReclaimLauncherView[] = [
      { sessionId: "boom", pid: 1, archived: true, state: "connected" },
      { sessionId: "ok", pid: 2, archived: true, state: "connected" },
    ];
    const deps = makeDeps(sessions, async (id) => {
      if (id === "boom") throw new Error("EPERM");
      return true;
    });

    const summary = await sweepArchivedProcesses(enabledConfig, deps);

    expect(summary.errors).toBe(1);
    expect(summary.reclaimed).toBe(1);
    // The healthy sibling still got reclaimed + recorded.
    expect(__getCleanupEventStoreSizeForTests()).toBe(1);
    expect(warnEvents).toContain("archived_process_reclaim.kill_failed");
  });

  it("snapshots the launcher view exactly once per pass (Backend-TS R6)", async () => {
    const sessions: ReclaimLauncherView[] = [
      { sessionId: "s1", pid: 1, archived: true, state: "connected" },
      { sessionId: "s2", pid: 2, archived: true, state: "connected" },
    ];
    const deps = makeDeps(sessions, async () => true);

    await sweepArchivedProcesses(enabledConfig, deps);

    expect(deps.getLauncherSessions).toHaveBeenCalledTimes(1);
  });

  it("processes every row regardless of concurrency clamp bounds", async () => {
    const sessions: ReclaimLauncherView[] = Array.from({ length: 20 }, (_, i) => ({
      sessionId: `s${i}`,
      pid: i + 1,
      archived: true as const,
      state: "connected" as const,
    }));

    for (const concurrency of [0, DEFAULT_RECLAIM_CONCURRENCY, MAX_RECLAIM_CONCURRENCY + 5]) {
      __resetCleanupCountersForTests();
      const deps = makeDeps(sessions, async () => true, { concurrency });
      const summary = await sweepArchivedProcesses(enabledConfig, deps);
      expect(summary.reclaimed).toBe(20);
      expect(deps.killSession).toHaveBeenCalledTimes(20);
    }
  });
});
