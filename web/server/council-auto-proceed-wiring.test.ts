import { describe, expect, it } from "vitest";
import {
  CouncilAutoProceedController,
  isBlockingStopFinding,
  type AutoProceedOnIdleConfig,
} from "./council-auto-proceed-controller.js";
import { IdleTimerManager, type IdleTimerSessionView } from "./idle-timer-manager.js";
import { SessionGroupCoordinator } from "./session-group-coordinator.js";
import { FakeClock } from "./clock-source.js";
import {
  AUTO_PROCEED_DIRECTIVE_PREFIX,
  AUTO_PROCEED_MAX_ITERATIONS_CEILING,
  resolveAutoProceedIterationCeiling,
} from "./auto-proceed-types.js";
import type { BrowserObserverFinding } from "./session-types.js";

// aura-meta-diet P4/AP-WIRE (ASK #9). Before this step nothing emitted
// `orchestrator_turn_idle`, so auto-proceed never armed in prod even for
// opted-in pairs. These tests drive the REAL chain the server runs:
//   orchestrator:turn-done (bus) → controller → coordinator.applyEvent
//   → state-machine effect → controller.enactor → IdleTimerManager.arm
//   → FakeClock fire → sendSyntheticFrame
// Only the session lookup and the bus are faked. The orchestrator half is
// always Claude (SUPPORTED_PAIRINGS: claude+claude, claude+codex), so the
// observer backend does not change this path — the pairing tests pin that.

const GROUP = "grp_0123456789abcdef0123456789abcdef";
const ORCH = "sess-orch";
const OBS = "sess-obs";
const IDLE_MS = 60_000;

interface Harness {
  clock: FakeClock;
  manager: IdleTimerManager;
  controller: CouncilAutoProceedController;
  sent: string[];
  /** Simulates the adapter: result frame → awaiting-input + bus emit. */
  turnDone(sessionId?: string, blockedByStop?: boolean): void;
  userFrame(sessionId?: string): void;
  review(findings: BrowserObserverFinding[]): void;
  turnState: { kind: "in-flight" } | { kind: "awaiting-input"; blockedByStop: boolean };
}

function makeHarness(opts: {
  config?: AutoProceedOnIdleConfig;
  observerBackend?: "claude" | "codex";
  iterationCeiling?: number;
  layerAllowed?: boolean;
} = {}): Harness {
  const clock = new FakeClock(0);
  const sent: string[] = [];
  const configs = new Map<string, AutoProceedOnIdleConfig>();
  if (opts.config) configs.set(ORCH, opts.config);

  const h = {
    turnState: { kind: "awaiting-input", blockedByStop: false },
  } as Harness;

  const manager = new IdleTimerManager({
    clock,
    getSession: (sessionId): IdleTimerSessionView | null =>
      sessionId === ORCH
        ? {
            sessionId,
            sessionGroupId: GROUP,
            sessionGroupRole: "orchestrator",
            state: "connected",
            orchestratorTurnState: h.turnState,
            workspaceRoot: "/nonexistent-ws",
            reconnectGraceActive: false,
            councilPhase: "council-implement",
          }
        : null,
    getGroupStatus: () => coordinator.get(GROUP)?.status ?? "unknown",
    persistTrace: () => ({ ok: true }),
    appendSummary: () => ({ ok: true }),
    sendSyntheticFrame: (_sid, body) => {
      sent.push(body);
      // The real bridge flips the adapter to in-flight on send.
      h.turnState = { kind: "in-flight" };
      return { ok: true };
    },
    logEvent: () => undefined,
  });

  const groupMeta = new Map([[GROUP, { primarySessionId: ORCH }]]);
  let coordinator!: SessionGroupCoordinator;
  const controller = new CouncilAutoProceedController({
    manager,
    groupMeta,
    watchers: new Map(),
    isAutoProceedAllowed: () => opts.layerAllowed ?? true,
    getAutoProceedConfig: (sid) => configs.get(sid),
    getGroupIdForSession: (sid) => (sid === ORCH || sid === OBS ? GROUP : undefined),
    applyGroupEvent: (gid, event) => {
      coordinator.applyEvent(gid, event);
    },
    iterationCeiling: opts.iterationCeiling,
  });
  coordinator = new SessionGroupCoordinator({
    spawn: async () => {
      throw new Error("unused");
    },
    kill: async () => undefined,
    idleTimerEnactor: controller.enactor,
  });
  coordinator.registerExternalGroup({
    sessionGroupId: GROUP,
    primary: { sessionId: ORCH, backendType: "claude" },
    observer: { sessionId: OBS, backendType: opts.observerBackend ?? "claude" },
    status: "active",
    createdAt: 0,
  });

  const cbs: {
    turnDone?: (sid: string, blocked: boolean) => void;
    user?: (sid: string) => void;
    review?: (gid: string, f: readonly BrowserObserverFinding[]) => void;
  } = {};
  controller.wire({
    onUserFrameObserved: (cb) => {
      cbs.user = cb;
    },
    onSessionExited: () => undefined,
    onOrchestratorTurnDone: (cb) => {
      cbs.turnDone = cb;
    },
    onGroupReview: (cb) => {
      cbs.review = cb;
    },
  });

  h.clock = clock;
  h.manager = manager;
  h.controller = controller;
  h.sent = sent;
  h.turnDone = (sid = ORCH, blocked = false) => {
    h.turnState = { kind: "awaiting-input", blockedByStop: blocked };
    cbs.turnDone!(sid, blocked);
  };
  h.userFrame = (sid = ORCH) => {
    h.turnState = { kind: "in-flight" };
    cbs.user!(sid);
  };
  h.review = (findings) => cbs.review!(GROUP, findings);
  return h;
}

function stop(overrides: Partial<BrowserObserverFinding> = {}): BrowserObserverFinding {
  return {
    id: "f1",
    severity: "STOP",
    claim: "`handleX` drops the error",
    evidence_path: "web/server/x.ts",
    evidence_lines: [10, 12],
    ...overrides,
  };
}

describe("auto-proceed wiring (AP-WIRE)", () => {
  // Requirement (2): idle orchestrator → orchestrator_turn_idle → armed → fires
  // the existing synthetic directive after idleMs.
  it("arms on turn-done for an opted-in orchestrator and fires the directive after idleMs", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 } });
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(true);

    h.clock.advance(IDLE_MS - 1);
    expect(h.sent).toHaveLength(0);
    h.clock.advance(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].startsWith(AUTO_PROCEED_DIRECTIVE_PREFIX)).toBe(true);
    expect(h.manager.getIterationCount(ORCH)).toBe(1);
  });

  // Requirement (3): no opt-in → nothing arms, ever (prod default).
  it("does not arm a session without the opt-in", () => {
    const h = makeHarness();
    h.turnDone();
    h.clock.advance(IDLE_MS * 10);
    expect(h.manager.isArmed(ORCH)).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  // Requirement (3): the autoProceed layer off refuses the arm even if a
  // config slipped through (routes also strip it at create time).
  it("does not arm when the autoProceed layer is off", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, layerAllowed: false });
    h.turnDone();
    h.clock.advance(IDLE_MS * 2);
    expect(h.sent).toHaveLength(0);
  });

  // The observer half never arms — only the orchestrator's opt-in is stored,
  // and the manager gate refuses a non-orchestrator anyway.
  it("ignores turn-done from the observer half", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 } });
    h.turnDone(OBS);
    expect(h.manager.isArmed(OBS)).toBe(false);
  });

  // Requirement (4): user activity before the timer fires cancels it.
  it("a user frame cancels the pending timer", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 } });
    h.turnDone();
    h.clock.advance(IDLE_MS / 2);
    h.userFrame();
    expect(h.manager.isArmed(ORCH)).toBe(false);
    h.clock.advance(IDLE_MS * 2);
    expect(h.sent).toHaveLength(0);
  });

  // Requirement (4): the orchestrator already mid-turn (agent working) is not
  // armable — a stale turn-done replay must not start a timer.
  it("refuses to arm while the orchestrator is in-flight", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 } });
    h.turnState = { kind: "in-flight" };
    h.controller.noteOrchestratorIdle(ORCH, false);
    expect(h.manager.isArmed(ORCH)).toBe(false);
  });

  // Requirement (4): the per-session cap holds across the fire → turn-done →
  // re-arm loop.
  it("stops after maxIterations fires", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 2 } });
    for (let i = 0; i < 5; i++) {
      h.turnDone();
      h.clock.advance(IDLE_MS);
    }
    expect(h.sent).toHaveLength(2);
    expect(h.manager.getIterationCount(ORCH)).toBe(2);
  });

  // Requirement (4): COMPANION_ORCH_AUTO_PROCEED_MAX_ITERATIONS_CEILING lowers
  // the per-session cap.
  it("clamps maxIterations to the operator ceiling", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 5 }, iterationCeiling: 1 });
    for (let i = 0; i < 4; i++) {
      h.turnDone();
      h.clock.advance(IDLE_MS);
    }
    expect(h.sent).toHaveLength(1);
  });

  // Requirement (5): claude+codex — the orchestrator is Claude in both
  // supported pairings, so the codex observer does not change the chain.
  it.each(["claude", "codex"] as const)("works with a %s observer", (observerBackend) => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 1 }, observerBackend });
    h.turnDone();
    h.clock.advance(IDLE_MS);
    expect(h.sent).toHaveLength(1);
  });

  // An adapter-reported blockedByStop never arms.
  it("does not arm when turn-done reports blockedByStop", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 } });
    h.turnDone(ORCH, true);
    expect(h.manager.isArmed(ORCH)).toBe(false);
  });

  // Safety: a blocking observer STOP cancels the pending timer and holds
  // re-arming; a later clean review resumes (re-arms while idle).
  it("a blocking STOP cancels and holds; a clean review re-arms", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 } });
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(true);

    h.review([stop()]);
    expect(h.manager.isArmed(ORCH)).toBe(false);
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(false);
    h.clock.advance(IDLE_MS * 2);
    expect(h.sent).toHaveLength(0);

    h.review([{ ...stop(), severity: "WARN" }]);
    expect(h.manager.isArmed(ORCH)).toBe(true);
    h.clock.advance(IDLE_MS);
    expect(h.sent).toHaveLength(1);
  });

  // Weak-evidence (B2) and disputed (B2b) STOPs are not in the blocker banner,
  // so they must not hold auto-proceed either.
  it("weak-evidence and disputed STOPs do not block", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 } });
    h.review([
      stop({ weakEvidence: "no_cited_lines" }),
      stop({ id: "f2", disputed: "same_claim" }),
    ]);
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(true);
  });

  it("isBlockingStopFinding matches the banner predicate", () => {
    expect(isBlockingStopFinding(stop())).toBe(true);
    expect(isBlockingStopFinding(stop({ severity: "NOTE", wasDowngraded: true }))).toBe(false);
    expect(isBlockingStopFinding(stop({ weakEvidence: "no_cited_lines" }))).toBe(false);
  });
});

describe("resolveAutoProceedIterationCeiling", () => {
  // Absent → the hard cap; valid values can only lower it; anything else is
  // fail-closed to the hard cap with a warning (never raises it).
  it("parses fail-closed and never raises the hard cap", () => {
    expect(resolveAutoProceedIterationCeiling({})).toEqual({ ceiling: AUTO_PROCEED_MAX_ITERATIONS_CEILING });
    expect(resolveAutoProceedIterationCeiling({ COMPANION_ORCH_AUTO_PROCEED_MAX_ITERATIONS_CEILING: " 3 " })).toEqual({
      ceiling: 3,
    });
    for (const bad of ["0", "11", "2.5", "-1", "abc", "1e1"]) {
      const r = resolveAutoProceedIterationCeiling({ COMPANION_ORCH_AUTO_PROCEED_MAX_ITERATIONS_CEILING: bad });
      expect(r.ceiling).toBe(AUTO_PROCEED_MAX_ITERATIONS_CEILING);
      expect(r.warning).toBeDefined();
    }
  });
});
