import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventLoopLagMonitor,
  __resetEventLoopLagMonitorForTests,
  formatTopOperations,
  installEventLoopLagMonitor,
  trackSync,
  type EventLoopLagReport,
} from "./event-loop-lag-monitor.js";

// The lag detector exists to answer one question from production logs: when
// Claude CLI stdout goes silent, was the bun event loop blocked, and by what?
// These tests pin (a) the lag arithmetic, (b) that a report names the slowest
// tracked operations from the window that produced the lag (not older ones),
// and (c) that the detector never takes the process down with it.

/** Fake monotonic clock + manually driven interval. */
function harness(opts: { intervalMs?: number; thresholdMs?: number; capacity?: number; topN?: number } = {}) {
  let t = 1_000;
  const reports: EventLoopLagReport[] = [];
  let scheduled: (() => void) | null = null;
  const unref = vi.fn();
  const clearIntervalFn = vi.fn();
  const monitor = new EventLoopLagMonitor({
    intervalMs: opts.intervalMs ?? 500,
    thresholdMs: opts.thresholdMs ?? 1_000,
    capacity: opts.capacity,
    topN: opts.topN,
    now: () => t,
    setIntervalFn: (fn) => {
      scheduled = fn;
      return { unref };
    },
    clearIntervalFn,
    onLag: (r) => reports.push(r),
  });
  return {
    monitor,
    reports,
    unref,
    clearIntervalFn,
    advance: (ms: number) => {
      t += ms;
    },
    fire: () => scheduled?.(),
    /** A tracked synchronous op that "takes" `ms` on the fake clock. */
    op: (label: string, ms: number) =>
      monitor.trackSync(label, () => {
        t += ms;
      }),
  };
}

describe("EventLoopLagMonitor", () => {
  it("stays silent while ticks arrive on time or late by no more than the threshold", () => {
    const h = harness();
    h.monitor.start();
    h.advance(500);
    h.fire(); // on time: lag 0
    h.advance(1_500);
    h.fire(); // late by exactly 1000 ms = threshold, not above it
    expect(h.reports).toEqual([]);
  });

  it("reports lag above the threshold with the slowest operations of that window, slowest first", () => {
    const h = harness({ topN: 2 });
    h.monitor.start();
    h.op("old.op", 900); // finishes before the first tick → belongs to an earlier window
    h.advance(100);
    h.fire(); // lag = 1000 - 500 = 500 → below threshold, but it resets the window
    h.op("session-store.save", 1_200);
    h.op("cli.stdout:abcd1234", 30);
    h.op("drift-detector.tick", 300);
    h.advance(500);
    h.fire();

    expect(h.reports).toHaveLength(1);
    const [r] = h.reports;
    // elapsed since previous tick = 1200 + 30 + 300 + 500 = 2030 → lag 1530
    expect(r.lagMs).toBe(1_530);
    expect(r.intervalMs).toBe(500);
    expect(r.operationCount).toBe(3);
    // topN=2 truncates; "old.op" from the previous window must not leak in.
    expect(r.topOperations.map((o) => o.label)).toEqual(["session-store.save", "drift-detector.tick"]);
    expect(r.topOperations[0].durationMs).toBe(1_200);
  });

  it("reports untracked blocking with an empty operation list", () => {
    // A block nobody wrapped (GC, cgroup throttle, an un-instrumented sync
    // call) must still be reported — that is the case the WARN's
    // `untrackedMs` field exists for.
    const h = harness();
    h.monitor.start();
    h.advance(3_000);
    h.fire();
    expect(h.reports).toEqual([{ lagMs: 2_500, intervalMs: 500, topOperations: [], operationCount: 0 }]);
  });

  it("trackSync returns the callback's value, and records + rethrows when it throws", () => {
    const h = harness({ thresholdMs: 0 });
    h.monitor.start();
    expect(h.monitor.trackSync("ok", () => 42)).toBe(42);
    expect(() =>
      h.monitor.trackSync("boom", () => {
        h.advance(700);
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    h.fire();
    expect(h.reports[0].topOperations[0]).toMatchObject({ label: "boom", durationMs: 700 });
  });

  it("keeps at most `capacity` operations (bounded memory on a busy stdout pump)", () => {
    const h = harness({ capacity: 3, topN: 10, thresholdMs: 0 });
    h.monitor.start();
    for (let i = 0; i < 10; i++) h.op(`op${i}`, i + 1);
    h.advance(500); // the interval itself; the ops' 55 ms are the lag
    h.fire();
    // Only the 3 most recent survive the ring: op7..op9.
    expect(h.reports[0].operationCount).toBe(3);
    expect(h.reports[0].topOperations.map((o) => o.label)).toEqual(["op9", "op8", "op7"]);
  });

  it("survives a throwing sink and keeps reporting on later ticks", () => {
    let calls = 0;
    let t = 0;
    let fire: () => void = () => {};
    const monitor = new EventLoopLagMonitor({
      intervalMs: 100,
      thresholdMs: 100,
      now: () => t,
      setIntervalFn: (fn) => {
        fire = fn;
        return {};
      },
      clearIntervalFn: () => {},
      onLag: () => {
        calls++;
        throw new Error("logger broke");
      },
    });
    monitor.start();
    t += 1_000;
    expect(() => fire()).not.toThrow();
    t += 1_000;
    fire();
    expect(calls).toBe(2);
  });

  it("start is idempotent, unrefs the timer, and stop clears it", () => {
    const h = harness();
    h.monitor.start();
    h.monitor.start();
    expect(h.unref).toHaveBeenCalledTimes(1);
    expect(h.monitor.running).toBe(true);
    h.monitor.stop();
    h.monitor.stop();
    expect(h.clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(h.monitor.running).toBe(false);
  });

  it("detects a real synchronous block with real timers", async () => {
    // End-to-end on the actual event loop: busy-wait 250 ms inside a tracked
    // call and expect a report naming that call. Small interval/threshold
    // keep the test fast.
    const reports: EventLoopLagReport[] = [];
    const monitor = new EventLoopLagMonitor({ intervalMs: 20, thresholdMs: 100, onLag: (r) => reports.push(r) });
    monitor.start();
    try {
      await new Promise((r) => setTimeout(r, 30));
      monitor.trackSync("busy.wait", () => {
        const until = performance.now() + 250;
        while (performance.now() < until) {
          // spin
        }
      });
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      monitor.stop();
    }
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].lagMs).toBeGreaterThan(100);
    expect(reports[0].topOperations[0].label).toBe("busy.wait");
    expect(reports[0].topOperations[0].durationMs).toBeGreaterThanOrEqual(240);
  });
});

describe("process-wide trackSync", () => {
  beforeEach(() => __resetEventLoopLagMonitorForTests());
  afterEach(() => __resetEventLoopLagMonitorForTests());

  it("is a plain passthrough before a monitor is installed", () => {
    // Call sites in cli-launcher/session-store run in unit tests that never
    // install a monitor; they must behave exactly as before.
    expect(trackSync("x", () => "value")).toBe("value");
    expect(() =>
      trackSync("x", () => {
        throw new Error("propagates");
      }),
    ).toThrow("propagates");
  });

  it("records into the installed monitor, and reinstalling stops the previous one", () => {
    let t = 0;
    const fires: Array<() => void> = [];
    const reports: EventLoopLagReport[] = [];
    const cleared: unknown[] = [];
    const mk = () =>
      installEventLoopLagMonitor({
        intervalMs: 100,
        thresholdMs: 0,
        now: () => t,
        setIntervalFn: (fn) => {
          fires.push(fn);
          return fires.length;
        },
        clearIntervalFn: (h) => cleared.push(h),
        onLag: (r) => reports.push(r),
      });
    const first = mk();
    const second = mk();
    expect(first.running).toBe(false);
    expect(cleared).toEqual([1]);
    trackSync("session-store.save", () => {
      t += 400;
    });
    fires[1]();
    expect(second.running).toBe(true);
    expect(reports[0].topOperations[0]).toMatchObject({ label: "session-store.save", durationMs: 400 });
  });
});

describe("formatTopOperations", () => {
  it("renders a compact single-line list and 'none' when empty", () => {
    expect(formatTopOperations([])).toBe("none");
    expect(
      formatTopOperations([
        { label: "session-store.save", durationMs: 1_234.6, endedAt: 0 },
        { label: "cli.stdout:abcd1234", durationMs: 3.2, endedAt: 0 },
      ]),
    ).toBe("session-store.save=1235ms, cli.stdout:abcd1234=3ms");
  });
});

describe("server wiring (index.ts canary)", () => {
  // index.ts boots the whole server on import, so — like
  // index-diagnostics-emit.test.ts — the wiring is pinned on the source text.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

  it("installs the monitor and emits the structured server.event_loop_lag WARN", () => {
    expect(src).toContain("installEventLoopLagMonitor(");
    expect(src).toContain('event: "server.event_loop_lag"');
    for (const field of ["lagMs:", "topOperations:", "operationCount:", "untrackedMs:", "rss:", "heapUsed:"]) {
      expect(src).toContain(field);
    }
  });

  it("stops the monitor during graceful shutdown", () => {
    const body = src.slice(src.indexOf("async function gracefulShutdown"));
    expect(body.indexOf("eventLoopLagMonitor.stop()")).toBeGreaterThan(0);
    expect(body.indexOf("eventLoopLagMonitor.stop()")).toBeLessThan(body.indexOf("orchestrator.getCouncilCoordinator()"));
  });
});
