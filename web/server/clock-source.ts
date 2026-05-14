/**
 * ClockSource — dependency-injection seam for `Date.now()` and
 * `setTimeout` so timer-driven code (idle-timer-manager, reconnect-grace,
 * health checks) becomes testable without `vi.useFakeTimers` gymnastics
 * or 5-minute wallclock sleeps in CI.
 *
 * Two reasons it lives in its own file rather than `session-types.ts`:
 * the latter is the CLI wire-format schema surface (665 lines of
 * NDJSON message shapes) and Fowler P6 ("earn the boundaries where they
 * matter") argues that timing-source DI is a distinct concern. Anyone
 * grepping for `clock` finds the whole feature here.
 *
 * The interface is intentionally tiny — `now()` + `schedule()` — so
 * Carmack P9 ("same input ⇒ same effect; deterministic tests") is
 * trivially satisfied. New timing primitives (intervals, cron) should
 * be added here as discrete methods, not threaded through ad-hoc
 * setInterval/setTimeout call sites elsewhere.
 */

/**
 * Handle returned by `ClockSource.schedule`. Calling `cancel()` is
 * idempotent — already-fired or already-cancelled timers are no-ops.
 * Mirrors the contract `clearTimeout` provides for opaque timeout
 * handles in the Node/Bun runtime.
 */
export interface ClockTimer {
  cancel(): void;
}

/**
 * The seam itself. Two methods only; everything else (intervals, cron,
 * exponential backoff) builds on top so the fake stays cheap.
 *
 *  - `now()` returns a millisecond-resolution wallclock reading; in the
 *    fake it returns the test-driven counter without ever observing the
 *    real wallclock.
 *  - `schedule(fn, ms)` runs `fn` after `ms` milliseconds. The real
 *    implementation MUST call `.unref()` on the underlying handle so
 *    the Node/Bun process can exit even when a long-lived idle timer
 *    is still armed (otherwise CI test runs hang for the full timeout).
 */
export interface ClockSource {
  now(): number;
  schedule(fn: () => void, ms: number): ClockTimer;
}

/**
 * Real-wallclock implementation. Wraps `Date.now()` and `setTimeout`
 * with the `.unref()` discipline described above. Exported as a
 * singleton-by-value (not a class instance) so callers can pass it
 * through DI without worrying about new-vs-shared semantics.
 */
export const SystemClock: ClockSource = {
  now: () => Date.now(),
  schedule(fn, ms) {
    const handle = setTimeout(fn, ms);
    // `.unref` exists on Node/Bun `Timeout` handles but not on the
    // (numeric) browser handle the same DOM lib type union sometimes
    // claims. Feature-detect rather than cast so the call is a no-op
    // in environments where it doesn't apply.
    const maybeUnref = (handle as unknown as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") {
      maybeUnref.call(handle);
    }
    return {
      cancel: () => clearTimeout(handle),
    };
  },
};

/**
 * Fake clock for tests. Tests drive `advance(ms)` to fire all timers
 * whose due-time falls within the new wallclock window, and read `now()`
 * to confirm the model has moved. The pending-timer queue is a simple
 * array kept sorted by absolute due-time — fine for the test workload
 * size (single-digit pending entries per test). Production never sees
 * this implementation.
 *
 * Constructor takes an optional initial `now` so a test can pin a
 * known wallclock origin (ISO-readable in error messages) instead of
 * starting at 0.
 */
export class FakeClock implements ClockSource {
  private current: number;
  private pending: Array<{ id: number; due: number; fn: () => void; cancelled: boolean }> = [];
  private nextId = 1;

  constructor(initialNow = 0) {
    this.current = initialNow;
  }

  now(): number {
    return this.current;
  }

  schedule(fn: () => void, ms: number): ClockTimer {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`FakeClock.schedule: ms must be a non-negative finite number (got ${ms})`);
    }
    const id = this.nextId++;
    const entry = { id, due: this.current + ms, fn, cancelled: false };
    this.pending.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  /**
   * Advance the wallclock by `ms`. Fires every timer whose due-time
   * is ≤ the new wallclock, in due-time order. Re-entrancy is
   * supported — a timer callback that schedules another timer with a
   * due-time within the advanced window will also fire in the same
   * `advance` call, so chained timers don't require multiple advances
   * to drain.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`FakeClock.advance: ms must be a non-negative finite number (got ${ms})`);
    }
    const target = this.current + ms;
    // Loop because callbacks may schedule further timers; keep firing
    // until no more entries are due ≤ target.
    while (true) {
      const due = this.pending
        .filter((e) => !e.cancelled && e.due <= target)
        .sort((a, b) => a.due - b.due);
      if (due.length === 0) break;
      const next = due[0];
      // Remove first — same identity check, in case the array
      // changed during fire of a previous entry.
      const idx = this.pending.indexOf(next);
      if (idx !== -1) this.pending.splice(idx, 1);
      this.current = next.due;
      next.fn();
    }
    this.current = target;
  }

  /**
   * Hard-set the wallclock without firing any timers. Use to set up a
   * known origin before exercising time-dependent code — the test
   * still drives `advance()` for fires.
   */
  setNow(ms: number): void {
    if (!Number.isFinite(ms)) {
      throw new RangeError(`FakeClock.setNow: ms must be a finite number (got ${ms})`);
    }
    this.current = ms;
  }

  /** Number of pending (not-yet-fired, not-cancelled) timers. */
  pendingCount(): number {
    return this.pending.filter((e) => !e.cancelled).length;
  }
}
