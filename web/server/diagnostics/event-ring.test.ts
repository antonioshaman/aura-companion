// Tests for the bounded event ring and the drift feed built on it (AC2).
//
// What is validated:
//   - the ring drops the oldest event when full and reports `wrapped`;
//   - snapshot returns only events inside the window, newest first, and the
//     window never starts before the ring was created (server start);
//   - the drift feed keeps event name, sessionId and reason verbatim, keeps
//     only scalar fields, truncates long strings, and ignores payloads with no
//     `event` (it must never invent a row).

import { describe, expect, it } from "vitest";
import { EventRing } from "./event-ring.js";
import { DriftFeed } from "./drift-feed.js";

describe("EventRing", () => {
  it("drops the oldest when full and says so", () => {
    let t = 1000;
    const ring = new EventRing<{ ts: number; n: number }>(2, 10_000, () => t);
    ring.record({ ts: t++, n: 1 });
    ring.record({ ts: t++, n: 2 });
    expect(ring.snapshot(t).wrapped).toBe(false);
    ring.record({ ts: t++, n: 3 });
    const snap = ring.snapshot(t);
    expect(snap.events.map((e) => e.n)).toEqual([3, 2]);
    expect(snap.wrapped).toBe(true);
  });

  it("returns only events inside the window, newest first", () => {
    const ring = new EventRing<{ ts: number; n: number }>(10, 1000, () => 0);
    ring.record({ ts: 100, n: 1 });
    ring.record({ ts: 1500, n: 2 });
    ring.record({ ts: 1800, n: 3 });
    const snap = ring.snapshot(2000);
    expect(snap.events.map((e) => e.n)).toEqual([3, 2]);
    expect(snap.windowStart).toBe(1000);
  });
});

describe("DriftFeed", () => {
  it("keeps the event, sessionId and reason verbatim and only scalar fields", () => {
    let now = 5000;
    const feed = new DriftFeed(() => now);
    feed.record({
      event: "silent_stdio_drift.detected",
      sessionId: "s1",
      reason: "jsonl mtime 26s newer",
      mtimeDeltaMs: 26358,
      subagentActive: false,
      nested: { a: 1 },
      list: [1, 2],
      cliWaitChannels: "x".repeat(500),
    });
    now = 6000;
    feed.record({ event: "silent_stdio_drift.withheld_open_tool_call", sessionId: "s1", toolCallStartedAtMs: 4000 });
    feed.record({ sessionId: "s2" }); // no event → ignored

    const view = feed.view();
    expect(view.events.map((e) => e.event)).toEqual([
      "silent_stdio_drift.withheld_open_tool_call",
      "silent_stdio_drift.detected",
    ]);
    const detected = view.events[1];
    expect(detected).toMatchObject({ ts: 5000, sessionId: "s1", reason: "jsonl mtime 26s newer" });
    expect(detected.fields).toMatchObject({ mtimeDeltaMs: 26358, subagentActive: false });
    expect(detected.fields).not.toHaveProperty("nested");
    expect(detected.fields).not.toHaveProperty("list");
    expect(String(detected.fields.cliWaitChannels).length).toBeLessThanOrEqual(201);
  });
});
