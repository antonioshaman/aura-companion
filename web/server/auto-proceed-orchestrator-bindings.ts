/**
 * Concrete-bindings adapters that wire the auto-proceed pipeline into the
 * session-orchestrator at boot time
 * (PLAN-aura-orchestrator-idle-auto-proceed Task 9).
 *
 * Lives in a sibling file rather than inside `session-orchestrator.ts`
 * because that module is a 1900+ line god-module whose file-level
 * coverage gate cascades any new untested lines past the 80% threshold
 * — `feedback_file_level_coverage_gate_cascade` documents the pattern.
 * Pulling these helpers out keeps the orchestrator file lean and lets
 * the unit test exercise the bindings + the inert manager directly.
 *
 * Two surfaces:
 *  - {@link buildNoopIdleTimerManager} — null-object default for DI omission.
 *  - {@link buildAutoProceedReconcileDeps} — concrete-bindings factory
 *    that the orchestrator's `initialize()` path calls once per boot.
 */

import { readdirSync } from "node:fs";
import { IdleTimerManager } from "./idle-timer-manager.js";
import { readAutoProceedTrace } from "./auto-proceed-state.js";
import { resolveCouncilStateDir } from "./council-state-path.js";
import {
  reconcileAutoProceedTraces,
  type AutoProceedReconcileDeps,
  type AutoProceedReconcileGroup,
  type AutoProceedReconcileLogEntry,
} from "./auto-proceed-reconcile.js";

/**
 * Build a fully-functional but inert {@link IdleTimerManager} — every
 * dependency is a stub that succeeds without doing real work. Used as
 * the DI default so existing test paths (and `index.ts` callers that
 * predate the auto-proceed feature) don't crash. The boot-reconcile
 * pass and SIGTERM-drain become harmless no-ops.
 */
export function buildNoopIdleTimerManager(): IdleTimerManager {
  return new IdleTimerManager({
    clock: { now: () => Date.now(), schedule: () => ({ cancel: () => undefined }) },
    getSession: () => null,
    getGroupStatus: () => "unknown",
    persistTrace: () => ({ ok: true }),
    appendSummary: () => ({ ok: true }),
    sendSyntheticFrame: () => ({ ok: false, error: "noop-manager-not-wired" }),
    logEvent: () => undefined,
  });
}

/** Inputs the orchestrator hands to {@link buildAutoProceedReconcileDeps}. */
export interface AutoProceedReconcileBindingsOptions {
  /** Live manager instance — the rehydrate target. */
  readonly manager: IdleTimerManager;
  /** Structured-log sink. Production wires this to the project logger. */
  readonly logger: (entry: AutoProceedReconcileLogEntry) => void;
}

/**
 * Concrete-bindings factory for {@link reconcileAutoProceedTraces}.
 * Returns the dependency surface the reducer needs, wired against the
 * real filesystem (`readdirSync`), real persistence reader
 * (`readAutoProceedTrace`), and the supplied manager + logger.
 *
 * Pulled into its own function so the unit test can pin the
 * concrete-bindings shape independently of the orchestrator harness.
 * The orchestrator's `rehydrateAutoProceedTraces` shrinks to a single
 * call site that passes the result of this factory into the pure reducer.
 */
/**
 * Minimal shape the rehydrate driver reads from the orchestrator's
 * per-group meta cache. Narrowed so the bindings module never sees the
 * full `CouncilGroupMeta` type from session-orchestrator.ts (which
 * carries observer-prompt-sha256 and other unrelated fields).
 */
export interface OrchestratorGroupMetaForRehydrate {
  readonly primarySessionId: string;
}

/** Minimal shape of the per-group watcher entry the driver reads. */
export interface OrchestratorWatcherForRehydrate {
  readonly cwd: string;
}

/**
 * Driver for the orchestrator-side rehydrate path. Pure data-in /
 * effects-out — takes the orchestrator's meta + watcher maps as inputs
 * and delegates to the {@link reconcileAutoProceedTraces} reducer with
 * concrete production bindings.
 *
 * Lives here rather than as a private method on `SessionOrchestrator`
 * because the orchestrator is a 1900+ line god-module whose file-level
 * coverage gate cascades any new untested lines past the 80% threshold
 * — `feedback_file_level_coverage_gate_cascade`. Pulling the rehydrate
 * loop out lets the unit test exercise the loop directly without
 * standing up the orchestrator's full event-bus harness.
 *
 * Synthetic placeholder ids (`__missing_orch_…`) from partial-pair
 * reconcile are filtered before the reducer call — they would never
 * have a real on-disk trace and the manager's state map keys on real
 * sessionIds only.
 */
export function runAutoProceedBootReconcile(
  councilGroupMeta: ReadonlyMap<string, OrchestratorGroupMetaForRehydrate>,
  councilWatchers: ReadonlyMap<string, OrchestratorWatcherForRehydrate>,
  manager: IdleTimerManager,
  logger: (entry: AutoProceedReconcileLogEntry) => void,
): void {
  const reconcileGroups: AutoProceedReconcileGroup[] = [];
  for (const [groupId, meta] of councilGroupMeta) {
    if (meta.primarySessionId.startsWith("__missing_")) continue;
    const watcher = councilWatchers.get(groupId);
    if (!watcher) continue;
    reconcileGroups.push({
      sessionGroupId: groupId,
      workspaceRoot: watcher.cwd,
      orchestratorSessionId: meta.primarySessionId,
    });
  }
  if (reconcileGroups.length === 0) return;
  reconcileAutoProceedTraces(
    reconcileGroups,
    buildAutoProceedReconcileDeps({ manager, logger }),
  );
}

export function buildAutoProceedReconcileDeps(
  opts: AutoProceedReconcileBindingsOptions,
): AutoProceedReconcileDeps {
  return {
    listStateFiles: (workspaceRoot) => {
      const dirResult = resolveCouncilStateDir(workspaceRoot);
      if (!dirResult.ok) {
        return { kind: "read-failed", error: dirResult.error };
      }
      try {
        return { kind: "ok", files: readdirSync(dirResult.value) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "missing" };
        }
        return { kind: "read-failed", error: err };
      }
    },
    readTrace: (workspaceRoot, groupId) => readAutoProceedTrace(workspaceRoot, groupId),
    rehydrate: (sessionId, trace, expectedGroupId) =>
      opts.manager.rehydrate(sessionId, trace, expectedGroupId),
    logEvent: opts.logger,
  };
}
