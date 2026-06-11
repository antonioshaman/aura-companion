// AURA-LOCAL
// Sentinel-before-sweep marker writers for the cleanup subsystem.
// PLAN task T4 (sibling of cleanup-paths + cleanup-scheduler).
//
// Three sentinel kinds — each pairs a `write*Marker` (BEFORE acting) with
// a `delete*Marker` (AFTER acting), so a crash between decision and act
// leaves the next reconciliation looking at the marker and resuming
// idempotently per EC-8.
//
//   .evicting           Phase H — session-map eviction sweep.
//                       <sessionRoot>/<ARCHIVED_SESSIONS_SUBDIR>/<sessionId>.evicting
//                       Boot reconcile: finish rename if source still
//                       exists, else delete the orphan marker.
//
//   .reaping/<pid>.json Phase D — PPID=1 orphan reaper.
//                       <sessionRoot>/<REAPING_SENTINEL_SUBDIR>/<pid>.json
//                       Written BEFORE SIGTERM, deleted AFTER confirmed
//                       exit. Boot reconcile: any orphaned marker → next
//                       boot's reaper re-classifies the same pid.
//
//   <tier>.sweep-in-progress  Phase E — daily retention sweep.
//                       <sessionRoot>/<tier>.sweep-in-progress
//                       Written BEFORE first unlink in a tier, deleted
//                       AFTER tier completes. Boot reconcile: enumerate
//                       and resume idempotently.
//
// Every fs touch routes through `resolveCleanupPath` per EC-7 — the
// resolver inlines realpath + bounds-check, so this module's writers
// never reach the filesystem with an un-validated path. The atomic-write
// wrapper handles tmp+rename+fsync per writeAtomicJson contract.
//
// EC-23: log payloads on delete-failure include the marker kind +
// numeric identifiers (sessionId, pid, tier) but NEVER raw path bytes.

import { readdirSync, unlinkSync } from "node:fs";
import { writeAtomicJson } from "../atomic-write.js";
import { log } from "../logger.js";
import {
  ARCHIVED_SESSIONS_SUBDIR,
  EVICTING_SENTINEL_SUFFIX,
  REAPING_SENTINEL_SUBDIR,
  SWEEP_IN_PROGRESS_SUFFIX,
  resolveCleanupPath,
} from "./cleanup-paths.js";

/** Payload for the eviction marker (Phase H). */
export interface EvictingMarkerPayload {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly targetDir: string;
}

/** Payload for the orphan-reap marker (Phase D). */
export interface ReapingMarkerPayload {
  readonly pid: number;
  readonly decisionTs: number;
  readonly reason: string;
}

/** Payload for the sweep-in-progress marker (Phase E). */
export interface SweepInProgressMarkerPayload {
  readonly tier: string;
  readonly startedAt: number;
}

/**
 * Write the `.evicting` marker for `sessionId` under `sessionRoot`. Caller
 * pattern: write → cancel debounce → removeSession → renameSync → fsync
 * → delete marker. Throws on resolver violation OR atomic-write failure
 * — caller MUST NOT proceed with the rename when the marker write failed,
 * since a crash mid-rename without the marker is the silent state-loss
 * mode EC-8 closes.
 */
export function writeEvictingMarker(
  sessionRoot: string,
  sessionId: string,
  payload: EvictingMarkerPayload,
): string {
  const target = resolveCleanupPath(
    sessionRoot,
    `${ARCHIVED_SESSIONS_SUBDIR}/${sessionId}${EVICTING_SENTINEL_SUFFIX}`,
  );
  writeAtomicJson(target, payload);
  return target;
}

/** Best-effort delete; ENOENT is silent (idempotent reconcile-after-resume). */
export function deleteEvictingMarker(sessionRoot: string, sessionId: string): void {
  const target = resolveCleanupPath(
    sessionRoot,
    `${ARCHIVED_SESSIONS_SUBDIR}/${sessionId}${EVICTING_SENTINEL_SUFFIX}`,
  );
  bestEffortUnlink(target, "evicting", { sessionId });
}

/**
 * Write a `.reaping/<pid>.json` orphan-reap marker. Phase D pattern: write
 * marker → mark synthetic intentional-kill → `process.kill(pid, "SIGTERM")`
 * → wait for exit → deleteReapingMarker. A crash between write and SIGTERM
 * leaves the next boot's reaper re-classifying the same pid; if the pid
 * has been reused, the marker is stale (next reconcile prunes it via
 * `verifyProcessIdentity`).
 */
export function writeReapingMarker(
  sessionRoot: string,
  pid: number,
  payload: ReapingMarkerPayload,
): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`writeReapingMarker: invalid pid ${pid}`);
  }
  const target = resolveCleanupPath(sessionRoot, `${REAPING_SENTINEL_SUBDIR}/${pid}.json`);
  writeAtomicJson(target, payload);
  return target;
}

export function deleteReapingMarker(sessionRoot: string, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`deleteReapingMarker: invalid pid ${pid}`);
  }
  const target = resolveCleanupPath(sessionRoot, `${REAPING_SENTINEL_SUBDIR}/${pid}.json`);
  bestEffortUnlink(target, "reaping", { pid });
}

/**
 * Enumerate the pids of all `.reaping/<pid>.json` markers under `sessionRoot`.
 * A missing `.reaping/` dir yields `[]` (the common case — nothing was reaped
 * since the last boot). Filenames whose stem isn't a positive integer are
 * skipped defensively; only `writeReapingMarker` should ever populate the dir.
 */
export function listReapingMarkerPids(sessionRoot: string): number[] {
  const dir = resolveCleanupPath(sessionRoot, REAPING_SENTINEL_SUBDIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return [];
    throw e;
  }
  const pids: number[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const stem = name.slice(0, -".json".length);
    const pid = Number(stem);
    if (Number.isInteger(pid) && pid > 0 && String(pid) === stem) pids.push(pid);
  }
  return pids;
}

export interface ReapingReconcileDeps {
  /** True iff `pid` is a live process. Default: `process.kill(pid, 0)`. */
  readonly isPidLive?: (pid: number) => boolean;
}

/**
 * Boot/periodic reconcile of the `.reaping/` sentinel dir: prune any marker
 * whose pid is no longer live. A live pid is LEFT intact — the marker means a
 * SIGTERM was issued but exit not yet confirmed, and the terminal reaper owns
 * the follow-up (the marker is its sentinel-before-sweep evidence per EC-8).
 *
 * Pruning is by liveness ONLY, not identity. A reused pid (a fresh process
 * inheriting a dead reap-target's pid) keeps the marker until that pid also
 * dies — harmless, because the marker carries no kill authority on its own;
 * the reaper re-derives identity from the terminal sidecar before any SIGTERM.
 */
export function reconcileStaleReapingMarkers(
  sessionRoot: string,
  deps: ReapingReconcileDeps = {},
): { scanned: number; pruned: number } {
  const isPidLive = deps.isPidLive ?? defaultIsPidLive;
  const pids = listReapingMarkerPids(sessionRoot);
  let pruned = 0;
  for (const pid of pids) {
    if (isPidLive(pid)) continue;
    deleteReapingMarker(sessionRoot, pid);
    pruned++;
    log.info("sentinel-markers", "Pruned stale reaping marker (pid no longer live)", {
      event: "cleanup.sentinel.reaping_reconciled",
      pid,
    });
  }
  return { scanned: pids.length, pruned };
}

function defaultIsPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // EPERM = the pid exists but we may not signal it → still live.
    return err.code === "EPERM";
  }
}

/**
 * Write a `<tier>.sweep-in-progress` marker before the first unlink in a
 * retention tier. Phase E pattern: write marker → readdir+stat → unlink
 * loop → delete marker. Crash mid-loop: next boot's reconcile sees the
 * marker, resumes the tier (idempotent because the unlink is for a file
 * matching the same age predicate).
 *
 * `tier` is a short identifier ("sessions", "recordings-soft",
 * "recordings-hard", "logs") — NOT a path. The resolver bounds-checks
 * against `sessionRoot`.
 */
export function writeSweepInProgressMarker(
  sessionRoot: string,
  tier: string,
  payload: SweepInProgressMarkerPayload,
): string {
  if (typeof tier !== "string" || tier.length === 0 || /[\/\\\0]/.test(tier)) {
    throw new Error(`writeSweepInProgressMarker: invalid tier identifier`);
  }
  const target = resolveCleanupPath(sessionRoot, `${tier}${SWEEP_IN_PROGRESS_SUFFIX}`);
  writeAtomicJson(target, payload);
  return target;
}

export function deleteSweepInProgressMarker(sessionRoot: string, tier: string): void {
  if (typeof tier !== "string" || tier.length === 0 || /[\/\\\0]/.test(tier)) {
    throw new Error(`deleteSweepInProgressMarker: invalid tier identifier`);
  }
  const target = resolveCleanupPath(sessionRoot, `${tier}${SWEEP_IN_PROGRESS_SUFFIX}`);
  bestEffortUnlink(target, "sweep-in-progress", { tier });
}

/**
 * ENOENT is the expected case during normal idempotent reconcile — silent.
 * Any other errno surfaces as a structured WARN naming the marker kind
 * and a numeric/string identifier — NEVER the raw path (EC-23).
 */
function bestEffortUnlink(
  target: string,
  marker: "evicting" | "reaping" | "sweep-in-progress",
  context: Record<string, string | number>,
): void {
  try {
    unlinkSync(target);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return;
    log.warn("sentinel-markers", "Failed to delete cleanup marker", {
      event: "cleanup.sentinel.delete_failed",
      marker,
      ...context,
      error_code: err.code ?? "unknown",
    });
  }
}
