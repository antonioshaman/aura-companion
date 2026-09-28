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
import type { ObserverAutoheal, ObserverAutohealResult } from "./council-observer-autoheal.js";
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

function makeHarness(opts: { stoppedByUser?: Set<string>; autoheal?: ObserverAutoheal } = {}): Harness {
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
    isSessionStoppedByUser: opts.stoppedByUser ? (id) => opts.stoppedByUser!.has(id) : undefined,
    autoheal: opts.autoheal,
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

  it("scan skips an observer the user stopped (P4/KILL-INTENTIONAL)", async () => {
    // A user-stopped pair must not get a catch-up poll: it would time out on
    // the dead observer and, after the strike threshold, degrade a pair that
    // never crashed. Resumed (mark cleared) → the same checkpoint is woken.
    const stopped = new Set([OBSERVER]);
    const h = makeHarness({ stoppedByUser: stopped });
    h.setCoordinator(coordinatorWithStatus("active"));
    h.setReady(true);
    writeCheckpoint(h.cwd, checkpoint(1));
    h.scheduler.scanForMissedObserverWakes("failsafe");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.dispatchWake).not.toHaveBeenCalled();

    stopped.delete(OBSERVER);
    h.scheduler.scanForMissedObserverWakes("failsafe");
    await vi.waitFor(() => expect(h.dispatchWake).toHaveBeenCalledTimes(1));
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

  // P4/OBS-AUTOHEAL seam: a timed-out catch-up poll hands the observer to the
  // injected auto-heal. The four outcomes map to four scheduler reactions.
  function fakeAutoheal(result: ObserverAutohealResult, onHeal?: () => void): ObserverAutoheal {
    return {
      heal: vi.fn(async () => {
        onHeal?.();
        return result;
      }),
      forgetGroup: vi.fn(),
    } as unknown as ObserverAutoheal;
  }
  async function runOnePoll(h: Harness, payload: CheckpointPayload): Promise<void> {
    const p = h.scheduler.scheduleCatchupWakeWhenObserverReady(GROUP, payload);
    await vi.advanceTimersByTimeAsync(31_000);
    await p;
  }

  it("healed → the missed wake is dispatched on the first timeout, no degrade", async () => {
    vi.useFakeTimers();
    let h!: Harness;
    const autoheal = fakeAutoheal({ kind: "healed", attempts: 1 }, () => h.setReady(true));
    h = makeHarness({ autoheal });
    const coordinator = coordinatorWithStatus("active");
    h.setCoordinator(coordinator);
    await runOnePoll(h, checkpoint(5));
    expect(autoheal.heal).toHaveBeenCalledWith(GROUP, OBSERVER, "adapter_wait_timed_out", "chk_5");
    expect(h.dispatchWake).toHaveBeenCalledTimes(1);
    expect(h.dispatchWake.mock.calls[0][1].checkpoint_id).toBe("chk_5");
    expect(coordinator.applyEvent).not.toHaveBeenCalled();
  });

  it("exhausted → degrades on the FIRST timeout (the heal budget decides, not the strike count)", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ autoheal: fakeAutoheal({ kind: "exhausted", attempts: 2 }) });
    const coordinator = coordinatorWithStatus("active");
    h.setCoordinator(coordinator);
    await runOnePoll(h, checkpoint(6));
    expect(coordinator.applyEvent).toHaveBeenCalledWith(GROUP, {
      type: "half_died",
      role: "observer",
      reason: "wake_send_failed",
    });
    expect(h.dispatchWake).not.toHaveBeenCalled();
  });

  it("skipped because the user stopped a half → never degrades, however many timeouts", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ autoheal: fakeAutoheal({ kind: "skipped", reason: "user_stopped" }) });
    const coordinator = coordinatorWithStatus("active");
    h.setCoordinator(coordinator);
    for (let i = 0; i < OBSERVER_CATCHUP_TIMEOUT_ESCALATION_THRESHOLD + 1; i++) {
      await runOnePoll(h, checkpoint(7));
    }
    expect(coordinator.applyEvent).not.toHaveBeenCalled();
  });

  it("rate-limited → falls back to the strike threshold", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ autoheal: fakeAutoheal({ kind: "skipped", reason: "rate_limited" }) });
    const coordinator = coordinatorWithStatus("active");
    h.setCoordinator(coordinator);
    for (let i = 0; i < OBSERVER_CATCHUP_TIMEOUT_ESCALATION_THRESHOLD - 1; i++) {
      await runOnePoll(h, checkpoint(8));
    }
    expect(coordinator.applyEvent).not.toHaveBeenCalled();
    await runOnePoll(h, checkpoint(8));
    expect(coordinator.applyEvent).toHaveBeenCalledTimes(1);
  });

  it("requestCatchupWake (live adapter_missing) starts one poll, deduped, and skips a user-stopped observer", async () => {
    vi.useFakeTimers();
    const stopped = new Set<string>();
    const h = makeHarness({ stoppedByUser: stopped });
    h.setCoordinator(coordinatorWithStatus("active"));
    // Two requests for the same checkpoint → one poll → one wake.
    h.scheduler.requestCatchupWake(GROUP, checkpoint(9));
    h.scheduler.requestCatchupWake(GROUP, checkpoint(9));
    h.setReady(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.dispatchWake).toHaveBeenCalledTimes(1);

    stopped.add(OBSERVER);
    h.scheduler.requestCatchupWake(GROUP, checkpoint(10));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.dispatchWake).toHaveBeenCalledTimes(1);
  });

  // P4/FIX-AUTOHEAL-1 item 2: after `healed` the re-sent wake can hit
  // `adapter_missing` again (the fresh adapter dropped once more). The live
  // pipeline answers that with requestCatchupWake — which used to be dropped
  // as a duplicate because the healing poll still held the in-flight key,
  // losing the wake until the next 5-min failsafe tick. The poll now releases
  // its key before re-dispatching, and its `finally` must not delete the key
  // the NEW poll took.
  it("a re-sent wake that hits adapter_missing again after healed starts a new poll (not dropped as a duplicate)", async () => {
    vi.useFakeTimers();
    let h!: Harness;
    const autoheal = fakeAutoheal({ kind: "healed", attempts: 1 });
    h = makeHarness({ autoheal });
    h.setCoordinator(coordinatorWithStatus("active"));
    // First re-dispatch: the adapter is gone again → the pipeline asks for a
    // catch-up (synchronously, as dispatchObserverWake does). Later ones succeed.
    h.dispatchWake.mockImplementationOnce((gid: string, payload: CheckpointPayload) => {
      h.scheduler.requestCatchupWake(gid, payload);
    });
    await runOnePoll(h, checkpoint(11));
    expect(h.dispatchWake).toHaveBeenCalledTimes(1);
    // A new poll for the checkpoint is running (the request was not dropped)
    // and it still owns its in-flight key after the healing poll's finally.
    const inFlight = (h.scheduler as unknown as { catchupWakesInFlight: Map<string, object> }).catchupWakesInFlight;
    expect(inFlight.has(`${GROUP}:chk_11`)).toBe(true);
    // So a duplicate request is deduped against it...
    const before = h.dispatchWake.mock.calls.length;
    h.scheduler.requestCatchupWake(GROUP, checkpoint(11));
    // ...and once the adapter attaches it delivers the wake exactly once.
    h.setReady(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.dispatchWake.mock.calls.length).toBe(before + 1);
    expect(h.dispatchWake.mock.calls.at(-1)![1].checkpoint_id).toBe("chk_11");
  });

  it("forgetGroup also drops the auto-heal's per-group history", () => {
    const autoheal = fakeAutoheal({ kind: "healed", attempts: 1 });
    const h = makeHarness({ autoheal });
    h.scheduler.forgetGroup(GROUP);
    expect(autoheal.forgetGroup).toHaveBeenCalledWith(GROUP);
  });
});
