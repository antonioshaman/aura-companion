import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "./logger.js";
import { abortableSleep, runResilientWatch } from "./resilient-watch.js";

/**
 * These tests validate the Issue #86 fix: a council fs.watch that dies
 * mid-uptime must be re-armed (not left silently dead) and every death must
 * surface as a structured ERROR log. The pure `runResilientWatch` helper is
 * exercised with a fake `start` and an injected `sleep` so no real timers or
 * filesystem are involved.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** Injected sleep: resolves immediately (no real backoff) unless aborted. */
const instantSleep = (_ms: number, signal: AbortSignal): Promise<void> =>
  signal.aborted ? Promise.resolve() : Promise.resolve();

describe("runResilientWatch", () => {
  it("re-arms after `start` throws, logging an ERROR each death until aborted", async () => {
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const controller = new AbortController();
    let calls = 0;

    // start() throws on the first two generations, then — once we've proven
    // re-arm happened — the third call aborts and resolves cleanly so the
    // loop terminates (mirrors a real watcher resolving on abort).
    const start = vi.fn(async () => {
      calls += 1;
      if (calls >= 3) {
        controller.abort();
        return; // resolve-with-abort → loop exits, no further re-arm
      }
      throw new Error(`watch boom ${calls}`);
    });

    await runResilientWatch({
      kind: "checkpoint",
      logContext: { sessionGroupId: "grp-1" },
      signal: controller.signal,
      start,
      sleep: instantSleep,
    });

    // Two throwing generations + one clean(aborted) generation = 3 starts.
    expect(start).toHaveBeenCalledTimes(3);
    // One ERROR per unexpected death (the two throws); the aborted resolve
    // is NOT a death and must not log.
    expect(errorSpy).toHaveBeenCalledTimes(2);
    const firstCallData = errorSpy.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(firstCallData).toMatchObject({
      event: "council.watcher.died",
      kind: "checkpoint",
      sessionGroupId: "grp-1",
      deathKind: "threw",
    });
    expect(String(firstCallData.error)).toContain("watch boom 1");
  });

  it("treats a resolve WITHOUT an abort as a death and re-arms (deathKind=ended)", async () => {
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const controller = new AbortController();
    let calls = 0;

    const start = vi.fn(async () => {
      calls += 1;
      // First generation resolves on its own (fs.watch iterator ended without
      // an abort — the silent-death case). Second generation aborts to stop.
      if (calls >= 2) controller.abort();
    });

    await runResilientWatch({
      kind: "review",
      signal: controller.signal,
      start,
      sleep: instantSleep,
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[2]).toMatchObject({ deathKind: "ended", kind: "review" });
  });

  it("invokes onDeath for each death and never re-arms after abort", async () => {
    vi.spyOn(log, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const onDeath = vi.fn();
    let calls = 0;

    const start = vi.fn(async () => {
      calls += 1;
      if (calls >= 2) {
        controller.abort();
        return;
      }
      throw new Error("boom");
    });

    await runResilientWatch({
      kind: "checkpoint",
      signal: controller.signal,
      start,
      onDeath,
      sleep: instantSleep,
    });

    expect(onDeath).toHaveBeenCalledTimes(1);
    expect(onDeath.mock.calls[0]?.[0]).toMatchObject({ kind: "threw" });
  });

  it("does nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = vi.fn(async () => {});

    await runResilientWatch({ kind: "checkpoint", signal: controller.signal, start, sleep: instantSleep });

    expect(start).not.toHaveBeenCalled();
  });

  it("swallows a throwing onDeath hook so the loop keeps re-arming", async () => {
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const controller = new AbortController();
    let calls = 0;

    const start = vi.fn(async () => {
      calls += 1;
      if (calls >= 2) {
        controller.abort();
        return;
      }
      throw new Error("boom");
    });
    const onDeath = vi.fn(() => {
      throw new Error("hook exploded");
    });

    // Must not reject even though onDeath throws.
    await expect(
      runResilientWatch({ kind: "checkpoint", signal: controller.signal, start, onDeath, sleep: instantSleep }),
    ).resolves.toBeUndefined();

    // The death ERROR + the hook-threw ERROR both logged.
    const messages = errorSpy.mock.calls.map((c) => c[1]);
    expect(messages).toContain("council watcher died — re-arming");
    expect(messages).toContain("council watcher onDeath hook threw");
  });
});

describe("abortableSleep", () => {
  it("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await abortableSleep(10_000, controller.signal);
    // Would hang 10s if it didn't short-circuit on the pre-aborted signal.
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("resolves early when the signal aborts during the wait", async () => {
    const controller = new AbortController();
    const p = abortableSleep(10_000, controller.signal);
    controller.abort();
    const start = Date.now();
    await p;
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("resolves after the delay elapses when never aborted (timer path)", async () => {
    // Council Review 2026-07-05 Beck #2: the two early-abort tests both assert
    // the short-circuit; neither exercises the production default's actual
    // setTimeout branch (fire + listener cleanup). This covers the timer-resolve
    // path so a mutation that drops the timer (or its listener removal) is caught.
    const controller = new AbortController();
    const start = Date.now();
    await abortableSleep(20, controller.signal);
    // The real timer must have fired (≥ ~15ms, allowing scheduler slack).
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    // Aborting AFTER a normal resolve must be a no-op (listener already removed):
    // if the abort listener leaked, this would throw on a settled promise's
    // resolve — it must not.
    expect(() => controller.abort()).not.toThrow();
  });
});

describe("runResilientWatch — escalating backoff (#11)", () => {
  it("backs off exponentially (capped) across a failing streak instead of a flat delay", async () => {
    // A watch that dies on every re-arm previously re-armed at a flat 1s — an
    // ERROR every second forever. Assert the injected sleep receives a growing,
    // capped delay across consecutive deaths (Council Review 2026-07-05 #11).
    vi.spyOn(log, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const sleepDelays: number[] = [];
    // Record each backoff, resolve instantly. `now` is frozen so every
    // generation has 0 uptime → the healthy-reset never fires → the streak grows.
    const recordingSleep = (ms: number, signal: AbortSignal): Promise<void> => {
      sleepDelays.push(ms);
      return signal.aborted ? Promise.resolve() : Promise.resolve();
    };
    let calls = 0;
    const start = vi.fn(async () => {
      calls += 1;
      if (calls >= 4) {
        controller.abort();
        return;
      }
      throw new Error(`boom ${calls}`);
    });

    await runResilientWatch({
      kind: "checkpoint",
      signal: controller.signal,
      start,
      sleep: recordingSleep,
      rearmDelayMs: 1_000,
      maxRearmDelayMs: 3_000,
      now: () => 0, // frozen clock → 0 uptime each generation → streak grows
    });

    // Three deaths → three backoffs: 1000, 2000, then capped at 3000 (not 4000).
    expect(sleepDelays).toEqual([1_000, 2_000, 3_000]);
  });

  it("resets the backoff after a generation that stayed up long enough to be healthy", async () => {
    // A death after a long-lived generation is a fresh blip, not part of a
    // failing streak — the counter (and thus the backoff) must reset to base.
    vi.spyOn(log, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const sleepDelays: number[] = [];
    const recordingSleep = (ms: number): Promise<void> => {
      sleepDelays.push(ms);
      return Promise.resolve();
    };
    // Advance the clock by a full healthy-uptime window on each `now()` read so
    // every generation looks healthy → each death resets the streak to base.
    let clock = 0;
    const now = () => {
      clock += 60_000; // >= REARM_HEALTHY_UPTIME_MS between start and death
      return clock;
    };
    let calls = 0;
    const start = vi.fn(async () => {
      calls += 1;
      if (calls >= 3) {
        controller.abort();
        return;
      }
      throw new Error(`boom ${calls}`);
    });

    await runResilientWatch({
      kind: "checkpoint",
      signal: controller.signal,
      start,
      sleep: recordingSleep,
      rearmDelayMs: 1_000,
      maxRearmDelayMs: 30_000,
      now,
    });

    // Both deaths followed healthy generations → both back off at base 1000.
    expect(sleepDelays).toEqual([1_000, 1_000]);
  });
});
