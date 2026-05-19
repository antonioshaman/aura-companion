// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reconcileAutoProceedTraces,
  type AutoProceedReconcileDeps,
  type AutoProceedReconcileGroup,
  type AutoProceedReconcileLogEntry,
  AUTO_PROCEED_TRACE_FILENAME_SUFFIX,
} from "./auto-proceed-reconcile.js";
import {
  AUTO_PROCEED_TRACE_SCHEMA_VERSION,
  ensureCouncilStateDir,
  readAutoProceedTrace,
  writeAutoProceedTrace,
  type AutoProceedTrace,
} from "./auto-proceed-state.js";
import { IdleTimerManager, type IdleTimerManagerDeps } from "./idle-timer-manager.js";
import { FakeClock } from "./clock-source.js";

// 32-hex group ids — match GROUP_ID_PATTERN exactly so the resolving
// wrapper accepts them. Two distinct ids let us test the orphan path
// (file named for group A in the workspace bound to group B).
const GROUP_A = "grp_4469a4c2bb3d1c4ac621d4cd9ae67bd9";
const GROUP_B = "grp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeFakeManagerDeps(): IdleTimerManagerDeps {
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

// Build a real {@link IdleTimerManager} so `rehydrate` exercises actual
// state-map mutation. This is the production-shape coverage — a test that
// mocked `rehydrate` would leave the manager-side state-map mutation
// untested and the boot-reconcile test would pass while the real manager
// silently dropped traces. Pair with vitest's `.getIterationCount` to
// assert post-rehydrate state.
function makeManager(): IdleTimerManager {
  return new IdleTimerManager(makeFakeManagerDeps());
}

function trace(overrides: Partial<AutoProceedTrace> = {}): AutoProceedTrace {
  return {
    schemaVersion: AUTO_PROCEED_TRACE_SCHEMA_VERSION,
    sessionGroupId: GROUP_A,
    iterationCount: 0,
    firedAt: [],
    cappedAt: null,
    lastObjectiveGateResult: null,
    ...overrides,
  };
}

describe("reconcileAutoProceedTraces", () => {
  let tmpRoot: string;
  let logEntries: AutoProceedReconcileLogEntry[];
  let realDeps: AutoProceedReconcileDeps;
  let manager: IdleTimerManager;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "auto-proceed-reconcile-"));
    logEntries = [];
    manager = makeManager();
    // Real filesystem + real persistence layer + real manager. This is
    // the production-shape happy path; only `logEvent` is a capture-stub
    // so assertions can inspect the structured emit log.
    realDeps = {
      listStateFiles: (workspaceRoot) => {
        try {
          // Read the actual `.council/state/` dir — the writer creates it.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { readdirSync } = require("node:fs") as typeof import("node:fs");
          return {
            kind: "ok",
            files: readdirSync(join(workspaceRoot, ".council", "state")),
          };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { kind: "missing" };
          }
          return { kind: "read-failed", error: err };
        }
      },
      readTrace: (workspaceRoot, groupId) => readAutoProceedTrace(workspaceRoot, groupId),
      rehydrate: (sessionId, traceValue, expectedGroupId) =>
        manager.rehydrate(sessionId, traceValue, expectedGroupId),
      logEvent: (entry) => {
        logEntries.push(entry);
      },
    };
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Happy path: one workspace, one trace, manager.rehydrate is called
  // with the persisted iteration count. Production-shape end-to-end —
  // any drift in {writer, suffix, reader, manager.rehydrate} breaks this.
  it("rehydrates a single group's iteration counter from disk", () => {
    ensureCouncilStateDir(tmpRoot);
    const persistResult = writeAutoProceedTrace(tmpRoot, GROUP_A, trace({
      iterationCount: 4,
      firedAt: [
        "2026-05-14T10:00:00.000Z",
        "2026-05-14T10:05:00.000Z",
        "2026-05-14T10:10:00.000Z",
        "2026-05-14T10:15:00.000Z",
      ],
    }));
    expect(persistResult.ok).toBe(true);

    const groups: AutoProceedReconcileGroup[] = [
      { sessionGroupId: GROUP_A, workspaceRoot: tmpRoot, orchestratorSessionId: "sess-orch-1" },
    ];
    const summary = reconcileAutoProceedTraces(groups, realDeps);

    expect(summary.rehydratedGroups).toBe(1);
    expect(summary.droppedTraces).toBe(0);
    expect(manager.getIterationCount("sess-orch-1")).toBe(4);
    // Structured emit: one rehydrated + one completed.
    expect(logEntries.map((e) => e.event)).toEqual([
      "auto-proceed.reconcile_rehydrated",
      "auto-proceed.reconcile_completed",
    ]);
  });

  // Idempotency — re-running with the same trace produces the same in-memory
  // state. Caller may invoke this multiple times per process lifetime;
  // the manager's `rehydrate` is idempotent by design.
  it("is idempotent — second call leaves the iteration count unchanged", () => {
    ensureCouncilStateDir(tmpRoot);
    writeAutoProceedTrace(tmpRoot, GROUP_A, trace({ iterationCount: 7, firedAt: [
      "2026-05-14T10:00:00.000Z",
      "2026-05-14T10:01:00.000Z",
      "2026-05-14T10:02:00.000Z",
      "2026-05-14T10:03:00.000Z",
      "2026-05-14T10:04:00.000Z",
      "2026-05-14T10:05:00.000Z",
      "2026-05-14T10:06:00.000Z",
    ] }));

    const groups: AutoProceedReconcileGroup[] = [
      { sessionGroupId: GROUP_A, workspaceRoot: tmpRoot, orchestratorSessionId: "sess-orch-1" },
    ];
    reconcileAutoProceedTraces(groups, realDeps);
    expect(manager.getIterationCount("sess-orch-1")).toBe(7);
    reconcileAutoProceedTraces(groups, realDeps);
    expect(manager.getIterationCount("sess-orch-1")).toBe(7);
  });

  // First-run path: the workspace has no `.council/state/` yet. Reconcile
  // must NOT log a drop (silent skip — missing dir is normal for fresh
  // workspaces). No final completed emit either since nothing happened.
  it("silently skips when the state dir is missing (first-run workspace)", () => {
    const groups: AutoProceedReconcileGroup[] = [
      { sessionGroupId: GROUP_A, workspaceRoot: tmpRoot, orchestratorSessionId: "sess-orch-1" },
    ];
    const summary = reconcileAutoProceedTraces(groups, realDeps);

    expect(summary).toEqual({ rehydratedGroups: 0, droppedTraces: 0 });
    expect(logEntries).toEqual([]);
    expect(manager.getIterationCount("sess-orch-1")).toBe(0);
  });

  // Orphan filename: a trace file present for GROUP_A in a workspace
  // associated with GROUP_B. The filename-prefix guard catches this
  // BEFORE the reader is called (so a malformed file doesn't even land
  // in the trace-invalid branch — anti-confusion).
  it("logs orphan-filename and skips when filename prefix mismatches the group id", () => {
    ensureCouncilStateDir(tmpRoot);
    writeAutoProceedTrace(tmpRoot, GROUP_A, trace({ iterationCount: 2, firedAt: [
      "2026-05-14T10:00:00.000Z",
      "2026-05-14T10:01:00.000Z",
    ] }));

    // The reconcile binding for this workspace claims it belongs to GROUP_B.
    const groups: AutoProceedReconcileGroup[] = [
      { sessionGroupId: GROUP_B, workspaceRoot: tmpRoot, orchestratorSessionId: "sess-orch-2" },
    ];
    const summary = reconcileAutoProceedTraces(groups, realDeps);

    expect(summary.rehydratedGroups).toBe(0);
    expect(summary.droppedTraces).toBe(1);
    expect(manager.getIterationCount("sess-orch-2")).toBe(0);
    const orphanLog = logEntries.find((e) => e.reason === "orphan-filename");
    expect(orphanLog?.event).toBe("auto-proceed.reconcile_dropped");
    expect(orphanLog?.sessionGroupId).toBe(GROUP_B);
  });

  // Schema-version mismatch: a hand-crafted file claims a future schema.
  // The reader rejects it loudly; the reconcile classifies it as
  // `trace-schema-mismatch` and skips. Manager state stays at zero.
  it("logs trace-schema-mismatch and skips when on-disk schemaVersion is unknown", () => {
    const stateDir = ensureCouncilStateDir(tmpRoot);
    expect(stateDir.ok).toBe(true);
    if (!stateDir.ok) return;
    const tracePath = join(stateDir.stateDir, `${GROUP_A}${AUTO_PROCEED_TRACE_FILENAME_SUFFIX}`);
    writeFileSync(
      tracePath,
      JSON.stringify({
        schemaVersion: 99,
        sessionGroupId: GROUP_A,
        iterationCount: 5,
        firedAt: [],
        cappedAt: null,
        lastObjectiveGateResult: null,
      }),
      "utf8",
    );

    const groups: AutoProceedReconcileGroup[] = [
      { sessionGroupId: GROUP_A, workspaceRoot: tmpRoot, orchestratorSessionId: "sess-orch-3" },
    ];
    const summary = reconcileAutoProceedTraces(groups, realDeps);

    expect(summary).toEqual({ rehydratedGroups: 0, droppedTraces: 1 });
    expect(manager.getIterationCount("sess-orch-3")).toBe(0);
    expect(logEntries.find((e) => e.reason === "trace-schema-mismatch")?.event).toBe(
      "auto-proceed.reconcile_dropped",
    );
  });

  // Corruption: a file with the right name but invalid JSON. The reader
  // returns `{kind:"invalid-json"}`; the reconcile maps that to
  // `trace-invalid-json`. Manager state stays clean.
  it("logs trace-invalid-json and skips when the file isn't parseable JSON", () => {
    const stateDir = ensureCouncilStateDir(tmpRoot);
    expect(stateDir.ok).toBe(true);
    if (!stateDir.ok) return;
    const tracePath = join(stateDir.stateDir, `${GROUP_A}${AUTO_PROCEED_TRACE_FILENAME_SUFFIX}`);
    writeFileSync(tracePath, "{not valid json", "utf8");

    const groups: AutoProceedReconcileGroup[] = [
      { sessionGroupId: GROUP_A, workspaceRoot: tmpRoot, orchestratorSessionId: "sess-orch-4" },
    ];
    const summary = reconcileAutoProceedTraces(groups, realDeps);

    expect(summary).toEqual({ rehydratedGroups: 0, droppedTraces: 1 });
    expect(logEntries.find((e) => e.reason === "trace-invalid-json")?.event).toBe(
      "auto-proceed.reconcile_dropped",
    );
  });

  // Multi-group: two workspaces, each with its own trace; both rehydrate
  // independently. Asserts the loop doesn't cross-contaminate state.
  it("rehydrates each group independently across multiple workspaces", () => {
    const wsA = tmpRoot;
    const wsB = mkdtempSync(join(tmpdir(), "auto-proceed-reconcile-b-"));
    try {
      ensureCouncilStateDir(wsA);
      ensureCouncilStateDir(wsB);
      writeAutoProceedTrace(wsA, GROUP_A, trace({
        sessionGroupId: GROUP_A,
        iterationCount: 3,
        firedAt: ["2026-05-14T10:00:00.000Z", "2026-05-14T10:01:00.000Z", "2026-05-14T10:02:00.000Z"],
      }));
      writeAutoProceedTrace(wsB, GROUP_B, trace({
        sessionGroupId: GROUP_B,
        iterationCount: 6,
        firedAt: [
          "2026-05-14T11:00:00.000Z",
          "2026-05-14T11:01:00.000Z",
          "2026-05-14T11:02:00.000Z",
          "2026-05-14T11:03:00.000Z",
          "2026-05-14T11:04:00.000Z",
          "2026-05-14T11:05:00.000Z",
        ],
      }));

      const groups: AutoProceedReconcileGroup[] = [
        { sessionGroupId: GROUP_A, workspaceRoot: wsA, orchestratorSessionId: "sess-a" },
        { sessionGroupId: GROUP_B, workspaceRoot: wsB, orchestratorSessionId: "sess-b" },
      ];
      const summary = reconcileAutoProceedTraces(groups, realDeps);

      expect(summary.rehydratedGroups).toBe(2);
      expect(manager.getIterationCount("sess-a")).toBe(3);
      expect(manager.getIterationCount("sess-b")).toBe(6);
    } finally {
      rmSync(wsB, { recursive: true, force: true });
    }
  });

  // readdir-failed branch: the deps surface a synthetic read failure.
  // Reconcile logs `readdir-failed` (the coarser drop-reason) and skips
  // the group; other groups in the same batch continue independently.
  it("logs readdir-failed and skips that group when listStateFiles fails", () => {
    const fakeDeps: AutoProceedReconcileDeps = {
      ...realDeps,
      listStateFiles: () => ({ kind: "read-failed", error: new Error("synthetic-failure") }),
    };
    const groups: AutoProceedReconcileGroup[] = [
      { sessionGroupId: GROUP_A, workspaceRoot: tmpRoot, orchestratorSessionId: "sess-x" },
    ];
    const summary = reconcileAutoProceedTraces(groups, fakeDeps);

    expect(summary).toEqual({ rehydratedGroups: 0, droppedTraces: 0 });
    expect(logEntries.map((e) => e.event)).toEqual(["auto-proceed.reconcile_dropped"]);
    expect(logEntries[0].reason).toBe("readdir-failed");
  });
});
