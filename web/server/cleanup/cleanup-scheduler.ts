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

/**
 * AURA-LOCAL — PLAN T13 (Phase H). A reconcile callback fires exactly
 * ONCE at `start()`, BEFORE the first periodic tick. Receives the
 * server's boot timestamp so the callback can distinguish "orphan
 * sentinel from a previous crash" from "sentinel from a sweep on
 * THIS process".
 */
export type ReconcileCallback = (bootTimeMs: number) => Promise<void> | void;

export interface CleanupSchedulerOptions {
  /** Optional initial interval; defaults to 24h, clamped to [1h, 25h]. */
  readonly intervalMs?: number;
  /**
   * AURA-LOCAL — PLAN T13 (Phase H). Test seam: pin the bootTimeMs
   * passed to reconcile callbacks. Production omits this; the scheduler
   * captures `Date.now()` at construction.
   */
  readonly bootTimeMsForTests?: number;
}

export class CleanupScheduler {
  private readonly sweeps: Map<string, SweepCallback> = new Map();
  /**
   * AURA-LOCAL — PLAN T13 (Phase H). Reconcile callbacks fired exactly
   * ONCE at `start()` BEFORE the first periodic tick. This is the
   * recovery-after-crash seam for sentinel-based sweeps:
   *   • Phase H eviction → finishes `.evicting` sentinel renames +
   *     sweeps orphan `.<hex>.tmp` files older than boot time.
   * Future tiers (e.g., recordings-tier .sweep-in-progress recovery)
   * can register here without rewiring the periodic tick contract.
   *
   * The bootTimeMs argument is passed to each callback so a reconcile
   * can distinguish "orphan from a previous crash" from "actively
   * being written by THIS process right now".
   */
  private readonly reconciles: Map<string, ReconcileCallback> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private disposed = false;
  private intervalMs: number;
  /** AURA-LOCAL: bootTimeMs captured at construction so reconciles see a
   *  stable cutoff between "in-flight on this process" and "stale orphan". */
  private readonly bootTimeMs: number;
  /** AURA-LOCAL: test-only override bypasses the [1h, 25h] clamp. */
  private intervalOverrideForTests: number | null = null;
  // PLAN T6 (Phase C): sweep-status fields surfaced via accessors so the
  // 5-min diagnostic tick can report `lastSweepCompletedAt`,
  // `lastSweepDurationMs`, `sweepInFlight` without reaching into private
  // scheduler state. Bumped at sweep-completion (start + duration only —
  // a still-in-flight sweep is observable via `sweepInFlight`).
  private lastSweepCompletedAt: number | null = null;
  private lastSweepDurationMs: number | null = null;

  constructor(opts: CleanupSchedulerOptions = {}) {
    this.intervalMs = clampInterval(opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.bootTimeMs = opts.bootTimeMsForTests ?? Date.now();
  }

  /**
   * AURA-LOCAL — PLAN T13 (Phase H). Register a reconcile callback
   * that fires exactly ONCE — either at the upcoming `start()` (if
   * not yet started), OR immediately as a fire-and-forget Promise
   * (if `start()` has already armed the periodic tick). Idempotent
   * on `name`: re-registration replaces the previous callback.
   * Reconciles run in insertion order.
   *
   * Production wires `start()` at ~index.ts:272 and registers reconciles
   * at ~index.ts:725 — well after `start()`. The fire-on-register path
   * is the production path; the pre-start path supports tests that
   * register before arming.
   *
   * No-op when the scheduler is disposed.
   *
   * Throws on a callback that fires synchronously and throws — the
   * scheduler wraps each reconcile in try/catch + structured log
   * (`event=cleanup.reconcile.error`) so a buggy reconcile from one
   * sweep cannot suppress siblings.
   */
  registerReconcile(name: string, run: ReconcileCallback): void {
    if (this.disposed) return;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("CleanupScheduler.registerReconcile: invalid name");
    }
    if (typeof run !== "function") {
      throw new Error("CleanupScheduler.registerReconcile: invalid callback");
    }
    this.reconciles.set(name, run);
    if (this.started) {
      // Fire immediately — start() already happened, so the
      // boot-drain pass has run with whatever set existed at that
      // moment. The fire-on-register path keeps the semantics
      // "every registered reconcile runs exactly once".
      void this.runReconcile(name, run);
    }
  }

  private async runReconcile(name: string, run: ReconcileCallback): Promise<void> {
    try {
      await run(this.bootTimeMs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      log.error("cleanup-scheduler", "Reconcile callback threw", {
        event: "cleanup.reconcile.error",
        reconcile: name,
        error_message: message,
        error_code: code ?? "unknown",
      });
    }
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
   * Wallclock timestamp (Date.now-style ms) at which the most recent
   * sweep tick LANDED `cleanup.sweep.completed`. `null` before the first
   * sweep finishes — operators reading the 5-min diagnostic see `null`
   * during the freshly-booted "scheduler armed, first tick not due yet"
   * window. PLAN T6.
   */
  getLastSweepCompletedAt(): number | null {
    return this.lastSweepCompletedAt;
  }

  /**
   * Wallclock duration (ms) of the most recent sweep tick from
   * `cleanup.sweep.started` to `cleanup.sweep.completed`. `null` before
   * the first sweep finishes. Pair with `getLastSweepCompletedAt` in the
   * diagnostic emit so a sweep that takes pathologically long is visible
   * before it bites the gracefulShutdown 8s budget.
   */
  getLastSweepDurationMs(): number | null {
    return this.lastSweepDurationMs;
  }

  /**
   * True while a sweep tick is mid-flight. False between ticks (and
   * before `start()` arms the first tick). The diagnostic snapshot reads
   * this so operators can correlate a long `lastSweepDurationMs` with a
   * still-running tick vs. a previously-completed slow tick.
   */
  getSweepInFlight(): boolean {
    return this.inFlight !== null;
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
      reconcileCount: this.reconciles.size,
      bootTimeMs: this.bootTimeMs,
    });
    // AURA-LOCAL — PLAN T13 (Phase H). Boot-time reconcile pass fires
    // BEFORE the first periodic sweep tick. Each reconcile is wrapped
    // in try/catch so a thrower in one doesn't suppress siblings.
    //
    // Phase H scheduling: the reconcile is fire-and-forget (no `await`)
    // so the scheduler's start() stays synchronous — Node's process.exit
    // shouldn't wait on a reconcile that's exceeded its budget. Each
    // reconcile is bounded internally (eviction reconcile is a single
    // readdir + per-entry op; no syscalls past the cap).
    void this.drainReconciles();
    this.scheduleNext();
  }

  private async drainReconciles(): Promise<void> {
    for (const [name, run] of this.reconciles) {
      await this.runReconcile(name, run);
    }
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
    const sweepCompletedAt = Date.now();
    const durationMs = sweepCompletedAt - sweepStartedAt;
    // PLAN T6: capture sweep-status snapshot so the 5-min diagnostic
    // tick's `lastSweepCompletedAt` / `lastSweepDurationMs` accessors
    // return the LATEST completed tick's values. `getSweepInFlight()`
    // is derived from `this.inFlight` so it auto-clears on the
    // `.finally` in `scheduleNext`.
    this.lastSweepCompletedAt = sweepCompletedAt;
    this.lastSweepDurationMs = durationMs;
    log.info("cleanup-scheduler", "Sweep tick complete", {
      event: "cleanup.sweep.completed",
      sweepCount: this.sweeps.size,
      durationMs,
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
