import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sweepEviction,
  reconcileEvictionSentinels,
  DEFAULT_EVICTION_CONCURRENCY,
  MAX_EVICTION_CONCURRENCY,
  type EvictionLauncherView,
  type EvictionBridgeView,
  type EvictionStoreView,
} from "./eviction-sweeper.js";
import type { CleanupConfig } from "./cleanup-config.js";
import {
  ARCHIVED_SESSIONS_SUBDIR,
  EVICTING_SENTINEL_SUFFIX,
} from "./cleanup-paths.js";
import {
  __resetCleanupCountersForTests,
  __getCleanupEventStoreSizeForTests,
} from "./cleanup-events.js";
import { __resetClockSourceForTests, setClockSourceForTests } from "./age-ms.js";
import { writeEvictingMarker } from "./sentinel-markers.js";
import type { ProcessIdentityResult } from "../process-identity.js";

// PLAN T13 eviction sweep — coverage contract per phase-H brief:
//   1. Spec self-verification: evictionGraceMs=0 + archived+exited row
//      → evicted from Map AND moved to archived/ on one tick.
//   2. Crash-mid-sweep recovery: write `.evicting` sentinel +
//      simulate crash BEFORE rename → reconcile finishes idempotently.
//   3. Subprocess alive: verifyProcessIdentity returns "match"
//      → row RETAINED + WARN logged with sessionId + pid.
//   4. EXDEV loud-throw: moveToArchive across simulated cross-FS
//      throws; sweep records as error + leaves marker for boot reconcile.
//   5. Snapshot iteration (Backend-TS R6): bridge.getSessionEntries
//      is called ONCE per pass; concurrent removeSession during sweep
//      doesn't deflect the iteration.
//
// Plus the EC-8/EC-21/EC-23 invariants the spec requires (sentinel
// written + cleared, cleanup-event recorded per eviction, structured
// log carries `event` field, no raw paths in payloads).

const HOUR_MS = 60 * 60 * 1000;

let tmpRoot: string;
let sessionsRoot: string;
let infoCalls: Array<{ event: string; payload: Record<string, unknown> }>;
let warnCalls: Array<{ event: string; payload: Record<string, unknown> }>;
let errorCalls: Array<{ event: string; payload: Record<string, unknown> }>;

beforeEach(async () => {
  __resetCleanupCountersForTests();
  __resetClockSourceForTests();
  infoCalls = [];
  warnCalls = [];
  errorCalls = [];

  tmpRoot = mkdtempSync(join(tmpdir(), "eviction-sweeper-test-"));
  sessionsRoot = join(tmpRoot, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  // Archive subdir is created lazily by SessionStore.moveToArchive, but
  // some tests pre-create it for writeEvictingMarker which needs it.
  mkdirSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR), { recursive: true });

  const loggerModule = await import("../logger.js");
  vi.spyOn(loggerModule.log, "info").mockImplementation((_, __, payload) => {
    const p = (payload ?? {}) as { event?: string } & Record<string, unknown>;
    infoCalls.push({ event: p.event ?? "", payload: p });
  });
  vi.spyOn(loggerModule.log, "warn").mockImplementation((_, __, payload) => {
    const p = (payload ?? {}) as { event?: string } & Record<string, unknown>;
    warnCalls.push({ event: p.event ?? "", payload: p });
  });
  vi.spyOn(loggerModule.log, "error").mockImplementation((_, __, payload) => {
    const p = (payload ?? {}) as { event?: string } & Record<string, unknown>;
    errorCalls.push({ event: p.event ?? "", payload: p });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetClockSourceForTests();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

/** Build a `CleanupConfig` whose `evictionGrace` carries the chosen ms or `disabled`. */
function buildConfig(graceMs: number | null): CleanupConfig {
  return {
    evictionGrace: graceMs === null
      ? { enabled: false }
      : { enabled: true, ms: graceMs },
    archiveTtl: { enabled: true, ms: 30 * 24 * HOUR_MS },
    recordingsSoftTtl: { enabled: true, ms: 14 * 24 * HOUR_MS },
    recordingsHardTtl: { enabled: true, ms: 60 * 24 * HOUR_MS },
    logsTtl: { enabled: true, ms: 7 * 24 * HOUR_MS },
    memoryPressureWarn: { enabled: true, us: 10_000_000 },
    terminalOrphanGrace: { enabled: true, ms: 300_000 },
  };
}

/** Touch a file's mtime to `nowMs - ageMs` so age-based gates fire deterministically. */
function touchAged(path: string, nowMs: number, ageMs: number, content = "{}"): void {
  writeFileSync(path, content);
  const sec = (nowMs - ageMs) / 1000;
  utimesSync(path, sec, sec);
}

/**
 * Build a minimal SessionStore-like surface backed by the temp dir +
 * a real renameSync. Keeps eviction-sweeper tests decoupled from the
 * full SessionStore class so a future SessionStore refactor doesn't
 * cascade-fail this suite.
 */
function buildStore(): EvictionStoreView & { evictedSessionIds: string[] } {
  const evictedSessionIds: string[] = [];
  return {
    directory: sessionsRoot,
    moveToArchive(sid: string): { kind: "moved"; dest: string } | { kind: "absent" } {
      const src = join(sessionsRoot, `${sid}.json`);
      if (!existsSync(src)) return { kind: "absent" };
      const dest = join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}.json`);
      mkdirSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR), { recursive: true });
      // node:fs renameSync via dynamic import to keep this helper pure.
      // Using require here is intentional — keeps the import surface small.
      const { renameSync } = require("node:fs");
      renameSync(src, dest);
      evictedSessionIds.push(sid);
      return { kind: "moved", dest };
    },
    evictedSessionIds,
  };
}

function buildBridge(
  entries: Array<[string, unknown]>,
  socketCounts: Record<string, number> = {},
): EvictionBridgeView & {
  removedSessionIds: string[];
  snapshotCalls: number;
} {
  const removed: string[] = [];
  let calls = 0;
  return {
    getSessionEntries() {
      calls++;
      return [...entries];
    },
    removeSession(sid) {
      removed.push(sid);
    },
    getBrowserSocketCount(sid) {
      return socketCounts[sid] ?? 0;
    },
    get removedSessionIds() { return removed; },
    get snapshotCalls() { return calls; },
  };
}

function buildLauncherLookup(
  sessions: Map<string, EvictionLauncherView>,
): (sid: string) => EvictionLauncherView | null {
  return (sid: string) => sessions.get(sid) ?? null;
}

/** Probe stub that returns the verdict the test pinned. */
function staticProbe(verdict: ProcessIdentityResult) {
  return () => verdict;
}

describe("sweepEviction — canary 1: spec self-verification (grace=0 + archived+exited row evicts on one tick)", () => {
  it("evicts archived state=exited row from Map AND moves JSON to archived/ on a single tick", async () => {
    // Spec floor: TTL/grace=0 + archived row that is also state=exited
    // and has been on disk longer than 0ms => evicted in one sweep call.
    // Asserts the full eviction protocol round-trip:
    //   - sentinel written BEFORE rename
    //   - source JSON renamed into archived/<sid>.json
    //   - wsBridge.removeSession called once
    //   - sentinel deleted AFTER rename
    //   - recordCleanupEvent("evicted") fired
    //   - structured log carries event="eviction.row_evicted" + sessionId
    const now = 1_700_000_000_000;
    setClockSourceForTests(() => now);
    const sid = "sess-spec-1";

    // Write the JSON row with mtime 10 seconds in the past so the grace
    // check (grace=0 → age must be > 0) is satisfied unambiguously.
    touchAged(join(sessionsRoot, `${sid}.json`), now, 10_000);

    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 12345 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    const cfg: CleanupConfig = {
      evictionGrace: { enabled: true, ms: 0 },
      archiveTtl: { enabled: true, ms: 30 * 24 * HOUR_MS },
      recordingsSoftTtl: { enabled: true, ms: 14 * 24 * HOUR_MS },
      recordingsHardTtl: { enabled: true, ms: 60 * 24 * HOUR_MS },
      logsTtl: { enabled: true, ms: 7 * 24 * HOUR_MS },
      memoryPressureWarn: { enabled: true, us: 10_000_000 },
      terminalOrphanGrace: { enabled: true, ms: 300_000 },
    };

    const summary = await sweepEviction(cfg, {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      // Subprocess: kernel agrees the pid is gone → eviction is safe.
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(1);
    expect(summary.scanned).toBe(1);
    expect(summary.errors).toBe(0);

    // Disk-half: source gone, archived dest present.
    expect(existsSync(join(sessionsRoot, `${sid}.json`))).toBe(false);
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}.json`))).toBe(true);

    // Memory-half: bridge.removeSession called.
    expect(bridge.removedSessionIds).toEqual([sid]);

    // EC-8: sentinel cleared after the rename.
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}${EVICTING_SENTINEL_SUFFIX}`))).toBe(false);

    // EC-21: cleanup-event recorded.
    expect(__getCleanupEventStoreSizeForTests()).toBe(1);

    // EC-9: structured log carries event + sessionId, no raw paths.
    const evictedLog = infoCalls.find((c) => c.event === "eviction.row_evicted");
    expect(evictedLog).toBeDefined();
    expect(evictedLog!.payload.sessionId).toBe(sid);
    expect(evictedLog!.payload.pid).toBe(12345);
  });

  it("EC-42 mutation-resistant: row is BOTH dropped from Map AND moved on disk in ONE tick", async () => {
    // The brief specifies: "row MUST be evicted from Map AND moved to disk
    // archive folder on a single tick (spec self-verification)." This
    // asserts BOTH halves so a future refactor that drops one of them
    // (e.g., a clever async move that fires the Map drop but skips the
    // rename) fails loudly.
    const now = 1_700_000_000_000;
    setClockSourceForTests(() => now);
    const sid = "sess-both-1";
    touchAged(join(sessionsRoot, `${sid}.json`), now, 100);

    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 99 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    // BOTH halves: this is the EC-42 invariant.
    const mapDropped = bridge.removedSessionIds.includes(sid);
    const diskMoved = !existsSync(join(sessionsRoot, `${sid}.json`)) &&
      existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}.json`));
    expect(mapDropped).toBe(true);
    expect(diskMoved).toBe(true);
  });
});

describe("sweepEviction — Realtime finding #1: live-browser-socket protection", () => {
  it("retains an evictable archived+exited row while a browser socket is attached", async () => {
    // Realtime finding #1 floor: never reclaim a row a user is actively
    // viewing. An archived+exited+pid-gone row is otherwise fully evictable,
    // but a live socket (getBrowserSocketCount > 0) means a tab has the
    // archived session open — yanking it would slam a terminal
    // `session_evicted` frame onto a healthy view. The row must survive until
    // the tab closes; the next tick re-checks.
    const now = 1_700_000_000_000;
    setClockSourceForTests(() => now);
    const sid = "sess-attached-1";
    touchAged(join(sessionsRoot, `${sid}.json`), now, 10_000);

    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 12345 }],
    ]);
    // One live browser socket attached → eviction must be refused.
    const bridge = buildBridge([[sid, { id: sid }]], { [sid]: 1 });

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(0);
    // Memory-half: never dropped from the Map while viewed.
    expect(bridge.removedSessionIds).toEqual([]);
    // Disk-half: source JSON untouched at original path.
    expect(existsSync(join(sessionsRoot, `${sid}.json`))).toBe(true);
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}.json`))).toBe(false);
  });

  it("evicts the same row once the last browser socket detaches (count → 0)", async () => {
    // Mutation-resistant companion to the guard above: the guard must be the
    // ONLY thing holding the row. With zero sockets the identical row evicts,
    // proving the retain was caused by the socket count and not some other gate.
    const now = 1_700_000_000_000;
    setClockSourceForTests(() => now);
    const sid = "sess-detached-1";
    touchAged(join(sessionsRoot, `${sid}.json`), now, 10_000);

    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 12345 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]], { [sid]: 0 });

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(1);
    expect(bridge.removedSessionIds).toEqual([sid]);
  });
});

describe("sweepEviction — canary 3: 'Subprocess alive' protection", () => {
  it("retains archived row when verifyProcessIdentity returns 'match' + logs WARN with sessionId + pid", async () => {
    // Subprocess R6 floor: NEVER evict an archived row whose argv+starttime-
    // verified subprocess is still alive on the host. The test asserts:
    //   - summary.retainedAlive === 1
    //   - decision action === "skipped_subprocess_alive"
    //   - structured WARN log carries event="eviction.retained.subprocess_alive"
    //     + sessionId + pid
    //   - source JSON remains at original path
    //   - bridge.removeSession NEVER called
    //   - no cleanup-event recorded
    const now = 1_700_000_000_000;
    const sid = "sess-alive-1";
    touchAged(join(sessionsRoot, `${sid}.json`), now, 7 * 24 * HOUR_MS); // very old

    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 4242 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "match" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(0);
    expect(summary.retainedAlive).toBe(1);
    expect(bridge.removedSessionIds).toEqual([]);
    expect(existsSync(join(sessionsRoot, `${sid}.json`))).toBe(true);
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}.json`))).toBe(false);

    const aliveWarn = warnCalls.find((c) => c.event === "eviction.retained.subprocess_alive");
    expect(aliveWarn).toBeDefined();
    expect(aliveWarn!.payload.sessionId).toBe(sid);
    expect(aliveWarn!.payload.pid).toBe(4242);

    expect(__getCleanupEventStoreSizeForTests()).toBe(0);
  });
});

describe("sweepEviction — WARN(phase-h): disk-absent Map-stranded row still evicts", () => {
  it("drops a Map-present archived+exited row whose JSON is absent (closes the removeSession-threw leak)", async () => {
    // Observer phase-h WARN: if bridge.removeSession throws AFTER moveToArchive
    // already moved the JSON, the row is stranded in wsBridge.sessions while the
    // source JSON is gone. The pre-fix code short-circuited on
    // existsSync(source)===false ("skipped_no_disk_file") and NEVER retried the
    // Map drop — the exact memory leak T13 exists to close, persisting for the
    // whole server uptime (self-heals only on restart). This pins the recovery:
    // a disk-absent + archived + exited + Map-present row is evicted (Map dropped)
    // on a single tick. Mutation-resistant: re-adding the skipped_no_disk_file
    // short-circuit flips evicted→0 and leaves removeSession uncalled.
    const now = 1_700_000_000_000;
    setClockSourceForTests(() => now);
    const sid = "sess-stranded-1";
    // Deliberately DO NOT write the JSON — the disk half is already gone.
    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 555 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    // Map-half: the stranded row IS dropped.
    expect(summary.evicted).toBe(1);
    expect(bridge.removedSessionIds).toEqual([sid]);
    // Disk-half: nothing to move — no archived dest materialised.
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}.json`))).toBe(false);
    // The eviction log records the absent disk dest (vs "moved").
    const evictedLog = infoCalls.find((c) => c.event === "eviction.row_evicted");
    expect(evictedLog).toBeDefined();
    expect(evictedLog!.payload.diskDest).toBe("absent");
    // Sentinel cleared after the Map drop (EC-8, idempotent on absent rename).
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}${EVICTING_SENTINEL_SUFFIX}`))).toBe(false);
  });
});

describe("sweepEviction — WARN(phase-h): degraded/PID-reuse probe verdicts evict", () => {
  // Observer phase-h WARN: 'unavailable' and 'mismatch' both fall through to
  // evict but only 'gone'/'match' were pinned. These two cases lock the
  // remaining branches so a refactor flipping either to retain-or-error fails
  // loudly instead of silently changing reclaim semantics.

  it("evicts when verifyProcessIdentity returns 'unavailable' (non-Linux host degrades to launcher.state.exited)", async () => {
    // Subprocess R6-sensitive branch: on a non-Linux dev host the probe cannot
    // verify, and the row is evicted on archived+exited alone. Flipping
    // unavailable→retain would strand dev-host rows with no failing test.
    const now = 1_700_000_000_000;
    setClockSourceForTests(() => now);
    const sid = "sess-unavail-1";
    touchAged(join(sessionsRoot, `${sid}.json`), now, 10_000);
    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 777 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "unavailable", platform: "darwin" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(1);
    expect(summary.retainedAlive).toBe(0);
    expect(bridge.removedSessionIds).toEqual([sid]);
    expect(existsSync(join(sessionsRoot, `${sid}.json`))).toBe(false);
  });

  it("evicts when verifyProcessIdentity returns 'mismatch' (PID reuse — verified subprocess gone, a different process holds the pid)", async () => {
    const now = 1_700_000_000_000;
    setClockSourceForTests(() => now);
    const sid = "sess-mismatch-1";
    touchAged(join(sessionsRoot, `${sid}.json`), now, 10_000);
    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 888 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "mismatch", reason: "argv" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(1);
    expect(summary.retainedAlive).toBe(0);
    expect(bridge.removedSessionIds).toEqual([sid]);
    expect(existsSync(join(sessionsRoot, `${sid}.json`))).toBe(false);
  });
});

describe("sweepEviction — canary 4: EXDEV loud-throw", () => {
  it("captures EXDEV from moveToArchive as error, leaves sentinel marker for boot reconcile", async () => {
    // Persistence R2: moveToArchive MUST throw on EXDEV rather than
    // fall back to copy+delete. The sweep records the failure as
    // action="error" + errorCode and leaves the .evicting sentinel
    // in place so the next boot's reconcile can act on it.
    const now = 1_700_000_000_000;
    const sid = "sess-exdev-1";
    touchAged(join(sessionsRoot, `${sid}.json`), now, 100);

    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 1 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    const exdevStore: EvictionStoreView = {
      directory: sessionsRoot,
      moveToArchive() {
        const err = new Error("cross-device link") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      },
    };

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store: exdevStore,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(0);
    expect(summary.errors).toBe(1);
    const errDecision = summary.decisions.find((d) => d.action === "error");
    expect(errDecision).toBeDefined();
    expect(errDecision!.errorCode).toBe("EXDEV");

    // Marker stays — boot reconcile picks it up.
    const markerPath = join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}${EVICTING_SENTINEL_SUFFIX}`);
    expect(existsSync(markerPath)).toBe(true);

    // Source JSON still at original path (no eviction happened).
    expect(existsSync(join(sessionsRoot, `${sid}.json`))).toBe(true);

    // bridge.removeSession NEVER called — Map drop is gated on rename success.
    expect(bridge.removedSessionIds).toEqual([]);

    // structured error log carries event field.
    const moveError = errorCalls.find((c) => c.event === "eviction.move_failed");
    expect(moveError).toBeDefined();
    expect(moveError!.payload.error_code).toBe("EXDEV");
  });
});

describe("sweepEviction — predicate gates: archived / state / grace", () => {
  it("skips row when archived=false", async () => {
    const now = 1_700_000_000_000;
    const sid = "sess-not-archived";
    touchAged(join(sessionsRoot, `${sid}.json`), now, HOUR_MS);

    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: false, state: "exited", pid: 1 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(0);
    expect(summary.skippedNotArchived).toBe(1);
    expect(bridge.removedSessionIds).toEqual([]);
  });

  it("skips row when state !== 'exited'", async () => {
    const now = 1_700_000_000_000;
    const sid = "sess-connected";
    touchAged(join(sessionsRoot, `${sid}.json`), now, HOUR_MS);

    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "connected", pid: 1 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(0);
    expect(summary.skippedNotExited).toBe(1);
    expect(bridge.removedSessionIds).toEqual([]);
  });

  it("skips row when ageMs <= grace (within grace window)", async () => {
    const now = 1_700_000_000_000;
    const sid = "sess-fresh-archived";
    touchAged(join(sessionsRoot, `${sid}.json`), now, 60_000); // 60s ago

    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 1 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    // grace = 24h → row is within grace.
    const summary = await sweepEviction(buildConfig(24 * HOUR_MS), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(0);
    expect(summary.skippedWithinGrace).toBe(1);
    expect(bridge.removedSessionIds).toEqual([]);
  });

  it("skips row when launcher view absent", async () => {
    const now = 1_700_000_000_000;
    const sid = "sess-no-launcher";
    touchAged(join(sessionsRoot, `${sid}.json`), now, HOUR_MS);

    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>();
    const bridge = buildBridge([[sid, { id: sid }]]);

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    expect(summary.evicted).toBe(0);
    expect(summary.skippedNoLauncherView).toBe(1);
  });
});

describe("sweepEviction — config / no-op paths", () => {
  it("evictionGrace disabled (enabled:false) short-circuits with sweep.disabled log", async () => {
    const sid = "sess-disabled";
    touchAged(join(sessionsRoot, `${sid}.json`), Date.now(), 7 * 24 * HOUR_MS);

    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 1 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);

    const summary = await sweepEviction(buildConfig(null), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
    });

    expect(summary.evicted).toBe(0);
    expect(summary.scanned).toBe(1);
    expect(bridge.removedSessionIds).toEqual([]);

    const disabledLog = infoCalls.find((c) => c.event === "eviction.sweep.disabled");
    expect(disabledLog).toBeDefined();
  });

  it("empty session map: completes with zero work", async () => {
    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>();
    const bridge = buildBridge([]);

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
    });

    expect(summary.evicted).toBe(0);
    expect(summary.scanned).toBe(0);
    expect(bridge.snapshotCalls).toBe(1); // ONE snapshot regardless
  });
});

describe("sweepEviction — Backend-TS R6 snapshot iteration", () => {
  it("snapshots ws-bridge entries ONCE per pass (single getSessionEntries call)", async () => {
    // The brief: "Iterate a SNAPSHOT [...wsBridge.sessions.entries()] —
    // never iterate the live Map during async ops." Asserts that the
    // sweep reads the entries exactly once and uses the resulting
    // array for the per-row pipeline — a future refactor that polls
    // entries() mid-loop would push this counter > 1 and fail the test.
    const now = 1_700_000_000_000;
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ids) {
      touchAged(join(sessionsRoot, `${id}.json`), now, 100);
    }
    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>(
      ids.map((id) => [id, { sessionId: id, archived: true, state: "exited", pid: 1 } as EvictionLauncherView]),
    );
    const bridge = buildBridge(ids.map((id) => [id, { id }]));

    await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
    });

    expect(bridge.snapshotCalls).toBe(1);
  });

  it("bounded concurrency: respects max=8 even if caller requests 100", async () => {
    // Spec: 4-8 parallel moveToArchive — NEVER unbounded Promise.all.
    // Test pins MAX_EVICTION_CONCURRENCY by introspection.
    expect(MAX_EVICTION_CONCURRENCY).toBeGreaterThanOrEqual(4);
    expect(MAX_EVICTION_CONCURRENCY).toBeLessThanOrEqual(8);
    expect(DEFAULT_EVICTION_CONCURRENCY).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_EVICTION_CONCURRENCY).toBeLessThanOrEqual(8);

    // Behavioural: a concurrency=100 request gets clamped to max=8 so
    // a misconfigured caller can't unbound the worker pool.
    const now = 1_700_000_000_000;
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    for (const id of ids) {
      touchAged(join(sessionsRoot, `${id}.json`), now, 100);
    }
    const store = buildStore();
    const launcher = new Map<string, EvictionLauncherView>(
      ids.map((id) => [id, { sessionId: id, archived: true, state: "exited", pid: 1 } as EvictionLauncherView]),
    );
    const bridge = buildBridge(ids.map((id) => [id, { id }]));

    let liveWorkers = 0;
    let peakWorkers = 0;
    const store2: EvictionStoreView = {
      directory: sessionsRoot,
      moveToArchive(sid) {
        liveWorkers++;
        if (liveWorkers > peakWorkers) peakWorkers = liveWorkers;
        const out = store.moveToArchive(sid);
        liveWorkers--;
        return out;
      },
    };

    const summary = await sweepEviction(buildConfig(0), {
      bridge,
      store: store2,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
      concurrency: 100,
    });

    expect(summary.evicted).toBe(20);
    expect(peakWorkers).toBeLessThanOrEqual(MAX_EVICTION_CONCURRENCY);
  });
});

describe("reconcileEvictionSentinels — canary 2: crash-mid-sweep recovery", () => {
  it("source JSON still present after crash: rename finishes idempotently, sentinel removed", async () => {
    // Simulate the crash window: .evicting marker is written, then the
    // process dies BEFORE the renameSync. Boot reconcile MUST finish
    // the rename and delete the marker.
    const sid = "sess-crash-1";
    const sourcePath = join(sessionsRoot, `${sid}.json`);
    writeFileSync(sourcePath, '{"id":"sess-crash-1"}');
    writeEvictingMarker(sessionsRoot, sid, {
      sessionId: sid,
      startedAt: Date.now(),
      targetDir: ARCHIVED_SESSIONS_SUBDIR,
    });

    const store = buildStore();
    const summary = reconcileEvictionSentinels({
      store,
      bootTimeMs: Date.now(),
      readdir: (p) => require("node:fs").readdirSync(p),
      stat: (p) => ({ mtimeMs: require("node:fs").statSync(p).mtimeMs }),
      unlink: (p) => require("node:fs").unlinkSync(p),
    });

    expect(summary.sentinels).toBe(1);
    expect(summary.resumedRenames).toBe(1);
    expect(summary.clearedOrphans).toBe(0);
    expect(summary.failures).toBe(0);

    // Source moved to archived/.
    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}.json`))).toBe(true);

    // Marker removed.
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}${EVICTING_SENTINEL_SUFFIX}`))).toBe(false);
  });

  it("source JSON already moved (crash AFTER rename, BEFORE marker delete): marker cleared", async () => {
    // The other half of the EC-8 recovery contract: previous run
    // completed the rename successfully but crashed before deleting
    // the sentinel. Boot reconcile treats moveToArchive's `absent`
    // result as success and removes the marker.
    const sid = "sess-crash-2";
    // Source ALREADY moved.
    writeFileSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}.json`), "{}");
    writeEvictingMarker(sessionsRoot, sid, {
      sessionId: sid,
      startedAt: Date.now(),
      targetDir: ARCHIVED_SESSIONS_SUBDIR,
    });

    const store = buildStore();
    const summary = reconcileEvictionSentinels({
      store,
      bootTimeMs: Date.now(),
      readdir: (p) => require("node:fs").readdirSync(p),
      stat: (p) => ({ mtimeMs: require("node:fs").statSync(p).mtimeMs }),
      unlink: (p) => require("node:fs").unlinkSync(p),
    });

    expect(summary.sentinels).toBe(1);
    expect(summary.resumedRenames).toBe(0);
    expect(summary.clearedOrphans).toBe(1);

    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${sid}${EVICTING_SENTINEL_SUFFIX}`))).toBe(false);
  });

  it("orphan .<hex>.tmp from a previous crash gets swept; in-flight tmp from THIS process is left alone", async () => {
    // Boot reconcile sweeps tmp files older than bootTimeMs (crashed
    // writeAtomicJson leftovers) but leaves tmp files mtime >= bootTimeMs
    // alone (an in-flight write on THIS process).
    const archiveDir = join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR);
    const oldTmp = join(archiveDir, ".deadbeef00.tmp");
    const liveTmp = join(archiveDir, ".cafef00d99.tmp");
    const oldMtimeSec = 1_600_000_000;        // 2020-09-13
    const bootTimeMs = 1_650_000_000_000;     // 2022-04-15
    const liveMtimeSec = bootTimeMs / 1000 + 10;  // 10s AFTER boot

    writeFileSync(oldTmp, "leak");
    utimesSync(oldTmp, oldMtimeSec, oldMtimeSec);
    writeFileSync(liveTmp, "active");
    utimesSync(liveTmp, liveMtimeSec, liveMtimeSec);

    const store = buildStore();
    const summary = reconcileEvictionSentinels({
      store,
      bootTimeMs,
      readdir: (p) => require("node:fs").readdirSync(p),
      stat: (p) => ({ mtimeMs: require("node:fs").statSync(p).mtimeMs }),
      unlink: (p) => require("node:fs").unlinkSync(p),
    });

    expect(summary.tmpOrphansSwept).toBe(1);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(liveTmp)).toBe(true);
  });

  it("archive dir absent (cold start): no-op, returns zeroes", async () => {
    rmSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR), { recursive: true, force: true });
    const store = buildStore();
    const summary = reconcileEvictionSentinels({
      store,
      bootTimeMs: Date.now(),
      readdir: (p) => require("node:fs").readdirSync(p),
      stat: (p) => ({ mtimeMs: require("node:fs").statSync(p).mtimeMs }),
      unlink: (p) => require("node:fs").unlinkSync(p),
    });

    expect(summary.sentinels).toBe(0);
    expect(summary.resumedRenames).toBe(0);
    expect(summary.failures).toBe(0);
  });
});

describe("sweepEviction — notifyArchived hook is fired BEFORE the rename", () => {
  // EC-42 mutation-resistant: the eviction sweep must call
  // `notifyArchived(sid)` BEFORE `moveToArchive(sid)` so the
  // IdleTimerManager (or any other downstream) cancels its armed
  // timer for the row before the disk rename completes — preventing
  // a race where the timer fires post-rename against an evicted row.
  it("notifyArchived(sid) is invoked BEFORE store.moveToArchive(sid) for the same sid", async () => {
    const now = 1_700_000_000_000;
    const sid = "sess-notify-1";
    touchAged(join(sessionsRoot, `${sid}.json`), now, 100);

    const order: string[] = [];
    const launcher = new Map<string, EvictionLauncherView>([
      [sid, { sessionId: sid, archived: true, state: "exited", pid: 1 }],
    ]);
    const bridge = buildBridge([[sid, { id: sid }]]);
    const store: EvictionStoreView = {
      directory: sessionsRoot,
      moveToArchive(s) {
        order.push(`moveToArchive:${s}`);
        const dest = join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, `${s}.json`);
        mkdirSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR), { recursive: true });
        require("node:fs").renameSync(join(sessionsRoot, `${s}.json`), dest);
        return { kind: "moved", dest };
      },
    };

    await sweepEviction(buildConfig(0), {
      bridge,
      store,
      getLauncherSession: buildLauncherLookup(launcher),
      probeProcessIdentity: staticProbe({ kind: "gone" }),
      nowMs: () => now,
      notifyArchived: (s) => order.push(`notifyArchived:${s}`),
    });

    const notifyIdx = order.indexOf(`notifyArchived:${sid}`);
    const moveIdx = order.indexOf(`moveToArchive:${sid}`);
    expect(notifyIdx).toBeGreaterThanOrEqual(0);
    expect(moveIdx).toBeGreaterThanOrEqual(0);
    expect(notifyIdx).toBeLessThan(moveIdx);
  });
});
