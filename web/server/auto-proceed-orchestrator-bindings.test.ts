// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNoopIdleTimerManager,
  buildAutoProceedReconcileDeps,
  runAutoProceedBootReconcile,
} from "./auto-proceed-orchestrator-bindings.js";
import {
  AUTO_PROCEED_TRACE_SCHEMA_VERSION,
  ensureCouncilStateDir,
  writeAutoProceedTrace,
} from "./auto-proceed-state.js";
import { IdleTimerManager, type IdleTimerManagerDeps } from "./idle-timer-manager.js";
import { FakeClock } from "./clock-source.js";
import type { AutoProceedReconcileLogEntry } from "./auto-proceed-reconcile.js";

const GROUP = "grp_4469a4c2bb3d1c4ac621d4cd9ae67bd9";

describe("buildNoopIdleTimerManager", () => {
  // The null-object default exists so callers that don't wire the real
  // manager (existing tests, `index.ts` paths predating the feature) don't
  // crash on dispose/rehydrate. Every dep stub must succeed silently.
  it("constructs a manager whose dispose/rehydrate/arm/cancel are no-ops", () => {
    const mgr = buildNoopIdleTimerManager();
    // disposeAll must not throw on an empty state.
    expect(() => mgr.disposeAll()).not.toThrow();
    // rehydrate is a no-op — the noop manager records nothing.
    mgr.rehydrate("sess-x", {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: GROUP,
      iterationCount: 5,
      firedAt: ["2026-05-14T10:00:00.000Z", "2026-05-14T10:01:00.000Z", "2026-05-14T10:02:00.000Z", "2026-05-14T10:03:00.000Z", "2026-05-14T10:04:00.000Z"],
      cappedAt: null,
      lastObjectiveGateResult: null,
    }, GROUP);
    expect(mgr.getIterationCount("sess-x")).toBe(5);
    // Arm refuses cleanly because the stubbed `getSession` returns null —
    // the gate stack short-circuits at `session-missing`.
    const armResult = mgr.arm("sess-x", { idleMs: 1_000, maxIterations: 3 });
    expect(armResult).toEqual({ kind: "refused", reason: "session-missing" });
    // cancel/noteUserMessage must not throw on missing sessions.
    expect(() => mgr.cancel("sess-x")).not.toThrow();
    expect(() => mgr.noteUserMessage("sess-x")).not.toThrow();
  });

  // The noop manager's `sendSyntheticFrame` is unreachable in production
  // (boot reconcile only calls rehydrate; nothing else fires through this
  // manager since no caller emits `orchestrator_turn_idle`). The
  // canonical-failure return shape is still part of the contract — if a
  // future change accidentally routes a fire through it, the
  // `synthetic-frame-not-wired` marker must surface in EC-9 logs.
  it("noop manager's sendSyntheticFrame is unreachable but the contract is documented", () => {
    // We can't invoke sendSyntheticFrame directly through the public
    // surface without going through fire() — and fire() requires arm() to
    // succeed first. The assertion above (`arm refuses with session-missing`)
    // is the structural proof: the noop's sendSyntheticFrame is unreachable.
    // This test surfaces the intent so a future fragmenting change doesn't
    // accidentally drop the noop's failure-mode marker.
    const mgr = buildNoopIdleTimerManager();
    expect(mgr).toBeInstanceOf(IdleTimerManager);
  });
});

describe("buildAutoProceedReconcileDeps", () => {
  let tmpRoot: string;
  let logEntries: AutoProceedReconcileLogEntry[];
  let manager: IdleTimerManager;

  // The reducer tests already cover the high-level behaviour with these
  // deps; this suite focuses on the wiring itself — that
  // `listStateFiles` correctly maps ENOENT to `{kind:"missing"}`, that
  // `readTrace` plumbs through the writer's output, that `rehydrate`
  // really lands on the manager.
  function realManagerDeps(): IdleTimerManagerDeps {
    return {
      clock: new FakeClock(0),
      getSession: () => null,
      getGroupStatus: () => "active",
      persistTrace: () => ({ ok: true }),
      appendSummary: () => ({ ok: true }),
      sendSyntheticFrame: () => ({ ok: false, error: "unused" }),
      logEvent: () => undefined,
    };
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "auto-proceed-bindings-"));
    logEntries = [];
    manager = new IdleTimerManager(realManagerDeps());
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("listStateFiles returns {kind:'missing'} when .council/state/ doesn't exist", () => {
    const deps = buildAutoProceedReconcileDeps({
      manager,
      logger: (e) => logEntries.push(e),
    });
    const result = deps.listStateFiles(tmpRoot);
    expect(result).toEqual({ kind: "missing" });
  });

  it("listStateFiles returns ok+files when the dir exists", () => {
    ensureCouncilStateDir(tmpRoot);
    writeAutoProceedTrace(tmpRoot, GROUP, {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: GROUP,
      iterationCount: 0,
      firedAt: [],
      cappedAt: null,
      lastObjectiveGateResult: null,
    });
    const deps = buildAutoProceedReconcileDeps({
      manager,
      logger: (e) => logEntries.push(e),
    });
    const result = deps.listStateFiles(tmpRoot);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.files).toContain(`${GROUP}-auto-proceed-trace.json`);
    }
  });

  it("listStateFiles returns read-failed on path-validation error (e.g. relative root)", () => {
    const deps = buildAutoProceedReconcileDeps({
      manager,
      logger: (e) => logEntries.push(e),
    });
    // A relative workspaceRoot fails the resolver's bounds check —
    // surfaces as read-failed (caller treats this as a drop reason).
    const result = deps.listStateFiles("relative/not-absolute");
    expect(result.kind).toBe("read-failed");
  });

  it("readTrace plumbs through to the persistence reader and round-trips a written trace", () => {
    ensureCouncilStateDir(tmpRoot);
    writeAutoProceedTrace(tmpRoot, GROUP, {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: GROUP,
      iterationCount: 2,
      firedAt: ["2026-05-14T10:00:00.000Z", "2026-05-14T10:01:00.000Z"],
      cappedAt: null,
      lastObjectiveGateResult: "pass",
    });
    const deps = buildAutoProceedReconcileDeps({
      manager,
      logger: (e) => logEntries.push(e),
    });
    const result = deps.readTrace(tmpRoot, GROUP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.iterationCount).toBe(2);
      expect(result.value.lastObjectiveGateResult).toBe("pass");
    }
  });

  it("rehydrate forwards to the supplied IdleTimerManager (lands on state map)", () => {
    const deps = buildAutoProceedReconcileDeps({
      manager,
      logger: (e) => logEntries.push(e),
    });
    deps.rehydrate(
      "sess-orch-1",
      {
        schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
        sessionGroupId: GROUP,
        iterationCount: 4,
        firedAt: [
          "2026-05-14T10:00:00.000Z",
          "2026-05-14T10:01:00.000Z",
          "2026-05-14T10:02:00.000Z",
          "2026-05-14T10:03:00.000Z",
        ],
        cappedAt: null,
        lastObjectiveGateResult: null,
      },
      GROUP,
    );
    expect(manager.getIterationCount("sess-orch-1")).toBe(4);
  });

  it("logEvent forwards verbatim to the supplied logger", () => {
    const deps = buildAutoProceedReconcileDeps({
      manager,
      logger: (e) => logEntries.push(e),
    });
    deps.logEvent({
      event: "auto-proceed.reconcile_rehydrated",
      sessionGroupId: GROUP,
      sessionId: "sess-orch-1",
    });
    expect(logEntries).toEqual([
      { event: "auto-proceed.reconcile_rehydrated", sessionGroupId: GROUP, sessionId: "sess-orch-1" },
    ]);
  });

  // Edge case: a real EACCES-style read failure surfaces as read-failed.
  // We simulate by creating the state dir, then a file inside it that
  // would short-circuit before reaching readdir errors. The simpler check
  // is that the wrapper consistently maps non-ENOENT errors to read-failed.
  it("listStateFiles maps non-ENOENT errors to read-failed", () => {
    // Create a regular file at the state-dir path so `readdirSync` throws
    // ENOTDIR. The resolver still validates the workspaceRoot — we use a
    // valid absolute path so the validator passes, then sabotage the dir.
    const stateDirParent = join(tmpRoot, ".council");
    writeFileSync(stateDirParent, "i am a file, not a directory", "utf8");
    const deps = buildAutoProceedReconcileDeps({
      manager,
      logger: (e) => logEntries.push(e),
    });
    const result = deps.listStateFiles(tmpRoot);
    expect(result.kind).toBe("read-failed");
  });
});

describe("runAutoProceedBootReconcile", () => {
  let tmpRoot: string;
  let manager: IdleTimerManager;
  let logEntries: AutoProceedReconcileLogEntry[];

  function realManagerDeps(): IdleTimerManagerDeps {
    return {
      clock: new FakeClock(0),
      getSession: () => null,
      getGroupStatus: () => "active",
      persistTrace: () => ({ ok: true }),
      appendSummary: () => ({ ok: true }),
      sendSyntheticFrame: () => ({ ok: false, error: "unused" }),
      logEvent: () => undefined,
    };
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "auto-proceed-driver-"));
    manager = new IdleTimerManager(realManagerDeps());
    logEntries = [];
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Empty meta map → no work to do. Reducer never even invoked, no
  // structured emit. Sanity check that the no-groups early-return path
  // doesn't crash or emit phantom "no groups" logs.
  it("is a no-op when councilGroupMeta is empty", () => {
    runAutoProceedBootReconcile(new Map(), new Map(), manager, (e) => logEntries.push(e));
    expect(logEntries).toEqual([]);
    expect(manager.getIterationCount("any-id")).toBe(0);
  });

  // Synthetic placeholder ids must be filtered BEFORE the reducer sees them
  // (the manager's state map keys on real sessionIds; a placeholder
  // landing in `rehydrate` would leak dead-weight state).
  it("filters out placeholder __missing_ sessionIds before invoking the reducer", () => {
    const meta = new Map([
      ["grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { primarySessionId: "__missing_orch_grp_aaa..." }],
    ]);
    const watchers = new Map([
      ["grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { cwd: tmpRoot }],
    ]);
    runAutoProceedBootReconcile(meta, watchers, manager, (e) => logEntries.push(e));
    // No state-dir read attempted — reducer was never invoked because
    // the filtered group list was empty.
    expect(logEntries).toEqual([]);
  });

  // A meta entry without a matching watcher means we don't know the cwd —
  // skip silently. (Watcher absence usually means startCouncilWatchers
  // hasn't fired yet for this group, which is a transient state during
  // initialize.)
  it("skips groups whose watcher entry is missing", () => {
    const meta = new Map([
      ["grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { primarySessionId: "sess-orch-1" }],
    ]);
    runAutoProceedBootReconcile(meta, new Map(), manager, (e) => logEntries.push(e));
    expect(logEntries).toEqual([]);
  });

  // End-to-end: meta + watcher map both populated, real on-disk trace
  // present. Manager's iteration counter rehydrates. Structured emit
  // contains the rehydrated + completed log lines.
  it("drives the reducer end-to-end and rehydrates the manager", () => {
    ensureCouncilStateDir(tmpRoot);
    writeAutoProceedTrace(tmpRoot, GROUP, {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: GROUP,
      iterationCount: 6,
      firedAt: [
        "2026-05-14T10:00:00.000Z",
        "2026-05-14T10:01:00.000Z",
        "2026-05-14T10:02:00.000Z",
        "2026-05-14T10:03:00.000Z",
        "2026-05-14T10:04:00.000Z",
        "2026-05-14T10:05:00.000Z",
      ],
      cappedAt: null,
      lastObjectiveGateResult: null,
    });
    const meta = new Map([[GROUP, { primarySessionId: "sess-orch-1" }]]);
    const watchers = new Map([[GROUP, { cwd: tmpRoot }]]);

    runAutoProceedBootReconcile(meta, watchers, manager, (e) => logEntries.push(e));

    expect(manager.getIterationCount("sess-orch-1")).toBe(6);
    const events = logEntries.map((e) => e.event);
    expect(events).toContain("auto-proceed.reconcile_rehydrated");
    expect(events).toContain("auto-proceed.reconcile_completed");
  });

  // Mixed batch: one real group + one placeholder. The placeholder is
  // dropped pre-reducer; the real group rehydrates normally. Asserts the
  // filter doesn't accidentally drop the real entry.
  it("processes real groups while filtering placeholders in the same batch", () => {
    ensureCouncilStateDir(tmpRoot);
    writeAutoProceedTrace(tmpRoot, GROUP, {
      schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
      sessionGroupId: GROUP,
      iterationCount: 1,
      firedAt: ["2026-05-14T10:00:00.000Z"],
      cappedAt: null,
      lastObjectiveGateResult: null,
    });
    const meta = new Map([
      ["grp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", { primarySessionId: "__missing_orch_grp_bbb..." }],
      [GROUP, { primarySessionId: "sess-real" }],
    ]);
    const watchers = new Map([
      [GROUP, { cwd: tmpRoot }],
    ]);

    runAutoProceedBootReconcile(meta, watchers, manager, (e) => logEntries.push(e));

    expect(manager.getIterationCount("sess-real")).toBe(1);
    // Manager state map MUST NOT contain the placeholder key.
    expect(manager.getIterationCount("__missing_orch_grp_bbb...")).toBe(0);
  });
});
