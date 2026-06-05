// AURA-LOCAL
// retention-sweeper.ts — daily 4-tier retention sweep. PLAN task T9.
//
// Tiers (in dispatch order — sequential, NEVER Promise.all):
//   1. sessions        ~/.companion/sessions/archived/*.json   past archiveTtl       → unlinkSync
//   2. recordings-soft ~/.companion/recordings/*.jsonl         past recordingsSoftTtl→ moveToArchive into archived-recordings/
//   3. recordings-hard ~/.companion/recordings/archived-recordings/*.jsonl past recordingsHardTtl → unlinkSync
//                      (EXCEPT archived-recordings/fixtures/ subtree per Willison R1)
//   4. logs            ~/.companion/logs/*.log                 past logsTtl          → unlinkSync
//
// Per-tier invariants (each codified in retention-sweeper.test.ts):
//   • `readdirSync` ONCE per tier, then per-entry `lstatSync` (symlink detect) +
//     `statSync` (mtime). Sort ascending by mtime — oldest victims first so a
//     residual cap leaves freshest survivors.
//   • Process serially (no `Promise.all`) — parallel unlink/rename pegs the
//     event loop and opens unbounded FDs on slow disks (Persistence R6 floor).
//   • Cap entries-per-pass at `DEFAULT_MAX_ENTRIES_PER_PASS=1000`; log residual
//     count so the operator sees backlog growth before it bites.
//   • Each unlink/rename path routes through `resolveCleanupPath` (EC-7 realpath
//     + bounds check). A traversal-shaped or symlink-shaped filename is
//     rejected before the syscall.
//   • Symlinks → ALWAYS rejected (lstat.isSymbolicLink()). Removing a symlink
//     from the recordings tree could shred an unrelated path the user pointed
//     it at.
//   • Recording tiers consult `getActiveRecordingPaths()` and skip currently-
//     open files. Unlinking an open file on Linux silently loses the recording
//     (the fd stays valid; the inode is unreachable after the last writer
//     closes). Logs tier consults the symmetric `getActiveLogPaths`.
//   • `.hold` sentinel under recordings root → ALL recording-tier deletes
//     skipped + `retention.skipped_hold` logged. Operator-facing
//     incident-preservation escape hatch (Hunt R6).
//   • Tier 3 enumeration is non-recursive AND skips dir-typed entries — the
//     `fixtures/` subdir is structurally invisible to the unlink loop. Belt +
//     braces: any resolved path that includes a `fixtures` segment is also
//     explicitly skipped and counted as `skippedFixture` (Willison R1).
//   • Each per-entry failure logs `retention.entry_failed` with the redacted
//     identifier (no raw path bytes — EC-23) and continues the sweep. One bad
//     file MUST NOT stop the tier.
//
// EC-8 sentinel-before-sweep:
//   Each tier writes `<sentinelRoot>/<tier>.sweep-in-progress` BEFORE its first
//   filesystem mutation, deletes AFTER the tier completes. Boot-time reconcile
//   (Phase H carries the matching pattern + enumerates orphan sentinels) sees
//   the marker and knows a previous run crashed mid-tier — the next run resumes
//   the same age predicate against the same root, so the unlink is idempotent.
//   Sentinel is SKIPPED when there is zero work this pass to avoid noise.
//
// EC-9 structured logs: every emitted line carries an `event` field
//   (`retention.tier.started`, `retention.tier.completed`, `retention.tier.disabled`,
//   `retention.skipped_hold`, `retention.entry_failed`, `retention.symlink_skipped`,
//   `retention.active_skipped`, `retention.cap_reached`, `retention.skipped_fixture`,
//   `retention.readdir_failed`, `retention.sentinel_write_failed`,
//   `retention.dest_dir_failed`).
//
// EC-21 cleanup-events single source of truth:
//   recordings-soft tier records `recordings_soft_archived`; recordings-hard
//   tier records `recordings_hard_deleted`. The sessions + logs tiers do NOT
//   have per-event counters — their cadence is observable via
//   `lastSweepDurationMs` and the per-tier `succeeded` field in the returned
//   summary.

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { CleanupConfig, DurationConfig } from "./cleanup-config.js";
import {
  ARCHIVED_RECORDINGS_SUBDIR,
  ARCHIVED_SESSIONS_SUBDIR,
  RECORDINGS_HOLD_SENTINEL,
  resolveCleanupPath,
} from "./cleanup-paths.js";
import {
  deleteSweepInProgressMarker,
  writeSweepInProgressMarker,
} from "./sentinel-markers.js";
import { recordCleanupEvent } from "./cleanup-events.js";
import { ageMs, nowMs as defaultNowMs } from "./age-ms.js";
import { log } from "../logger.js";

/** Hard cap on entries processed per tier per pass. */
export const DEFAULT_MAX_ENTRIES_PER_PASS = 1000;

const FIXTURES_SUBDIR = "fixtures";

export type RetentionTier =
  | "sessions"
  | "recordings-soft"
  | "recordings-hard"
  | "logs";

export interface RetentionSweepRoots {
  readonly sessionsRoot: string;
  readonly recordingsRoot: string;
  readonly logsRoot: string;
  readonly sentinelRoot: string;
}

export interface RetentionSweepDeps {
  readonly getActiveRecordingPaths?: () => Set<string>;
  readonly getActiveLogPaths?: () => Set<string>;
  readonly nowMs?: () => number;
  readonly maxEntriesPerPass?: number;
}

export interface TierSummary {
  readonly tier: RetentionTier;
  readonly enabled: boolean;
  readonly holdActive: boolean;
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skippedActive: number;
  readonly skippedFixture: number;
  readonly skippedSymlink: number;
  readonly skippedDirectory: number;
  readonly residual: number;
  readonly durationMs: number;
  readonly enumerateError?: string;
}

export interface SweepSummary {
  readonly tiers: ReadonlyArray<TierSummary>;
  readonly startedAt: number;
  readonly completedAt: number;
}

/**
 * Run all four retention tiers serially. Pure orchestration — each tier is a
 * self-contained call that catches its own errors and returns a summary.
 *
 * Marked `async` for forward-compat; current internals are synchronous.
 */
export async function sweepRetention(
  config: CleanupConfig,
  roots: RetentionSweepRoots,
  deps: RetentionSweepDeps = {},
): Promise<SweepSummary> {
  const clock = deps.nowMs ?? defaultNowMs;
  const max = deps.maxEntriesPerPass ?? DEFAULT_MAX_ENTRIES_PER_PASS;
  const startedAt = clock();

  const holdActive = recordingsHoldActive(roots.recordingsRoot);

  const tiers: TierSummary[] = [];
  tiers.push(
    runSessionsTier({
      ttl: config.archiveTtl,
      sessionsRoot: roots.sessionsRoot,
      sentinelRoot: roots.sentinelRoot,
      clock,
      max,
    }),
  );
  tiers.push(
    runRecordingsSoftTier({
      ttl: config.recordingsSoftTtl,
      recordingsRoot: roots.recordingsRoot,
      sentinelRoot: roots.sentinelRoot,
      clock,
      max,
      holdActive,
      getActiveRecordingPaths: deps.getActiveRecordingPaths,
    }),
  );
  tiers.push(
    runRecordingsHardTier({
      ttl: config.recordingsHardTtl,
      recordingsRoot: roots.recordingsRoot,
      sentinelRoot: roots.sentinelRoot,
      clock,
      max,
      holdActive,
      getActiveRecordingPaths: deps.getActiveRecordingPaths,
    }),
  );
  tiers.push(
    runLogsTier({
      ttl: config.logsTtl,
      logsRoot: roots.logsRoot,
      sentinelRoot: roots.sentinelRoot,
      clock,
      max,
      getActiveLogPaths: deps.getActiveLogPaths,
    }),
  );

  return { tiers, startedAt, completedAt: clock() };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-tier dispatchers
// ──────────────────────────────────────────────────────────────────────────

interface SessionsTierArgs {
  ttl: DurationConfig;
  sessionsRoot: string;
  sentinelRoot: string;
  clock: () => number;
  max: number;
}

function runSessionsTier(args: SessionsTierArgs): TierSummary {
  const tier: RetentionTier = "sessions";
  const startedAt = args.clock();
  if (!args.ttl.enabled) {
    emitTierDisabled(tier);
    return zeroSummary(tier, false, false, args.clock() - startedAt);
  }
  const archivedDir = safeJoin(args.sessionsRoot, ARCHIVED_SESSIONS_SUBDIR);
  return runDeleteTier({
    tier,
    enumerateRoot: archivedDir,
    sentinelRoot: args.sentinelRoot,
    ttlMs: args.ttl.ms,
    clock: args.clock,
    max: args.max,
    matchFilename: (name) => name.endsWith(".json"),
    activePaths: undefined,
    fixtureGuard: false,
    holdActive: false,
    eventKind: null,
  });
}

interface RecordingsSoftTierArgs {
  ttl: DurationConfig;
  recordingsRoot: string;
  sentinelRoot: string;
  clock: () => number;
  max: number;
  holdActive: boolean;
  getActiveRecordingPaths?: () => Set<string>;
}

function runRecordingsSoftTier(args: RecordingsSoftTierArgs): TierSummary {
  const tier: RetentionTier = "recordings-soft";
  const startedAt = args.clock();
  if (!args.ttl.enabled) {
    emitTierDisabled(tier);
    return zeroSummary(tier, false, args.holdActive, args.clock() - startedAt);
  }
  if (args.holdActive) {
    log.info("retention-sweeper", "Recordings tier skipped — .hold sentinel present", {
      event: "retention.skipped_hold",
      tier,
    });
    return zeroSummary(tier, true, true, args.clock() - startedAt);
  }
  return runMoveTier({
    tier,
    enumerateRoot: args.recordingsRoot,
    sentinelRoot: args.sentinelRoot,
    destSubdir: ARCHIVED_RECORDINGS_SUBDIR,
    ttlMs: args.ttl.ms,
    clock: args.clock,
    max: args.max,
    matchFilename: (name) => name.endsWith(".jsonl"),
    activePaths: args.getActiveRecordingPaths?.(),
    eventKind: "recordings_soft_archived",
  });
}

interface RecordingsHardTierArgs {
  ttl: DurationConfig;
  recordingsRoot: string;
  sentinelRoot: string;
  clock: () => number;
  max: number;
  holdActive: boolean;
  getActiveRecordingPaths?: () => Set<string>;
}

function runRecordingsHardTier(args: RecordingsHardTierArgs): TierSummary {
  const tier: RetentionTier = "recordings-hard";
  const startedAt = args.clock();
  if (!args.ttl.enabled) {
    emitTierDisabled(tier);
    return zeroSummary(tier, false, args.holdActive, args.clock() - startedAt);
  }
  if (args.holdActive) {
    log.info("retention-sweeper", "Recordings tier skipped — .hold sentinel present", {
      event: "retention.skipped_hold",
      tier,
    });
    return zeroSummary(tier, true, true, args.clock() - startedAt);
  }
  const hardRoot = safeJoin(args.recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR);
  return runDeleteTier({
    tier,
    enumerateRoot: hardRoot,
    sentinelRoot: args.sentinelRoot,
    ttlMs: args.ttl.ms,
    clock: args.clock,
    max: args.max,
    matchFilename: (name) => name.endsWith(".jsonl"),
    activePaths: args.getActiveRecordingPaths?.(),
    fixtureGuard: true,
    holdActive: true,
    eventKind: "recordings_hard_deleted",
  });
}

interface LogsTierArgs {
  ttl: DurationConfig;
  logsRoot: string;
  sentinelRoot: string;
  clock: () => number;
  max: number;
  getActiveLogPaths?: () => Set<string>;
}

function runLogsTier(args: LogsTierArgs): TierSummary {
  const tier: RetentionTier = "logs";
  const startedAt = args.clock();
  if (!args.ttl.enabled) {
    emitTierDisabled(tier);
    return zeroSummary(tier, false, false, args.clock() - startedAt);
  }
  return runDeleteTier({
    tier,
    enumerateRoot: args.logsRoot,
    sentinelRoot: args.sentinelRoot,
    ttlMs: args.ttl.ms,
    clock: args.clock,
    max: args.max,
    matchFilename: (name) => name.endsWith(".log"),
    activePaths: args.getActiveLogPaths?.(),
    fixtureGuard: false,
    holdActive: false,
    eventKind: null,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Generic delete-tier + move-tier
// ──────────────────────────────────────────────────────────────────────────

interface CandidateEntry {
  readonly absPath: string;
  readonly name: string;
  readonly mtimeMs: number;
}

interface EnumerationResult {
  readonly entries: CandidateEntry[];
  readonly skippedSymlink: number;
  readonly skippedDirectory: number;
  readonly enumerateError?: string;
}

interface DeleteTierArgs {
  tier: RetentionTier;
  enumerateRoot: string;
  sentinelRoot: string;
  ttlMs: number;
  clock: () => number;
  max: number;
  matchFilename: (name: string) => boolean;
  activePaths?: Set<string>;
  fixtureGuard: boolean;
  holdActive: boolean;
  eventKind:
    | "evicted"
    | "orphan_reaped"
    | "drained_pending"
    | "recordings_soft_archived"
    | "recordings_hard_deleted"
    | null;
}

function runDeleteTier(args: DeleteTierArgs): TierSummary {
  const startedAt = args.clock();
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedActive = 0;
  let skippedFixture = 0;

  log.info("retention-sweeper", "Tier started", {
    event: "retention.tier.started",
    tier: args.tier,
    ttlMs: args.ttlMs,
    enumerateRoot_present: existsSync(args.enumerateRoot),
  });

  const enumeration = enumerateAndFilter({
    root: args.enumerateRoot,
    matchFilename: args.matchFilename,
    clock: args.clock,
    ttlMs: args.ttlMs,
    tier: args.tier,
  });

  const cappedCount = Math.min(args.max, enumeration.entries.length);
  const residual = enumeration.entries.length - cappedCount;
  if (residual > 0) {
    log.warn("retention-sweeper", "Tier cap reached — residual entries deferred to next pass", {
      event: "retention.cap_reached",
      tier: args.tier,
      cap: args.max,
      residual,
    });
  }

  // Sentinel-before-sweep (EC-8). Skipped when there is no work this pass.
  let sentinelWritten = false;
  if (cappedCount > 0) {
    try {
      writeSweepInProgressMarker(args.sentinelRoot, args.tier, {
        tier: args.tier,
        startedAt,
      });
      sentinelWritten = true;
    } catch (err) {
      log.warn("retention-sweeper", "sentinel write failed — aborting tier", {
        event: "retention.sentinel_write_failed",
        tier: args.tier,
        error_message: err instanceof Error ? err.message : String(err),
      });
      return {
        tier: args.tier,
        enabled: true,
        holdActive: args.holdActive,
        processed: 0,
        succeeded: 0,
        failed: 0,
        skippedActive: 0,
        skippedFixture: 0,
        skippedSymlink: enumeration.skippedSymlink,
        skippedDirectory: enumeration.skippedDirectory,
        residual: enumeration.entries.length,
        durationMs: args.clock() - startedAt,
        enumerateError: enumeration.enumerateError,
      };
    }
  }

  for (let i = 0; i < cappedCount; i++) {
    const entry = enumeration.entries[i];

    if (args.fixtureGuard && pathInFixturesSubtree(entry.absPath)) {
      skippedFixture++;
      processed++;
      log.info("retention-sweeper", "Skipping fixtures-subtree entry", {
        event: "retention.skipped_fixture",
        tier: args.tier,
        name: entry.name,
      });
      continue;
    }

    if (args.activePaths && args.activePaths.has(entry.absPath)) {
      skippedActive++;
      processed++;
      log.info("retention-sweeper", "Skipping currently-open file", {
        event: "retention.active_skipped",
        tier: args.tier,
        name: entry.name,
      });
      continue;
    }

    try {
      unlinkSync(entry.absPath);
      succeeded++;
      processed++;
      if (args.eventKind) recordCleanupEvent(args.eventKind);
    } catch (err) {
      failed++;
      processed++;
      const e = err as NodeJS.ErrnoException;
      log.warn("retention-sweeper", "Entry delete failed", {
        event: "retention.entry_failed",
        tier: args.tier,
        name: entry.name,
        error_code: e.code ?? "unknown",
      });
    }
  }

  if (sentinelWritten) {
    deleteSweepInProgressMarker(args.sentinelRoot, args.tier);
  }

  const durationMs = args.clock() - startedAt;
  log.info("retention-sweeper", "Tier completed", {
    event: "retention.tier.completed",
    tier: args.tier,
    processed,
    succeeded,
    failed,
    skippedActive,
    skippedFixture,
    skippedSymlink: enumeration.skippedSymlink,
    skippedDirectory: enumeration.skippedDirectory,
    residual,
    durationMs,
  });

  return {
    tier: args.tier,
    enabled: true,
    holdActive: args.holdActive,
    processed,
    succeeded,
    failed,
    skippedActive,
    skippedFixture,
    skippedSymlink: enumeration.skippedSymlink,
    skippedDirectory: enumeration.skippedDirectory,
    residual,
    durationMs,
    enumerateError: enumeration.enumerateError,
  };
}

interface MoveTierArgs {
  tier: RetentionTier;
  enumerateRoot: string;
  sentinelRoot: string;
  destSubdir: string;
  ttlMs: number;
  clock: () => number;
  max: number;
  matchFilename: (name: string) => boolean;
  activePaths?: Set<string>;
  eventKind: "recordings_soft_archived";
}

function runMoveTier(args: MoveTierArgs): TierSummary {
  const startedAt = args.clock();
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedActive = 0;

  log.info("retention-sweeper", "Tier started", {
    event: "retention.tier.started",
    tier: args.tier,
    ttlMs: args.ttlMs,
    enumerateRoot_present: existsSync(args.enumerateRoot),
  });

  const enumeration = enumerateAndFilter({
    root: args.enumerateRoot,
    matchFilename: args.matchFilename,
    clock: args.clock,
    ttlMs: args.ttlMs,
    tier: args.tier,
  });

  const cappedCount = Math.min(args.max, enumeration.entries.length);
  const residual = enumeration.entries.length - cappedCount;
  if (residual > 0) {
    log.warn("retention-sweeper", "Tier cap reached — residual entries deferred to next pass", {
      event: "retention.cap_reached",
      tier: args.tier,
      cap: args.max,
      residual,
    });
  }

  let sentinelWritten = false;
  if (cappedCount > 0) {
    try {
      writeSweepInProgressMarker(args.sentinelRoot, args.tier, {
        tier: args.tier,
        startedAt,
      });
      sentinelWritten = true;
    } catch (err) {
      log.warn("retention-sweeper", "sentinel write failed — aborting tier", {
        event: "retention.sentinel_write_failed",
        tier: args.tier,
        error_message: err instanceof Error ? err.message : String(err),
      });
      return {
        tier: args.tier,
        enabled: true,
        holdActive: false,
        processed: 0,
        succeeded: 0,
        failed: 0,
        skippedActive: 0,
        skippedFixture: 0,
        skippedSymlink: enumeration.skippedSymlink,
        skippedDirectory: enumeration.skippedDirectory,
        residual: enumeration.entries.length,
        durationMs: args.clock() - startedAt,
        enumerateError: enumeration.enumerateError,
      };
    }
  }

  // Lazy dest-dir creation — only when we have work.
  let destDirEnsured = false;
  const ensureDestDir = (): string | null => {
    try {
      const destDir = resolveCleanupPath(args.enumerateRoot, args.destSubdir);
      if (!destDirEnsured) {
        mkdirSync(destDir, { recursive: true, mode: 0o700 });
        destDirEnsured = true;
      }
      return destDir;
    } catch (err) {
      log.warn("retention-sweeper", "dest dir resolution failed", {
        event: "retention.dest_dir_failed",
        tier: args.tier,
        error_message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  for (let i = 0; i < cappedCount; i++) {
    const entry = enumeration.entries[i];

    if (args.activePaths && args.activePaths.has(entry.absPath)) {
      skippedActive++;
      processed++;
      log.info("retention-sweeper", "Skipping currently-open file", {
        event: "retention.active_skipped",
        tier: args.tier,
        name: entry.name,
      });
      continue;
    }

    const destDir = ensureDestDir();
    if (!destDir) {
      failed++;
      processed++;
      continue;
    }

    let destPath: string;
    try {
      destPath = resolveCleanupPath(args.enumerateRoot, `${args.destSubdir}/${entry.name}`);
    } catch (err) {
      failed++;
      processed++;
      log.warn("retention-sweeper", "Entry dest resolution failed", {
        event: "retention.entry_failed",
        tier: args.tier,
        name: entry.name,
        error_code: "EC7_REJECT",
        error_message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    try {
      renameSync(entry.absPath, destPath);
      succeeded++;
      processed++;
      recordCleanupEvent(args.eventKind);
    } catch (err) {
      failed++;
      processed++;
      const e = err as NodeJS.ErrnoException;
      log.warn("retention-sweeper", "Entry rename failed", {
        event: "retention.entry_failed",
        tier: args.tier,
        name: entry.name,
        error_code: e.code ?? "unknown",
      });
    }
  }

  if (sentinelWritten) {
    deleteSweepInProgressMarker(args.sentinelRoot, args.tier);
  }

  const durationMs = args.clock() - startedAt;
  log.info("retention-sweeper", "Tier completed", {
    event: "retention.tier.completed",
    tier: args.tier,
    processed,
    succeeded,
    failed,
    skippedActive,
    skippedFixture: 0,
    skippedSymlink: enumeration.skippedSymlink,
    skippedDirectory: enumeration.skippedDirectory,
    residual,
    durationMs,
  });

  return {
    tier: args.tier,
    enabled: true,
    holdActive: false,
    processed,
    succeeded,
    failed,
    skippedActive,
    skippedFixture: 0,
    skippedSymlink: enumeration.skippedSymlink,
    skippedDirectory: enumeration.skippedDirectory,
    residual,
    durationMs,
    enumerateError: enumeration.enumerateError,
  };
}

interface EnumerateArgs {
  root: string;
  matchFilename: (name: string) => boolean;
  clock: () => number;
  ttlMs: number;
  tier: RetentionTier;
}

function enumerateAndFilter(args: EnumerateArgs): EnumerationResult {
  const entries: CandidateEntry[] = [];
  let skippedSymlink = 0;
  let skippedDirectory = 0;
  let enumerateError: string | undefined;

  let names: string[];
  try {
    names = readdirSync(args.root);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // ENOENT is the expected case on a fresh install before the dir is
    // created — silent (the tier is a no-op).
    if (e.code !== "ENOENT") {
      log.warn("retention-sweeper", "Tier readdir failed", {
        event: "retention.readdir_failed",
        tier: args.tier,
        error_code: e.code ?? "unknown",
      });
      enumerateError = e.code ?? e.message;
    }
    return { entries, skippedSymlink, skippedDirectory, enumerateError };
  }

  const now = args.clock();

  for (const name of names) {
    if (!args.matchFilename(name)) continue;

    // lstat the RAW path BEFORE resolveCleanupPath so symlinks are
    // detected against the entry itself, not the symlink's realpath
    // target. resolveCleanupPath collapses symlinks via realpathSync
    // which would otherwise mask a .jsonl that's actually a link
    // into the recordings tree from an external path.
    const directPath = join(args.root, name);
    let lstat: ReturnType<typeof lstatSync>;
    try {
      lstat = lstatSync(directPath);
    } catch {
      continue;
    }

    if (lstat.isSymbolicLink()) {
      skippedSymlink++;
      log.warn("retention-sweeper", "Skipping symlink (EC-7 reject)", {
        event: "retention.symlink_skipped",
        tier: args.tier,
        name,
      });
      continue;
    }
    if (lstat.isDirectory()) {
      skippedDirectory++;
      continue;
    }
    if (!lstat.isFile()) continue;

    let absPath: string;
    try {
      absPath = resolveCleanupPath(args.root, name);
    } catch (err) {
      log.warn("retention-sweeper", "Entry resolve rejected", {
        event: "retention.entry_failed",
        tier: args.tier,
        name,
        error_code: "EC7_REJECT",
        error_message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let mtimeMs: number;
    try {
      const s = statSync(absPath);
      mtimeMs = s.mtimeMs;
    } catch {
      continue;
    }

    if (ageMs(mtimeMs, now) <= args.ttlMs) continue;

    entries.push({ absPath, name, mtimeMs });
  }

  // Oldest first — the cap drops freshest victims when budget is tight.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  return { entries, skippedSymlink, skippedDirectory, enumerateError };
}

// ──────────────────────────────────────────────────────────────────────────
// Small helpers
// ──────────────────────────────────────────────────────────────────────────

function emitTierDisabled(tier: RetentionTier): void {
  log.info("retention-sweeper", "Tier disabled — TTL knob is `0`", {
    event: "retention.tier.disabled",
    tier,
  });
}

function zeroSummary(
  tier: RetentionTier,
  enabled: boolean,
  holdActive: boolean,
  durationMs: number,
): TierSummary {
  return {
    tier,
    enabled,
    holdActive,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skippedActive: 0,
    skippedFixture: 0,
    skippedSymlink: 0,
    skippedDirectory: 0,
    residual: 0,
    durationMs,
  };
}

function recordingsHoldActive(recordingsRoot: string): boolean {
  try {
    const probe = resolveCleanupPath(recordingsRoot, RECORDINGS_HOLD_SENTINEL);
    return existsSync(probe);
  } catch {
    return false;
  }
}

function safeJoin(root: string, subdir: string): string {
  try {
    return resolveCleanupPath(root, subdir);
  } catch {
    return join(root, subdir);
  }
}

/** True when the resolved absolute path includes a `fixtures` segment
 *  anywhere — defence in depth beyond the non-recursive directory skip.
 *  Substring matches like `my-fixtures/...` are NOT caught: the brief
 *  carves out the `fixtures/` SUBDIR name, not a substring. */
function pathInFixturesSubtree(absPath: string): boolean {
  const segments = absPath.split(/[\\/]/);
  return segments.includes(FIXTURES_SUBDIR);
}
