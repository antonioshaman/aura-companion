import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CouncilObserverScheduler,
  OBSERVER_CATCHUP_TIMEOUT_ESCALATION_THRESHOLD,
  OBSERVER_FAILSAFE_FALLBACK_MS,
  type ObserverSchedulerGroupMeta,
} from "./council-observer-scheduler.js";
import type { CouncilWatcherEntry } from "./council-checkpoint-pipeline.js";
import { CheckpointLineSnapshots } from "./observer-line-snapshots.js";
import { writeCouncilWakeSentinel } from "./council-wake-sentinel.js";
import { writeAtomicJson } from "./atomic-write.js";
import type { SessionGroupCoordinator } from "./session-group-coordinator.js";
import { COUNCIL_SCHEMA_VERSION, type CheckpointPayload } from "./council-types.js";

// P4/C1b: the observer wake scheduler (missed-checkpoint scan, EC-13
// failsafe tick, catch-up + spawn polls) was extracted verbatim from
// session-orchestrator.ts. Its behaviour is pinned end-to-end by the
// orchestrator suite, which still drives it through the orchestrator's
// delegates. These tests pin the NEW seam: the scheduler works with nothing
// but its DI deps — no orchestrator — and the coordinator / readiness / wake
// callbacks are resolved at call time, not captured at construction.

const GROUP = "grp_sched";
const OBSERVER = "sess_obs";

interface Harness {
  scheduler: CouncilObserverScheduler;
  watchers: Map<string, CouncilWatcherEntry>;
  meta: Map<string, ObserverSchedulerGroupMeta>;
  dispatchWake: ReturnType<typeof vi.fn>;
  setCoordinator: (c: SessionGroupCoordinator | null) => void;
  setReady: (v: boolean) => void;
  cwd: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.useRealTimers();
});

function coordinatorWithStatus(status: string): SessionGroupCoordinator {
  return {
    get: vi.fn(() => ({ sessionGroupId: GROUP, status })),
    applyEvent: vi.fn(),
  } as unknown as SessionGroupCoordinator;
}

function makeHarness(): Harness {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "council-scheduler-")));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const watchers = new Map<string, CouncilWatcherEntry>();
  const meta = new Map<string, ObserverSchedulerGroupMeta>();
  let coordinator: SessionGroupCoordinator | null = null;
  let ready = false;
  const dispatchWake = vi.fn();
  const scheduler = new CouncilObserverScheduler({
    watchers,
    groupMeta: meta,
    getCoordinator: () => coordinator,
    lineSnapshots: new CheckpointLineSnapshots(),
    isObserverReadyForWake: () => ready,
    dispatchWake,
  });
  watchers.set(GROUP, {
    cwd,
    abort: new AbortController(),
    lastCheckpoint: null,
    previousCheckpoint: null,
    pendingCheckpoint: null,
    supersededCheckpointIds: [],
    pendingReviewDeadline: null,
  });
  meta.set(GROUP, { observerSessionId: OBSERVER });
  return {
    scheduler,
    watchers,
    meta,
    dispatchWake,
    setCoordinator: (c) => { coordinator = c; },
    setReady: (v) => { ready = v; },
    cwd,
  };
}

function checkpoint(sequence: number, id = `chk_${sequence}`): CheckpointPayload {
  return {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: id,
    phase: `phase-${sequence}`,
    sequence,
    session_group_id: GROUP,
    emitted_at: new Date().toISOString(),
    artifact_paths: [],
  };
}

function writeCheckpoint(cwd: string, payload: CheckpointPayload): void {
  const dir = join(cwd, ".council", "checkpoints");
  mkdirSync(dir, { recursive: true });
  writeAtomicJson(join(dir, `${payload.phase}.${GROUP}.json`), payload);
}

describe("CouncilObserverScheduler (DI seam)", () => {
  it("scan dispatches the highest unwoken checkpoint through the injected dispatchWake", async () => {
    // Two checkpoints on disk, sentinel says seq 1 was woken → only seq 2
    // (the highest) must be dispatched, once the injected readiness gate
    // reports the observer ready. Also seeds the watcher's manifest base.
    const h = makeHarness();
    h.setCoordinator(coordinatorWithStatus("active"));
    h.setReady(true);
    writeCheckpoint(h.cwd, checkpoint(1));
    writeCheckpoint(h.cwd, checkpoint(2));
    writeCouncilWakeSentinel(h.cwd, GROUP, { checkpointId: "chk_1", sequence: 1 });

    h.scheduler.scanForMissedObserverWakes("failsafe");
    await vi.waitFor(() => expect(h.dispatchWake).toHaveBeenCalledTimes(1));
    expect(h.dispatchWake.mock.calls[0][0]).toBe(GROUP);
    expect(h.dispatchWake.mock.calls[0][1].checkpoint_id).toBe("chk_2");
    expect(h.watchers.get(GROUP)!.lastCheckpoint?.checkpoint_id).toBe("chk_2");
  });

  it("scan skips a group the coordinator resolved at call time reports degraded", () => {
    // The coordinator is swapped AFTER construction — the scheduler must see
    // the new one (lazy getter), and a degraded group is never polled.
    const h = makeHarness();
    writeCheckpoint(h.cwd, checkpoint(1));
    h.setCoordinator(coordinatorWithStatus("degraded"));
    h.setReady(true);
    h.scheduler.scanForMissedObserverWakes("init");
    expect(h.dispatchWake).not.toHaveBeenCalled();
  });

  it("catch-up poll escalates to half_died after the timeout threshold, via the live coordinator", async () => {
    // Observer never becomes ready: each 30s poll times out. At the
    // threshold the group is degraded through coordinator.applyEvent — the
    // single degrade authority — and no wake is ever dispatched.
    vi.useFakeTimers();
    const h = makeHarness();
    const coordinator = coordinatorWithStatus("active");
    h.setCoordinator(coordinator);
    for (let i = 0; i < OBSERVER_CATCHUP_TIMEOUT_ESCALATION_THRESHOLD; i++) {
      const p = h.scheduler.scheduleCatchupWakeWhenObserverReady(GROUP, checkpoint(3));
      await vi.advanceTimersByTimeAsync(31_000);
      await p;
    }
    expect(coordinator.applyEvent).toHaveBeenCalledWith(GROUP, {
      type: "half_died",
      role: "observer",
      reason: "wake_send_failed",
    });
    expect(h.dispatchWake).not.toHaveBeenCalled();
  });

  it("forgetGroup clears the spawn-pending flag and the group's catch-up strike counts", async () => {
    // Two timeouts, then forgetGroup, then two more: without the reset the
    // 3rd total timeout would escalate; after forgetGroup it must not.
    vi.useFakeTimers();
    const h = makeHarness();
    const coordinator = coordinatorWithStatus("active");
    h.setCoordinator(coordinator);
    const runTimeout = async () => {
      const p = h.scheduler.scheduleCatchupWakeWhenObserverReady(GROUP, checkpoint(4));
      await vi.advanceTimersByTimeAsync(31_000);
      await p;
    };
    await runTimeout();
    await runTimeout();
    h.scheduler.spawnCheckpointPending.add(GROUP);
    h.scheduler.forgetGroup(GROUP);
    expect(h.scheduler.spawnCheckpointPending.has(GROUP)).toBe(false);
    await runTimeout();
    await runTimeout();
    expect(coordinator.applyEvent).not.toHaveBeenCalled();
  });

  it("spawn poll writes the spawn checkpoint once the injected readiness gate flips", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const target = join(h.cwd, ".council", "checkpoints", `spawn.${GROUP}.json`);
    mkdirSync(join(h.cwd, ".council", "checkpoints"), { recursive: true });
    const p = h.scheduler.scheduleSpawnCheckpointWhenObserverReady(GROUP, OBSERVER, h.cwd);
    await vi.advanceTimersByTimeAsync(500);
    expect(existsSync(target)).toBe(false);
    expect(h.scheduler.spawnCheckpointPollsInFlight.has(GROUP)).toBe(true);
    h.setReady(true);
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(existsSync(target)).toBe(true);
    expect(h.scheduler.spawnCheckpointPending.has(GROUP)).toBe(false);
    expect(h.scheduler.spawnCheckpointPollsInFlight.has(GROUP)).toBe(false);
  });

  it("startFailsafe is idempotent and stopFailsafe stops the tick", () => {
    // EC-13: one tick per interval even after a second start; none after stop.
    vi.useFakeTimers();
    const h = makeHarness();
    const tick = vi.fn();
    h.scheduler.startFailsafe(tick);
    h.scheduler.startFailsafe(tick);
    vi.advanceTimersByTime(OBSERVER_FAILSAFE_FALLBACK_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    h.scheduler.stopFailsafe();
    vi.advanceTimersByTime(OBSERVER_FAILSAFE_FALLBACK_MS * 2);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("a throwing failsafe tick is contained (never an unhandled exception)", () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const tick = vi.fn(() => { throw new Error("boom"); });
    h.scheduler.startFailsafe(tick);
    expect(() => vi.advanceTimersByTime(OBSERVER_FAILSAFE_FALLBACK_MS)).not.toThrow();
    expect(tick).toHaveBeenCalledTimes(1);
    h.scheduler.stopFailsafe();
  });
});
