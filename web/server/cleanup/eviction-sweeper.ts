// AURA-LOCAL
// eviction-sweeper.ts — session-map eviction sweep. PLAN task T13 (Phase H).
//
// The closing move on the session-map memory-leak story. Phases B + E shipped
// the cadence skeleton + the disk-half retention sweep; Phase H closes the
// memory-half: archived rows whose Companion-spawned subprocess is dead AND
// whose archive grace has elapsed get evicted from `wsBridge.sessions`
// (memory) AND the per-session `<sessionId>.json` gets renamed into
// `<sessionsRoot>/archived/` (disk).
//
// Eviction predicate (every gate MUST hold — order matters for short-circuit):
//
//   archived === true               (operator-flipped via archiveSession)
//   AND state === "exited"          (launcher's own view that the CLI is gone)
//   AND ageMs(archiveMtime) > config.evictionGrace.ms
//                                   (boot-time grace — a session archived 5s ago
//                                    waits at least `evictionGrace` before reclaim
//                                    so a re-mount can race the reaper)
//   AND verifyProcessIdentity(pid, ...) !== "match"
//                                   (Subprocess R6 floor — NEVER evict a row
//                                    whose argv+starttime-verified subprocess
//                                    is alive on the host. A "mismatch" verdict
//                                    means the PID has been reused by an unrelated
//                                    process; eviction is safe. A "gone" verdict
//                                    means the kernel agrees the spawn record's
//                                    PID is dead. "unavailable" (non-Linux dev
//                                    box) — we still evict; the subprocess
//                                    invariant degrades to launcher.state.)
//
// Per-row protocol (IN ORDER — each step is the prereq for the next):
//
//   1. `writeEvictingMarker` writes `<sessionRoot>/archived/<sessionId>.evicting`
//      atomically (tmp+rename+fsync). Marker payload carries `{sessionId,
//      startedAt, targetDir}` so the boot-time reconcile can replay even after
//      power-loss between marker and rename.
//
//   2. `SessionStore.moveToArchive(sessionId)` cancels the per-session
//      debounced `save()` timer FIRST (or a 150ms-late `saveSync` resurrects
//      the JSON at the source path — Debounce-recreate race the spec calls
//      out), then `renameSync` the source JSON into the archive subdir
//      and `fsync`'s the archive directory. EXDEV RETHROWS loudly per
//      Persistence R2 (never fall back to copy+delete).
//
//   3. `wsBridge.removeSession(sessionId)` drops the row from the in-memory
//      Map AND cancels its idle-kill watchdog / browser drain timer / state
//      machine listener / disconnect timer. `store.remove` inside is a
//      silent no-op because the file is already at the archive path.
//
//   4. `deleteEvictingMarker` removes the sentinel. ENOENT-silent.
//
// On any failure mid-step, the marker stays. Next boot's `reconcileEvictionSentinels`
// finishes the rename (idempotent — `moveToArchive` returns `absent` when
// source has moved) and removes the marker.
//
// EC-7 (filesystem-access predicates): every fs touch routes through
//   `resolveCleanupPath` via `writeEvictingMarker` and `SessionStore.moveToArchive`
//   (which `realpathSync`'s + bounds-checks). The sweep itself never
//   constructs a raw path.
//
// EC-8 (sentinel-before-sweep): marker BEFORE rename, deleted AFTER rename
//   succeeds. The boot reconcile is the failure-recovery half of the contract.
//
// EC-9 (structured logs): every event carries `event` + `sessionId` (+
//   `pid` / `errorCode` where applicable). No raw paths.
//
// EC-21 (cleanup-events single source): each successful eviction records
//   `recordCleanupEvent("evicted")` — the projection on `metricsCollector`
//   surfaces `evictedLastHour` in the 5-min diagnostic snapshot.
//
// Backend-TS R6 (snapshot-then-iterate): the sweep snapshots
//   `bridge.getSessionEntries()` ONCE per pass and iterates the array.
//   Mid-pass Map mutations (a new session connect, an unrelated
//   `removeSession`) cannot deflect the iteration.
//
// Concurrency cap: `DEFAULT_EVICTION_CONCURRENCY = 4` parallel
//   `moveToArchive` calls. NOT `Promise.all(snapshot.map(...))` — that
//   would launch O(sessions) parallel fs syscalls on the bun event
//   loop. The bounded worker-pool keeps fd pressure capped so a
//   pathological backlog (1000+ archived rows after a multi-day
//   incident-preservation hold) doesn't stall the bridge's other tick
//   work. The cap is conservative; raising it requires a sustained-load
//   workload + an explicit operator decision.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CleanupConfig } from "./cleanup-config.js";
import {
  ARCHIVED_SESSIONS_SUBDIR,
  EVICTING_SENTINEL_SUFFIX,
} from "./cleanup-paths.js";
import {
  deleteEvictingMarker,
  writeEvictingMarker,
} from "./sentinel-markers.js";
import { recordCleanupEvent } from "./cleanup-events.js";
import { ageMs, nowMs as defaultNowMs } from "./age-ms.js";
import { log } from "../logger.js";
import { readRuntimeSidecar } from "../cli-runtime-sidecar.js";
import {
  verifyProcessIdentity,
  type ProcessIdentityResult,
} from "../process-identity.js";

/** Bounded concurrency for parallel moveToArchive calls. */
export const DEFAULT_EVICTION_CONCURRENCY = 4 as const;

/** Hard ceiling on eviction concurrency the caller MAY pass. */
export const MAX_EVICTION_CONCURRENCY = 8 as const;

/**
 * Narrowed view of a launcher session the sweep consults. Mirrors the
 * subset of {@link SdkSessionInfo} the eviction predicate reads — kept
 * here so the sweep does not depend on the launcher's full type, which
 * would force a circular import through every test seam.
 */
export interface EvictionLauncherView {
  readonly sessionId: string;
  readonly pid?: number;
  readonly archived?: boolean;
  readonly state: "starting" | "connected" | "running" | "exited";
}

/** Bridge surface the sweep needs — three calls only, all read-only or evict. */
export interface EvictionBridgeView {
  /** Snapshot of live sessions Map. Backend-TS R6: never iterate the live Map. */
  getSessionEntries(): Array<[string, unknown]>;
  /** Remove a session from the in-memory Map + cancel its timers. */
  removeSession(sessionId: string): void;
}

/** SessionStore surface the sweep needs. */
export interface EvictionStoreView {
  /** Atomic rename + cancel-debounce. EXDEV THROWS. */
  moveToArchive(sessionId: string): { kind: "moved"; dest: string } | { kind: "absent" };
  /** Absolute path of the session JSON used for the mtime probe. */
  readonly directory: string;
}

/** Optional process-identity probe override — production binds to verifyProcessIdentity. */
export type ProcessIdentityProbe = (
  pid: number,
  sessionId: string,
  expectedStartMs: number | null,
) => ProcessIdentityResult;

export interface EvictionSweepDeps {
  readonly bridge: EvictionBridgeView;
  readonly store: EvictionStoreView;
  /** Resolves the launcher's view per sessionId for the predicate. */
  readonly getLauncherSession: (sessionId: string) => EvictionLauncherView | null;
  /** Pure probe seam. Production binds to {@link verifyProcessIdentity}. */
  readonly probeProcessIdentity?: ProcessIdentityProbe;
  /** Test seam — clock source. Defaults to age-ms module clock. */
  readonly nowMs?: () => number;
  /** Test seam — cap parallel renames. Defaults to {@link DEFAULT_EVICTION_CONCURRENCY}. */
  readonly concurrency?: number;
  /**
   * Optional hook for `setArchived`-aware downstream cleanup, primarily
   * the `IdleTimerManager`. Called BEFORE the rename so a cancelled
   * timer cannot race the evicted row. Production wires
   * `(sid) => idleTimerManager.setArchived(sid)`.
   */
  readonly notifyArchived?: (sessionId: string) => void;
}

export interface EvictionDecision {
  readonly sessionId: string;
  readonly action:
    | "evicted"
    | "skipped_not_archived"
    | "skipped_not_exited"
    | "skipped_within_grace"
    | "skipped_subprocess_alive"
    | "skipped_no_launcher_view"
    | "error";
  readonly errorCode?: string;
  readonly pid?: number;
}

export interface EvictionSummary {
  readonly scanned: number;
  readonly evicted: number;
  readonly retainedAlive: number;
  readonly skippedNotArchived: number;
  readonly skippedNotExited: number;
  readonly skippedWithinGrace: number;
  readonly skippedNoLauncherView: number;
  readonly errors: number;
  readonly decisions: ReadonlyArray<EvictionDecision>;
  readonly startedAt: number;
  readonly completedAt: number;
}

/**
 * Run one eviction-sweep tick. Pure orchestrator over the snapshot
 * iteration + bounded-parallel rename pipeline. Never throws — every
 * per-row failure is captured as `{action:"error", errorCode}` and the
 * sweep continues.
 *
 * Returns a summary the caller MAY log (the diagnostic snapshot reads
 * `evictedLastHour` via `metricsCollector`, not this return shape).
 */
export async function sweepEviction(
  config: CleanupConfig,
  deps: EvictionSweepDeps,
): Promise<EvictionSummary> {
  const clock = deps.nowMs ?? defaultNowMs;
  const startedAt = clock();
  const probe = deps.probeProcessIdentity ?? verifyProcessIdentity;
  const concurrency = Math.max(
    1,
    Math.min(MAX_EVICTION_CONCURRENCY, deps.concurrency ?? DEFAULT_EVICTION_CONCURRENCY),
  );

  // Backend-TS R6 — snapshot ONCE, never iterate live Map across awaits.
  const snapshot = deps.bridge.getSessionEntries();
  const sessionIds = snapshot.map(([sid]) => sid);

  if (!config.evictionGrace.enabled) {
    log.info("eviction-sweeper", "sweep disabled — evictionGrace=0", {
      event: "eviction.sweep.disabled",
      scanned: sessionIds.length,
    });
    return {
      scanned: sessionIds.length,
      evicted: 0,
      retainedAlive: 0,
      skippedNotArchived: 0,
      skippedNotExited: 0,
      skippedWithinGrace: 0,
      skippedNoLauncherView: 0,
      errors: 0,
      decisions: [],
      startedAt,
      completedAt: clock(),
    };
  }
  const graceMs = config.evictionGrace.ms;

  log.info("eviction-sweeper", "sweep started", {
    event: "eviction.sweep.started",
    scanned: sessionIds.length,
    graceMs,
    concurrency,
  });

  // Worker pool: a simple "consumer" pattern over the shared cursor.
  // We avoid Promise.all(map) so a 1000-session backlog stays within
  // `concurrency` parallel fs ops.
  const decisions: EvictionDecision[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= sessionIds.length) return;
      const sessionId = sessionIds[idx];
      const decision = await classifyAndEvictOne(sessionId, {
        config,
        graceMs,
        clock,
        deps,
        probe,
      });
      decisions.push(decision);
    }
  }
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, sessionIds.length);
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);

  const summary: EvictionSummary = {
    scanned: sessionIds.length,
    evicted: decisions.filter((d) => d.action === "evicted").length,
    retainedAlive: decisions.filter((d) => d.action === "skipped_subprocess_alive").length,
    skippedNotArchived: decisions.filter((d) => d.action === "skipped_not_archived").length,
    skippedNotExited: decisions.filter((d) => d.action === "skipped_not_exited").length,
    skippedWithinGrace: decisions.filter((d) => d.action === "skipped_within_grace").length,
    skippedNoLauncherView: decisions.filter((d) => d.action === "skipped_no_launcher_view").length,
    errors: decisions.filter((d) => d.action === "error").length,
    decisions,
    startedAt,
    completedAt: clock(),
  };

  log.info("eviction-sweeper", "sweep completed", {
    event: "eviction.sweep.completed",
    scanned: summary.scanned,
    evicted: summary.evicted,
    retainedAlive: summary.retainedAlive,
    skippedNotArchived: summary.skippedNotArchived,
    skippedNotExited: summary.skippedNotExited,
    skippedWithinGrace: summary.skippedWithinGrace,
    errors: summary.errors,
    durationMs: summary.completedAt - summary.startedAt,
  });

  return summary;
}

interface ClassifyContext {
  readonly config: CleanupConfig;
  readonly graceMs: number;
  readonly clock: () => number;
  readonly deps: EvictionSweepDeps;
  readonly probe: ProcessIdentityProbe;
}

async function classifyAndEvictOne(
  sessionId: string,
  ctx: ClassifyContext,
): Promise<EvictionDecision> {
  const launcherView = ctx.deps.getLauncherSession(sessionId);
  if (!launcherView) {
    // Bridge has a row the launcher doesn't — likely transient state during
    // a relaunch. Skip; the next tick re-checks. Don't evict — we have no
    // archived/state signal to gate on, and the subprocess invariant is
    // unverifiable without a pid.
    return { sessionId, action: "skipped_no_launcher_view" };
  }
  if (launcherView.archived !== true) {
    return { sessionId, action: "skipped_not_archived" };
  }
  if (launcherView.state !== "exited") {
    return { sessionId, action: "skipped_not_exited" };
  }

  // Age check: mtime of the JSON at the source path. setArchived ↦
  // saveSync ↦ writeFileSync updates the mtime; ageMs(mtime) ≈ time
  // since archive.
  const sourcePath = join(ctx.deps.store.directory, `${sessionId}.json`);
  let mtimeMs: number | null = null;
  try {
    if (existsSync(sourcePath)) {
      mtimeMs = statSync(sourcePath).mtimeMs;
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { sessionId, action: "error", errorCode: err.code ?? "stat_failed" };
  }
  // Disk-absent (already-evicted-but-Map-stranded after a mid-tick
  // bridge.removeSession throw, partial restart, or pre-Phase-H legacy
  // row): the JSON is already gone, so there is nothing to age-gate and
  // nothing to move — but the in-memory row is EXACTLY the leak T13 closes.
  // Fall through to the subprocess guard and a Map-only drop (moveToArchive
  // returns {kind:"absent"} ⇒ no rename). Only the disk-PRESENT path is
  // age-gated; a disk-absent row has no fresh-archive grace to honour.
  let age = 0;
  if (mtimeMs !== null) {
    age = ageMs(mtimeMs, ctx.clock());
    if (age <= ctx.graceMs) {
      return { sessionId, action: "skipped_within_grace" };
    }
  }

  // Subprocess invariant — NEVER evict a row whose Companion-spawned
  // subprocess argv+starttime-verifies "match". Sidecar carries the
  // anchor when available; missing-sidecar falls back to the 2-factor
  // probe with `expectedStartMs=null`. "unavailable" (non-Linux dev
  // host) degrades the invariant to launcher.state.exited which we
  // already checked above.
  if (typeof launcherView.pid === "number" && launcherView.pid > 0) {
    let expectedStartMs: number | null = null;
    try {
      const sidecar = readRuntimeSidecar(ctx.deps.store.directory, sessionId);
      if (sidecar.kind === "present") {
        expectedStartMs = sidecar.payload.processStartMs;
      }
    } catch {
      // Sidecar malformed — treat as absent (degraded probe). The Phase D
      // sidecar reader THROWS on corrupt-present per its explicit-intent
      // contract; we degrade here rather than propagate because eviction
      // is best-effort and the launcher.state.exited gate already covers
      // the safety floor.
    }
    let verdict: ProcessIdentityResult;
    try {
      verdict = ctx.probe(launcherView.pid, sessionId, expectedStartMs);
    } catch (e) {
      const err = e as Error;
      return { sessionId, action: "error", errorCode: err.message || "probe_failed" };
    }
    if (verdict.kind === "match") {
      // Subprocess R6 floor — log loud + retain.
      log.warn("eviction-sweeper", "Subprocess alive — retaining archived row", {
        event: "eviction.retained.subprocess_alive",
        sessionId,
        pid: launcherView.pid,
      });
      return {
        sessionId,
        action: "skipped_subprocess_alive",
        pid: launcherView.pid,
      };
    }
    // mismatch | gone | unavailable — fall through to evict.
  }

  // Per-row eviction protocol — IN ORDER, marker BEFORE rename.
  const sessionRoot = ctx.deps.store.directory;
  const startedAt = ctx.clock();
  try {
    writeEvictingMarker(sessionRoot, sessionId, {
      sessionId,
      startedAt,
      targetDir: ARCHIVED_SESSIONS_SUBDIR,
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    log.warn("eviction-sweeper", "marker write failed — skipping row", {
      event: "eviction.marker_write_failed",
      sessionId,
      error_code: err.code ?? "unknown",
    });
    return { sessionId, action: "error", errorCode: err.code ?? "marker_failed" };
  }

  // Notify the idle-timer manager BEFORE the rename so an in-flight
  // synthetic-fire callback can't race the evicted row (Subprocess R6).
  // Idempotent on unknown session — guards the call so a test stub
  // can pass {} without exploding.
  try {
    ctx.deps.notifyArchived?.(sessionId);
  } catch (e) {
    // Best-effort — notification is bookkeeping, not authoritative.
    const err = e as Error;
    log.warn("eviction-sweeper", "notifyArchived hook threw — continuing", {
      event: "eviction.notify_archived_failed",
      sessionId,
      error_message: err.message,
    });
  }

  let moveResult: { kind: "moved"; dest: string } | { kind: "absent" };
  try {
    moveResult = ctx.deps.store.moveToArchive(sessionId);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    log.error("eviction-sweeper", "moveToArchive failed — leaving marker", {
      event: "eviction.move_failed",
      sessionId,
      error_code: err.code ?? "unknown",
    });
    // Marker stays — next boot reconcile picks up; do NOT remove from
    // Map because we couldn't move the disk row, and removing now would
    // produce an in-memory eviction without disk consistency.
    return { sessionId, action: "error", errorCode: err.code ?? "rename_failed" };
  }

  // Map drop happens AFTER the disk rename succeeds. wsBridge.removeSession's
  // internal store.remove is a silent no-op now (the file is at the archive
  // path; ENOENT at the source). The Map drop also cancels idle-kill /
  // disconnect / drain timers on the row — Subprocess R6 floor.
  try {
    ctx.deps.bridge.removeSession(sessionId);
  } catch (e) {
    const err = e as Error;
    log.error("eviction-sweeper", "bridge.removeSession threw — leaving marker", {
      event: "eviction.bridge_remove_failed",
      sessionId,
      error_message: err.message,
    });
    return { sessionId, action: "error", errorCode: "bridge_remove_failed" };
  }

  // Delete marker LAST. ENOENT-silent (idempotent reconcile-after-resume).
  try {
    deleteEvictingMarker(sessionRoot, sessionId);
  } catch (e) {
    // bestEffortUnlink inside the marker module already filters ENOENT,
    // but a non-ENOENT failure ends up here. Log + count error — the
    // Map drop + rename are both already complete; the marker leak is
    // forensic-only and the next boot reconcile prunes it.
    const err = e as NodeJS.ErrnoException;
    log.warn("eviction-sweeper", "marker delete failed — Map+rename already complete", {
      event: "eviction.marker_delete_failed",
      sessionId,
      error_code: err.code ?? "unknown",
    });
  }

  recordCleanupEvent("evicted");

  log.info("eviction-sweeper", "row evicted", {
    event: "eviction.row_evicted",
    sessionId,
    pid: launcherView.pid,
    diskDest: moveResult.kind,
    ageMs: age,
    durationMs: ctx.clock() - startedAt,
  });

  return { sessionId, action: "evicted", pid: launcherView.pid };
}

// ──────────────────────────────────────────────────────────────────────────
// Boot-time reconcile — Phase H's half of the EC-8 sentinel contract.
// Exported for CleanupScheduler wire-in.
// ──────────────────────────────────────────────────────────────────────────

export interface ReconcileSummary {
  readonly sentinels: number;
  readonly resumedRenames: number;
  readonly clearedOrphans: number;
  readonly failures: number;
  readonly tmpOrphansSwept: number;
}

/**
 * Boot-time reconcile of `.evicting` sentinels under `<sessionsRoot>/archived/`
 * AND orphan `.<hex>.tmp` files in the same directory. Called from
 * `CleanupScheduler` at server-init BEFORE the first periodic tick.
 *
 * Per-sentinel action:
 *   • Source `<sessionId>.json` still present in `sessionsRoot` ⇒
 *     `SessionStore.moveToArchive(sessionId)` finishes the rename
 *     idempotently, then deletes the sentinel.
 *   • Source absent ⇒ the previous run completed the rename but crashed
 *     before deleting the sentinel; delete it.
 *
 * Per-tmp file action:
 *   • mtime predates server boot ⇒ orphan from a previous crash;
 *     unlink. mtime ≥ bootTimeMs is left alone — an in-flight
 *     writeAtomicJson currently writing through tmp.
 *
 * Never throws. Per-entry errors are counted in `failures` and logged.
 */
export interface ReconcileDeps {
  readonly store: EvictionStoreView;
  readonly bootTimeMs: number;
  readonly readdir: (path: string) => string[];
  readonly stat: (path: string) => { mtimeMs: number };
  readonly unlink: (path: string) => void;
}

export function reconcileEvictionSentinels(deps: ReconcileDeps): ReconcileSummary {
  const archiveDir = join(deps.store.directory, ARCHIVED_SESSIONS_SUBDIR);
  let sentinels = 0;
  let resumedRenames = 0;
  let clearedOrphans = 0;
  let failures = 0;
  let tmpOrphansSwept = 0;

  let entries: string[];
  try {
    entries = deps.readdir(archiveDir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      // No archive dir yet — nothing to reconcile.
      return { sentinels, resumedRenames, clearedOrphans, failures, tmpOrphansSwept };
    }
    log.warn("eviction-sweeper", "reconcile: readdir failed", {
      event: "eviction.reconcile.readdir_failed",
      error_code: err.code ?? "unknown",
    });
    return { sentinels, resumedRenames, clearedOrphans, failures: 1, tmpOrphansSwept };
  }

  for (const name of entries) {
    // Sentinels: `<sessionId>.evicting`.
    if (name.endsWith(EVICTING_SENTINEL_SUFFIX)) {
      sentinels++;
      const sessionId = name.slice(0, -EVICTING_SENTINEL_SUFFIX.length);
      if (sessionId.length === 0 || sessionId.includes("/") || sessionId.includes("\\")) {
        // Malformed sentinel name — refuse to act on it; surface in failures.
        failures++;
        log.warn("eviction-sweeper", "reconcile: malformed sentinel name", {
          event: "eviction.reconcile.malformed_sentinel",
          name,
        });
        continue;
      }
      try {
        const move = deps.store.moveToArchive(sessionId);
        if (move.kind === "moved") {
          resumedRenames++;
          log.info("eviction-sweeper", "reconcile: resumed rename", {
            event: "eviction.reconcile.rename_resumed",
            sessionId,
          });
        } else {
          clearedOrphans++;
          log.info("eviction-sweeper", "reconcile: orphan sentinel cleared", {
            event: "eviction.reconcile.orphan_cleared",
            sessionId,
          });
        }
        deleteEvictingMarker(deps.store.directory, sessionId);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        failures++;
        log.warn("eviction-sweeper", "reconcile: per-sentinel error", {
          event: "eviction.reconcile.sentinel_failed",
          sessionId,
          error_code: err.code ?? "unknown",
        });
      }
      continue;
    }

    // Orphan tmp files: `.<hex>.tmp` under archived/ from a crashed
    // writeAtomicJson. Delete if older than boot time.
    if (name.startsWith(".") && name.endsWith(".tmp")) {
      const full = join(archiveDir, name);
      try {
        const st = deps.stat(full);
        if (st.mtimeMs < deps.bootTimeMs) {
          deps.unlink(full);
          tmpOrphansSwept++;
          log.info("eviction-sweeper", "reconcile: orphan tmp swept", {
            event: "eviction.reconcile.tmp_orphan_swept",
            name,
          });
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          failures++;
          log.warn("eviction-sweeper", "reconcile: tmp orphan check failed", {
            event: "eviction.reconcile.tmp_orphan_failed",
            name,
            error_code: err.code ?? "unknown",
          });
        }
      }
    }
  }

  log.info("eviction-sweeper", "reconcile pass complete", {
    event: "eviction.reconcile.completed",
    sentinels,
    resumedRenames,
    clearedOrphans,
    failures,
    tmpOrphansSwept,
  });

  return { sentinels, resumedRenames, clearedOrphans, failures, tmpOrphansSwept };
}
