/**
 * Bounded in-memory ring of recent events (plan Task 4; fowler 8, dahl).
 *
 * Generic on purpose: it knows nothing about drift. Bounded twice — by count
 * (oldest dropped when full) and by age (`snapshot` returns only events inside
 * the window). In memory only: it starts empty at server start, which the
 * Diagnostics card states explicitly (`windowStart`, `wrapped`).
 */

export interface TimedEvent {
  ts: number;
}

export class EventRing<T extends TimedEvent> {
  private readonly buf: T[] = [];
  private dropped = false;
  readonly startedAt: number;

  constructor(
    readonly capacity: number,
    readonly windowMs: number,
    now: () => number = Date.now,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("EventRing: capacity must be a positive integer");
    this.startedAt = now();
  }

  record(event: T): void {
    this.buf.push(event);
    if (this.buf.length > this.capacity) {
      this.buf.shift();
      this.dropped = true;
    }
  }

  /** Events with `ts >= now - windowMs`, newest first. */
  snapshot(now: number = Date.now()): { events: T[]; windowStart: number; wrapped: boolean } {
    const since = now - this.windowMs;
    const events = this.buf.filter((e) => e.ts >= since).sort((a, b) => b.ts - a.ts);
    return { events, windowStart: Math.max(this.startedAt, since), wrapped: this.dropped };
  }
}
