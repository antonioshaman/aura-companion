// AURA-LOCAL
// Event-loop lag detector (P7/SERVER-STDOUT-STALL).
//
// Why this exists: silent-stdio drift kills showed Claude CLIs whose stdout
// went quiet while their transcript kept growing, and 23 of 52 such stalls
// overlapped a stall in another session. One candidate cause is the bun
// event loop itself being blocked (sync fs on a hot path, GC, cgroup memory
// throttle), which would starve every stdout pump at once. Recordings argue
// against it (bun kept reading other CLIs during 21 of the stalls), but
// there was no direct measurement. This module provides one.
//
// Mechanism: a `setInterval` ticks every `intervalMs`; the gap between the
// expected and the actual tick time is the time the loop could not run
// timers. A gap above `thresholdMs` emits a structured `server.event_loop_lag`
// warning. To say *what* blocked the loop, hot synchronous call sites wrap
// themselves in `trackSync(label, fn)`; each wrapped call records its
// duration into a bounded ring, and the warning lists the slowest operations
// that ran since the previous tick. Untracked time shows up as the gap
// between `lagMs` and the top operation's duration.
//
// Cost: one timer at 500 ms plus two `performance.now()` calls per tracked
// call — negligible next to JSON parsing of a stdout frame.

export interface TrackedOperation {
  label: string;
  durationMs: number;
  /** Monotonic end time (performance.now()-style clock). */
  endedAt: number;
}

export interface EventLoopLagReport {
  lagMs: number;
  intervalMs: number;
  /** Slowest tracked operations that finished since the previous tick, slowest first. */
  topOperations: TrackedOperation[];
  /** Tracked operations that finished since the previous tick (before truncation). */
  operationCount: number;
}

export interface EventLoopLagMonitorOptions {
  intervalMs?: number;
  thresholdMs?: number;
  /** Ring capacity for tracked operations. */
  capacity?: number;
  /** How many operations a report lists. */
  topN?: number;
  /** Monotonic clock in ms. Injected for tests. */
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  onLag: (report: EventLoopLagReport) => void;
}

export const DEFAULT_LAG_INTERVAL_MS = 500;
export const DEFAULT_LAG_THRESHOLD_MS = 1000;
const DEFAULT_CAPACITY = 64;
const DEFAULT_TOP_N = 5;

export class EventLoopLagMonitor {
  readonly intervalMs: number;
  readonly thresholdMs: number;
  private readonly capacity: number;
  private readonly topN: number;
  private readonly now: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly onLag: (report: EventLoopLagReport) => void;
  private readonly ring: TrackedOperation[] = [];
  private ringNext = 0;
  private handle: unknown = null;
  private lastTickAt = 0;

  constructor(opts: EventLoopLagMonitorOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_LAG_INTERVAL_MS;
    this.thresholdMs = opts.thresholdMs ?? DEFAULT_LAG_THRESHOLD_MS;
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    this.topN = Math.max(1, opts.topN ?? DEFAULT_TOP_N);
    this.now = opts.now ?? (() => performance.now());
    this.setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.onLag = opts.onLag;
  }

  start(): void {
    if (this.handle !== null) return;
    this.lastTickAt = this.now();
    const handle = this.setIntervalFn(() => this.tick(), this.intervalMs);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.handle = handle;
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  /** Run `fn`, recording its synchronous duration under `label`. Rethrows. */
  trackSync<T>(label: string, fn: () => T): T {
    const startedAt = this.now();
    try {
      return fn();
    } finally {
      const endedAt = this.now();
      this.record({ label, durationMs: endedAt - startedAt, endedAt });
    }
  }

  /** Timer callback. Public so tests can drive it with a fake clock. */
  tick(): void {
    const now = this.now();
    const lagMs = now - this.lastTickAt - this.intervalMs;
    const windowStart = this.lastTickAt;
    this.lastTickAt = now;
    if (lagMs <= this.thresholdMs) return;
    const recent = this.ring.filter((op) => op.endedAt >= windowStart);
    const topOperations = [...recent]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, this.topN);
    try {
      this.onLag({ lagMs, intervalMs: this.intervalMs, topOperations, operationCount: recent.length });
    } catch {
      // A throwing sink must not kill the only lag timer.
    }
  }

  private record(op: TrackedOperation): void {
    if (this.ring.length < this.capacity) {
      this.ring.push(op);
    } else {
      this.ring[this.ringNext] = op;
    }
    this.ringNext = (this.ringNext + 1) % this.capacity;
  }
}

/** `label=12ms, label=3ms` — compact form for the single-line log. */
export function formatTopOperations(ops: TrackedOperation[]): string {
  if (ops.length === 0) return "none";
  return ops.map((op) => `${op.label}=${Math.round(op.durationMs)}ms`).join(", ");
}

// ── Process-wide instance ───────────────────────────────────────────────
// Call sites (cli-launcher stdout pump, drift detector tick, session store
// writes) import `trackSync` directly; the server entry point installs the
// sink and starts the timer. Until `installEventLoopLagMonitor` runs (tests,
// tools), `trackSync` is a plain call with no recording.

let processMonitor: EventLoopLagMonitor | null = null;

export function installEventLoopLagMonitor(opts: EventLoopLagMonitorOptions): EventLoopLagMonitor {
  processMonitor?.stop();
  processMonitor = new EventLoopLagMonitor(opts);
  processMonitor.start();
  return processMonitor;
}

export function trackSync<T>(label: string, fn: () => T): T {
  return processMonitor ? processMonitor.trackSync(label, fn) : fn();
}

/** AP-17 reset helper: stops and forgets the process-wide monitor. */
export function __resetEventLoopLagMonitorForTests(): void {
  processMonitor?.stop();
  processMonitor = null;
}
