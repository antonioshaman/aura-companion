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
  resolveOrphanReaperGate,
  codexHomeFromEnviron,
  isCompanionCodexSessionHome,
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

  // 2026-09-11 addition: stdio transport (default for CLI >= 2.1.123).
  // Companion-spawned Claude subprocesses under stdio carry a specific
  // token quorum (`--print` + `--output-format stream-json` +
  // `--input-format stream-json`). Reproduced orphan on prod 2026-09-11
  // was exactly this shape.
  it("detects stdio-transport Claude by quorum: --print + --output-format stream-json + --input-format stream-json", () => {
    const c = classifyArgv([
      "/home/auracomp/.local/bin/claude",
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", "claude-opus-4-8",
      "--permission-mode", "bypassPermissions",
      "--resume", "2eaf079e-91c0-4e10-80db-18b340d1b97c",
    ]);
    expect(c.isCompanionShape).toBe(true);
    expect(c.isServerManagedShape).toBe(true);
    // No --sdk-url → no Companion sessionId extracted (stdio orphans
    // fall through to the REAP branch since they can't re-attach
    // anyway — bun can't recover stdin/stdout of a subprocess it
    // didn't spawn).
    expect(c.sessionId).toBeNull();
  });

  it("stdio quorum requires ALL three markers — --print alone is not enough", () => {
    // A bare `claude --print "hi"` from a user script should NOT be
    // treated as Companion-spawned. Only reap when the full stream-json
    // stdio combination is present.
    const c = classifyArgv([
      "/usr/local/bin/claude",
      "--print", "hi",
    ]);
    expect(c.isCompanionShape).toBe(true); // basename says "claude"
    expect(c.isServerManagedShape).toBe(false); // quorum incomplete
  });

  it("stdio quorum requires ALL three markers — output-format alone is not enough", () => {
    const c = classifyArgv([
      "/usr/local/bin/claude",
      "--output-format", "stream-json",
      "hi",
    ]);
    expect(c.isServerManagedShape).toBe(false);
  });

  it("stdio quorum is basename-gated — random `node` binary with matching args is NOT reaped as claude", () => {
    // Defense-in-depth: even if some other tool happens to use the same
    // three flag names, we require argv[0] basename === "claude".
    const c = classifyArgv([
      "/usr/bin/node",
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
    ]);
    expect(c.isCompanionShape).toBe(false); // basename check filters upfront
    expect(c.isServerManagedShape).toBe(false);
  });

  it("stdio Claude with fable/opus/haiku model — model id does not affect classification", () => {
    // The 2026-09-10 model rotation (PR #182) means orphans may be on
    // any chain entry. Assert the classification is model-agnostic.
    for (const model of ["claude-opus-5", "claude-opus-4-8", "claude-fable-5-1", "claude-haiku-4-5"]) {
      const c = classifyArgv([
        "/home/auracomp/.local/bin/claude",
        "--print",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--model", model,
        "--resume", "some-cli-session-id",
      ]);
      expect(c.isServerManagedShape).toBe(true);
    }
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

// aura-meta-diet P6/D2: the AuraBench bench instance shares the host and user
// with prod, and the reaper scans all of /proc — so a second instance must be
// able to boot with the reaper off. The gate is fail-closed: only an explicit
// off-value disables it; typos keep prod behaviour (on) and warn.
describe("resolveOrphanReaperGate — COMPANION_ORPHAN_REAPER boot gate", () => {
  it("defaults to enabled when the variable is absent or empty (prod behaviour)", () => {
    expect(resolveOrphanReaperGate(undefined)).toEqual({ enabled: true });
    expect(resolveOrphanReaperGate("")).toEqual({ enabled: true });
    expect(resolveOrphanReaperGate("  ")).toEqual({ enabled: true });
  });

  it("accepts the closed on/off set case-insensitively", () => {
    for (const v of ["on", "1", "true", "ON", " True "]) expect(resolveOrphanReaperGate(v)).toEqual({ enabled: true });
    for (const v of ["off", "0", "false", "OFF", " False "]) expect(resolveOrphanReaperGate(v)).toEqual({ enabled: false });
  });

  it("fails closed to enabled with a warning on an unknown value", () => {
    // A typo like "of" must never silently disable the reaper in prod.
    const r = resolveOrphanReaperGate("of");
    expect(r.enabled).toBe(true);
    expect(r.warning).toContain("COMPANION_ORPHAN_REAPER");
    expect(r.warning).toContain('"of"');
  });
});

describe("reapOrphans — SIGTERM-ignoring orphan escalates to SIGKILL (W10a)", () => {
  // Prod regression: a codex `app-server` orphan (PPID=1) ignored SIGTERM for
  // weeks while every boot logged "orphan reaped via SIGTERM". The reaper must
  // (1) observe exit before claiming a reap, (2) escalate to SIGKILL after the
  // SIGTERM grace, and (3) report a survivor honestly instead of as reaped.
  function codexCmdline(): string {
    return ["/usr/bin/node", "/usr/lib/node_modules/@openai/codex/bin/codex.js", "app-server", "--listen", "ws://127.0.0.1:4502"].join("\0") + "\0";
  }
  function depsWith(over: Partial<OrphanReaperDeps>): OrphanReaperDeps {
    let t = 1_700_000_001_000;
    return {
      loadedSessions: [],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [4502],
      readStat: () => fakeStat("node", 1),
      readCmdline: () => codexCmdline(),
      // Ownership proof (required for codex app-server orphans since the
      // VS Code extension also runs `codex app-server`): the per-session
      // CODEX_HOME the launcher sets on spawn.
      codexHomeRoot: "/home/auracomp/.companion/codex-home",
      readEnviron: () => "PATH=/usr/bin\0CODEX_HOME=/home/auracomp/.companion/codex-home/sess-w10a\0",
      sleep: async (ms: number) => { t += ms; },
      now: () => t,
      ...over,
    };
  }
  const reapedLogs = () =>
    infoSpy.mock.calls.filter((c: unknown[]) => (c[2] as { event?: string } | undefined)?.event === "orphan_reaped");

  it("SIGTERM ignored → SIGKILL sent → exit observed → reaped, logged as SIGKILL", async () => {
    let alive = true;
    const kill = vi.fn((_pid: number, sig: string) => { if (sig === "SIGKILL") alive = false; });
    const sum = await reapOrphans(depsWith({ kill, killCheck: () => alive }));
    expect(kill.mock.calls.map((c) => c[1])).toEqual(["SIGTERM", "SIGKILL"]);
    expect(sum.reaped).toBe(1);
    expect(sum.escalatedToSigkill).toBe(1);
    expect(sum.survived).toBe(0);
    expect(reapedLogs()).toHaveLength(1);
    expect(reapedLogs()[0][1]).toBe("orphan reaped via SIGKILL");
    expect(reapedLogs()[0][2]).toMatchObject({ signal: "SIGKILL" });
    expect(existsSync(join(tmpRoot, REAPING_SENTINEL_SUBDIR, "4502.json"))).toBe(false);
  });

  it("process exits on SIGTERM → no SIGKILL, logged as SIGTERM", async () => {
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const sum = await reapOrphans(depsWith({ kill, killCheck: () => alive }));
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(4502, "SIGTERM");
    expect(sum.reaped).toBe(1);
    expect(sum.escalatedToSigkill).toBe(0);
    expect(reapedLogs()[0][1]).toBe("orphan reaped via SIGTERM");
  });

  it("survives SIGTERM and SIGKILL → NOT counted as reaped, survived=1, honest WARN", async () => {
    const kill = vi.fn();
    const sum = await reapOrphans(depsWith({ kill, killCheck: () => true }));
    expect(kill.mock.calls.map((c) => c[1])).toEqual(["SIGTERM", "SIGKILL"]);
    expect(sum.reaped).toBe(0);
    expect(sum.survived).toBe(1);
    expect(reapedLogs()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "orphan-reaper",
      expect.stringContaining("survived"),
      expect.objectContaining({ event: "orphan_reaper.survived", pid: 4502 }),
    );
  });

  it("identity drifts during the SIGTERM grace (PID reuse) → SIGKILL is NOT sent", async () => {
    // The first two cmdline reads (classify + pre-SIGTERM re-verify) see the
    // orphan; afterwards the pid belongs to an unrelated process.
    let reads = 0;
    const kill = vi.fn();
    const sum = await reapOrphans(depsWith({
      kill,
      killCheck: () => true,
      readCmdline: () => (++reads <= 2 ? codexCmdline() : ["/usr/bin/vim", "notes.txt"].join("\0") + "\0"),
    }));
    expect(kill.mock.calls.map((c) => c[1])).toEqual(["SIGTERM"]);
    expect(sum.reaped).toBe(0);
    expect(sum.killAbortedDrift).toBe(1);
  });
});

// ─── PR #188 finding #3: stdio shape alone is NOT ownership proof ────────────
//
// The Claude stdio triple (`--print --output-format stream-json
// --input-format stream-json`) is public CLI usage: a human on this shared
// host can run exactly that headless invocation in their own script, and if
// it is reparented to init (nohup / closed terminal) it looks identical to a
// Companion-spawned orphan. These tests pin that the reaper only SIGTERMs a
// stdio-shaped orphan when its argv hash matches a runtime sidecar the
// server wrote at spawn, while `--sdk-url` / `app-server` orphans keep their
// existing (provable-marker) behaviour.
describe("reapOrphans — stdio-shaped orphans require server-written sidecar ownership (#188 finding #3)", () => {
  const stdioArgv = [
    "/home/auracomp/.local/bin/claude",
    "--print",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
  ];
  const stdioCmdline = stdioArgv.join("\0") + "\0";

  function stdioDeps(over: Partial<OrphanReaperDeps> = {}): OrphanReaperDeps {
    let alive = true;
    return {
      loadedSessions: [],
      sentinelRoot: tmpRoot,
      sessionsRoot: tmpRoot,
      platform: () => "linux",
      listProcPids: () => [6100],
      readStat: () => fakeStat("claude", 1),
      readCmdline: () => stdioCmdline,
      killCheck: () => alive,
      kill: vi.fn(() => { alive = false; }),
      sleep: async () => {},
      now: () => 1_700_000_001_000,
      ...over,
    };
  }

  it("classifyArgv flags the stdio triple as stdioShapeOnly, but not --sdk-url / app-server argv", () => {
    // The flag is what the reap branch keys the extra ownership check on.
    expect(classifyArgv(stdioArgv).stdioShapeOnly).toBe(true);
    expect(classifyArgv(splitCmdline(claudeCmdline("s1"))).stdioShapeOnly).toBe(false);
    expect(classifyArgv(["/usr/bin/codex", "app-server"]).stdioShapeOnly).toBe(false);
    // A bare interactive claude is not server-managed at all → not stdio-only either.
    expect(classifyArgv(["/usr/bin/claude"]).stdioShapeOnly).toBe(false);
  });

  it("a human's own headless `claude -p` (no sidecar anywhere) is NOT signalled", async () => {
    // No loaded session has a sidecar → nothing proves the server spawned it.
    const kill = vi.fn();
    const sum = await reapOrphans(stdioDeps({ kill }));
    expect(kill).not.toHaveBeenCalled();
    expect(sum.reaped).toBe(0);
    expect(sum.skippedNoSessionMatch).toBe(1);
    // No sentinel is written for a process we decided not to touch.
    expect(existsSync(join(tmpRoot, REAPING_SENTINEL_SUBDIR, "6100.json"))).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "orphan-reaper",
      expect.any(String),
      expect.objectContaining({ event: "orphan_reaper.skipped_unowned_stdio_shape", pid: 6100 }),
    );
  });

  it("a stdio orphan whose argv differs from every server sidecar is NOT signalled", async () => {
    // A loaded session has a sidecar, but for a DIFFERENT argv (different
    // --resume id) — same shape, no ownership match.
    writeRuntimeSidecar(tmpRoot, "sess-other", {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      pid: 1234,
      processStartMs: 1_700_000_000_000,
      argvSha256: argvSha256([...stdioArgv, "--resume", "someone-else"]),
    });
    const kill = vi.fn();
    const sum = await reapOrphans(stdioDeps({ kill, loadedSessions: [{ sessionId: "sess-other", pid: 1234 }] }));
    expect(kill).not.toHaveBeenCalled();
    expect(sum.reaped).toBe(0);
  });

  it("a stdio orphan whose argv hash matches a server-written sidecar IS reaped", async () => {
    // The session's tracked pid is different (it was relaunched / the pid is
    // stale), but the sidecar anchor proves the server spawned this argv.
    writeRuntimeSidecar(tmpRoot, "sess-owned", {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      pid: 5000,
      processStartMs: 1_700_000_000_000,
      argvSha256: argvSha256(stdioArgv),
    });
    const kill = vi.fn();
    let alive = true;
    kill.mockImplementation(() => { alive = false; });
    const sum = await reapOrphans(stdioDeps({
      kill,
      killCheck: () => alive,
      loadedSessions: [{ sessionId: "sess-owned", pid: undefined }],
    }));
    expect(kill).toHaveBeenCalledWith(6100, "SIGTERM");
    expect(sum.reaped).toBe(1);
  });

  it("the readOwnedArgvShas seam is honoured (ownership comes from the injected set)", async () => {
    const kill = vi.fn();
    let alive = true;
    kill.mockImplementation(() => { alive = false; });
    const sum = await reapOrphans(stdioDeps({
      kill,
      killCheck: () => alive,
      readOwnedArgvShas: () => new Set([argvSha256(stdioArgv)]),
    }));
    expect(sum.reaped).toBe(1);
  });
});

// ─── Codex app-server ownership (follow-up to PR #403) ───────────────────────
//
// The `app-server` subcommand is NOT ownership: the Codex VS Code extension
// and the root-owned Codex app-server daemon run `codex app-server` too. The
// server spawns Codex as `node .../codex.js app-server --listen ws://...`
// (the argv the runtime sidecar hashes), and that wrapper execs a native child
// `.../vendor/<triple>/bin/codex app-server --listen ws://...` whose argv
// hashes differently. Both inherit the per-session
// `CODEX_HOME=<COMPANION_HOME>/codex-home/<sessionId>` env the launcher sets.
// Observed on the prod box 2026-10-19 (wrapper pid 343478 → native child
// 343496, both with that CODEX_HOME; the sidecar argvSha256 equals the
// wrapper's cmdline hash, not the child's).
describe("reapOrphans — codex app-server requires server ownership proof", () => {
  const CODEX_HOME_ROOT = "/home/auracomp/.companion/codex-home";
  const wrapperArgv = [
    "/usr/bin/node",
    "/usr/lib/node_modules/@openai/codex/bin/codex.js",
    "app-server", "--listen", "ws://127.0.0.1:4500",
    "--enable", "multi_agent", "-c", "tools.web_search=true",
  ];
  const nativeArgv = [
    "/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
    "app-server", "--listen", "ws://127.0.0.1:4500",
    "--enable", "multi_agent", "-c", "tools.web_search=true",
  ];
  const environ = (codexHome?: string) =>
    ["PATH=/usr/bin", ...(codexHome ? [`CODEX_HOME=${codexHome}`] : [])].join("\0") + "\0";

  function codexDeps(argv: string[], over: Partial<OrphanReaperDeps> = {}): { deps: OrphanReaperDeps; kill: ReturnType<typeof vi.fn> } {
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    return {
      kill,
      deps: {
        loadedSessions: [],
        sentinelRoot: tmpRoot,
        sessionsRoot: tmpRoot,
        platform: () => "linux",
        listProcPids: () => [7100],
        readStat: () => fakeStat("codex", 1),
        readCmdline: () => argv.join("\0") + "\0",
        killCheck: () => alive,
        kill,
        sleep: async () => {},
        now: () => 1_700_000_001_000,
        codexHomeRoot: CODEX_HOME_ROOT,
        readEnviron: () => environ(),
        ...over,
      },
    };
  }
  const skippedUnownedCodex = () =>
    warnSpy.mock.calls.filter((c: unknown[]) => (c[2] as { event?: string } | undefined)?.event === "orphan_reaper.skipped_unowned_codex");

  it("classifyArgv marks both the node wrapper and the native binary as codex app-server", () => {
    expect(classifyArgv(wrapperArgv).isCodexAppServer).toBe(true);
    expect(classifyArgv(nativeArgv).isCodexAppServer).toBe(true);
    // An unrelated binary that merely has an `app-server` token is not codex.
    expect(classifyArgv(["/usr/bin/python3", "app-server"]).isCodexAppServer).toBe(false);
  });

  it("a foreign `codex app-server` (VS Code extension: no sidecar, no Companion CODEX_HOME) is NOT signalled", async () => {
    // The extension's process has no CODEX_HOME or the user's ~/.codex.
    const { deps, kill } = codexDeps(["/home/dev/.vscode-server/extensions/openai.chatgpt/bin/codex", "app-server"], {
      readEnviron: () => environ("/home/auracomp/.codex"),
    });
    const sum = await reapOrphans(deps);
    expect(kill).not.toHaveBeenCalled();
    expect(sum.reaped).toBe(0);
    expect(sum.skippedNoSessionMatch).toBe(1);
    // No sentinel for a process we decided not to touch.
    expect(existsSync(join(tmpRoot, REAPING_SENTINEL_SUBDIR, "7100.json"))).toBe(false);
    expect(skippedUnownedCodex()).toHaveLength(1);
    expect(skippedUnownedCodex()[0][2]).toMatchObject({ pid: 7100 });
  });

  it("another user's `codex app-server` (environ unreadable → EACCES) is NOT signalled", async () => {
    // Mirrors the root-owned app-server daemon on the prod box: the service
    // user cannot read its environ; an unreadable environ is no proof.
    const { deps, kill } = codexDeps(nativeArgv, {
      readEnviron: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
    });
    const sum = await reapOrphans(deps);
    expect(kill).not.toHaveBeenCalled();
    expect(sum.reaped).toBe(0);
    expect(skippedUnownedCodex()).toHaveLength(1);
  });

  it("a CODEX_HOME that only looks similar (outside our codex-home root, unknown session) is NOT proof", async () => {
    const { deps, kill } = codexDeps(nativeArgv, {
      readEnviron: () => environ("/tmp/elsewhere/codex-home/some-session"),
    });
    await reapOrphans(deps);
    expect(kill).not.toHaveBeenCalled();
  });

  it("our orphaned node wrapper is reaped via the sidecar argv hash", async () => {
    // The sidecar written at spawn hashes exactly the wrapper argv.
    writeRuntimeSidecar(tmpRoot, "sess-codex", {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      pid: 5000,
      processStartMs: 1_700_000_000_000,
      argvSha256: argvSha256(wrapperArgv),
    });
    const { deps, kill } = codexDeps(wrapperArgv, {
      loadedSessions: [{ sessionId: "sess-codex", pid: undefined }],
    });
    const sum = await reapOrphans(deps);
    expect(kill).toHaveBeenCalledWith(7100, "SIGTERM");
    expect(sum.reaped).toBe(1);
    const reaped = infoSpy.mock.calls.find((c: unknown[]) => (c[2] as { event?: string } | undefined)?.event === "orphan_reaped");
    expect(reaped?.[2]).toMatchObject({ codexOwnershipProof: "sidecar_argv" });
  });

  it("our orphaned native child (wrapper gone, argv matches no sidecar) is reaped via its per-session CODEX_HOME", async () => {
    // The sidecar exists but hashes the WRAPPER argv, so the native child
    // can only prove ownership through the inherited CODEX_HOME. The session
    // was since deleted (not loaded) — still ours: the home is under our root.
    writeRuntimeSidecar(tmpRoot, "sess-codex", {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      pid: 5000,
      processStartMs: 1_700_000_000_000,
      argvSha256: argvSha256(wrapperArgv),
    });
    const { deps, kill } = codexDeps(nativeArgv, {
      loadedSessions: [{ sessionId: "sess-codex", pid: undefined }],
      readEnviron: () => environ(`${CODEX_HOME_ROOT}/f1a26243-bb3a-41cf-b9ae-7e301bfec91d`),
    });
    const sum = await reapOrphans(deps);
    expect(kill).toHaveBeenCalledWith(7100, "SIGTERM");
    expect(sum.reaped).toBe(1);
    const reaped = infoSpy.mock.calls.find((c: unknown[]) => (c[2] as { event?: string } | undefined)?.event === "orphan_reaped");
    expect(reaped?.[2]).toMatchObject({ codexOwnershipProof: "codex_home_env" });
  });

  it("a per-launch codexHome override still proves ownership when the dir is named after a loaded session", async () => {
    const { deps, kill } = codexDeps(nativeArgv, {
      loadedSessions: [{ sessionId: "sess-override", pid: undefined }],
      readEnviron: () => environ("/srv/custom-codex/sess-override"),
    });
    const sum = await reapOrphans(deps);
    expect(kill).toHaveBeenCalledWith(7100, "SIGTERM");
    expect(sum.reaped).toBe(1);
  });

  it("codexHomeFromEnviron / isCompanionCodexSessionHome parse and match exactly", () => {
    expect(codexHomeFromEnviron("A=1\0CODEX_HOME=/x/y\0B=2\0")).toBe("/x/y");
    expect(codexHomeFromEnviron("A=1\0")).toBeNull();
    expect(codexHomeFromEnviron("CODEX_HOME=\0")).toBeNull();
    const none = new Set<string>();
    expect(isCompanionCodexSessionHome(`${CODEX_HOME_ROOT}/abc`, CODEX_HOME_ROOT, none)).toBe(true);
    // The root itself, or a nested path, is not a per-session home.
    expect(isCompanionCodexSessionHome(CODEX_HOME_ROOT, CODEX_HOME_ROOT, none)).toBe(false);
    expect(isCompanionCodexSessionHome(`${CODEX_HOME_ROOT}/abc/def`, CODEX_HOME_ROOT, none)).toBe(false);
    // `..` traversal resolves out of the root.
    expect(isCompanionCodexSessionHome(`${CODEX_HOME_ROOT}/../other`, CODEX_HOME_ROOT, none)).toBe(false);
  });
});
