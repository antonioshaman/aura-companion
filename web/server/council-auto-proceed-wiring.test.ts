import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CouncilAutoProceedController,
  isBlockingStopFinding,
  type AutoProceedOnIdleConfig,
  type GroupStopHoldView,
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
import { log } from "./logger.js";
import { readStopResolutions } from "./auto-proceed-stop-resolutions.js";

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

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ap-hold-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Lets the async restore (loadGroupFindings) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

interface Harness {
  clock: FakeClock;
  /** Manager log events (fire-cap-reached, iterations-reset, …). */
  managerLog: string[];
  persisted: number[];
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
  /** Workspace for persisted STOP resolutions (resolveStop). */
  cwd?: string;
  /** FIX-AP-1 restore source (a complete view); omitted → nothing to restore. */
  loadGroupFindings?: (gid: string) => Promise<readonly BrowserObserverFinding[] | null>;
  /** FIX-AP-2 restore source with unfrozen raw STOPs and gaps. */
  loadGroupStopHoldView?: (gid: string) => Promise<GroupStopHoldView | null>;
  /** FIX-AP-2: drop the group's workspace (watcher) even when restoring. */
  noWorkspace?: boolean;
} = {}): Harness {
  const clock = new FakeClock(0);
  const sent: string[] = [];
  const managerLog: string[] = [];
  const persisted: number[] = [];
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
    persistTrace: (_ws, _gid, trace) => {
      persisted.push(trace.iterationCount);
      return { ok: true };
    },
    appendSummary: () => ({ ok: true }),
    sendSyntheticFrame: (_sid, body) => {
      sent.push(body);
      // The real bridge flips the adapter to in-flight on send.
      h.turnState = { kind: "in-flight" };
      return { ok: true };
    },
    logEvent: (e) => {
      managerLog.push(e.event);
    },
  });

  const groupMeta = new Map([[GROUP, { primarySessionId: ORCH }]]);
  let coordinator!: SessionGroupCoordinator;
  // A known group always has a workspace in prod; a restore without one is a
  // gap (FIX-AP-2), so restoring harnesses get a temp workspace by default.
  const legacyLoad = opts.loadGroupFindings;
  const loadView = opts.loadGroupStopHoldView
    ?? (legacyLoad
      ? async (gid: string): Promise<GroupStopHoldView | null> => {
          const findings = await legacyLoad(gid);
          return findings ? { findings, unfrozenRawStopIds: [], gaps: [] } : null;
        }
      : undefined);
  const cwd = opts.noWorkspace ? undefined : opts.cwd ?? (loadView ? tmpWorkspace() : undefined);
  const controller = new CouncilAutoProceedController({
    manager,
    groupMeta,
    watchers: new Map(cwd ? [[GROUP, { cwd }]] : []),
    loadGroupStopHoldView: loadView,
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
  h.managerLog = managerLog;
  h.persisted = persisted;
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

  // Safety (rewritten for FIX-AP-1; was "a clean review re-arms"): a blocking
  // observer STOP cancels the pending timer and holds re-arming. A later
  // review without a STOP does NOT release it — the browser's banner keeps
  // showing every unresolved STOP across reviews, so auto-proceed firing then
  // would act past a blocker the human can still see. Only a human dismissal
  // releases it (the dismissal path re-arms while idle).
  it("a blocking STOP cancels and holds; a clean review does not release; a dismissal re-arms", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd: tmpWorkspace() });
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(true);

    h.review([stop()]);
    expect(h.manager.isArmed(ORCH)).toBe(false);
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(false);
    h.clock.advance(IDLE_MS * 2);
    expect(h.sent).toHaveLength(0);

    h.review([{ ...stop(), id: "f-warn", severity: "WARN" }]);
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(false);

    expect(h.controller.resolveStop(GROUP, "f1")).toEqual({ ok: true, released: true, persisted: true });
    expect(h.manager.isArmed(ORCH)).toBe(true);
    h.clock.advance(IDLE_MS);
    expect(h.sent).toHaveLength(1);
  });

  // The supervisor's scenario, verbatim: STOP in review A, NOTE in review B →
  // the timer must not fire, however long the orchestrator stays idle.
  it("STOP in review A, NOTE in review B → never fires", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 } });
    h.review([stop({ id: "a-stop" })]);
    h.review([stop({ id: "b-note", severity: "NOTE" })]);
    h.turnDone();
    h.clock.advance(IDLE_MS * 10);
    expect(h.sent).toHaveLength(0);
    expect(h.controller.getUnresolvedStopIds(GROUP)).toEqual(["a-stop"]);
  });

  // Every unresolved STOP holds; releasing one of two keeps holding.
  it("holds until the last unresolved STOP is released", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd: tmpWorkspace() });
    h.review([stop({ id: "s1" })]);
    h.review([stop({ id: "s2", claim: "`other` leaks", evidence_path: "web/server/y.ts" })]);
    h.turnDone();
    h.controller.resolveStop(GROUP, "s1");
    expect(h.manager.isArmed(ORCH)).toBe(false);
    h.controller.resolveStop(GROUP, "s2");
    expect(h.manager.isArmed(ORCH)).toBe(true);
  });

  // (5) B2b dispute → controller: the disputed STOP and a held re-raise of the
  // same claim on the same file are both released (what the banner hides);
  // a STOP about another file keeps holding.
  it("a dispute releases the disputed STOP and matching re-raises, not other files", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 } });
    h.review([stop({ id: "d1" })]);
    h.review([stop({ id: "d2" }), stop({ id: "other", evidence_path: "web/server/z.ts" })]);
    h.controller.noteDispute(GROUP, { findingId: "d1", claim: stop().claim, evidencePath: stop().evidence_path });
    expect(h.controller.getUnresolvedStopIds(GROUP)).toEqual(["other"]);
    h.controller.noteDispute(GROUP, { findingId: "other", claim: stop().claim, evidencePath: "web/server/z.ts" });
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(true);
  });

  // A dismissed id never holds again, even if the same finding is replayed.
  it("a resolved finding id does not re-hold when the review is replayed", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd: tmpWorkspace() });
    h.review([stop()]);
    h.controller.resolveStop(GROUP, "f1");
    h.review([stop()]);
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(true);
  });

  it("resolveStop validates input and the group", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd: tmpWorkspace() });
    expect(h.controller.resolveStop(GROUP, "")).toEqual({ ok: false, reason: "invalid_input" });
    expect(h.controller.resolveStop(GROUP, "x".repeat(300))).toEqual({ ok: false, reason: "invalid_input" });
    expect(h.controller.resolveStop("grp_ffffffffffffffffffffffffffffffff", "f1")).toEqual({
      ok: false,
      reason: "unknown_group",
    });
  });

  // (2) Restart: the hold is rebuilt from what is on disk — the reviews as the
  // banner bootstraps them, minus persisted dismissals — before anything arms.
  it("after a restart, a persisted STOP holds and a persisted dismissal does not", async () => {
    const cwd = tmpWorkspace();
    // Session 1: STOP s1 dismissed, STOP s2 still open.
    const before = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd });
    before.review([stop({ id: "s1" }), stop({ id: "s2", evidence_path: "web/server/y.ts" })]);
    before.controller.resolveStop(GROUP, "s1");
    expect(readStopResolutions(cwd, GROUP)).toEqual({ ok: true, findingIds: ["s1"] });

    // Session 2 (fresh controller = restarted server): reviews still on disk.
    const onDisk = [stop({ id: "s1" }), stop({ id: "s2", evidence_path: "web/server/y.ts" })];
    const after = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd, loadGroupFindings: async () => onDisk });
    after.turnDone();
    expect(after.manager.isArmed(ORCH)).toBe(false); // fail-closed while restoring
    await flush();
    expect(after.manager.isArmed(ORCH)).toBe(false);
    expect(after.controller.getUnresolvedStopIds(GROUP)).toEqual(["s2"]);

    after.controller.resolveStop(GROUP, "s2");
    expect(after.manager.isArmed(ORCH)).toBe(true);
  });

  // Restore with nothing blocking: the idle edge that arrived during the
  // restore is re-tried, so a clean group still arms after a restart.
  it("after a restart with no open STOP, the idle edge seen during the restore arms", async () => {
    const h = makeHarness({
      config: { idleMs: IDLE_MS, maxIterations: 3 },
      loadGroupFindings: async () => [stop({ weakEvidence: "no_cited_lines" }), stop({ id: "n", severity: "NOTE" })],
    });
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(false);
    await flush();
    expect(h.manager.isArmed(ORCH)).toBe(true);
  });

  // A failed restore keeps holding (never fires past STOPs it could not read)
  // and is retried on the next idle edge.
  it("a failed restore holds and is retried on the next edge", async () => {
    let calls = 0;
    const h = makeHarness({
      config: { idleMs: IDLE_MS, maxIterations: 3 },
      loadGroupFindings: async () => {
        calls++;
        if (calls === 1) throw new Error("disk gone");
        return [];
      },
    });
    h.turnDone();
    await flush();
    expect(h.manager.isArmed(ORCH)).toBe(false);
    h.turnDone();
    await flush();
    expect(calls).toBe(2);
    expect(h.manager.isArmed(ORCH)).toBe(true);
  });

  // FIX-AP-2 (1): a raw STOP whose grounding verdict was never frozen (the
  // server died between writing the review and recording its verdict, or the
  // review predates the verdicts file) holds on its RAW severity. The
  // re-grounded view calls it NOTE, but that re-grounding ran against a later
  // checkpoint, so it must not be what releases the hold.
  it("an unfrozen raw STOP holds even when the re-grounded view shows NOTE", async () => {
    const h = makeHarness({
      config: { idleMs: IDLE_MS, maxIterations: 3 },
      loadGroupStopHoldView: async () => ({
        findings: [stop({ id: "u1", severity: "NOTE", wasDowngraded: true, downgradeReason: "evidence_not_in_modified_set" })],
        unfrozenRawStopIds: ["u1"],
        gaps: [],
      }),
    });
    h.turnDone();
    await flush();
    expect(h.controller.getUnresolvedStopIds(GROUP)).toEqual(["u1"]);
    expect(h.manager.isArmed(ORCH)).toBe(false);
    // Still releasable by a human (the dismissal endpoint takes the id).
    h.controller.resolveStop(GROUP, "u1");
    expect(h.manager.isArmed(ORCH)).toBe(true);
  });

  // FIX-AP-3: no invisible holds. The bootstrap flags exactly the findings
  // that hold but that the banner predicate alone would hide; a blocking STOP
  // is already visible, a dismissed one no longer holds, and a pair whose
  // auto-proceed never arms (no opt-in / layer off) holds nothing at all.
  describe("invisibleHeldStopIds (FIX-AP-3)", () => {
    const view = {
      findings: [
        stop({ id: "blocking" }),
        stop({ id: "regrounded", severity: "NOTE", wasDowngraded: true, downgradeReason: "evidence_not_in_modified_set" }),
        stop({ id: "weak", weakEvidence: "no_cited_lines" }),
        stop({ id: "disputed", severity: "NOTE", disputed: "same_claim" }),
        stop({ id: "plain-note", severity: "NOTE" }),
      ],
      unfrozenRawStopIds: ["regrounded", "weak", "disputed"],
    };

    it("flags unfrozen raw STOPs the banner would hide, not blocking / disputed / never-STOP ones", () => {
      const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd: tmpWorkspace() });
      expect([...h.controller.invisibleHeldStopIds(GROUP, view)].sort()).toEqual(["regrounded", "weak"]);
    });

    it("drops a finding once a human dismissed it (in memory or persisted)", () => {
      const cwd = tmpWorkspace();
      const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd });
      expect(h.controller.resolveStop(GROUP, "regrounded")).toMatchObject({ ok: true, persisted: true });
      expect([...h.controller.invisibleHeldStopIds(GROUP, view)]).toEqual(["weak"]);
      // A fresh controller (restart) reads the persisted dismissal from disk.
      const restarted = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd });
      expect([...restarted.controller.invisibleHeldStopIds(GROUP, view)]).toEqual(["weak"]);
    });

    it("also flags a finding the live hold already carries, whatever it now looks like", () => {
      const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd: tmpWorkspace() });
      h.review([stop({ id: "live" })]);
      const shown = { findings: [stop({ id: "live", severity: "NOTE" })], unfrozenRawStopIds: [] };
      expect([...h.controller.invisibleHeldStopIds(GROUP, shown)]).toEqual(["live"]);
    });

    it("flags nothing without the opt-in or with the auto-proceed layer off", () => {
      expect(makeHarness({ cwd: tmpWorkspace() }).controller.invisibleHeldStopIds(GROUP, view).size).toBe(0);
      const off = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, layerAllowed: false, cwd: tmpWorkspace() });
      expect(off.controller.invisibleHeldStopIds(GROUP, view).size).toBe(0);
    });
  });

  // A human dispute is a real release, frozen or not.
  it("an unfrozen raw STOP that a human disputed does not hold", async () => {
    const h = makeHarness({
      config: { idleMs: IDLE_MS, maxIterations: 3 },
      loadGroupStopHoldView: async () => ({
        findings: [stop({ id: "u1", disputed: "same_claim" })],
        unfrozenRawStopIds: ["u1"],
        gaps: [],
      }),
    });
    h.turnDone();
    await flush();
    expect(h.manager.isArmed(ORCH)).toBe(true);
  });

  // FIX-AP-2 (2): every way the restore can be incomplete holds and logs the
  // reason (EC-9), instead of silently reading as "no STOP".
  describe("an incomplete restore holds, logs why, and is retried", () => {
    const cases: Array<{ name: string; gap: string; opts: Parameters<typeof makeHarness>[0] }> = [
      { name: "group unknown to the lifecycle (null view)", gap: "group_unknown",
        opts: { loadGroupStopHoldView: async () => null } },
      { name: "no workspace for the group", gap: "no_workspace",
        opts: { noWorkspace: true, loadGroupStopHoldView: async () => ({ findings: [], unfrozenRawStopIds: [], gaps: [] }) } },
      { name: "reviews directory unreadable", gap: "reviews_readdir_failed",
        opts: { loadGroupStopHoldView: async () => ({ findings: [], unfrozenRawStopIds: [], gaps: ["reviews_readdir_failed"] }) } },
      { name: "a review file that cannot be parsed", gap: "review_unparseable:x-codex-observer.md",
        opts: { loadGroupStopHoldView: async () => ({ findings: [], unfrozenRawStopIds: [], gaps: ["review_unparseable:x-codex-observer.md"] }) } },
      { name: "verdicts file corrupt", gap: "verdicts_invalid-json",
        opts: { loadGroupStopHoldView: async () => ({ findings: [], unfrozenRawStopIds: [], gaps: ["verdicts_invalid-json"] }) } },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const warn = vi.spyOn(log, "warn");
        const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, ...c.opts });
        h.turnDone();
        await flush();
        h.turnDone();
        await flush();
        expect(h.manager.isArmed(ORCH)).toBe(false);
        const incomplete = warn.mock.calls.filter(([, , data]) =>
          (data as { event?: string } | undefined)?.event === "auto-proceed.hold-restore-incomplete");
        // Retried on the second edge, logged each time with the reason.
        expect(incomplete).toHaveLength(2);
        expect(incomplete[0]![2]).toMatchObject({ sessionGroupId: GROUP, sessionId: ORCH, role: "orchestrator" });
        expect((incomplete[0]![2] as { gaps: string[] }).gaps).toContain(c.gap);
      });
    }

    // STOPs the partial view did find still hold, and the restore completes
    // (and arms) once the gap is gone.
    it("keeps the STOPs it found and completes when the gap clears", async () => {
      let gaps = ["review_unreadable:y-claude-observer.md"];
      let findings = [stop({ id: "s1" })];
      const h = makeHarness({
        config: { idleMs: IDLE_MS, maxIterations: 3 },
        loadGroupStopHoldView: async () => ({ findings, unfrozenRawStopIds: [], gaps }),
      });
      h.turnDone();
      await flush();
      expect(h.controller.getUnresolvedStopIds(GROUP)).toEqual(["s1"]);
      h.controller.resolveStop(GROUP, "s1");
      expect(h.manager.isArmed(ORCH)).toBe(false); // still incomplete
      gaps = [];
      findings = [];
      h.turnDone();
      await flush();
      expect(h.manager.isArmed(ORCH)).toBe(true);
    });
  });

  // (4) A real (browser-typed) user message ends the unattended episode: the
  // cap counter restarts, and the zeroed trace is persisted so a restart does
  // not bring the old count back.
  it("a human message resets the iteration counter and persists it", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 1 } });
    h.turnDone();
    h.clock.advance(IDLE_MS);
    expect(h.sent).toHaveLength(1);
    h.turnDone();
    h.clock.advance(IDLE_MS);
    expect(h.sent).toHaveLength(1); // capped

    h.userFrame();
    expect(h.manager.getIterationCount(ORCH)).toBe(0);
    expect(h.persisted.at(-1)).toBe(0);
    expect(h.managerLog).toContain("idle-timer.iterations-reset");
    h.turnDone();
    h.clock.advance(IDLE_MS);
    expect(h.sent).toHaveLength(2);
  });

  // (4) Past the cap nothing arms, so the manager never logs fire-cap-reached
  // on each idle edge; the controller logs the cap once per episode.
  it("does not arm past the cap and logs the cap once", () => {
    const info = vi.spyOn(log, "info");
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 1 } });
    h.turnDone();
    h.clock.advance(IDLE_MS);
    for (let i = 0; i < 4; i++) {
      h.turnDone();
      expect(h.manager.isArmed(ORCH)).toBe(false);
      h.clock.advance(IDLE_MS);
    }
    expect(h.managerLog).not.toContain("idle-timer.fire-cap-reached");
    const capLogs = info.mock.calls.filter((c) => (c[2] as { event?: string })?.event === "auto-proceed.cap-reached");
    expect(capLogs).toHaveLength(1);
  });

  // (3) EC-9: arm / refuse(reason) / hold / release are structured logs with
  // event + sessionGroupId + sessionId + role.
  it("logs arm, refusal, hold and release as EC-9 entries", () => {
    const info = vi.spyOn(log, "info");
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd: tmpWorkspace() });
    h.turnDone();
    h.review([stop()]);
    h.turnDone();
    h.turnState = { kind: "in-flight" };
    h.controller.resolveStop(GROUP, "f1"); // release → re-try → refused (in-flight)
    const byEvent = (e: string) =>
      info.mock.calls.map((c) => c[2] as Record<string, unknown>).filter((x) => x?.event === e);
    for (const e of ["auto-proceed.armed", "auto-proceed.stop-held", "auto-proceed.hold", "auto-proceed.stop-released", "auto-proceed.arm-refused"]) {
      const [entry] = byEvent(e);
      expect(entry, e).toMatchObject({ sessionGroupId: GROUP, sessionId: ORCH, role: "orchestrator" });
    }
    expect(byEvent("auto-proceed.arm-refused")[0]).toMatchObject({ reason: "in-flight" });
    expect(byEvent("auto-proceed.hold")[0]).toMatchObject({ reason: "unresolved_stop", findingIds: ["f1"] });
    expect(byEvent("auto-proceed.stop-released")[0]).toMatchObject({ via: "dismissed", findingIds: ["f1"] });
  });

  // (5) Archive cancels a pending timer explicitly and drops the hold.
  it("archiving cancels the pending timer", () => {
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 } });
    h.turnDone();
    expect(h.manager.isArmed(ORCH)).toBe(true);
    h.controller.noteArchived(ORCH);
    expect(h.manager.isArmed(ORCH)).toBe(false);
    h.clock.advance(IDLE_MS * 2);
    expect(h.sent).toHaveLength(0);

    h.review([stop({ id: "held" })]);
    expect(h.controller.getUnresolvedStopIds(GROUP)).toEqual(["held"]);
    h.controller.noteArchived(ORCH);
    expect(h.controller.getUnresolvedStopIds(GROUP)).toEqual([]);
  });

  // A resolutions file that cannot be parsed fails toward holding.
  it("an unreadable resolutions file holds on every restored STOP", async () => {
    const cwd = tmpWorkspace();
    mkdirSync(join(cwd, ".council", "state"), { recursive: true });
    writeFileSync(join(cwd, ".council", "state", `${GROUP}-resolved-stops.json`), "{not json");
    const h = makeHarness({ config: { idleMs: IDLE_MS, maxIterations: 3 }, cwd, loadGroupFindings: async () => [stop()] });
    h.turnDone();
    await flush();
    expect(h.controller.getUnresolvedStopIds(GROUP)).toEqual(["f1"]);
    expect(h.manager.isArmed(ORCH)).toBe(false);
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
