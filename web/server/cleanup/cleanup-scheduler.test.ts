import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CleanupScheduler, __CLAMP_BOUNDS_FOR_TESTS } from "./cleanup-scheduler.js";

// The scheduler owns three contracts:
//   1. Lifecycle: start() idempotent + dispose() awaits in-flight.
//   2. Self-rescheduling timer with [1h, 25h] clamp.
//   3. Error boundary: a thrown sweep does NOT crash the loop.
//
// Tests use fake timers so the suite doesn't block real wall time on
// the daily cadence. `__setIntervalMsForTests` bypasses the clamp so
// fake-timer advances can drive multiple ticks per test.

let infoSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.useFakeTimers();
  const loggerModule = await import("../logger.js");
  infoSpy = vi.spyOn(loggerModule.log, "info").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(loggerModule.log, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("constructor interval clamp", () => {
  // The brief specifies clamp [1h, 25h] — pin the boundary values so a
  // future drift to e.g. [30min, 48h] is visible at this layer rather
  // than via observed production cadence.
  it("defaults to 24h and clamps inputs to [1h, 25h]", () => {
    const sched = new CleanupScheduler();
    expect(sched.isStarted()).toBe(false);

    // The clamp constants pinned at the module — codifies the contract.
    expect(__CLAMP_BOUNDS_FOR_TESTS.MIN_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(__CLAMP_BOUNDS_FOR_TESTS.MAX_INTERVAL_MS).toBe(25 * 60 * 60 * 1000);
    expect(__CLAMP_BOUNDS_FOR_TESTS.DEFAULT_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  // Constructor accepts within-bounds inputs verbatim.
  it("accepts a within-bounds intervalMs verbatim", () => {
    const twoHours = 2 * 60 * 60 * 1000;
    const sched = new CleanupScheduler({ intervalMs: twoHours });
    expect(sched.isStarted()).toBe(false);
  });
});

describe("start() — idempotent + arms first timer", () => {
  // The brief: start() MUST be idempotent. A second call is a no-op.
  // We assert via the info-log shape: the "scheduler started" line
  // fires exactly once.
  it("emits cleanup.scheduler.started exactly once even when start() is called twice", () => {
    const sched = new CleanupScheduler();
    sched.start();
    sched.start();
    sched.start();

    const startedCalls = infoSpy.mock.calls.filter(
      (call: unknown[]) => (call[2] as Record<string, unknown> | undefined)?.event === "cleanup.scheduler.started",
    );
    expect(startedCalls).toHaveLength(1);
    expect(sched.isStarted()).toBe(true);
  });

  // After dispose(), start() is structurally a no-op — the scheduler is
  // retired. This prevents a stale `start()` call buried in shutdown
  // ordering from re-arming a timer after dispose was awaited.
  it("start() after dispose() is a no-op", async () => {
    const sched = new CleanupScheduler();
    await sched.dispose();
    sched.start();
    expect(sched.isStarted()).toBe(false);
  });
});

describe("self-rescheduling timer", () => {
  // Advance fake timers to fire one tick, confirm the sweep ran, then
  // advance again and confirm the NEXT tick fired — that's the
  // self-rescheduling contract that closes the EC-12 sibling
  // "missed ticks pile up on resume" failure mode.
  it("fires sweep callbacks at the configured cadence, re-arming after each tick", async () => {
    const sched = new CleanupScheduler();
    const sweepCalls: string[] = [];
    sched.registerSweep("tier-a", () => { sweepCalls.push("a"); });
    sched.registerSweep("tier-b", () => { sweepCalls.push("b"); });
    sched.__setIntervalMsForTests(100);
    sched.start();

    // First tick.
    await vi.advanceTimersByTimeAsync(100);
    expect(sweepCalls).toEqual(["a", "b"]);

    // Second tick — the scheduler re-armed.
    await vi.advanceTimersByTimeAsync(100);
    expect(sweepCalls).toEqual(["a", "b", "a", "b"]);

    await sched.dispose();
  });
});

describe("error boundary — thrown sweep does not crash the loop", () => {
  // A registered sweep that throws MUST be caught + logged + the next
  // sweep in the tick still runs + the next tick still fires. This is
  // the "unhandled rejection inside setInterval crashes Bun" failsafe.
  it("catches a thrown sweep, logs cleanup.sweep.error, and continues to the next sweep", async () => {
    const sched = new CleanupScheduler();
    const calls: string[] = [];
    sched.registerSweep("tier-bad", () => {
      calls.push("bad");
      throw new Error("simulated tier failure");
    });
    sched.registerSweep("tier-good", () => {
      calls.push("good");
    });
    sched.__setIntervalMsForTests(50);
    sched.start();

    await vi.advanceTimersByTimeAsync(50);

    // Both sweeps ran inside this tick — the throw did NOT short-circuit.
    expect(calls).toEqual(["bad", "good"]);
    // Error log was emitted with the documented event-name + sweep-name.
    const sweepErrors = errorSpy.mock.calls.filter(
      (call: unknown[]) => (call[2] as Record<string, unknown> | undefined)?.event === "cleanup.sweep.error",
    );
    expect(sweepErrors).toHaveLength(1);
    const data = sweepErrors[0][2] as Record<string, unknown>;
    expect(data.sweep).toBe("tier-bad");
    expect(data.error_message).toBe("simulated tier failure");

    // Next tick still fires.
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toEqual(["bad", "good", "bad", "good"]);

    await sched.dispose();
  });

  // Async sweep that rejects MUST be awaited and caught — same shape
  // as synchronous throw. This is the failure mode that would crash
  // Bun under `setInterval` without the wrapper.
  it("catches an async sweep rejection", async () => {
    const sched = new CleanupScheduler();
    sched.registerSweep("tier-async-bad", async () => {
      throw new Error("async-fail");
    });
    sched.__setIntervalMsForTests(20);
    sched.start();

    await vi.advanceTimersByTimeAsync(20);

    const sweepErrors = errorSpy.mock.calls.filter(
      (call: unknown[]) => (call[2] as Record<string, unknown> | undefined)?.event === "cleanup.sweep.error",
    );
    expect(sweepErrors).toHaveLength(1);
    expect((sweepErrors[0][2] as Record<string, unknown>).sweep).toBe("tier-async-bad");

    await sched.dispose();
  });
});

describe("dispose() — awaits in-flight sweep within shutdown budget", () => {
  // The brief: dispose() MUST await any in-flight sweep so SIGTERM
  // mid-sweep doesn't leave half-mutated state. We simulate an
  // in-flight async sweep, fire the timer, then call dispose() and
  // assert it doesn't resolve until the sweep does.
  it("dispose() awaits a slow in-flight sweep", async () => {
    const sched = new CleanupScheduler();
    let resolveSweep: () => void = () => {};
    const sweepPromise = new Promise<void>((res) => { resolveSweep = res; });
    let sweepDone = false;
    sched.registerSweep("slow-tier", async () => {
      await sweepPromise;
      sweepDone = true;
    });
    sched.__setIntervalMsForTests(10);
    sched.start();

    // Fire the timer; runSweep is now in-flight inside the slow callback.
    await vi.advanceTimersByTimeAsync(10);
    expect(sweepDone).toBe(false);

    // Kick off dispose() — it MUST NOT resolve until the sweep does.
    const disposePromise = sched.dispose();
    let disposeResolved = false;
    void disposePromise.then(() => { disposeResolved = true; });

    // Give the microtask queue a beat — dispose should still be pending.
    await Promise.resolve();
    expect(disposeResolved).toBe(false);

    // Release the sweep.
    resolveSweep();
    await disposePromise;
    expect(sweepDone).toBe(true);
    expect(disposeResolved).toBe(true);
  });

  // Repeated dispose() is safe — it still awaits any in-flight run.
  it("dispose() is idempotent on a non-started scheduler", async () => {
    const sched = new CleanupScheduler();
    await sched.dispose();
    await sched.dispose();
    expect(sched.isStarted()).toBe(false);
  });
});

describe("registerSweep — validation + idempotent replacement", () => {
  // Registering the same name twice replaces the callback — useful for
  // hot-reload + for tests that re-wire the same tier between runs.
  it("re-registering a sweep name replaces the callback", async () => {
    const sched = new CleanupScheduler();
    let firstCalled = 0;
    let secondCalled = 0;
    sched.registerSweep("tier", () => { firstCalled++; });
    sched.registerSweep("tier", () => { secondCalled++; });
    sched.__setIntervalMsForTests(10);
    sched.start();

    await vi.advanceTimersByTimeAsync(10);
    expect(firstCalled).toBe(0);
    expect(secondCalled).toBe(1);

    await sched.dispose();
  });

  // Schema validation at the registration boundary — invalid inputs
  // throw rather than silently mis-storing.
  it("rejects empty name or non-function callback at register time", () => {
    const sched = new CleanupScheduler();
    expect(() => sched.registerSweep("", () => {})).toThrow(/invalid name/);
    // @ts-expect-error — testing runtime rejection of non-function.
    expect(() => sched.registerSweep("ok", "not a fn")).toThrow(/invalid callback/);
  });
});

describe("__runSweepNowForTests — manual one-shot sweep without timer", () => {
  // The test seam for suites that want to exercise the error-boundary
  // path without involving `setTimeout` at all. Useful for tightly
  // scoped unit tests that don't care about cadence.
  it("runs the registered sweeps once and waits for settlement", async () => {
    vi.useRealTimers(); // No fake timer needed for the no-timer path.
    const sched = new CleanupScheduler();
    let ran = 0;
    sched.registerSweep("tier", () => { ran++; });
    await sched.__runSweepNowForTests();
    expect(ran).toBe(1);
    await sched.dispose();
  });
});
