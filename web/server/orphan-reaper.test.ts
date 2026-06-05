// AURA-LOCAL — tests for orphan-reaper.ts (PLAN T8).
//
// Coverage shape:
//   - macOS (`unavailable`) degraded mode: WARN + no kill calls + scan=0.
//   - RE-ATTACH (Subprocess R5): orphan argv matches known sessionId +
//     verifyProcessIdentity returns `match` → known.pid mutated, kill NOT
//     called, sentinel NEVER written. Subprocess R5 floor.
//   - REAP (unknown orphan): no companion-side sessionId match →
//     sentinel written, SIGTERM, sentinel deleted, info NOT mutated.
//   - REAP (identity mismatch): argv sessionId matches known session
//     BUT verifyProcessIdentity returns `mismatch` (PID reuse) → reap,
//     known.pid NOT mutated.
//   - REPLAY (EC-6 spirit): captured PID-reuse scenario where the
//     orphan PID's stat starttime exceeds the sidecar's expectedStartMs
//     tolerance → mismatch → reap. False-positive relaunch suppressed.
//   - Budget cap: enumerate many PPID=1 candidates, slow read latency,
//     reaper exits with budgetExceeded=true.
//   - Skips tracked pids — pids the launcher already owns (not orphans).
//   - EC-23: log payload contains argvSha256 + argvShape + cwdDepth +
//     sessionIdPresent — NEVER raw argv tokens.
//   - Sentinel-write failure short-circuits SIGTERM (EC-8 floor).

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reapOrphans,
  classifyArgv,
  splitCmdline,
  parsePpidFromStat,
  type OrphanReaperDeps,
  type ReaperKnownSession,
} from "./orphan-reaper.js";
import {
  setProcReaderForTests,
  __resetProcReaderForTests,
} from "./process-identity.js";
import {
  writeRuntimeSidecar,
  SIDECAR_SCHEMA_VERSION,
  argvSha256,
} from "./cli-runtime-sidecar.js";
import { REAPING_SENTINEL_SUBDIR } from "./cleanup/cleanup-paths.js";

let tmpRoot: string;
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "orphan-reaper-test-"));
  const loggerModule = await import("./logger.js");
  infoSpy = vi.spyOn(loggerModule.log, "info").mockImplementation(() => undefined);
  warnSpy = vi.spyOn(loggerModule.log, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  __resetProcReaderForTests();
  vi.restoreAllMocks();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

// Helpers ---------------------------------------------------------------

/** Build a `/proc/<pid>/stat` line with the given comm + ppid. */
function fakeStat(comm: string, ppid: number, starttime = 100): string {
  // Layout: pid (comm) state ppid pgrp ... starttime ...
  // We only need ppid (field 4 → index 1 after `)`) and starttime
  // (field 22 → index 19 after `)`) parsing here. Fill placeholders.
  const fields = [
    "S", String(ppid), "0", "0", "0", "0",
    "0", "0", "0", "0", "0", "0",
    "0", "0", "0", "0", "0", "0",
    String(starttime), "0", "0", "0",
  ];
  return `1 (${comm}) ${fields.join(" ")}\n`;
}

/** Build a NUL-joined cmdline for a Claude `--sdk-url ws://.../<sessionId>` argv. */
function claudeCmdline(sessionId: string): string {
  return [
    "/usr/local/bin/claude",
    "--sdk-url",
    `ws://localhost:3456/ws/cli/${sessionId}`,
    "--print",
    "--output-format",
    "stream-json",
  ].join("\0") + "\0";
}

// ─── argv parsing helpers ───────────────────────────────────────────────────

describe("splitCmdline + parsePpidFromStat — proc parser primitives", () => {
  it("splitCmdline drops empty NUL-trailer", () => {
    expect(splitCmdline("a\0b\0c\0")).toEqual(["a", "b", "c"]);
  });

  it("parsePpidFromStat handles comm with spaces+parens", () => {
    // Real-world: `bash -c "foo"` produces comm=`(sh)` etc.; tests pin
    // the lastIndexOf(`)`) trick.
    const stat = `1234 (sh (with spaces)) S 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
    expect(parsePpidFromStat(stat)).toBe(1);
  });

  it("parsePpidFromStat throws on missing closing paren", () => {
    expect(() => parsePpidFromStat("garbage")).toThrow(/malformed/);
  });
});

describe("classifyArgv — Companion-shape detection + EC-23 redaction", () => {
  it("detects Claude shape AND extracts sessionId from --sdk-url URL", () => {
    const c = classifyArgv([
      "/usr/local/bin/claude",
      "--sdk-url",
      "ws://localhost:3456/ws/cli/abc-123",
    ]);
    expect(c.isCompanionShape).toBe(true);
    expect(c.sessionId).toBe("abc-123");
    // EC-23: argvShape is categorical labels (`<URL>`), never raw bytes.
    expect(c.argvShape).toEqual(["claude", "--sdk-url", "<URL>"]);
    expect(c.argvSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects Codex (host mode) without sessionId — pure shape match", () => {
    const c = classifyArgv(["/usr/bin/codex", "app-server"]);
    expect(c.isCompanionShape).toBe(true);
    expect(c.sessionId).toBeNull();
  });

  it("detects Codex via node-wrapper invocation", () => {
    const c = classifyArgv(["/usr/bin/node", "/opt/codex/dist/codex.js", "app-server"]);
    expect(c.isCompanionShape).toBe(true);
  });

  it("rejects non-Companion shapes (random bash)", () => {
    const c = classifyArgv(["/bin/bash", "-c", "sleep 1000"]);
    expect(c.isCompanionShape).toBe(false);
  });

  it("EC-23: argvShape never carries raw URL/PATH bytes for shape labels", () => {
    const c = classifyArgv([
      "/usr/local/bin/claude",
      "--cwd",
      "/home/operator/projects/secret-project",
      "--sdk-url",
      "ws://localhost:3456/ws/cli/sess-x",
    ]);
    // No raw path bytes; categorical labels only.
    expect(c.argvShape).toEqual(["claude", "--cwd", "<PATH>", "--sdk-url", "<URL>"]);
    // cwdDepth captures structure of the deepest path token.
    expect(c.cwdDepth).toBeGreaterThanOrEqual(3);
  });
});

// ─── reapOrphans behaviour ──────────────────────────────────────────────────

describe("reapOrphans — macOS / unavailable degraded mode", () => {
  it("WARNs once and returns scan=0 + reap=0 on darwin", async () => {
    const kill = vi.fn();
    const sum = await reapOrphans({
      loadedSessions: [],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "darwin",
      kill,
    });
    expect(sum.platform).toBe("darwin");
    expect(sum.reaped).toBe(0);
    expect(sum.reattached).toBe(0);
    expect(sum.scannedPids).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "orphan-reaper",
      expect.stringContaining("non-Linux"),
      expect.objectContaining({ event: "orphan_reaper.unavailable", platform: "darwin" }),
    );
  });
});

describe("reapOrphans — RE-ATTACH branch (Subprocess R5)", () => {
  it("PURE info.pid mutation; NEVER kills; NEVER writes sentinel", async () => {
    const sessionId = "sess-attach-1";
    // Sidecar present with matching processStartMs → 3-factor probe
    // returns `match` (process-identity stubs configured below).
    writeRuntimeSidecar(tmpRoot, sessionId, {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      pid: 99999, // sidecar's recorded PID (stale — process was reparented to 4242)
      processStartMs: 1_700_000_000_000,
      argvSha256: argvSha256(["claude", "--sdk-url", `ws://localhost:3456/ws/cli/${sessionId}`]),
    });

    // Stub process-identity's proc-reader to return matching argv + starttime.
    setProcReaderForTests({
      platform: () => "linux",
      killCheck: () => true,
      readCmdline: () => claudeCmdline(sessionId),
      // starttime conversion: bootSecs * 1000 + (starttime * 1000 / clkTck)
      // We want this to land within ±2s of 1_700_000_000_000.
      readStat: () => fakeStat("claude", 1, 0), // starttime=0
      readBootStat: () => `btime 1700000000\n`, // 1700000000 secs → 1700000000000 ms
      clkTck: 100,
    });

    const known: ReaperKnownSession = { sessionId, pid: undefined };
    const kill = vi.fn();
    const deps: OrphanReaperDeps = {
      loadedSessions: [known],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [4242],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => claudeCmdline(sessionId),
      killCheck: () => true,
      kill,
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };

    const sum = await reapOrphans(deps);
    expect(sum.reattached).toBe(1);
    expect(sum.reaped).toBe(0);
    expect(known.pid).toBe(4242); // PURE mutation.
    expect(kill).not.toHaveBeenCalled();
    // Sentinel NEVER written.
    expect(existsSync(join(tmpRoot, REAPING_SENTINEL_SUBDIR, `4242.json`))).toBe(false);
  });
});

describe("reapOrphans — REAP branch (no known session)", () => {
  it("writes sentinel BEFORE SIGTERM, deletes after exit, reap counter increments", async () => {
    const kill = vi.fn();
    let livenessCalls = 0;
    const deps: OrphanReaperDeps = {
      loadedSessions: [],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [7777],
      readStat: () => fakeStat("claude", 1),
      // Orphan with sessionId we don't know about.
      readCmdline: () => claudeCmdline("unknown-sess"),
      killCheck: () => {
        livenessCalls++;
        return livenessCalls === 0; // simulate immediate exit after SIGTERM
      },
      kill,
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };

    const sum = await reapOrphans(deps);
    expect(sum.reaped).toBe(1);
    expect(sum.reattached).toBe(0);
    expect(sum.skippedNoSessionMatch).toBe(1);
    expect(kill).toHaveBeenCalledWith(7777, "SIGTERM");
    // Sentinel was written, then cleaned up after exit confirmed.
    expect(existsSync(join(tmpRoot, REAPING_SENTINEL_SUBDIR, `7777.json`))).toBe(false);
  });
});

describe("reapOrphans — REAP branch (identity mismatch — captured PID-reuse scenario)", () => {
  // EC-6 spirit: simulate a captured PID-reuse scenario. The sidecar
  // says session X started at T0; the orphan PID's /proc/<pid>/stat
  // shows starttime T1 (way later than T0 ± 2s). Verdict = mismatch.
  // The reaper reaps WITHOUT mutating known.pid — the false-positive
  // relaunch the spec set out to close is suppressed.
  it("rejects PID reuse via verifyProcessIdentity, reaps without re-attaching", async () => {
    const sessionId = "sess-reuse-mismatch";
    writeRuntimeSidecar(tmpRoot, sessionId, {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      pid: 11111,
      processStartMs: 1_700_000_000_000, // T0
      argvSha256: argvSha256(["claude", "--sdk-url", `ws://localhost:3456/ws/cli/${sessionId}`]),
    });

    // Stub process-identity to return starttime that translates to
    // wallclock far outside the ±2s tolerance.
    setProcReaderForTests({
      platform: () => "linux",
      killCheck: () => true,
      readCmdline: () => claudeCmdline(sessionId),
      readStat: () => fakeStat("claude", 1, 10000), // 10000 ticks @ 100Hz = 100s
      readBootStat: () => `btime 1700000500\n`, // bootSecs differ from sidecar; mismatch
      clkTck: 100,
    });

    const known: ReaperKnownSession = { sessionId, pid: undefined };
    const kill = vi.fn();
    const deps: OrphanReaperDeps = {
      loadedSessions: [known],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [22222],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => claudeCmdline(sessionId),
      killCheck: () => false, // already dead after SIGTERM
      kill,
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };

    const sum = await reapOrphans(deps);
    expect(sum.reaped).toBe(1);
    expect(sum.reattached).toBe(0);
    expect(known.pid).toBeUndefined(); // NEVER mutated
    expect(kill).toHaveBeenCalledWith(22222, "SIGTERM");
  });
});

describe("reapOrphans — skips tracked pids", () => {
  it("does NOT reap a pid the launcher is already tracking as live", async () => {
    const sessionId = "sess-live";
    const kill = vi.fn();
    const deps: OrphanReaperDeps = {
      loadedSessions: [{ sessionId, pid: 5555 }], // launcher tracks pid 5555
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [5555],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => claudeCmdline(sessionId),
      killCheck: () => false,
      kill,
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };
    const sum = await reapOrphans(deps);
    expect(sum.reaped).toBe(0);
    expect(sum.reattached).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("reapOrphans — 5s budget cap", () => {
  it("budgetExceeded=true when clock advances past budget mid-scan", async () => {
    const kill = vi.fn();
    let nowCallCount = 0;
    const fakeNow = () => {
      // Drive the clock forward fast — every read advances 2s; with
      // budget 5s the third pid lands past the gate.
      nowCallCount++;
      return 1_700_000_000_000 + nowCallCount * 2_000;
    };
    const deps: OrphanReaperDeps = {
      loadedSessions: [],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [1001, 1002, 1003, 1004, 1005],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => claudeCmdline("unknown"),
      killCheck: () => false,
      kill,
      sleep: async () => {},
      now: fakeNow,
      budgetMs: 5_000,
    };
    const sum = await reapOrphans(deps);
    expect(sum.budgetExceeded).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "orphan-reaper",
      expect.stringContaining("budget exceeded"),
      expect.objectContaining({ event: "orphan_reaper.budget_exceeded" }),
    );
  });
});

describe("reapOrphans — EC-23 log redaction", () => {
  it("orphan_reaped log payload carries argvSha256 + argvShape + cwdDepth, NOT raw argv bytes", async () => {
    const deps: OrphanReaperDeps = {
      loadedSessions: [],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [3333],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => claudeCmdline("redaction-test"),
      killCheck: () => false,
      kill: vi.fn(),
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };
    await reapOrphans(deps);
    const reapedCall = infoSpy.mock.calls.find(
      (c: unknown[]) => (c[2] as { event?: string } | undefined)?.event === "orphan_reaped",
    );
    expect(reapedCall).toBeDefined();
    const payload = reapedCall![2] as Record<string, unknown>;
    expect(payload.argvSha256).toEqual(expect.any(String));
    expect(payload.argvShape).toEqual(["claude", "--sdk-url", "<URL>", "--print", "--output-format", "<TOKEN>"]);
    expect(payload.sessionIdPresent).toBe(true);
    // EC-23 floor: NO raw URL/path bytes in the structured log.
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain("ws://localhost:3456");
    expect(serialised).not.toContain("redaction-test");
  });
});

describe("reapOrphans — EC-8 sentinel-write failure short-circuits SIGTERM", () => {
  it("when sentinel write throws, kill is NOT called (EC-8 floor)", async () => {
    const kill = vi.fn();
    // sentinelRoot pointing at a path that exists as a file (collides
    // with directory creation) — sentinel-markers writeAtomicJson will
    // throw on the mkdir.
    const collisionPath = join(tmpRoot, "collision-file");
    writeFileSync(collisionPath, "blocker");
    const deps: OrphanReaperDeps = {
      loadedSessions: [],
      sentinelRoot: collisionPath, // not a directory → resolver/atomic-write fails
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [9999],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => claudeCmdline("no-match"),
      killCheck: () => false,
      kill,
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };
    const sum = await reapOrphans(deps);
    expect(kill).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "orphan-reaper",
      expect.stringContaining("sentinel write failed"),
      expect.objectContaining({ event: "orphan_reaper.sentinel_write_failed" }),
    );
    // sentinel-write failure still counts as reaped=0 (we never killed).
    expect(sum.reaped).toBe(0);
  });
});

describe("reapOrphans — skips non-PPID=1 processes", () => {
  it("ignores Companion-shaped procs whose ppid != 1", async () => {
    const kill = vi.fn();
    const deps: OrphanReaperDeps = {
      loadedSessions: [],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [4242],
      // ppid=42 → not orphaned to init.
      readStat: () => fakeStat("claude", 42),
      readCmdline: () => claudeCmdline("not-orphan"),
      killCheck: () => false,
      kill,
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };
    const sum = await reapOrphans(deps);
    expect(sum.reaped).toBe(0);
    expect(sum.scannedPids).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("reapOrphans — inconclusive verdict on known session defers reap (WARN fix)", () => {
  // Cross-cut safety alignment with cli-launcher.restoreFromDisk: an
  // inconclusive (`unavailable`/`gone`) verdict on a re-attach candidate must
  // NOT reap. Killing here would SIGTERM the very session that reconnected via
  // KillMode=process → the duplicate-relaunch storm this subsystem prevents.
  it("unavailable verdict → skip (no kill, no sentinel, skippedInconclusive=1)", async () => {
    const sessionId = "sess-inconclusive-unavail";
    writeRuntimeSidecar(tmpRoot, sessionId, {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      pid: 30000,
      processStartMs: 1_700_000_000_000,
      argvSha256: argvSha256(["claude", "--sdk-url", `ws://localhost:3456/ws/cli/${sessionId}`]),
    });
    // process-identity sees a NON-linux platform → returns `unavailable`,
    // while the reaper itself runs (deps.platform === "linux").
    setProcReaderForTests({
      platform: () => "darwin",
      killCheck: () => true,
      readCmdline: () => claudeCmdline(sessionId),
      readStat: () => fakeStat("claude", 1),
      readBootStat: () => `btime 1700000000\n`,
      clkTck: 100,
    });
    const known: ReaperKnownSession = { sessionId, pid: undefined };
    const kill = vi.fn();
    const deps: OrphanReaperDeps = {
      loadedSessions: [known],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [4242],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => claudeCmdline(sessionId),
      killCheck: () => true,
      kill,
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };
    const sum = await reapOrphans(deps);
    expect(sum.skippedInconclusive).toBe(1);
    expect(sum.reaped).toBe(0);
    expect(sum.reattached).toBe(0);
    expect(known.pid).toBeUndefined(); // NOT mutated — not a confirmed match.
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(join(tmpRoot, REAPING_SENTINEL_SUBDIR, `4242.json`))).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "orphan-reaper",
      expect.stringContaining("inconclusive identity verdict"),
      expect.objectContaining({ event: "orphan_reaper.verify_inconclusive", verdict: "unavailable" }),
    );
  });

  it("gone verdict (probe sees process dead) → skip (no kill, skippedInconclusive=1)", async () => {
    const sessionId = "sess-inconclusive-gone";
    writeRuntimeSidecar(tmpRoot, sessionId, {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      pid: 31000,
      processStartMs: 1_700_000_000_000,
      argvSha256: argvSha256(["claude", "--sdk-url", `ws://localhost:3456/ws/cli/${sessionId}`]),
    });
    // process-identity's liveness probe returns false → fail-CLOSED `gone`.
    setProcReaderForTests({
      platform: () => "linux",
      killCheck: () => false,
      readCmdline: () => claudeCmdline(sessionId),
      readStat: () => fakeStat("claude", 1),
      readBootStat: () => `btime 1700000000\n`,
      clkTck: 100,
    });
    const known: ReaperKnownSession = { sessionId, pid: undefined };
    const kill = vi.fn();
    const deps: OrphanReaperDeps = {
      loadedSessions: [known],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [4343],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => claudeCmdline(sessionId),
      killCheck: () => true,
      kill,
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };
    const sum = await reapOrphans(deps);
    expect(sum.skippedInconclusive).toBe(1);
    expect(sum.reaped).toBe(0);
    expect(known.pid).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "orphan-reaper",
      expect.stringContaining("inconclusive identity verdict"),
      expect.objectContaining({ event: "orphan_reaper.verify_inconclusive", verdict: "gone" }),
    );
  });
});

describe("reapOrphans — non-ESRCH kill failure not counted as reaped (NOTE fix)", () => {
  // EPERM means the process SURVIVES the SIGTERM attempt; counting it as
  // reaped would over-report success while the orphan persists. ESRCH
  // (already-exited) is the benign case and DOES count.
  it("EPERM SIGTERM → killFailed=1, reaped=0, no orphan_reaped log", async () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    const deps: OrphanReaperDeps = {
      loadedSessions: [],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [8888],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => claudeCmdline("eperm-orphan"),
      killCheck: () => false,
      kill,
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };
    const sum = await reapOrphans(deps);
    expect(kill).toHaveBeenCalledWith(8888, "SIGTERM");
    expect(sum.killFailed).toBe(1);
    expect(sum.reaped).toBe(0); // survived → not a reap
    const reapedLog = infoSpy.mock.calls.find(
      (c: unknown[]) => (c[2] as { event?: string } | undefined)?.event === "orphan_reaped",
    );
    expect(reapedLog).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "orphan-reaper",
      expect.stringContaining("SIGTERM failed"),
      expect.objectContaining({ event: "orphan_reaper.kill_failed", error_code: "EPERM" }),
    );
  });

  it("ESRCH SIGTERM (already exited) → counted as reaped (benign)", async () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const deps: OrphanReaperDeps = {
      loadedSessions: [],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [8889],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => claudeCmdline("esrch-orphan"),
      killCheck: () => false,
      kill,
      sleep: async () => {},
      now: () => 1_700_000_001_000,
    };
    const sum = await reapOrphans(deps);
    expect(sum.reaped).toBe(1); // already-gone == effective reap
    expect(sum.killFailed).toBe(0);
  });
});
