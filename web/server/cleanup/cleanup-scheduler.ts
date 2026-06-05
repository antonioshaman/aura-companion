// AURA-LOCAL
// CleanupScheduler — lifecycle owner for the daily cleanup-sweep cadence.
// PLAN task T4.
//
// Why a class with `start()` / `dispose()` instead of a bare
// `setInterval`:
//   1. `setInterval(fn, 24h)` pegs a queue: laptop sleep / clock jump
//      can fire many ticks back-to-back when the host resumes. The
//      self-rescheduling `setTimeout(runSweep, computeNextRunMs())`
//      pattern collapses missed ticks to ONE.
//   2. An unhandled rejection inside a `setInterval` callback crashes
//      Bun. Wrapping each registered sweep in `try/catch (err: unknown)`
//      + structured log keeps a buggy sweeper from taking down the
//      server.
//   3. `gracefulShutdown` needs to AWAIT any in-flight sweep so a SIGTERM
//      mid-sweep doesn't leave half-evicted Map state. `dispose()`
//      returns a promise that resolves once the in-flight run completes.
//
// Phase B ships the lifecycle skeleton + sweep registry. Phases D/E/H
// each call `registerSweep(name, run)` to add their tier. The scheduler
// does NOT know about the specifics of any tier — it owns the timing,
// the error boundary, and the shutdown handshake; the tiers own the
// "what to delete."
//
// Interval clamp [1h, 25h]: the brief specifies the daily cadence with
// drift tolerance (25h not 24h covers the 24h+jitter shape Phase E's
// retention tier expects). Test-only override `__setIntervalMsForTests`
// bypasses the clamp so suites can advance fake timers without waiting
// real wall-time. Production callers MUST NOT call the override —
// the `ForTests` suffix is the boundary marker.

import { log } from "../logger.js";

const MIN_INTERVAL_MS = 60 * 60 * 1000;        // 1h
const MAX_INTERVAL_MS = 25 * 60 * 60 * 1000;   // 25h
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/** Each registered sweep runs in sequence inside one tick. */
export type SweepCallback = () => Promise<void> | void;

export interface SweepRegistration {
  readonly name: string;
  readonly run: SweepCallback;
}

export interface CleanupSchedulerOptions {
  /** Optional initial interval; defaults to 24h, clamped to [1h, 25h]. */
  readonly intervalMs?: number;
}

export class CleanupScheduler {
  private readonly sweeps: Map<string, SweepCallback> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private disposed = false;
  private intervalMs: number;
  /** AURA-LOCAL: test-only override bypasses the [1h, 25h] clamp. */
  private intervalOverrideForTests: number | null = null;

  constructor(opts: CleanupSchedulerOptions = {}) {
    this.intervalMs = clampInterval(opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  /**
   * Register a sweep callback. Idempotent on `name`: re-registration
   * replaces the previous callback. Sweeps run in insertion order
   * inside each tick.
   *
   * Safe to call BEFORE OR AFTER `start()`. Phase D/E/H wire their
   * sweepers at boot time AFTER constructing the scheduler in
   * `index.ts`.
   */
  registerSweep(name: string, run: SweepCallback): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("CleanupScheduler.registerSweep: invalid name");
    }
    if (typeof run !== "function") {
      throw new Error("CleanupScheduler.registerSweep: invalid callback");
    }
    this.sweeps.set(name, run);
  }

  /** Returns true after `start()` has armed the first timer. Idempotent. */
  isStarted(): boolean {
    return this.started && !this.disposed;
  }

  /**
   * Arm the first timer tick. Idempotent — a second `start()` call is a
   * no-op. Calling `start()` after `dispose()` is also a no-op (the
   * scheduler is permanently retired post-dispose).
   */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    log.info("cleanup-scheduler", "Scheduler started", {
      event: "cleanup.scheduler.started",
      intervalMs: this.getEffectiveIntervalMs(),
      sweepCount: this.sweeps.size,
    });
    this.scheduleNext();
  }

  /**
   * Cancel any pending timer + await any in-flight sweep. Returns once
   * the scheduler is fully drained. Safe to call multiple times — only
   * the first call actually mutates state.
   *
   * `index.ts` wires `dispose()` into `gracefulShutdown` BEFORE the
   * container-state persist so the 8s shutdown budget covers any
   * in-flight sweep + the container persist serially. A sweep that
   * exceeds the budget is the orchestrator's problem, not the
   * scheduler's — the scheduler is a transparent forwarder.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      // Still await an in-flight run even on repeated dispose so
      // shutdown waits for genuine drain.
      if (this.inFlight) {
        try { await this.inFlight; } catch { /* logged in runSweep */ }
      }
      return;
    }
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) {
      try { await this.inFlight; } catch { /* logged in runSweep */ }
    }
    log.info("cleanup-scheduler", "Scheduler disposed", {
      event: "cleanup.scheduler.disposed",
    });
  }

  /**
   * Test seam: bypass the [1h, 25h] clamp so suites can advance fake
   * timers without waiting real wall-time. The override applies on the
   * NEXT `scheduleNext` call — typically test pattern is:
   *   scheduler.__setIntervalMsForTests(10);
   *   scheduler.start();
   *   await vi.advanceTimersByTimeAsync(20);
   * Production code MUST NOT call this.
   */
  __setIntervalMsForTests(ms: number): void {
    this.intervalOverrideForTests = ms;
  }

  /**
   * Test seam: explicitly run one sweep cycle without waiting for the
   * scheduled timer. Returns the in-flight promise so the test can await
   * settlement. Used by suites that exercise the try/catch error boundary
   * without involving `setTimeout`.
   */
  async __runSweepNowForTests(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) {
      try { await this.inFlight; } catch { /* swallowed/logged */ }
      return;
    }
    this.inFlight = this.runSweep().finally(() => {
      this.inFlight = null;
    });
    try { await this.inFlight; } catch { /* swallowed/logged */ }
  }

  /** Effective ms used at the next `scheduleNext` call. */
  private getEffectiveIntervalMs(): number {
    return this.intervalOverrideForTests ?? this.intervalMs;
  }

  /** Schedule the next sweep tick. Captures the timer ref so `dispose()` can cancel it. */
  private scheduleNext(): void {
    if (this.disposed) return;
    const delayMs = this.getEffectiveIntervalMs();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.runSweep().finally(() => {
        this.inFlight = null;
        this.scheduleNext();
      });
    }, delayMs);
  }

  /**
   * Drain registered sweeps sequentially. Each sweep is wrapped in a
   * try/catch so a thrown error in tier N doesn't suppress tier N+1.
   * The error log shape is structured per EC-22 — operators alert on
   * `event=cleanup.sweep.error`.
   */
  private async runSweep(): Promise<void> {
    const sweepStartedAt = Date.now();
    log.info("cleanup-scheduler", "Sweep tick starting", {
      event: "cleanup.sweep.started",
      sweepCount: this.sweeps.size,
    });
    for (const [name, run] of this.sweeps) {
      try {
        await run();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        log.error("cleanup-scheduler", "Sweep callback threw", {
          event: "cleanup.sweep.error",
          sweep: name,
          error_message: message,
          error_code: code ?? "unknown",
        });
      }
    }
    log.info("cleanup-scheduler", "Sweep tick complete", {
      event: "cleanup.sweep.completed",
      sweepCount: this.sweeps.size,
      durationMs: Date.now() - sweepStartedAt,
    });
  }
}

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, ms));
}

/** Exported for sibling tests. */
export const __CLAMP_BOUNDS_FOR_TESTS = {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
} as const;
