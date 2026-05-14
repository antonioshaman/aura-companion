// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeClock } from "./clock-source.js";
import { AUTO_PROCEED_DIRECTIVE_PREFIX, AUTO_PROCEED_MAX_ITERATIONS_CEILING } from "./auto-proceed-types.js";
import { AUTO_PROCEED_TRACE_SCHEMA_VERSION, type AutoProceedTrace } from "./auto-proceed-state.js";
import {
  IdleTimerManager,
  type IdleTimerArmOptions,
  type IdleTimerGroupStatus,
  type IdleTimerLogEntry,
  type IdleTimerManagerDeps,
  type IdleTimerSessionView,
} from "./idle-timer-manager.js";

const GROUP_ID = "grp_4469a4c2bb3d1c4ac621d4cd9ae67bd9";

// ── Test scaffolding ────────────────────────────────────────────────
//
// `buildDeps` produces a mutable test harness whose `setSession()` and
// `setGroupStatus()` setters let each test pin the world's state for
// a single gate evaluation. The persistTrace / appendSummary / send
// fakes capture call args so assertions can check both the sequence
// AND the per-call payload — both axes matter for the cap-enforcement
// invariant.

function buildView(overrides: Partial<IdleTimerSessionView> = {}): IdleTimerSessionView {
  return {
    sessionId: "sess-orch-1",
    sessionGroupId: GROUP_ID,
    sessionGroupRole: "orchestrator",
    state: "connected",
    orchestratorTurnState: { kind: "awaiting-input", blockedByStop: false },
    workspaceRoot: "/work/project",
    reconnectGraceActive: false,
    councilPhase: "council-implement",
    ...overrides,
  };
}

interface Harness {
  deps: IdleTimerManagerDeps;
  clock: FakeClock;
  setSession: (view: IdleTimerSessionView | null) => void;
  setGroupStatus: (status: IdleTimerGroupStatus) => void;
  persistCalls: Array<{ workspaceRoot: string; groupId: string; trace: AutoProceedTrace }>;
  summaryCalls: Array<{ workspaceRoot: string; groupId: string; entry: string }>;
  sendCalls: Array<{ sessionId: string; body: string }>;
  logEntries: IdleTimerLogEntry[];
  // Mutables a test can flip mid-flight:
  persistShouldFail: { value: boolean };
  sendShouldFail: { value: string | null };
}

function buildHarness(): Harness {
  const clock = new FakeClock(1_700_000_000_000);
  let currentSession: IdleTimerSessionView | null = buildView();
  let currentStatus: IdleTimerGroupStatus = "active";
  const persistCalls: Harness["persistCalls"] = [];
  const summaryCalls: Harness["summaryCalls"] = [];
  const sendCalls: Harness["sendCalls"] = [];
  const logEntries: IdleTimerLogEntry[] = [];
  const persistShouldFail = { value: false };
  const sendShouldFail: { value: string | null } = { value: null };

  const deps: IdleTimerManagerDeps = {
    clock,
    getSession: (id) => (currentSession && currentSession.sessionId === id ? currentSession : null),
    getGroupStatus: () => currentStatus,
    persistTrace: (workspaceRoot, groupId, trace) => {
      persistCalls.push({ workspaceRoot, groupId, trace });
      if (persistShouldFail.value) return { ok: false, error: "persist-failed" };
      return { ok: true };
    },
    appendSummary: (workspaceRoot, groupId, entry) => {
      summaryCalls.push({ workspaceRoot, groupId, entry });
      return { ok: true };
    },
    sendSyntheticFrame: (sessionId, body) => {
      sendCalls.push({ sessionId, body });
      if (sendShouldFail.value) return { ok: false, error: sendShouldFail.value };
      return { ok: true };
    },
    logEvent: (entry) => {
      logEntries.push(entry);
    },
  };

  return {
    deps,
    clock,
    setSession: (v) => {
      currentSession = v;
    },
    setGroupStatus: (s) => {
      currentStatus = s;
    },
    persistCalls,
    summaryCalls,
    sendCalls,
    logEntries,
    persistShouldFail,
    sendShouldFail,
  };
}

const VALID_OPTS: IdleTimerArmOptions = { idleMs: 5 * 60_000, maxIterations: 10 };

describe("IdleTimerManager.arm — option validation", () => {
  let h: Harness;
  let m: IdleTimerManager;
  beforeEach(() => {
    h = buildHarness();
    m = new IdleTimerManager(h.deps);
  });

  it.each([
    ["zero idleMs", { idleMs: 0, maxIterations: 10 }],
    ["negative idleMs", { idleMs: -1, maxIterations: 10 }],
    ["non-finite idleMs", { idleMs: Infinity, maxIterations: 10 }],
    ["non-integer idleMs", { idleMs: 1.5, maxIterations: 10 }],
    ["zero maxIterations", { idleMs: 1000, maxIterations: 0 }],
    [
      "maxIterations above ceiling",
      { idleMs: 1000, maxIterations: AUTO_PROCEED_MAX_ITERATIONS_CEILING + 1 },
    ],
    ["non-integer maxIterations", { idleMs: 1000, maxIterations: 3.5 }],
  ])("refuses arm with invalid-options for %s", (_label, opts) => {
    const out = m.arm("sess-orch-1", opts as IdleTimerArmOptions);
    expect(out).toEqual({ kind: "refused", reason: "invalid-options" });
  });

  it("accepts boundary case maxIterations === ceiling", () => {
    const out = m.arm("sess-orch-1", {
      idleMs: 1000,
      maxIterations: AUTO_PROCEED_MAX_ITERATIONS_CEILING,
    });
    expect(out).toEqual({ kind: "armed" });
  });
});

describe("IdleTimerManager.arm — gate predicates", () => {
  let h: Harness;
  let m: IdleTimerManager;
  beforeEach(() => {
    h = buildHarness();
    m = new IdleTimerManager(h.deps);
  });

  it("refuses arm when session is missing from lookup", () => {
    h.setSession(null);
    expect(m.arm("sess-orch-1", VALID_OPTS)).toEqual({
      kind: "refused",
      reason: "session-missing",
    });
  });

  it("refuses arm when session state !== connected", () => {
    h.setSession(buildView({ state: "reconnecting" }));
    expect(m.arm("sess-orch-1", VALID_OPTS)).toEqual({
      kind: "refused",
      reason: "session-not-connected",
    });
  });

  it("refuses arm when role !== orchestrator", () => {
    h.setSession(buildView({ sessionGroupRole: "observer" }));
    expect(m.arm("sess-orch-1", VALID_OPTS)).toEqual({
      kind: "refused",
      reason: "not-orchestrator-half",
    });
  });

  it("refuses arm when group is not active", () => {
    h.setGroupStatus("degraded");
    expect(m.arm("sess-orch-1", VALID_OPTS)).toEqual({
      kind: "refused",
      reason: "group-not-active",
    });
  });

  it("refuses arm when orchestrator is in-flight", () => {
    h.setSession(buildView({ orchestratorTurnState: { kind: "in-flight" } }));
    expect(m.arm("sess-orch-1", VALID_OPTS)).toEqual({
      kind: "refused",
      reason: "in-flight",
    });
  });

  it("refuses arm when blockedByStop is true (JS-3 axis)", () => {
    h.setSession(buildView({ orchestratorTurnState: { kind: "awaiting-input", blockedByStop: true } }));
    expect(m.arm("sess-orch-1", VALID_OPTS)).toEqual({
      kind: "refused",
      reason: "blocked-by-stop",
    });
  });

  it("refuses arm during reconnect grace", () => {
    h.setSession(buildView({ reconnectGraceActive: true }));
    expect(m.arm("sess-orch-1", VALID_OPTS)).toEqual({
      kind: "refused",
      reason: "reconnect-grace-active",
    });
  });
});

describe("IdleTimerManager.arm + fire happy path", () => {
  let h: Harness;
  let m: IdleTimerManager;
  beforeEach(() => {
    h = buildHarness();
    m = new IdleTimerManager(h.deps);
  });

  it("arm schedules a timer; advance to idleMs fires it; counter increments", () => {
    expect(m.arm("sess-orch-1", VALID_OPTS)).toEqual({ kind: "armed" });
    expect(m.isArmed("sess-orch-1")).toBe(true);
    h.clock.advance(VALID_OPTS.idleMs);
    // Persist happened BEFORE send.
    expect(h.persistCalls.length).toBe(1);
    expect(h.persistCalls[0].trace.iterationCount).toBe(1);
    expect(h.sendCalls.length).toBe(1);
    // Body starts with the v1 prefix.
    expect(h.sendCalls[0].body.startsWith(`${AUTO_PROCEED_DIRECTIVE_PREFIX} `)).toBe(true);
    // In-memory counter advanced.
    expect(m.getIterationCount("sess-orch-1")).toBe(1);
  });

  it("body envelope echoes the session phase + group id", () => {
    h.setSession(buildView({ councilPhase: "council-review" }));
    m.arm("sess-orch-1", VALID_OPTS);
    h.clock.advance(VALID_OPTS.idleMs);
    const body = h.sendCalls[0].body;
    const json = body.slice(AUTO_PROCEED_DIRECTIVE_PREFIX.length + 1);
    const env = JSON.parse(json);
    expect(env.phase).toBe("council-review");
    expect(env.group_id).toBe(GROUP_ID);
    expect(env.iteration).toBe(1);
    expect(env.max_iterations).toBe(VALID_OPTS.maxIterations);
  });

  it("AFK summary is appended after a successful send", () => {
    m.arm("sess-orch-1", VALID_OPTS);
    h.clock.advance(VALID_OPTS.idleMs);
    expect(h.summaryCalls.length).toBe(1);
    expect(h.summaryCalls[0].entry).toMatch(/iteration=1\/10/);
    expect(h.summaryCalls[0].entry).toMatch(/directive=proceed-with-best-judgment/);
  });

  it("EC-9 logs the fire-sent event with sessionGroupId + role + iteration", () => {
    m.arm("sess-orch-1", VALID_OPTS);
    h.clock.advance(VALID_OPTS.idleMs);
    const sent = h.logEntries.find((e) => e.event === "idle-timer.fire-sent");
    expect(sent).toBeDefined();
    expect(sent?.sessionGroupId).toBe(GROUP_ID);
    expect(sent?.role).toBe("orchestrator");
    expect(sent?.iteration).toBe(1);
  });
});

describe("IdleTimerManager — noteUserMessage cancels the timer (token-stale defence)", () => {
  it("user-message between schedule and fire aborts the fire via token re-read", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    m.arm("sess-orch-1", VALID_OPTS);
    // Half the idle window passes — then user sends a message.
    h.clock.advance(VALID_OPTS.idleMs / 2);
    m.noteUserMessage("sess-orch-1");
    expect(m.isArmed("sess-orch-1")).toBe(false);
    // Advance past where the fire WOULD have fired — no send.
    h.clock.advance(VALID_OPTS.idleMs);
    expect(h.sendCalls.length).toBe(0);
    expect(h.persistCalls.length).toBe(0);
  });

  it("cancel() is idempotent + a no-op when no timer is armed", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    expect(() => m.cancel("sess-orch-1")).not.toThrow();
    m.arm("sess-orch-1", VALID_OPTS);
    m.cancel("sess-orch-1");
    m.cancel("sess-orch-1");
    expect(m.isArmed("sess-orch-1")).toBe(false);
  });
});

describe("IdleTimerManager — TOCTOU defence (fresh gate read at fire-time)", () => {
  // EC-7 — the fire path MUST re-evaluate the gate on a fresh
  // session-state read. A state change between schedule and fire
  // must skip the fire silently and EC-9-log the reason.

  it("session disconnects between arm and fire → skip + log", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    m.arm("sess-orch-1", VALID_OPTS);
    // Flip state mid-window.
    h.setSession(buildView({ state: "exited" }));
    h.clock.advance(VALID_OPTS.idleMs);
    expect(h.sendCalls.length).toBe(0);
    const skip = h.logEntries.find((e) => e.event === "idle-timer.fire-skipped");
    expect(skip?.reason).toBe("session-not-connected");
  });

  it("group degrades between arm and fire → skip + log", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    m.arm("sess-orch-1", VALID_OPTS);
    h.setGroupStatus("degraded");
    h.clock.advance(VALID_OPTS.idleMs);
    expect(h.sendCalls.length).toBe(0);
    const skip = h.logEntries.find((e) => e.event === "idle-timer.fire-skipped");
    expect(skip?.reason).toBe("group-not-active");
  });

  it("STOP raised between arm and fire → skip + log", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    m.arm("sess-orch-1", VALID_OPTS);
    h.setSession(buildView({ orchestratorTurnState: { kind: "awaiting-input", blockedByStop: true } }));
    h.clock.advance(VALID_OPTS.idleMs);
    expect(h.sendCalls.length).toBe(0);
    const skip = h.logEntries.find((e) => e.event === "idle-timer.fire-skipped");
    expect(skip?.reason).toBe("blocked-by-stop");
  });
});

describe("IdleTimerManager — cap enforcement", () => {
  it("refuses to fire past maxIterations; persists cappedAt; logs cap-reached", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    // Cap at 2 so the test is short.
    const opts = { idleMs: 1000, maxIterations: 2 };
    // First fire.
    m.arm("sess-orch-1", opts);
    h.clock.advance(opts.idleMs);
    expect(h.sendCalls.length).toBe(1);
    expect(m.getIterationCount("sess-orch-1")).toBe(1);
    // Re-arm + second fire.
    m.arm("sess-orch-1", opts);
    h.clock.advance(opts.idleMs);
    expect(h.sendCalls.length).toBe(2);
    expect(m.getIterationCount("sess-orch-1")).toBe(2);
    // Third arm + advance — cap reached, NO send.
    m.arm("sess-orch-1", opts);
    h.clock.advance(opts.idleMs);
    expect(h.sendCalls.length).toBe(2);
    const capLog = h.logEntries.find((e) => e.event === "idle-timer.fire-cap-reached");
    expect(capLog).toBeDefined();
    expect(capLog?.iteration).toBe(2);
    // Trace persisted with cappedAt set.
    const cappedTrace = h.persistCalls.find((c) => c.trace.cappedAt !== null);
    expect(cappedTrace).toBeDefined();
  });
});

describe("IdleTimerManager — persist failure aborts send", () => {
  // The cap is the structural bound. A persist failure mid-fire would
  // let the in-memory counter and the on-disk counter diverge — the
  // next boot would resume from a stale count and the cap could
  // silently drift upward. Refuse the send so the two stay in sync.
  it("persistTrace error aborts the send and returns send-failed", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    h.persistShouldFail.value = true;
    m.arm("sess-orch-1", VALID_OPTS);
    h.clock.advance(VALID_OPTS.idleMs);
    expect(h.sendCalls.length).toBe(0);
    expect(h.logEntries.some((e) => e.event === "idle-timer.persist-failed")).toBe(true);
    // In-memory counter MUST NOT advance — keeps the disk-and-memory
    // bound aligned.
    expect(m.getIterationCount("sess-orch-1")).toBe(0);
  });
});

describe("IdleTimerManager — send failure logs but does not retry", () => {
  it("sendSyntheticFrame failure lands EC-9 entry; counter stays incremented", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    h.sendShouldFail.value = "EPIPE";
    m.arm("sess-orch-1", VALID_OPTS);
    h.clock.advance(VALID_OPTS.idleMs);
    expect(h.sendCalls.length).toBe(1);
    expect(h.logEntries.some((e) => e.event === "idle-timer.fire-failed")).toBe(true);
    // Counter ALREADY advanced on disk (persist happened before send);
    // refuse to re-fire so the cap stays the bound.
    expect(m.getIterationCount("sess-orch-1")).toBe(1);
  });
});

describe("IdleTimerManager.rehydrate — boot reconcile", () => {
  it("loads iterationCount + firedAt history from a persisted trace", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    const trace: AutoProceedTrace = {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: GROUP_ID,
      iterationCount: 3,
      firedAt: ["2026-05-14T10:00:00.000Z", "2026-05-14T10:05:00.000Z", "2026-05-14T10:10:00.000Z"],
      cappedAt: null,
      lastObjectiveGateResult: "pass",
    };
    m.rehydrate("sess-orch-1", trace, GROUP_ID);
    expect(m.getIterationCount("sess-orch-1")).toBe(3);
    expect(h.logEntries.some((e) => e.event === "idle-timer.rehydrated")).toBe(true);
  });

  it("skips rehydrate when trace.sessionGroupId mismatches the expected group", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    const trace: AutoProceedTrace = {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      iterationCount: 5,
      firedAt: [],
      cappedAt: null,
      lastObjectiveGateResult: null,
    };
    m.rehydrate("sess-orch-1", trace, GROUP_ID);
    // Counter should NOT have been loaded.
    expect(m.getIterationCount("sess-orch-1")).toBe(0);
    expect(h.logEntries.some((e) => e.event === "idle-timer.rehydrate-skipped-orphan")).toBe(true);
  });
});

describe("IdleTimerManager.disposeAll — SIGTERM drain", () => {
  it("cancels every armed timer in one pass", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    m.arm("sess-orch-1", VALID_OPTS);
    expect(m.isArmed("sess-orch-1")).toBe(true);
    m.disposeAll();
    expect(m.isArmed("sess-orch-1")).toBe(false);
    h.clock.advance(VALID_OPTS.idleMs * 2);
    expect(h.sendCalls.length).toBe(0);
  });

  it("is idempotent (second call is a no-op)", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    m.arm("sess-orch-1", VALID_OPTS);
    m.disposeAll();
    expect(() => m.disposeAll()).not.toThrow();
  });
});

describe("IdleTimerManager — re-arm semantics", () => {
  it("re-arming cancels the previous timer + advances the turnToken", () => {
    const h = buildHarness();
    const m = new IdleTimerManager(h.deps);
    m.arm("sess-orch-1", VALID_OPTS);
    h.clock.advance(VALID_OPTS.idleMs / 2);
    // Re-arm — should cancel the previous timer.
    m.arm("sess-orch-1", VALID_OPTS);
    // Advance past where the FIRST timer would have fired — no send.
    h.clock.advance(VALID_OPTS.idleMs / 2);
    expect(h.sendCalls.length).toBe(0);
    // Advance the remaining → second timer fires.
    h.clock.advance(VALID_OPTS.idleMs / 2);
    expect(h.sendCalls.length).toBe(1);
  });
});
