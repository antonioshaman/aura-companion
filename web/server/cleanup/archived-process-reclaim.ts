// AURA-LOCAL
// archived-process-reclaim.ts — periodic reclamation of live CLI
// subprocesses belonging to ARCHIVED sessions.
//
// The gap this closes (distinct from eviction-sweeper.ts):
//
//   eviction-sweeper reclaims the session-store ENTRY (in-memory Map row +
//   on-disk JSON) but ONLY when `state === "exited"` AND the subprocess is
//   already dead (`verifyProcessIdentity !== "match"`). It deliberately
//   RETAINS a row whose Companion-spawned subprocess is still alive — for a
//   non-archived session, killing a matching live process would be a bug.
//
//   But an ARCHIVED session whose process is still alive+matching is exactly
//   the leak: the user closed it, yet `claude --sdk-url` / codex keeps
//   running for weeks (PPID=1, surviving every `KillMode=process` restart).
//   The one-time boot orphan-reaper skips it too — a restored archived
//   session is still `trackedPids` in the launcher, so it isn't an "orphan".
//
// This sweep owns process lifecycle, NOT map/disk reclamation: for each
// archived session the launcher still believes is alive (`state !== "exited"`)
// with a live pid, route through `launcher.kill(sessionId)`. That path
// already does EC-45 identity verification (`shouldSignalPreviousInstancePid`
// → `verifyProcessIdentity`) before SIGTERM→grace→SIGKILL for restart-survived
// pids, and an unconditional kill for in-process handles — so we never
// re-implement signal logic here and never SIGTERM a kernel-reused pid.
// Once killed, the launcher flips `state = "exited"`; the eviction-sweeper
// then reclaims the Map/disk row on a later tick. The two tiers compose.
//
// Enablement: gated on `config.evictionGrace.enabled` — the same operator
// rubicon that governs the eviction tier. `AURA_EVICTION_GRACE_HOURS=0`
// disables all automatic session reclamation, this tier included. No new
// env knob: an archived session is terminal (the user closed it), and the
// daily sweep cadence is itself the grace — a same-day archive→tick collision
// on a 24h interval is not a real re-open race.
//
// EC-9 (structured logs): every event carries `event` + `sessionId` (+ `pid`).
// EC-21 (cleanup-events single source): each reclaimed process records
//   `recordCleanupEvent("archived_process_reclaimed")` — surfaced as
//   `archivedProcessReclaimedLastHour` in the 5-min diagnostic snapshot.
// Backend-TS R6 (snapshot-then-iterate): snapshot the launcher view ONCE per
//   pass; mid-pass Map mutations cannot deflect the iteration.
// Concurrency cap mirrors the eviction sweep — each kill carries up to a 5s
//   SIGTERM grace, so a bounded worker pool keeps a backlog from stretching
//   the tick past the gracefulShutdown budget.

import type { CleanupConfig } from "./cleanup-config.js";
import { recordCleanupEvent } from "./cleanup-events.js";
import { nowMs as defaultNowMs } from "./age-ms.js";
import { log } from "../logger.js";

/** Bounded concurrency for parallel kills. Mirrors the eviction default. */
export const DEFAULT_RECLAIM_CONCURRENCY = 4 as const;

/** Hard ceiling on reclaim concurrency the caller MAY pass. */
export const MAX_RECLAIM_CONCURRENCY = 8 as const;

/**
 * Narrowed view of a launcher session the sweep consults — the subset of
 * {@link SdkSessionInfo} the reclamation predicate reads. Kept local so the
 * sweep does not depend on the launcher's full type.
 */
export interface ReclaimLauncherView {
  readonly sessionId: string;
  readonly pid?: number;
  readonly archived?: boolean;
  readonly state: "starting" | "connected" | "running" | "exited";
}

export interface ReclaimSweepDeps {
  /** Snapshot of the launcher's sessions. Backend-TS R6: taken ONCE per pass. */
  readonly getLauncherSessions: () => ReclaimLauncherView[];
  /**
   * Terminate the session's CLI subprocess. Production binds to
   * `launcher.kill` — which EC-45 identity-verifies restart-survived pids
   * before signalling. Resolves `true` when a process was signalled.
   */
  readonly killSession: (sessionId: string) => Promise<boolean>;
  /** Test seam — clock source. Defaults to the age-ms module clock. */
  readonly nowMs?: () => number;
  /** Test seam — cap parallel kills. Defaults to {@link DEFAULT_RECLAIM_CONCURRENCY}. */
  readonly concurrency?: number;
  /** Test seam — event recorder. Defaults to {@link recordCleanupEvent}. */
  readonly recordEvent?: (kind: "archived_process_reclaimed") => void;
}

export interface ReclaimDecision {
  readonly sessionId: string;
  readonly action:
    | "reclaimed"
    | "skipped_not_archived"
    | "skipped_exited"
    | "skipped_no_pid"
    | "skipped_kill_declined"
    | "error";
  readonly errorCode?: string;
  readonly pid?: number;
}

export interface ReclaimSummary {
  readonly scanned: number;
  readonly reclaimed: number;
  readonly skippedNotArchived: number;
  readonly skippedExited: number;
  readonly skippedNoPid: number;
  readonly skippedKillDeclined: number;
  readonly errors: number;
  readonly decisions: ReadonlyArray<ReclaimDecision>;
  readonly startedAt: number;
  readonly completedAt: number;
}

function emptySummary(scanned: number, startedAt: number, completedAt: number): ReclaimSummary {
  return {
    scanned,
    reclaimed: 0,
    skippedNotArchived: 0,
    skippedExited: 0,
    skippedNoPid: 0,
    skippedKillDeclined: 0,
    errors: 0,
    decisions: [],
    startedAt,
    completedAt,
  };
}

/**
 * Run one archived-process-reclaim tick. Never throws — every per-row failure
 * is captured as `{action:"error", errorCode}` and the sweep continues.
 */
export async function sweepArchivedProcesses(
  config: CleanupConfig,
  deps: ReclaimSweepDeps,
): Promise<ReclaimSummary> {
  const clock = deps.nowMs ?? defaultNowMs;
  const startedAt = clock();
  const record = deps.recordEvent ?? recordCleanupEvent;
  const concurrency = Math.max(
    1,
    Math.min(MAX_RECLAIM_CONCURRENCY, deps.concurrency ?? DEFAULT_RECLAIM_CONCURRENCY),
  );

  // Backend-TS R6 — snapshot ONCE, never iterate the live launcher Map.
  const snapshot = deps.getLauncherSessions();

  if (!config.evictionGrace.enabled) {
    // Same operator rubicon as the eviction tier — reclamation opted out.
    log.info("archived-process-reclaim", "sweep disabled — evictionGrace=0", {
      event: "archived_process_reclaim.sweep.disabled",
      scanned: snapshot.length,
    });
    return emptySummary(snapshot.length, startedAt, clock());
  }

  log.info("archived-process-reclaim", "sweep started", {
    event: "archived_process_reclaim.sweep.started",
    scanned: snapshot.length,
    concurrency,
  });

  const decisions: ReclaimDecision[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= snapshot.length) return;
      // eslint-disable-next-line no-await-in-loop
      decisions.push(await reclaimOne(snapshot[idx], deps, record));
    }
  }
  const workerCount = Math.min(concurrency, snapshot.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);

  const summary: ReclaimSummary = {
    scanned: snapshot.length,
    reclaimed: decisions.filter((d) => d.action === "reclaimed").length,
    skippedNotArchived: decisions.filter((d) => d.action === "skipped_not_archived").length,
    skippedExited: decisions.filter((d) => d.action === "skipped_exited").length,
    skippedNoPid: decisions.filter((d) => d.action === "skipped_no_pid").length,
    skippedKillDeclined: decisions.filter((d) => d.action === "skipped_kill_declined").length,
    errors: decisions.filter((d) => d.action === "error").length,
    decisions,
    startedAt,
    completedAt: clock(),
  };

  log.info("archived-process-reclaim", "sweep completed", {
    event: "archived_process_reclaim.sweep.completed",
    scanned: summary.scanned,
    reclaimed: summary.reclaimed,
    skippedNotArchived: summary.skippedNotArchived,
    skippedExited: summary.skippedExited,
    skippedNoPid: summary.skippedNoPid,
    skippedKillDeclined: summary.skippedKillDeclined,
    errors: summary.errors,
    durationMs: summary.completedAt - summary.startedAt,
  });

  return summary;
}

async function reclaimOne(
  view: ReclaimLauncherView,
  deps: ReclaimSweepDeps,
  record: (kind: "archived_process_reclaimed") => void,
): Promise<ReclaimDecision> {
  const { sessionId } = view;
  if (view.archived !== true) {
    return { sessionId, action: "skipped_not_archived" };
  }
  // `exited` archived rows are the eviction-sweeper's job (Map/disk reclaim);
  // their process is already gone. Splitting responsibility keeps the two
  // tiers non-overlapping — this one only kills still-alive processes.
  if (view.state === "exited") {
    return { sessionId, action: "skipped_exited" };
  }
  if (typeof view.pid !== "number" || view.pid <= 0) {
    return { sessionId, action: "skipped_no_pid" };
  }

  let signalled: boolean;
  try {
    signalled = await deps.killSession(sessionId);
  } catch (e) {
    const err = e as Error;
    log.warn("archived-process-reclaim", "kill threw — leaving row for next tick", {
      event: "archived_process_reclaim.kill_failed",
      sessionId,
      pid: view.pid,
      error_message: err.message,
    });
    return { sessionId, action: "error", errorCode: err.message || "kill_failed" };
  }

  if (!signalled) {
    // launcher.kill declined — the pid's identity failed EC-45 verification
    // (kernel-reused / already dead) OR there was nothing to signal. Safe:
    // the row simply waits for the eviction tier once its state settles.
    return { sessionId, action: "skipped_kill_declined", pid: view.pid };
  }

  record("archived_process_reclaimed");
  log.info("archived-process-reclaim", "archived session process reclaimed", {
    event: "archived_process_reclaim.reclaimed",
    sessionId,
    pid: view.pid,
  });
  return { sessionId, action: "reclaimed", pid: view.pid };
}
