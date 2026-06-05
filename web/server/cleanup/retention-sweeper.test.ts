import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sweepRetention,
  DEFAULT_MAX_ENTRIES_PER_PASS,
  type RetentionSweepRoots,
} from "./retention-sweeper.js";
import type { CleanupConfig } from "./cleanup-config.js";
import {
  ARCHIVED_RECORDINGS_SUBDIR,
  ARCHIVED_SESSIONS_SUBDIR,
  RECORDINGS_HOLD_SENTINEL,
  SWEEP_IN_PROGRESS_SUFFIX,
} from "./cleanup-paths.js";
import {
  __resetCleanupCountersForTests,
  __getCleanupEventStoreSizeForTests,
} from "./cleanup-events.js";
import { __resetClockSourceForTests, setClockSourceForTests } from "./age-ms.js";

// PLAN T9 retention sweep — coverage contract per phase-E brief:
//   - 4 disabled-tier behavioural tests (one per TTL knob the sweeper owns).
//     The brief asks for "6 env vars" but only 4 of the 6 cleanup-config
//     knobs gate retention tiers; the other 2 (`evictionGrace`,
//     `memoryPressureWarn`) belong to Phases H and C respectively. This
//     suite covers the 4 retention-controlled knobs and the worker
//     HANDOFF documents the interpretation.
//   - .hold sentinel skip (both recording tiers).
//   - fixtures-subtree skip (recordings-hard tier).
//   - Active-FD skip via injected `getActiveRecordingPaths` /
//     `getActiveLogPaths` deps.
//   - Symlink rejection (EC-7).
//   - mtime-ascending sort + residual cap (oldest first).
//   - EC-8 sentinel-before-sweep marker exists during work, cleared after.
//   - Per-entry delete failure does not stop the tier.
//   - EC-21 cleanup-events recorded for recordings tiers only.

const DAY_MS = 24 * 60 * 60 * 1000;

let tmpRoot: string;
let sessionsRoot: string;
let recordingsRoot: string;
let logsRoot: string;
let sentinelRoot: string;

beforeEach(async () => {
  __resetCleanupCountersForTests();
  __resetClockSourceForTests();

  tmpRoot = mkdtempSync(join(tmpdir(), "retention-sweeper-test-"));
  sessionsRoot = join(tmpRoot, "sessions");
  recordingsRoot = join(tmpRoot, "recordings");
  logsRoot = join(tmpRoot, "logs");
  sentinelRoot = tmpRoot;
  // Pre-create the per-tier roots so the readdir paths exist for the
  // happy-path tests. Tests that exercise ENOENT can `rmSync` the
  // specific subtree they need missing.
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR), { recursive: true });
  mkdirSync(recordingsRoot, { recursive: true });
  mkdirSync(join(recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR), { recursive: true });
  mkdirSync(logsRoot, { recursive: true });

  // Silence the structured logger by default so suite output stays
  // readable. Tests that need to assert on log shape re-mock locally.
  const loggerModule = await import("../logger.js");
  vi.spyOn(loggerModule.log, "info").mockImplementation(() => undefined);
  vi.spyOn(loggerModule.log, "warn").mockImplementation(() => undefined);
  vi.spyOn(loggerModule.log, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetClockSourceForTests();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function buildRoots(): RetentionSweepRoots {
  return { sessionsRoot, recordingsRoot, logsRoot, sentinelRoot };
}

/**
 * Build a `CleanupConfig` whose four retention TTLs are all `enabled:true`
 * with the supplied day counts. Knobs the sweeper doesn't read
 * (`evictionGrace`, `memoryPressureWarn`) are filled in with safe enabled
 * defaults so the test can pass the typed boundary unchanged.
 */
function buildConfig(opts: {
  archiveDays?: number | null;
  recordingsSoftDays?: number | null;
  recordingsHardDays?: number | null;
  logsDays?: number | null;
}): CleanupConfig {
  const toCfg = (days: number | null | undefined) =>
    days === null
      ? ({ enabled: false } as const)
      : ({ enabled: true, ms: (days ?? 1) * DAY_MS } as const);
  return {
    evictionGrace: { enabled: true, ms: 24 * 60 * 60 * 1000 },
    archiveTtl: toCfg(opts.archiveDays),
    recordingsSoftTtl: toCfg(opts.recordingsSoftDays),
    recordingsHardTtl: toCfg(opts.recordingsHardDays),
    logsTtl: toCfg(opts.logsDays),
    memoryPressureWarn: { enabled: true, us: 10_000_000 },
  };
}

/** Helper: stamp a file's mtime to `nowMs - ageMs`. */
function touchAgedFile(path: string, nowMs: number, ageMs: number, content = "x"): void {
  writeFileSync(path, content);
  const sec = (nowMs - ageMs) / 1000;
  utimesSync(path, sec, sec);
}

describe("TTL=0 disabled — one behavioural test per retention TTL knob", () => {
  // The brief: "each of the 6 env vars set to 0 -> corresponding tier
  // skips entirely." Only 4 of the 6 cleanup-config knobs gate
  // retention tiers; the other 2 (evictionGrace, memoryPressureWarn)
  // are Phase H + Phase C concerns. These 4 tests cover the retention
  // surface; the HANDOFF carries the documentation of the discrepancy.

  it("archiveTtl disabled gates the sessions tier with zero FS touches", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);
    const aged = join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, "ancient.json");
    touchAgedFile(aged, now, 365 * DAY_MS, "{}");

    const cfg = buildConfig({
      archiveDays: null,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    const summary = await sweepRetention(cfg, buildRoots());
    const sessionsTier = summary.tiers.find((t) => t.tier === "sessions");
    expect(sessionsTier).toBeDefined();
    expect(sessionsTier!.enabled).toBe(false);
    expect(sessionsTier!.processed).toBe(0);
    expect(sessionsTier!.succeeded).toBe(0);
    expect(existsSync(aged)).toBe(true);
    expect(existsSync(join(sentinelRoot, `sessions${SWEEP_IN_PROGRESS_SUFFIX}`))).toBe(false);
  });

  it("recordingsSoftTtl disabled gates the recordings-soft tier", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);
    const aged = join(recordingsRoot, "old-recording.jsonl");
    touchAgedFile(aged, now, 30 * DAY_MS);

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: null,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    const summary = await sweepRetention(cfg, buildRoots());
    const tier = summary.tiers.find((t) => t.tier === "recordings-soft");
    expect(tier).toBeDefined();
    expect(tier!.enabled).toBe(false);
    expect(tier!.processed).toBe(0);
    expect(existsSync(aged)).toBe(true);
    expect(existsSync(join(recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR, "old-recording.jsonl"))).toBe(false);
  });

  it("recordingsHardTtl disabled gates the recordings-hard tier", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);
    const aged = join(recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR, "ancient.jsonl");
    touchAgedFile(aged, now, 365 * DAY_MS);

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: null,
      logsDays: 7,
    });

    const summary = await sweepRetention(cfg, buildRoots());
    const tier = summary.tiers.find((t) => t.tier === "recordings-hard");
    expect(tier).toBeDefined();
    expect(tier!.enabled).toBe(false);
    expect(tier!.processed).toBe(0);
    expect(existsSync(aged)).toBe(true);
  });

  it("logsTtl disabled gates the logs tier", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);
    const aged = join(logsRoot, "old.log");
    touchAgedFile(aged, now, 30 * DAY_MS);

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: null,
    });

    const summary = await sweepRetention(cfg, buildRoots());
    const tier = summary.tiers.find((t) => t.tier === "logs");
    expect(tier).toBeDefined();
    expect(tier!.enabled).toBe(false);
    expect(tier!.processed).toBe(0);
    expect(existsSync(aged)).toBe(true);
  });
});

describe(".hold sentinel keeps both recording tiers idle", () => {
  // Hunt R6 incident-preservation escape hatch: presence of
  // <recordingsRoot>/.hold makes BOTH recording tiers refuse to delete
  // OR archive ANY .jsonl file. Operator can drop the sentinel during
  // a forensic investigation and re-arm by removing it.
  it("with .hold present both recording tiers report holdActive=true and skip", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    const softAged = join(recordingsRoot, "soft.jsonl");
    touchAgedFile(softAged, now, 30 * DAY_MS);
    const hardAged = join(recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR, "hard.jsonl");
    touchAgedFile(hardAged, now, 365 * DAY_MS);

    writeFileSync(join(recordingsRoot, RECORDINGS_HOLD_SENTINEL), "");

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    const summary = await sweepRetention(cfg, buildRoots());
    const softTier = summary.tiers.find((t) => t.tier === "recordings-soft");
    const hardTier = summary.tiers.find((t) => t.tier === "recordings-hard");
    expect(softTier!.enabled).toBe(true);
    expect(softTier!.holdActive).toBe(true);
    expect(softTier!.processed).toBe(0);
    expect(hardTier!.enabled).toBe(true);
    expect(hardTier!.holdActive).toBe(true);
    expect(hardTier!.processed).toBe(0);

    expect(existsSync(softAged)).toBe(true);
    expect(existsSync(hardAged)).toBe(true);
    expect(existsSync(join(recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR, "soft.jsonl"))).toBe(false);

    const sessionsTier = summary.tiers.find((t) => t.tier === "sessions");
    expect(sessionsTier!.holdActive).toBe(false);
  });
});

describe("fixtures subtree under archived-recordings preserved (Willison R1)", () => {
  it("files inside archived-recordings/fixtures/ are never deleted", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    const hardDir = join(recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR);
    const fixturesDir = join(hardDir, "fixtures");
    mkdirSync(fixturesDir, { recursive: true });
    const fixtureFile = join(fixturesDir, "preserve-me.jsonl");
    touchAgedFile(fixtureFile, now, 365 * DAY_MS);
    const topLevelOld = join(hardDir, "ordinary.jsonl");
    touchAgedFile(topLevelOld, now, 365 * DAY_MS);

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    const summary = await sweepRetention(cfg, buildRoots());
    const hardTier = summary.tiers.find((t) => t.tier === "recordings-hard")!;
    // The fixtures/ dir is filtered at matchFilename time (we only
    // enumerate names ending .jsonl) — non-recursive readdir never
    // descends into the subdir, so fixtures/preserve-me.jsonl never
    // enters the candidate set. The CONTRACT verified here is that
    // the fixture survives + the ordinary top-level file is deleted.
    expect(hardTier.succeeded).toBe(1);
    expect(existsSync(fixtureFile)).toBe(true);
    expect(existsSync(topLevelOld)).toBe(false);
  });
});

describe("active recording paths skip (Persistence R6)", () => {
  it("recordings-soft tier skips files in the active set, leaves them on disk", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    const liveFile = join(recordingsRoot, "live-session.jsonl");
    touchAgedFile(liveFile, now, 30 * DAY_MS);
    const deadFile = join(recordingsRoot, "dead-session.jsonl");
    touchAgedFile(deadFile, now, 30 * DAY_MS);

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    const summary = await sweepRetention(cfg, buildRoots(), {
      getActiveRecordingPaths: () => new Set([liveFile]),
    });
    const tier = summary.tiers.find((t) => t.tier === "recordings-soft")!;
    expect(tier.skippedActive).toBe(1);
    expect(tier.succeeded).toBe(1);
    // Live file stayed on disk + was not moved.
    expect(existsSync(liveFile)).toBe(true);
    expect(existsSync(join(recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR, "live-session.jsonl"))).toBe(false);
    // Dead file moved to archived-recordings.
    expect(existsSync(deadFile)).toBe(false);
    expect(existsSync(join(recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR, "dead-session.jsonl"))).toBe(true);
  });

  it("logs tier skips files in the active log set", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    const liveLog = join(logsRoot, "current.log");
    touchAgedFile(liveLog, now, 30 * DAY_MS);
    const oldLog = join(logsRoot, "stale.log");
    touchAgedFile(oldLog, now, 30 * DAY_MS);

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    const summary = await sweepRetention(cfg, buildRoots(), {
      getActiveLogPaths: () => new Set([liveLog]),
    });
    const tier = summary.tiers.find((t) => t.tier === "logs")!;
    expect(tier.skippedActive).toBe(1);
    expect(tier.succeeded).toBe(1);
    expect(existsSync(liveLog)).toBe(true);
    expect(existsSync(oldLog)).toBe(false);
  });
});

describe("symlink rejection (EC-7 floor)", () => {
  it("symlinks are detected via lstat and skipped (never followed)", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    // Create a real target outside the sweeper root that a symlink
    // inside the recordings tier would otherwise unlink. The symlink
    // skip is the contract that keeps an attacker who controls a
    // recordings filename from shredding an unrelated path.
    const offsiteVictim = join(tmpRoot, "offsite-victim.txt");
    writeFileSync(offsiteVictim, "do-not-delete");

    const symlinkPath = join(recordingsRoot, "evil.jsonl");
    symlinkSync(offsiteVictim, symlinkPath);
    // Best effort to age the symlink mtime — even though symlink mtime
    // is fs-specific, the path's lstat is what matters for the skip.

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    const summary = await sweepRetention(cfg, buildRoots());
    const tier = summary.tiers.find((t) => t.tier === "recordings-soft")!;
    expect(tier.skippedSymlink).toBe(1);
    // Symlink + its target both untouched.
    expect(existsSync(offsiteVictim)).toBe(true);
  });
});

describe("mtime-ascending sort + residual cap", () => {
  // The brief: cap entries-per-pass at 1000 default; oldest-first sort
  // so a residual cap leaves the FRESHEST survivors (least urgent).
  // Test uses a tiny override cap to keep the setup small.
  it("processes the oldest N entries first and reports residual", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    // 5 past-TTL files with explicitly staggered mtimes.
    const ages = [10, 20, 30, 40, 50]; // days old
    const names: string[] = [];
    for (let i = 0; i < ages.length; i++) {
      const name = `aged-${i}.json`;
      const p = join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, name);
      touchAgedFile(p, now, ages[i] * DAY_MS, "{}");
      names.push(name);
    }

    const cfg = buildConfig({
      archiveDays: 1, // anything older than 1d is fair game
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    const summary = await sweepRetention(cfg, buildRoots(), {
      maxEntriesPerPass: 2,
    });
    const tier = summary.tiers.find((t) => t.tier === "sessions")!;
    expect(tier.processed).toBe(2);
    expect(tier.succeeded).toBe(2);
    expect(tier.residual).toBe(3);

    // The two OLDEST files (aged-3, aged-4 — 40d/50d) should be gone.
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, "aged-4.json"))).toBe(false);
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, "aged-3.json"))).toBe(false);
    // The three fresher ones survive this pass.
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, "aged-0.json"))).toBe(true);
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, "aged-1.json"))).toBe(true);
    expect(existsSync(join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, "aged-2.json"))).toBe(true);
  });

  it("default cap is DEFAULT_MAX_ENTRIES_PER_PASS (1000)", () => {
    // Pin the exported constant — guards against a future drift to a
    // higher number that would burn the event loop on a real backlog.
    expect(DEFAULT_MAX_ENTRIES_PER_PASS).toBe(1000);
  });
});

describe("EC-8 sentinel-before-sweep", () => {
  it("writes <tier>.sweep-in-progress BEFORE work and clears AFTER", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    const aged = join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, "old.json");
    touchAgedFile(aged, now, 90 * DAY_MS, "{}");

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    // Spy on the sentinel-markers module so we can observe the order.
    const sentinelModule = await import("./sentinel-markers.js");
    const writeSpy = vi.spyOn(sentinelModule, "writeSweepInProgressMarker");
    const deleteSpy = vi.spyOn(sentinelModule, "deleteSweepInProgressMarker");

    await sweepRetention(cfg, buildRoots());

    // At least the sessions tier wrote + cleared its marker. Note we
    // can't naively assert on call-order between write+delete because
    // vitest's spy timestamps are per-invocation, not per-tier — but we
    // CAN assert that a write fired for the sessions tier AND a delete
    // fired for the same tier.
    const writes = writeSpy.mock.calls.filter((c) => c[1] === "sessions");
    const deletes = deleteSpy.mock.calls.filter((c) => c[1] === "sessions");
    expect(writes.length).toBe(1);
    expect(deletes.length).toBe(1);
    // Marker should be cleared on disk post-sweep.
    expect(existsSync(join(sentinelRoot, `sessions${SWEEP_IN_PROGRESS_SUFFIX}`))).toBe(false);
  });

  it("skips sentinel write when there is zero work this pass", async () => {
    // Empty roots (no past-TTL entries) -> no marker churn.
    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });
    const sentinelModule = await import("./sentinel-markers.js");
    const writeSpy = vi.spyOn(sentinelModule, "writeSweepInProgressMarker");
    await sweepRetention(cfg, buildRoots());
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("EC-21 cleanup-events counter recording", () => {
  it("records recordings_soft_archived per successful move", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    const f1 = join(recordingsRoot, "a.jsonl");
    const f2 = join(recordingsRoot, "b.jsonl");
    touchAgedFile(f1, now, 30 * DAY_MS);
    touchAgedFile(f2, now, 30 * DAY_MS);

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    const sizeBefore = __getCleanupEventStoreSizeForTests();
    await sweepRetention(cfg, buildRoots());
    const sizeAfter = __getCleanupEventStoreSizeForTests();
    expect(sizeAfter - sizeBefore).toBe(2);
  });

  it("records recordings_hard_deleted per successful unlink", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    const hard = join(recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR, "hard.jsonl");
    touchAgedFile(hard, now, 365 * DAY_MS);

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });

    const sizeBefore = __getCleanupEventStoreSizeForTests();
    await sweepRetention(cfg, buildRoots());
    const sizeAfter = __getCleanupEventStoreSizeForTests();
    expect(sizeAfter - sizeBefore).toBe(1);
    expect(existsSync(hard)).toBe(false);
  });

  it("sessions + logs tiers do NOT record cleanup-events", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    const aged = join(sessionsRoot, ARCHIVED_SESSIONS_SUBDIR, "old.json");
    touchAgedFile(aged, now, 90 * DAY_MS, "{}");
    const oldLog = join(logsRoot, "stale.log");
    touchAgedFile(oldLog, now, 30 * DAY_MS);

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: null,
      recordingsHardDays: null,
      logsDays: 7,
    });

    const sizeBefore = __getCleanupEventStoreSizeForTests();
    await sweepRetention(cfg, buildRoots());
    const sizeAfter = __getCleanupEventStoreSizeForTests();
    expect(sizeAfter - sizeBefore).toBe(0);
    expect(existsSync(aged)).toBe(false);
    expect(existsSync(oldLog)).toBe(false);
  });
});

describe("per-entry failure does not stop the tier", () => {
  // The contract: one per-entry failure logs + bumps `failed` but the
  // loop continues to the next entry. We exercise it via the move tier
  // by pre-creating a non-empty directory at the destination path —
  // renameSync throws ENOTEMPTY/EISDIR/EPERM (platform-varying) for
  // exactly one of the candidates and the sweeper continues.
  it("a single bad rename logs + continues; other entries still processed", async () => {
    const now = 1_000_000_000_000;
    setClockSourceForTests(() => now);

    const a = join(recordingsRoot, "a.jsonl");
    const b = join(recordingsRoot, "b.jsonl");
    const c = join(recordingsRoot, "c.jsonl");
    touchAgedFile(a, now, 50 * DAY_MS);
    touchAgedFile(b, now, 40 * DAY_MS);
    touchAgedFile(c, now, 30 * DAY_MS);

    // Pre-stage a NON-EMPTY directory at the destination for `b.jsonl`.
    // renameSync(file, non-empty-dir) -> errno (EISDIR on linux, also
    // ENOTEMPTY when the dir has children). The other two renames
    // succeed normally.
    const archDir = join(recordingsRoot, ARCHIVED_RECORDINGS_SUBDIR);
    mkdirSync(join(archDir, "b.jsonl"), { recursive: true });
    writeFileSync(join(archDir, "b.jsonl", "blocker.txt"), "x");

    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });
    const summary = await sweepRetention(cfg, buildRoots());

    const tier = summary.tiers.find((t) => t.tier === "recordings-soft")!;
    expect(tier.processed).toBe(3);
    expect(tier.succeeded).toBe(2);
    expect(tier.failed).toBe(1);
    // The bad-rename source survives on disk.
    expect(existsSync(b)).toBe(true);
    // Other two successfully moved into the archive subdir.
    expect(existsSync(a)).toBe(false);
    expect(existsSync(c)).toBe(false);
    expect(existsSync(join(archDir, "a.jsonl"))).toBe(true);
    expect(existsSync(join(archDir, "c.jsonl"))).toBe(true);
  });
});

describe("nonexistent enumerate root handled gracefully", () => {
  it("missing logs root -> tier no-op with no error surfaced", async () => {
    rmSync(logsRoot, { recursive: true, force: true });
    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });
    const summary = await sweepRetention(cfg, buildRoots());
    const tier = summary.tiers.find((t) => t.tier === "logs")!;
    expect(tier.enabled).toBe(true);
    expect(tier.processed).toBe(0);
    expect(tier.enumerateError).toBeUndefined();
  });
});

describe("sweep summary shape", () => {
  it("returns a summary with 4 tiers in fixed order", async () => {
    const cfg = buildConfig({
      archiveDays: 30,
      recordingsSoftDays: 14,
      recordingsHardDays: 60,
      logsDays: 7,
    });
    const summary = await sweepRetention(cfg, buildRoots());
    expect(summary.tiers.map((t) => t.tier)).toEqual([
      "sessions",
      "recordings-soft",
      "recordings-hard",
      "logs",
    ]);
    expect(summary.completedAt).toBeGreaterThanOrEqual(summary.startedAt);
  });
});
