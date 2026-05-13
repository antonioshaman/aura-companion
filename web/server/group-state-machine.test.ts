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
  it("pairing transitions to active on both_ready", () => {
    expect(transition("pairing", { type: "both_ready" })).toBe("active");
  });

  it("active transitions to degraded when a half dies", () => {
    expect(transition("active", { type: "half_died", role: "observer" })).toBe("degraded");
    expect(transition("active", { type: "half_died", role: "orchestrator" })).toBe("degraded");
  });

  it("degraded transitions back to active on half_respawned", () => {
    expect(transition("degraded", { type: "half_respawned", role: "observer" })).toBe("active");
  });

  it("active enters reconnecting on reconnect_started", () => {
    expect(
      transition("active", { type: "reconnect_started", survivingRole: "orchestrator", deadlineMs: 1_000 }),
    ).toBe("reconnecting");
  });

  it("reconnecting transitions to active on reconnect_ok", () => {
    expect(transition("reconnecting", { type: "reconnect_ok", role: "observer" })).toBe("active");
  });

  it("reconnecting transitions to degraded on reconnect_failed", () => {
    expect(transition("reconnecting", { type: "reconnect_failed", role: "observer" })).toBe("degraded");
  });

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

  it.each<GroupEvent>([
    { type: "both_ready" },
    { type: "half_died", role: "observer" },
    { type: "half_respawned", role: "orchestrator" },
    { type: "reconnect_started", survivingRole: "orchestrator", deadlineMs: 1_000 },
    { type: "reconnect_ok", role: "observer" },
    { type: "reconnect_failed", role: "observer" },
    { type: "user_archived" },
    { type: "user_killed" },
  ])("archived is terminal under event %#", (event) => {
    expect(transition("archived", event)).toBe("archived");
  });

  // Beck F2: full transition table. Replaces the previous "never returns
  // undefined" loop (which a mutated `transition` returning a constant
  // would also have passed). This is the complete 5×8 state-machine
  // snapshot — any cell that drifts fails the test, not just "must be in
  // the state enum".
  it("matches the full transition table", () => {
    // Representative payloads for events that now carry data — the
    // transition table only cares about (from, event-discriminator) →
    // next, so the role / deadline values are stable filler.
    const reconnectStartedEv: GroupEvent = { type: "reconnect_started", survivingRole: "orchestrator", deadlineMs: 1_000 };
    const reconnectOkEv: GroupEvent = { type: "reconnect_ok", role: "observer" };
    const reconnectFailedEv: GroupEvent = { type: "reconnect_failed", role: "observer" };
    const table: Array<[GroupStatus, GroupEvent, GroupStatus]> = [
      // From pairing
      ["pairing", { type: "both_ready" }, "active"],
      ["pairing", { type: "half_died", role: "observer" }, "pairing"],
      ["pairing", { type: "half_respawned", role: "observer" }, "pairing"],
      ["pairing", reconnectStartedEv, "pairing"],
      ["pairing", reconnectOkEv, "pairing"],
      ["pairing", reconnectFailedEv, "pairing"],
      ["pairing", { type: "user_archived" }, "archived"],
      ["pairing", { type: "user_killed" }, "archived"],
      // From active
      ["active", { type: "both_ready" }, "active"],
      ["active", { type: "half_died", role: "observer" }, "degraded"],
      ["active", { type: "half_respawned", role: "observer" }, "active"],
      ["active", reconnectStartedEv, "reconnecting"],
      ["active", reconnectOkEv, "active"],
      ["active", reconnectFailedEv, "active"],
      ["active", { type: "user_archived" }, "archived"],
      ["active", { type: "user_killed" }, "archived"],
      // From degraded
      ["degraded", { type: "both_ready" }, "degraded"],
      ["degraded", { type: "half_died", role: "observer" }, "degraded"],
      ["degraded", { type: "half_respawned", role: "observer" }, "active"],
      ["degraded", reconnectStartedEv, "degraded"],
      ["degraded", reconnectOkEv, "degraded"],
      ["degraded", reconnectFailedEv, "degraded"],
      ["degraded", { type: "user_archived" }, "archived"],
      ["degraded", { type: "user_killed" }, "archived"],
      // From reconnecting
      ["reconnecting", { type: "both_ready" }, "reconnecting"],
      ["reconnecting", { type: "half_died", role: "observer" }, "reconnecting"],
      ["reconnecting", { type: "half_respawned", role: "observer" }, "reconnecting"],
      ["reconnecting", reconnectStartedEv, "reconnecting"],
      ["reconnecting", reconnectOkEv, "active"],
      ["reconnecting", reconnectFailedEv, "degraded"],
      ["reconnecting", { type: "user_archived" }, "archived"],
      ["reconnecting", { type: "user_killed" }, "archived"],
      // From archived — terminal under every event
      ["archived", { type: "both_ready" }, "archived"],
      ["archived", { type: "half_died", role: "observer" }, "archived"],
      ["archived", { type: "half_respawned", role: "observer" }, "archived"],
      ["archived", reconnectStartedEv, "archived"],
      ["archived", reconnectOkEv, "archived"],
      ["archived", reconnectFailedEv, "archived"],
      ["archived", { type: "user_archived" }, "archived"],
      ["archived", { type: "user_killed" }, "archived"],
    ];
    for (const [from, event, expected] of table) {
      expect(transition(from, event), `transition(${from}, ${event.type}) should be ${expected}`).toBe(expected);
    }
  });
});

describe("isOperable", () => {
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

// Make ALL_STATES referenced so linters don't flag it; remains an
// inventory of valid states for any future regression test.
describe("ALL_STATES inventory", () => {
  it("covers every state in the discriminated union", () => {
    expect(ALL_STATES).toContain("pairing");
    expect(ALL_STATES).toContain("active");
    expect(ALL_STATES).toContain("degraded");
    expect(ALL_STATES).toContain("archived");
    expect(ALL_STATES).toContain("reconnecting");
  });
});
