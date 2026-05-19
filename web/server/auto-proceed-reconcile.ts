/**
 * Auto-proceed boot reconcile — pure, dependency-injected core for the
 * orchestrator's restart-recovery path
 * (PLAN-aura-orchestrator-idle-auto-proceed Task 9).
 *
 * Why a separate module: `session-orchestrator.ts` is 1900+ lines and the
 * reconcile logic only needs three injected callables (readTrace, listFiles,
 * rehydrate) plus a logger. Lifting it out keeps the orchestrator's mixin
 * surface small and lets the test exercise the real filesystem + real
 * {@link IdleTimerManager.rehydrate} without standing up a full
 * SessionOrchestrator harness.
 *
 * Idempotency: re-running with the same on-disk state produces the same
 * in-memory state — `rehydrate` overwrites; readdir is purely
 * observational. The reducer's caller (`session-orchestrator.initialize`)
 * may invoke this multiple times during one process lifetime without harm.
 *
 * Filename convention: `<group-id>-auto-proceed-trace.json`. The reducer
 * filters by suffix AND asserts the filename prefix equals the requested
 * group-id; mismatched prefixes are surfaced as `orphan-filename` so a
 * file copied between workspaces doesn't accidentally rehydrate the wrong
 * group.
 */

import type { AutoProceedTrace, AutoProceedTraceReadError } from "./auto-proceed-state.js";

/** Suffix the producer (`writeAutoProceedTrace`) emits. Pure constant — the
 *  reducer matches files by exact suffix, never by glob, so a future
 *  `<group>-auto-proceed-trace.json.bak` doesn't accidentally rehydrate. */
export const AUTO_PROCEED_TRACE_FILENAME_SUFFIX = "-auto-proceed-trace.json";

/** Per-group input the reducer needs to find and bind a trace. */
export interface AutoProceedReconcileGroup {
  /** Canonical `grp_<hex>` id; matches the filename prefix. */
  readonly sessionGroupId: string;
  /** Workspace root (absolute) under which `.council/state/` lives. */
  readonly workspaceRoot: string;
  /** Real, non-synthetic Companion sessionId for the orchestrator half. The
   *  reducer's caller must filter out placeholder ids (`__missing_…`) so the
   *  manager's state map never keys on a synthesis. */
  readonly orchestratorSessionId: string;
}

/** Pluggable side-effect surface. Tests substitute fakes; production wires
 *  to `readdirSync`, `readAutoProceedTrace`, and `manager.rehydrate`. */
export interface AutoProceedReconcileDeps {
  /** Enumerate the absolute `<workspaceRoot>/.council/state/` directory. Returns
   *  a discriminated outcome: a missing dir is NOT an error (first run for a
   *  workspace has no traces yet); read errors return `{kind:"read-failed", error}`. */
  readonly listStateFiles: (
    workspaceRoot: string,
  ) => { kind: "ok"; files: string[] } | { kind: "missing" } | { kind: "read-failed"; error: unknown };
  /** Read + validate a trace file. Mirrors the shape of
   *  {@link readAutoProceedTrace}. */
  readonly readTrace: (
    workspaceRoot: string,
    groupId: string,
  ) => { ok: true; value: AutoProceedTrace } | { ok: false; error: AutoProceedTraceReadError };
  /** Idempotent rehydrate of the manager's in-memory state for a given
   *  session. The manager's own implementation cross-checks
   *  `expectedGroupId` against `trace.sessionGroupId` and logs an orphan
   *  skip if they don't match — this reducer doesn't duplicate that check. */
  readonly rehydrate: (
    sessionId: string,
    trace: AutoProceedTrace,
    expectedGroupId: string,
  ) => void;
  /** Structured log sink. EC-9 — fields beyond the canonical set MUST stay
   *  off the wire. */
  readonly logEvent: (entry: AutoProceedReconcileLogEntry) => void;
}

/** Drop reasons surfaced via {@link AutoProceedReconcileDeps.logEvent}. */
export type AutoProceedReconcileDropReason =
  | "readdir-failed"
  | "orphan-filename"
  | "trace-missing"
  | "trace-invalid-json"
  | "trace-invalid-shape"
  | "trace-schema-mismatch"
  | "trace-path-error";

/** Canonical structured log entry. */
export interface AutoProceedReconcileLogEntry {
  readonly event:
    | "auto-proceed.reconcile_rehydrated"
    | "auto-proceed.reconcile_dropped"
    | "auto-proceed.reconcile_completed";
  readonly sessionGroupId?: string;
  readonly sessionId?: string;
  readonly reason?: AutoProceedReconcileDropReason;
  readonly rehydratedGroups?: number;
  readonly droppedTraces?: number;
}

export interface AutoProceedReconcileSummary {
  /** Number of `(group, sessionId)` rehydrate calls made. */
  readonly rehydratedGroups: number;
  /** Number of trace files surfaced as drop reasons. */
  readonly droppedTraces: number;
}

/**
 * Map a {@link AutoProceedTraceReadError} discriminant onto the reducer's
 * coarser drop-reason vocabulary. Keeps the log surface stable when the
 * persistence layer adds new error kinds — a future schema-version
 * variant lands as `trace-schema-mismatch`, not as a new log enum value
 * that downstream alerting has to learn.
 */
function classifyTraceError(error: AutoProceedTraceReadError): AutoProceedReconcileDropReason {
  switch (error.kind) {
    case "missing":
      return "trace-missing";
    case "invalid-json":
      return "trace-invalid-json";
    case "invalid-shape":
      return "trace-invalid-shape";
    case "schema-version-mismatch":
      return "trace-schema-mismatch";
    case "path-error":
      return "trace-path-error";
  }
}

/**
 * The reducer. Pure-by-DI: every side effect (filesystem read, manager
 * mutation, log emit) flows through {@link AutoProceedReconcileDeps}.
 *
 * Per-group loop:
 *  1. List `.council/state/`. Missing dir → silent skip (first run).
 *     Read failure → one structured log + skip this group.
 *  2. Filter files by the canonical trace suffix.
 *  3. For each candidate, check the filename prefix equals the group-id
 *     (anti-orphan guard) before reading the trace.
 *  4. Read + validate the trace. Failure → one structured log + skip.
 *  5. Call rehydrate.
 *
 * Returns the per-call summary so the caller can decide whether to emit
 * a final aggregate log line.
 */
export function reconcileAutoProceedTraces(
  groups: readonly AutoProceedReconcileGroup[],
  deps: AutoProceedReconcileDeps,
): AutoProceedReconcileSummary {
  let rehydratedGroups = 0;
  let droppedTraces = 0;

  for (const g of groups) {
    const listResult = deps.listStateFiles(g.workspaceRoot);
    if (listResult.kind === "missing") continue;
    if (listResult.kind === "read-failed") {
      deps.logEvent({
        event: "auto-proceed.reconcile_dropped",
        sessionGroupId: g.sessionGroupId,
        reason: "readdir-failed",
      });
      continue;
    }

    const traceFiles = listResult.files.filter(
      (f) => f.endsWith(AUTO_PROCEED_TRACE_FILENAME_SUFFIX) && !f.startsWith("."),
    );

    for (const file of traceFiles) {
      const filenamePrefix = file.slice(
        0,
        file.length - AUTO_PROCEED_TRACE_FILENAME_SUFFIX.length,
      );
      if (filenamePrefix !== g.sessionGroupId) {
        deps.logEvent({
          event: "auto-proceed.reconcile_dropped",
          sessionGroupId: g.sessionGroupId,
          reason: "orphan-filename",
        });
        droppedTraces++;
        continue;
      }

      const traceResult = deps.readTrace(g.workspaceRoot, g.sessionGroupId);
      if (!traceResult.ok) {
        deps.logEvent({
          event: "auto-proceed.reconcile_dropped",
          sessionGroupId: g.sessionGroupId,
          reason: classifyTraceError(traceResult.error),
        });
        droppedTraces++;
        continue;
      }

      deps.rehydrate(g.orchestratorSessionId, traceResult.value, g.sessionGroupId);
      deps.logEvent({
        event: "auto-proceed.reconcile_rehydrated",
        sessionGroupId: g.sessionGroupId,
        sessionId: g.orchestratorSessionId,
      });
      rehydratedGroups++;
    }
  }

  if (rehydratedGroups > 0 || droppedTraces > 0) {
    deps.logEvent({
      event: "auto-proceed.reconcile_completed",
      rehydratedGroups,
      droppedTraces,
    });
  }

  return { rehydratedGroups, droppedTraces };
}
