import { describe, expect, it } from "vitest";
import {
  type GroupEvent,
  type GroupStatus,
  isObserverHealthy,
  isOperable,
  transition,
} from "./group-state-machine.js";

const ALL_STATES: GroupStatus[] = ["pairing", "active", "degraded", "archived", "reconnecting"];

describe("transition", () => {
  // The pairing → active path is the happy spawn sequence.
  it("pairing transitions to active on both_ready", () => {
    expect(transition("pairing", { type: "both_ready" })).toBe("active");
  });

  // active → degraded on a half death is the central invariant that
  // distinguishes "watching" from "alone". Three callers reading status
  // must all agree the moment a half dies.
  it("active transitions to degraded when a half dies", () => {
    expect(transition("active", { type: "half_died", role: "observer" })).toBe("degraded");
    expect(transition("active", { type: "half_died", role: "orchestrator" })).toBe("degraded");
  });

  // Respawn returns the group to operational state.
  it("degraded transitions back to active on half_respawned", () => {
    expect(transition("degraded", { type: "half_respawned", role: "observer" })).toBe("active");
  });

  // Reconnect window — active enters reconnecting on signal; positive
  // outcome restores active, negative drops to degraded.
  it("active enters reconnecting on reconnect_started", () => {
    expect(transition("active", { type: "reconnect_started" })).toBe("reconnecting");
  });

  it("reconnecting transitions to active on reconnect_ok", () => {
    expect(transition("reconnecting", { type: "reconnect_ok" })).toBe("active");
  });

  it("reconnecting transitions to degraded on reconnect_failed", () => {
    expect(transition("reconnecting", { type: "reconnect_failed" })).toBe("degraded");
  });

  // Archive is terminal — nothing can pull it back to a live state.
  // Without this rule a stale event from a torn-down group could
  // resurrect it ghost-style.
  it.each(["pairing", "active", "degraded", "reconnecting"] as const)(
    "user_archived from %s lands in archived",
    (from) => {
      expect(transition(from, { type: "user_archived" })).toBe("archived");
    },
  );

  it.each(["pairing", "active", "degraded", "reconnecting"] as const)(
    "user_killed from %s lands in archived",
    (from) => {
      expect(transition(from, { type: "user_killed" })).toBe("archived");
    },
  );

  // Once archived, every event is a no-op. A late half_died for an
  // already-archived group must not transition it to degraded.
  it.each<GroupEvent>([
    { type: "both_ready" },
    { type: "half_died", role: "observer" },
    { type: "half_respawned", role: "orchestrator" },
    { type: "reconnect_started" },
    { type: "reconnect_ok" },
    { type: "reconnect_failed" },
    { type: "user_archived" },
    { type: "user_killed" },
  ])("archived is terminal under event %#", (event) => {
    expect(transition("archived", event)).toBe("archived");
  });

  // Determinism check — every (state, event) pair returns a known state.
  // Catches any future event-type addition that forgets a case.
  it.each(ALL_STATES)("transition from %s never returns undefined", (state) => {
    const events: GroupEvent[] = [
      { type: "both_ready" },
      { type: "half_died", role: "observer" },
      { type: "half_respawned", role: "orchestrator" },
      { type: "reconnect_started" },
      { type: "reconnect_ok" },
      { type: "reconnect_failed" },
      { type: "user_archived" },
      { type: "user_killed" },
    ];
    for (const event of events) {
      expect(ALL_STATES).toContain(transition(state, event));
    }
  });
});

describe("isOperable", () => {
  // The orchestrator chat may keep accepting input in active, degraded,
  // and reconnecting — only pairing (not ready yet) and archived (gone)
  // disable input.
  it.each<[GroupStatus, boolean]>([
    ["pairing", false],
    ["active", true],
    ["degraded", true],
    ["reconnecting", true],
    ["archived", false],
  ])("isOperable(%s) = %s", (state, expected) => {
    expect(isOperable(state)).toBe(expected);
  });
});

describe("isObserverHealthy", () => {
  // Only `active` guarantees observer is up and producing findings.
  // Reconnecting and degraded both mean "do not trust observer signal".
  it.each<[GroupStatus, boolean]>([
    ["pairing", false],
    ["active", true],
    ["degraded", false],
    ["reconnecting", false],
    ["archived", false],
  ])("isObserverHealthy(%s) = %s", (state, expected) => {
    expect(isObserverHealthy(state)).toBe(expected);
  });
});
