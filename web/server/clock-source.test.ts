// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { SystemClock, FakeClock, type ClockSource } from "./clock-source.js";

describe("SystemClock", () => {
  // SystemClock wraps `Date.now()` and `setTimeout` with `.unref()`. We
  // can't deterministically test the real timer firing here without
  // sleeping, but we CAN verify the shape: `now()` returns a fresh
  // wallclock reading on each call, and `schedule()` returns a
  // ClockTimer with a cancel that actually clears the underlying
  // handle (no fire-after-cancel).
  it("now() advances across two readings", async () => {
    const t1 = SystemClock.now();
    // Tight loop — we just need >0 ms to elapse.
    while (SystemClock.now() === t1) {
      // wait
    }
    expect(SystemClock.now()).toBeGreaterThan(t1);
  });

  it("schedule(fn, 0) fires fn asynchronously (not synchronously)", async () => {
    const fn = vi.fn();
    SystemClock.schedule(fn, 0);
    // Right after schedule returns, fn must NOT have been called —
    // setTimeout always defers to a future event-loop tick.
    expect(fn).not.toHaveBeenCalled();
    // Yield via a real-timer wait. `setImmediate` is insufficient on
    // Bun for an `.unref()`-ed handle whose tick is already past the
    // microtask queue boundary; a 10ms setTimeout reliably yields
    // through one full timer-phase cycle.
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel() prevents a still-pending fn from firing", async () => {
    const fn = vi.fn();
    const timer = SystemClock.schedule(fn, 50);
    timer.cancel();
    await new Promise((r) => setTimeout(r, 80));
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() is idempotent (no throw on double-cancel)", () => {
    const timer = SystemClock.schedule(() => {}, 1000);
    timer.cancel();
    expect(() => timer.cancel()).not.toThrow();
  });
});

describe("FakeClock — basic queue", () => {
  it("starts at the supplied initial now", () => {
    const c = new FakeClock(1_000);
    expect(c.now()).toBe(1_000);
  });

  it("defaults initial now to 0 when none supplied", () => {
    const c = new FakeClock();
    expect(c.now()).toBe(0);
  });

  it("advance(0) is a no-op (no fires, no clock movement)", () => {
    const c = new FakeClock(500);
    const fn = vi.fn();
    c.schedule(fn, 100);
    c.advance(0);
    expect(fn).not.toHaveBeenCalled();
    expect(c.now()).toBe(500);
  });

  it("schedule(fn, 0) fires on the next advance(>=0)", () => {
    // Zero-delay timers are fired the moment the clock can — i.e. on
    // any advance, including advance(0). This is the FakeClock
    // equivalent of microtask draining; tests rely on it for
    // synchronously-scheduled cleanup callbacks.
    const c = new FakeClock();
    const fn = vi.fn();
    c.schedule(fn, 0);
    c.advance(0);
    // Implementation detail: our advance(0) loops while `due <= target`;
    // a zero-due timer becomes due at the current clock and fires.
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("FakeClock — firing order and timing", () => {
  it("advance fires due timers in due-time order, not insertion order", () => {
    // Insertion order is [later, sooner]; firing order must be
    // [sooner, later]. Regression guard for "first registered wins"
    // bug that has bitten other home-grown clock fakes.
    const c = new FakeClock();
    const calls: string[] = [];
    c.schedule(() => calls.push("later"), 100);
    c.schedule(() => calls.push("sooner"), 50);
    c.advance(200);
    expect(calls).toEqual(["sooner", "later"]);
  });

  it("moves wallclock to each fire's due-time as it fires", () => {
    // A test inspecting `now()` inside a callback must see the due-time
    // of THAT timer, not the final post-advance value. This makes
    // age/elapsed assertions inside callbacks deterministic.
    const c = new FakeClock(1_000);
    let seenNow = 0;
    c.schedule(() => {
      seenNow = c.now();
    }, 200);
    c.advance(500);
    expect(seenNow).toBe(1_200);
    expect(c.now()).toBe(1_500);
  });

  it("re-entrant scheduling within an advance is also drained", () => {
    // Callback that schedules another timer due before the advance
    // target — the second timer must also fire within the same
    // advance call. This is the chained-timer pattern idle-timer-manager
    // uses for the cap-cleanup tick after an auto-proceed fires.
    const c = new FakeClock();
    const calls: string[] = [];
    c.schedule(() => {
      calls.push("first");
      c.schedule(() => calls.push("chained"), 10);
    }, 50);
    c.advance(100);
    expect(calls).toEqual(["first", "chained"]);
  });
});

describe("FakeClock — cancel semantics", () => {
  it("cancel before fire prevents the callback from running", () => {
    const c = new FakeClock();
    const fn = vi.fn();
    const timer = c.schedule(fn, 100);
    timer.cancel();
    c.advance(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel after fire is a no-op (idempotent)", () => {
    const c = new FakeClock();
    const fn = vi.fn();
    const timer = c.schedule(fn, 10);
    c.advance(20);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(() => timer.cancel()).not.toThrow();
  });

  it("pendingCount excludes cancelled timers", () => {
    const c = new FakeClock();
    const a = c.schedule(() => {}, 100);
    c.schedule(() => {}, 200);
    expect(c.pendingCount()).toBe(2);
    a.cancel();
    expect(c.pendingCount()).toBe(1);
  });
});

describe("FakeClock — argument validation", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
  ])("schedule rejects ms = %s", (_label, ms) => {
    const c = new FakeClock();
    expect(() => c.schedule(() => {}, ms)).toThrow(/non-negative finite/);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
  ])("advance rejects ms = %s", (_label, ms) => {
    const c = new FakeClock();
    expect(() => c.advance(ms)).toThrow(/non-negative finite/);
  });

  it("setNow rejects non-finite ms (allows negatives — caller pinning known origin)", () => {
    const c = new FakeClock();
    expect(() => c.setNow(Number.NaN)).toThrow(/finite/);
    // Negative is allowed — represents a known wallclock origin before
    // epoch; not realistic for production but harmless for tests.
    expect(() => c.setNow(-100)).not.toThrow();
  });
});

describe("ClockSource — both implementations satisfy the interface", () => {
  // Type-level: both impls assign to a ClockSource binding. Behavioural:
  // schedule + cancel + now exist on both. This is the "fakes match
  // production" canary — adding a method to the interface forces both
  // to implement it or the test file fails to typecheck.
  it("both implementations expose now() and schedule()", () => {
    const real: ClockSource = SystemClock;
    const fake: ClockSource = new FakeClock();
    expect(typeof real.now).toBe("function");
    expect(typeof real.schedule).toBe("function");
    expect(typeof fake.now).toBe("function");
    expect(typeof fake.schedule).toBe("function");
  });
});
