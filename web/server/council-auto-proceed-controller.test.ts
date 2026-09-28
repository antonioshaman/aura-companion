import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CouncilAutoProceedController } from "./council-auto-proceed-controller.js";
import { IdleTimerManager } from "./idle-timer-manager.js";
import { FakeClock } from "./clock-source.js";
import {
  AUTO_PROCEED_TRACE_SCHEMA_VERSION,
  ensureCouncilStateDir,
  writeAutoProceedTrace,
} from "./auto-proceed-state.js";

// P4/C1c: the auto-proceed call sites (user-frame gate, exit clear, API-limit
// pause, archive clear, boot reconcile, coordinator enactor) were extracted
// verbatim from session-orchestrator.ts. The orchestrator suite still pins
// them end-to-end through the orchestrator (CR-7 wiring tests, API-limit
// pause, DI get/set). These tests pin the NEW seam: the controller works with
// nothing but its DI deps, and every entry point resolves the manager at CALL
// time — the late `setManager` swap index.ts performs after construction must
// reach listeners and the enactor that were handed out before the swap.

const GROUP = "grp_4469a4c2bb3d1c4ac621d4cd9ae67bd9";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Spy manager: only the methods the controller calls. */
function spyManager() {
  return {
    arm: vi.fn(),
    cancel: vi.fn(),
    noteUserMessage: vi.fn(),
    noteApiLimitReached: vi.fn(),
    isApiLimitReached: vi.fn(() => true),
    clearPendingSyntheticTurn: vi.fn(),
    disposeAll: vi.fn(),
  };
}
type SpyManager = ReturnType<typeof spyManager>;
const asManager = (m: SpyManager) => m as unknown as IdleTimerManager;

function realManager(): IdleTimerManager {
  return new IdleTimerManager({
    clock: new FakeClock(0),
    getSession: () => null,
    getGroupStatus: () => "active",
    persistTrace: () => ({ ok: true }),
    appendSummary: () => ({ ok: true }),
    sendSyntheticFrame: () => ({ ok: false, error: "unused" }),
    logEvent: () => undefined,
  });
}

function makeController(manager?: IdleTimerManager) {
  const groupMeta = new Map<string, { primarySessionId: string }>();
  const watchers = new Map<string, { cwd: string }>();
  const controller = new CouncilAutoProceedController({ manager, groupMeta, watchers });
  return { controller, groupMeta, watchers };
}

/** Captures the callbacks `wire()` registers so the test can fire them. */
function captureWiring() {
  const captured: { userFrame?: (sid: string) => void; exited?: (sid: string) => void } = {};
  return {
    captured,
    wiring: {
      onUserFrameObserved: (cb: (sid: string) => void) => {
        captured.userFrame = cb;
      },
      onSessionExited: (cb: (sid: string) => void) => {
        captured.exited = cb;
      },
    },
  };
}

describe("CouncilAutoProceedController", () => {
  // DI omission → inert null-object manager (tests and pre-feature callers
  // must not crash on dispose / api-limit reads).
  it("defaults to a usable no-op manager when DI omits it", () => {
    const { controller } = makeController();
    const manager = controller.getManager();
    expect(manager).toBeDefined();
    expect(() => manager.disposeAll()).not.toThrow();
    expect(controller.isApiLimitReached("s1")).toBe(false);
    expect(() => controller.clearPendingSyntheticTurn("s1")).not.toThrow();
  });

  // Task 11.6 + 11.8 wiring: the user-frame callback feeds noteUserMessage and
  // the exit callback clears the sticky synthetic-turn token.
  it("wire() forwards user frames and session exits to the manager", () => {
    const spy = spyManager();
    const { controller } = makeController(asManager(spy));
    const { captured, wiring } = captureWiring();

    controller.wire(wiring);
    captured.userFrame!("sess-tab-b");
    captured.exited!("sess-dead");

    expect(spy.noteUserMessage).toHaveBeenCalledWith("sess-tab-b");
    expect(spy.clearPendingSyntheticTurn).toHaveBeenCalledWith("sess-dead");
  });

  // The load-bearing seam: index.ts constructs the orchestrator with the noop
  // manager, wires, then swaps in the real one. Listeners and the enactor
  // handed out BEFORE the swap must hit the new manager, not the noop one.
  it("late setManager reaches listeners and the enactor handed out before the swap", () => {
    const early = spyManager();
    const late = spyManager();
    const { controller } = makeController(asManager(early));
    const { captured, wiring } = captureWiring();
    controller.wire(wiring);
    const enactor = controller.enactor;

    controller.setManager(asManager(late));
    expect(controller.getManager()).toBe(late);

    captured.userFrame!("s1");
    captured.exited!("s1");
    enactor.arm("s1", { idleMs: 1_000, maxIterations: 3 });
    enactor.cancel("s1");
    enactor.noteUserMessage("s2");
    controller.noteApiLimitReached("s1");
    controller.isApiLimitReached("s1");

    expect(late.noteUserMessage).toHaveBeenCalledWith("s1");
    expect(late.noteUserMessage).toHaveBeenCalledWith("s2");
    expect(late.clearPendingSyntheticTurn).toHaveBeenCalledWith("s1");
    expect(late.arm).toHaveBeenCalledWith("s1", { idleMs: 1_000, maxIterations: 3 });
    expect(late.cancel).toHaveBeenCalledWith("s1");
    expect(late.noteApiLimitReached).toHaveBeenCalledWith("s1");
    expect(late.isApiLimitReached).toHaveBeenCalledWith("s1");
    for (const fn of Object.values(early)) expect(fn).not.toHaveBeenCalled();
  });

  // API-limit read is a pass-through (the checkpoint pipeline suppresses
  // observer wakes on it), so the manager's answer must come back unchanged.
  it("isApiLimitReached returns the manager's answer", () => {
    const spy = spyManager();
    const { controller } = makeController(asManager(spy));
    expect(controller.isApiLimitReached("s1")).toBe(true);
    spy.isApiLimitReached.mockReturnValue(false);
    expect(controller.isApiLimitReached("s1")).toBe(false);
  });

  // Boot reconcile reads the orchestrator-owned maps it was handed — entries
  // added AFTER construction (reconcileCouncilGroups runs later in
  // initialize()) must be visible, and the real on-disk trace rehydrates the
  // iteration counter.
  it("rehydrateTraces reads the injected maps live and rehydrates from disk", () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-proceed-ctl-"));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    ensureCouncilStateDir(cwd);
    writeAutoProceedTrace(cwd, GROUP, {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: GROUP,
      iterationCount: 2,
      firedAt: ["2026-05-14T10:00:00.000Z", "2026-05-14T10:01:00.000Z"],
      cappedAt: null,
      lastObjectiveGateResult: null,
    });
    const manager = realManager();
    const { controller, groupMeta, watchers } = makeController(manager);

    // Populated after construction, as in the orchestrator.
    groupMeta.set(GROUP, { primarySessionId: "sess-orch-1" });
    watchers.set(GROUP, { cwd });
    controller.rehydrateTraces();

    expect(manager.getIterationCount("sess-orch-1")).toBe(2);
  });

  // No groups → no filesystem access, no state; must never throw from
  // initialize().
  it("rehydrateTraces is a no-op with no groups", () => {
    const manager = realManager();
    const { controller } = makeController(manager);
    expect(() => controller.rehydrateTraces()).not.toThrow();
    expect(manager.getIterationCount("any")).toBe(0);
  });
});
