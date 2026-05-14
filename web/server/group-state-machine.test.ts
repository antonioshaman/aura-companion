import { describe, expect, it } from "vitest";
import {
  deriveSideEffects,
  type GroupBusSideEffect,
  type GroupEvent,
  type GroupIdleTimerEffect,
  type GroupLogEntry,
  type GroupStatus,
  type GroupTransitionSideEffects,
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

// PLAN-aura-consolidated-refactor.md Task 1: direct unit coverage for the
// AP-2 keystone. The Council Review 2026-05-12-2211 flagged that
// `deriveSideEffects` had zero direct tests — every applyEvent correctness
// claim rested on integration happenstance. This block enumerates the full
// 5 × 8 cartesian `(prev_status × event_type)` matrix, computing the actual
// `next` via `transition()` and asserting exact `{busEvents, logEntries}`.
// Any cell that drifts fails the test by structural mismatch — not just
// "must be in the union shape."
//
// Realtime × Carmack — Principle 4 (Broadcast fan-out): the bus emit
// descriptors the coordinator enacts are the wire-frame plan. Direct
// coverage of the plan-producing function is the cheapest leverage in the
// council lifecycle: every subsequent reconnect/degrade behaviour change
// has a regression net.
//
// Backend × Carmack — Principle 8 (Type safety at the boundary): the
// TypeScript types `GroupTransitionSideEffects` and the runtime descriptors
// are validated together — drift between them is what this table catches.
describe("deriveSideEffects", () => {
  // Stable filler payloads for events that carry data. The descriptor
  // matrix only cares about (prev, next, event-discriminator) → side
  // effects, so role / deadline values are repeated through cells.
  const survObs: GroupEvent = {
    type: "reconnect_started",
    survivingRole: "observer",
    deadlineMs: 1_000,
  };
  const survOrch: GroupEvent = {
    type: "reconnect_started",
    survivingRole: "orchestrator",
    deadlineMs: 1_000,
  };
  const recOkObs: GroupEvent = { type: "reconnect_ok", role: "observer" };
  const recOkOrch: GroupEvent = { type: "reconnect_ok", role: "orchestrator" };
  const recFailedObs: GroupEvent = { type: "reconnect_failed", role: "observer" };
  const recFailedOrch: GroupEvent = { type: "reconnect_failed", role: "orchestrator" };
  const noop: GroupTransitionSideEffects = { busEvents: [], logEntries: [], idleTimerEffects: [] };
  const exited: GroupTransitionSideEffects = {
    busEvents: [{ kind: "exited", reason: "user_archived" }],
    logEntries: [{ event: "group.exited" }],
    idleTimerEffects: [],
  };

  // Helper — what `deriveSideEffects` should produce when an unintentional
  // exit (or a `reconnect_failed`) drives the group to degraded. The shape
  // diverges by event type: half_died logs `group.degraded` with the dead
  // role, while reconnect_failed logs `group.reconnect_failed` with the
  // role + attempts=1.
  function degradedFromHalfDied(role: "observer" | "orchestrator"): GroupTransitionSideEffects {
    return {
      busEvents: [{ kind: "degraded", deadRole: role }],
      logEntries: [{ event: "group.degraded", role }],
      idleTimerEffects: [],
    };
  }
  function degradedFromReconnectFailed(role: "observer" | "orchestrator"): GroupTransitionSideEffects {
    return {
      busEvents: [{ kind: "degraded", deadRole: role }],
      logEntries: [{ event: "group.reconnect_failed", role, attempts: 1 }],
      idleTimerEffects: [],
    };
  }
  function reconnectingFromStarted(survivingRole: "observer" | "orchestrator", deadlineMs: number): GroupTransitionSideEffects {
    return {
      busEvents: [{ kind: "reconnecting", survivingRole, deadlineMs }],
      logEntries: [{ event: "group.reconnect_started", role: survivingRole, attempts: 1 }],
      idleTimerEffects: [],
    };
  }
  function reconnectedOk(role: "observer" | "orchestrator"): GroupTransitionSideEffects {
    return {
      busEvents: [{ kind: "reconnected" }],
      logEntries: [{ event: "group.reconnect_ok", role, attempts: 1 }],
      idleTimerEffects: [],
    };
  }

  // The full table — every (prev × event) cell with the expected side
  // effects. The `next` column is intentionally computed via `transition()`
  // at test time, NOT pre-baked, so a drift in `transition()` flips the
  // descriptor expectation through the same chain the production
  // coordinator uses (`applyEvent` reads `next = transition(prev, event)`,
  // then calls `deriveSideEffects(prev, next, event)`).
  const table: Array<{ prev: GroupStatus; event: GroupEvent; expected: GroupTransitionSideEffects; label: string }> = [
    // ── from pairing ──
    { prev: "pairing", event: { type: "both_ready" }, expected: noop, label: "pairing × both_ready → active (no side effect; createCouncilGroup directly emits group:created)" },
    { prev: "pairing", event: { type: "half_died", role: "observer" }, expected: noop, label: "pairing × half_died/observer (no transition)" },
    { prev: "pairing", event: { type: "half_respawned", role: "observer" }, expected: noop, label: "pairing × half_respawned/observer (no transition)" },
    { prev: "pairing", event: survObs, expected: noop, label: "pairing × reconnect_started (no transition)" },
    { prev: "pairing", event: recOkObs, expected: noop, label: "pairing × reconnect_ok (no transition)" },
    { prev: "pairing", event: recFailedObs, expected: noop, label: "pairing × reconnect_failed (no transition)" },
    { prev: "pairing", event: { type: "user_archived" }, expected: exited, label: "pairing × user_archived → archived" },
    { prev: "pairing", event: { type: "user_killed" }, expected: exited, label: "pairing × user_killed → archived" },

    // ── from active ──
    { prev: "active", event: { type: "both_ready" }, expected: noop, label: "active × both_ready (no transition)" },
    { prev: "active", event: { type: "half_died", role: "observer" }, expected: degradedFromHalfDied("observer"), label: "active × half_died/observer → degraded" },
    { prev: "active", event: { type: "half_died", role: "orchestrator" }, expected: degradedFromHalfDied("orchestrator"), label: "active × half_died/orchestrator → degraded" },
    { prev: "active", event: { type: "half_respawned", role: "observer" }, expected: noop, label: "active × half_respawned (no transition)" },
    { prev: "active", event: survObs, expected: reconnectingFromStarted("observer", 1_000), label: "active × reconnect_started/observer → reconnecting" },
    { prev: "active", event: survOrch, expected: reconnectingFromStarted("orchestrator", 1_000), label: "active × reconnect_started/orchestrator → reconnecting" },
    { prev: "active", event: recOkObs, expected: noop, label: "active × reconnect_ok (no transition — not in a reconnect cycle)" },
    { prev: "active", event: recFailedObs, expected: noop, label: "active × reconnect_failed (no transition)" },
    { prev: "active", event: { type: "user_archived" }, expected: exited, label: "active × user_archived → archived" },
    { prev: "active", event: { type: "user_killed" }, expected: exited, label: "active × user_killed → archived" },

    // ── from degraded ──
    { prev: "degraded", event: { type: "both_ready" }, expected: noop, label: "degraded × both_ready (no transition)" },
    { prev: "degraded", event: { type: "half_died", role: "observer" }, expected: noop, label: "degraded × half_died (no transition — already degraded)" },
    // degraded → active via half_respawned has no descriptor emission;
    // session-orchestrator's recovery path re-emits group:created via the
    // synthetic replay channel, not through deriveSideEffects.
    { prev: "degraded", event: { type: "half_respawned", role: "observer" }, expected: noop, label: "degraded × half_respawned → active (no side effect; group:created replayed elsewhere)" },
    { prev: "degraded", event: survObs, expected: noop, label: "degraded × reconnect_started (no transition)" },
    { prev: "degraded", event: recOkObs, expected: noop, label: "degraded × reconnect_ok (no transition)" },
    { prev: "degraded", event: recFailedObs, expected: noop, label: "degraded × reconnect_failed (no transition)" },
    { prev: "degraded", event: { type: "user_archived" }, expected: exited, label: "degraded × user_archived → archived" },
    { prev: "degraded", event: { type: "user_killed" }, expected: exited, label: "degraded × user_killed → archived" },

    // ── from reconnecting ──
    { prev: "reconnecting", event: { type: "both_ready" }, expected: noop, label: "reconnecting × both_ready (no transition)" },
    { prev: "reconnecting", event: { type: "half_died", role: "observer" }, expected: noop, label: "reconnecting × half_died (no transition)" },
    { prev: "reconnecting", event: { type: "half_respawned", role: "observer" }, expected: noop, label: "reconnecting × half_respawned (no transition)" },
    { prev: "reconnecting", event: survObs, expected: noop, label: "reconnecting × reconnect_started (no transition — already reconnecting)" },
    { prev: "reconnecting", event: recOkObs, expected: reconnectedOk("observer"), label: "reconnecting × reconnect_ok/observer → active" },
    { prev: "reconnecting", event: recOkOrch, expected: reconnectedOk("orchestrator"), label: "reconnecting × reconnect_ok/orchestrator → active" },
    { prev: "reconnecting", event: recFailedObs, expected: degradedFromReconnectFailed("observer"), label: "reconnecting × reconnect_failed/observer → degraded" },
    { prev: "reconnecting", event: recFailedOrch, expected: degradedFromReconnectFailed("orchestrator"), label: "reconnecting × reconnect_failed/orchestrator → degraded" },
    { prev: "reconnecting", event: { type: "user_archived" }, expected: exited, label: "reconnecting × user_archived → archived" },
    { prev: "reconnecting", event: { type: "user_killed" }, expected: exited, label: "reconnecting × user_killed → archived" },

    // ── from archived (terminal) ── prev === next on every cell, so noop.
    { prev: "archived", event: { type: "both_ready" }, expected: noop, label: "archived × both_ready (terminal — noop)" },
    { prev: "archived", event: { type: "half_died", role: "observer" }, expected: noop, label: "archived × half_died (terminal — noop)" },
    { prev: "archived", event: { type: "half_respawned", role: "observer" }, expected: noop, label: "archived × half_respawned (terminal — noop)" },
    { prev: "archived", event: survObs, expected: noop, label: "archived × reconnect_started (terminal — noop)" },
    { prev: "archived", event: recOkObs, expected: noop, label: "archived × reconnect_ok (terminal — noop)" },
    { prev: "archived", event: recFailedObs, expected: noop, label: "archived × reconnect_failed (terminal — noop)" },
    { prev: "archived", event: { type: "user_archived" }, expected: noop, label: "archived × user_archived (terminal — noop, no double-emit)" },
    { prev: "archived", event: { type: "user_killed" }, expected: noop, label: "archived × user_killed (terminal — noop, no double-emit)" },
  ];

  it.each(table)("$label", ({ prev, event, expected }) => {
    const next = transition(prev, event);
    const result = deriveSideEffects(prev, next, event);
    expect(result.busEvents).toEqual(expected.busEvents);
    expect(result.logEntries).toEqual(expected.logEntries);
    expect(result.idleTimerEffects).toEqual(expected.idleTimerEffects);
  });

  // Inventory tests — the matrix above is the canonical truth, but these
  // assertions pin specific high-leverage invariants in a form a careless
  // refactor cannot accidentally satisfy:

  it("never emits side effects when prev === next (no-op transitions stay silent)", () => {
    for (const state of ["pairing", "active", "degraded", "reconnecting", "archived"] as const) {
      // Pick an event whose discriminator does not transition out of this state.
      const noopEvent: GroupEvent = state === "archived"
        ? { type: "both_ready" } // terminal — no-op
        : { type: "half_respawned", role: "observer" }; // half_respawned only transitions degraded → active
      const next = transition(state, noopEvent);
      if (next !== state) continue; // skip cells that actually transition
      const result = deriveSideEffects(state, next, noopEvent);
      expect(result.busEvents).toEqual([]);
      expect(result.logEntries).toEqual([]);
    }
  });

  it("bus events and log entries are paired one-to-one (no asymmetric emit — either both populated or both empty)", () => {
    // Split into TWO invariants so an asymmetric defect (bus emit without
    // log entry or vice versa) cannot slip past the `if (length > 0)` guard
    // the original single check used. v1 implement review NOTE 1 (2026-05-13):
    // wrapping the count assertion inside `if (busEvents.length > 0)` skipped
    // the assertion when bus is empty but logEntries is populated (or mirror).
    for (const cell of table) {
      const next = transition(cell.prev, cell.event);
      const result = deriveSideEffects(cell.prev, next, cell.event);
      // Invariant 1: bus + log are paired (same length, always).
      expect(
        result.busEvents.length,
        `paired-emit invariant violated at (${cell.prev} × ${cell.event.type}): bus=${result.busEvents.length}, log=${result.logEntries.length}`,
      ).toBe(result.logEntries.length);
      // Invariant 2: when non-empty, exactly one of each (no fanout amplification).
      if (result.busEvents.length > 0) {
        expect(result.busEvents).toHaveLength(1);
        expect(result.logEntries).toHaveLength(1);
      }
    }
  });

  it("EC-9 log shape — every emitted log entry carries `event` and never leaks cliSessionId/path/observerPromptSha256", () => {
    // PLAN Task 8: auto-proceed notification events extend the EC-9 allowlist
    // with `sessionId` and `iteration`. Both are still bounded — no cliSessionId,
    // no observerPromptSha256, no workspace path. The allowlist grows; the
    // EC-9 floor (structured JSON, no PII / no path) doesn't.
    const allowedKeys = new Set(["event", "role", "attempts", "sessionId", "iteration"]);
    for (const cell of table) {
      const next = transition(cell.prev, cell.event);
      const result = deriveSideEffects(cell.prev, next, cell.event);
      for (const entry of result.logEntries) {
        expect(entry.event).toMatch(/^group\./);
        // EC-9 bounded-context contract — the descriptor must not carry
        // any field outside the canonical allowlist. If the type ever
        // grows a field, the convention check in `conventions.md` EC-9
        // forces an explicit decision here, not a silent leak.
        for (const key of Object.keys(entry)) {
          expect(allowedKeys.has(key), `log entry leaked key "${key}" — EC-9 violation`).toBe(true);
        }
      }
    }
  });

  // Cross-cutting test: assert the matrix is exhaustive — every combination
  // of GroupStatus × GroupEvent discriminator is covered by exactly one row.
  // Drift detection: if a new event variant lands without a table entry,
  // this fails; the implementer is forced to extend the matrix consciously
  // rather than discover the gap during a production incident.
  it("table is exhaustive — every (state × event-discriminator) is covered", () => {
    const states: GroupStatus[] = ["pairing", "active", "degraded", "reconnecting", "archived"];
    // Lifecycle discriminators only. The six auto-proceed events
    // (orchestrator_turn_idle / _active, stop_finding_raised / _resolved,
    // auto_proceed_fired, iteration_cap_tripped) have their own dedicated
    // coverage block below — they're session-scoped (no group-status
    // transitions) so cross-multiplying them by GroupStatus produces
    // mostly-noisy cells without insight.
    const eventDiscriminators: Array<GroupEvent["type"]> = [
      "both_ready",
      "half_died",
      "half_respawned",
      "reconnect_started",
      "reconnect_ok",
      "reconnect_failed",
      "user_archived",
      "user_killed",
    ];
    const covered = new Set<string>();
    for (const cell of table) {
      covered.add(`${cell.prev}::${cell.event.type}`);
    }
    for (const state of states) {
      for (const disc of eventDiscriminators) {
        expect(covered.has(`${state}::${disc}`), `(${state} × ${disc}) missing from deriveSideEffects table`).toBe(true);
      }
    }
  });

  // Surface the imported types so unused-import lint rules don't trip on
  // them — they're conceptually load-bearing for the test (any drift in
  // GroupBusSideEffect / GroupLogEntry shape would change `toEqual`
  // matching above), even if the matchers don't reference them directly.
  it("descriptor types remain assignable from the matrix shape", () => {
    const sample: GroupBusSideEffect = { kind: "exited", reason: "user_archived" };
    const log: GroupLogEntry = { event: "group.exited" };
    expect(sample.kind).toBe("exited");
    expect(log.event).toBe("group.exited");
  });
});

// PLAN-aura-orchestrator-idle-auto-proceed Task 8: state-machine integration
// for the six auto-proceed events. These are session-scoped — they do NOT
// change GroupStatus — so the lifecycle matrix above does not cover them.
// This block is the focused coverage: every event produces the right
// idle-timer descriptor / log entry, and `transition()` returns `from`
// unchanged across the full GroupStatus axis.
describe("auto-proceed events (Task 8)", () => {
  const SESSION_ID = "sess-orch-1";
  const STATES: GroupStatus[] = ["pairing", "active", "degraded", "reconnecting", "archived"];

  describe("transition() returns `from` unchanged for every auto-proceed event", () => {
    // Six new events × five states = 30 cells. Each must be a status no-op:
    // group lifecycle is unrelated to per-session turn-state. AP-2 is
    // preserved — these events ride the same `applyEvent` channel but
    // contribute to idle-timer side effects only.
    const events: GroupEvent[] = [
      { type: "orchestrator_turn_idle", sessionId: SESSION_ID, idleMs: 300_000, maxIterations: 10 },
      { type: "orchestrator_turn_active", sessionId: SESSION_ID },
      { type: "stop_finding_raised", sessionId: SESSION_ID },
      { type: "stop_finding_resolved", sessionId: SESSION_ID },
      { type: "auto_proceed_fired", sessionId: SESSION_ID, iteration: 3, firedAtMs: 1_700_000_000_000 },
      { type: "iteration_cap_tripped", sessionId: SESSION_ID, iteration: 10, cappedAtMs: 1_700_000_000_000 },
    ];
    for (const state of STATES) {
      for (const ev of events) {
        it(`(${state} × ${ev.type}) is status-noop`, () => {
          expect(transition(state, ev)).toBe(state);
        });
      }
    }
  });

  describe("deriveSideEffects — orchestrator_turn_idle", () => {
    // arm-idle-timer fires ONLY when prev === "active". Every other status
    // → no effect. This is the coarse group-status gate per Task 8; the
    // manager re-checks the full gate stack (state=connected, role=orchestrator,
    // blockedByStop=false, reconnect-grace clear) at fire time (TOCTOU defence).
    it("emits arm-idle-timer when prev === active", () => {
      const ev: GroupEvent = {
        type: "orchestrator_turn_idle",
        sessionId: SESSION_ID,
        idleMs: 300_000,
        maxIterations: 10,
      };
      const next = transition("active", ev);
      const result = deriveSideEffects("active", next, ev);
      expect(result.idleTimerEffects).toEqual<GroupIdleTimerEffect[]>([
        {
          kind: "arm-idle-timer",
          sessionId: SESSION_ID,
          idleMs: 300_000,
          maxIterations: 10,
        },
      ]);
      expect(result.busEvents).toEqual([]);
      expect(result.logEntries).toEqual([]);
    });

    it.each<GroupStatus>(["pairing", "degraded", "reconnecting", "archived"])(
      "suppresses arm when prev === %s (group not active)",
      (state) => {
        const ev: GroupEvent = {
          type: "orchestrator_turn_idle",
          sessionId: SESSION_ID,
          idleMs: 300_000,
          maxIterations: 10,
        };
        const next = transition(state, ev);
        const result = deriveSideEffects(state, next, ev);
        expect(result.idleTimerEffects).toEqual([]);
        expect(result.busEvents).toEqual([]);
        expect(result.logEntries).toEqual([]);
      },
    );
  });

  describe("deriveSideEffects — orchestrator_turn_active", () => {
    // note-user-message fires regardless of group status. The manager's
    // noteUserMessage is idempotent on missing sessions — coarse group
    // gating at this layer would risk leaving a stale timer armed across
    // a flap, which the EC-7 TOCTOU defence already prevents anyway.
    it.each<GroupStatus>(["pairing", "active", "degraded", "reconnecting"])(
      "emits note-user-message regardless of status (prev=%s)",
      (state) => {
        const ev: GroupEvent = { type: "orchestrator_turn_active", sessionId: SESSION_ID };
        const next = transition(state, ev);
        const result = deriveSideEffects(state, next, ev);
        expect(result.idleTimerEffects).toEqual<GroupIdleTimerEffect[]>([
          { kind: "note-user-message", sessionId: SESSION_ID },
        ]);
        expect(result.busEvents).toEqual([]);
        expect(result.logEntries).toEqual([]);
      },
    );
  });

  describe("deriveSideEffects — stop_finding_raised / _resolved", () => {
    it("stop_finding_raised emits cancel-idle-timer", () => {
      const ev: GroupEvent = { type: "stop_finding_raised", sessionId: SESSION_ID };
      const next = transition("active", ev);
      const result = deriveSideEffects("active", next, ev);
      expect(result.idleTimerEffects).toEqual<GroupIdleTimerEffect[]>([
        { kind: "cancel-idle-timer", sessionId: SESSION_ID },
      ]);
      expect(result.busEvents).toEqual([]);
      expect(result.logEntries).toEqual([]);
    });

    it("stop_finding_resolved emits no effects (next turn-idle re-arms naturally)", () => {
      const ev: GroupEvent = { type: "stop_finding_resolved", sessionId: SESSION_ID };
      const next = transition("active", ev);
      const result = deriveSideEffects("active", next, ev);
      expect(result.idleTimerEffects).toEqual([]);
      expect(result.busEvents).toEqual([]);
      expect(result.logEntries).toEqual([]);
    });
  });

  describe("deriveSideEffects — manager notifications (log-only)", () => {
    it("auto_proceed_fired produces a single EC-9 log entry, no bus, no idle effect", () => {
      const ev: GroupEvent = {
        type: "auto_proceed_fired",
        sessionId: SESSION_ID,
        iteration: 3,
        firedAtMs: 1_700_000_000_000,
      };
      const next = transition("active", ev);
      const result = deriveSideEffects("active", next, ev);
      expect(result.logEntries).toEqual<GroupLogEntry[]>([
        {
          event: "group.auto-proceed.fired",
          role: "orchestrator",
          sessionId: SESSION_ID,
          iteration: 3,
        },
      ]);
      expect(result.busEvents).toEqual([]);
      expect(result.idleTimerEffects).toEqual([]);
    });

    it("iteration_cap_tripped produces a single EC-9 log entry, no bus, no idle effect", () => {
      const ev: GroupEvent = {
        type: "iteration_cap_tripped",
        sessionId: SESSION_ID,
        iteration: 10,
        cappedAtMs: 1_700_000_000_000,
      };
      const next = transition("active", ev);
      const result = deriveSideEffects("active", next, ev);
      expect(result.logEntries).toEqual<GroupLogEntry[]>([
        {
          event: "group.auto-proceed.cap-reached",
          role: "orchestrator",
          sessionId: SESSION_ID,
          iteration: 10,
        },
      ]);
      expect(result.busEvents).toEqual([]);
      expect(result.idleTimerEffects).toEqual([]);
    });
  });

  // Auto-proceed events never emit `bus events`. The pairing invariant
  // from the lifecycle matrix (bus.length === log.length) does NOT apply —
  // here the invariant is "exactly one channel per event": bus | log |
  // idle-timer, never two at once, never zero (except stop_finding_resolved).
  it("each auto-proceed event populates exactly one effect channel (or zero for stop_finding_resolved)", () => {
    const cells: Array<{ event: GroupEvent; expectIdle: boolean; expectLog: boolean }> = [
      { event: { type: "orchestrator_turn_idle", sessionId: SESSION_ID, idleMs: 1, maxIterations: 1 }, expectIdle: true, expectLog: false },
      { event: { type: "orchestrator_turn_active", sessionId: SESSION_ID }, expectIdle: true, expectLog: false },
      { event: { type: "stop_finding_raised", sessionId: SESSION_ID }, expectIdle: true, expectLog: false },
      { event: { type: "stop_finding_resolved", sessionId: SESSION_ID }, expectIdle: false, expectLog: false },
      { event: { type: "auto_proceed_fired", sessionId: SESSION_ID, iteration: 1, firedAtMs: 0 }, expectIdle: false, expectLog: true },
      { event: { type: "iteration_cap_tripped", sessionId: SESSION_ID, iteration: 1, cappedAtMs: 0 }, expectIdle: false, expectLog: true },
    ];
    for (const cell of cells) {
      const result = deriveSideEffects("active", "active", cell.event);
      expect(result.busEvents).toEqual([]);
      expect(result.idleTimerEffects.length > 0, `idle expected=${cell.expectIdle} for ${cell.event.type}`).toBe(cell.expectIdle);
      expect(result.logEntries.length > 0, `log expected=${cell.expectLog} for ${cell.event.type}`).toBe(cell.expectLog);
    }
  });
});
