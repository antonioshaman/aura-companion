// Tests for the accumulation trigger (spec §3.2; AC4, AC5).
//
// AC4: last run 2 days ago, 3 new entries, 7 sessions → not due, and the card
// string reads exactly "3/10 entries · 7/25 sessions · due in ≤12 days".
// AC5: 10 entries since the last run → due by entries. Each threshold alone
// makes it due ("any one of"); entries are counted by their own createdAt /
// updatedAt, never file mtimes.

import { describe, expect, it } from "vitest";
import { countNewEntries, evaluateTrigger, formatProgress } from "./kb-analysis-trigger.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const DAY = 86_400_000;
const T = { newEntriesThreshold: 10, sessionsThreshold: 25, maxAgeDays: 14 };

describe("evaluateTrigger", () => {
  it("AC4: not due, with the exact card wording", () => {
    const p = evaluateTrigger({ lastRunAt: NOW - 2 * DAY, newEntries: 3, sessions: 7, now: NOW, thresholds: T });
    expect(p.due).toBe(false);
    expect(formatProgress(p)).toBe("3/10 entries · 7/25 sessions · due in ≤12 days");
  });

  it("AC5: due by entries once 10 were added", () => {
    const p = evaluateTrigger({ lastRunAt: NOW - 2 * DAY, newEntries: 10, sessions: 0, now: NOW, thresholds: T });
    expect(p).toMatchObject({ due: true, reason: "entries" });
  });

  it("any one threshold is enough: sessions, then age", () => {
    expect(evaluateTrigger({ lastRunAt: NOW - DAY, newEntries: 0, sessions: 25, now: NOW, thresholds: T }).reason).toBe("sessions");
    expect(evaluateTrigger({ lastRunAt: NOW - 14 * DAY, newEntries: 0, sessions: 0, now: NOW, thresholds: T })).toMatchObject({ reason: "age", dueInDays: 0 });
  });

  it("a KB that was never analysed is due by age right away", () => {
    expect(evaluateTrigger({ lastRunAt: null, newEntries: 0, sessions: 0, now: NOW, thresholds: T }).reason).toBe("age");
  });
});

describe("countNewEntries", () => {
  it("counts entries created or updated after the last run", () => {
    const load = {
      errors: [],
      stores: [
        {
          file: "g.jsonl",
          lines: [
            { kind: "entry" as const, text: "", entry: { id: "old", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" } },
            { kind: "entry" as const, text: "", entry: { id: "edited", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z" } },
            { kind: "entry" as const, text: "", entry: { id: "new", createdAt: "2026-10-18T00:00:00Z" } },
          ],
        },
      ],
    };
    expect(countNewEntries(load, Date.parse("2026-10-10T00:00:00Z"))).toBe(2);
    expect(countNewEntries(load, null)).toBe(3);
  });
});
