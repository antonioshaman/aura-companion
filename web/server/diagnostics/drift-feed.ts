/**
 * Drift feed for the Diagnostics page (plan Task 4, AC2).
 *
 * Fed by `SessionRecoveryDeps.onDriftEvent` with the exact payload of each
 * `silent_stdio_drift.*` log line. Stores only scalar fields (no wait-channel
 * dumps, no nested evidence), bounded by count and a 24 h window.
 */

import type { DriftEventView, DriftFeedView } from "./diagnostics-types.js";
import { EventRing } from "./event-ring.js";

export const DRIFT_FEED_CAPACITY = 500;
export const DRIFT_FEED_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_FIELD_CHARS = 200;

export class DriftFeed {
  private readonly ring: EventRing<DriftEventView>;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.ring = new EventRing<DriftEventView>(DRIFT_FEED_CAPACITY, DRIFT_FEED_WINDOW_MS, now);
  }

  record(payload: Record<string, unknown>): void {
    const event = typeof payload.event === "string" ? payload.event : null;
    if (!event) return;
    const fields: DriftEventView["fields"] = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k === "event" || k === "sessionId" || k === "reason") continue;
      if (typeof v === "number" || typeof v === "boolean") fields[k] = v;
      else if (typeof v === "string") fields[k] = v.length > MAX_FIELD_CHARS ? `${v.slice(0, MAX_FIELD_CHARS)}…` : v;
    }
    this.ring.record({
      ts: this.now(),
      event,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      ...(typeof payload.reason === "string" ? { reason: payload.reason.slice(0, MAX_FIELD_CHARS) } : {}),
      fields,
    });
  }

  view(): DriftFeedView {
    const snap = this.ring.snapshot(this.now());
    return { events: snap.events, windowStart: snap.windowStart, wrapped: snap.wrapped, capacity: this.ring.capacity };
  }
}
