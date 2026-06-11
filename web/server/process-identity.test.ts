import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  verifyProcessIdentity,
  verifyProcessIdentityByArgv,
  setProcReaderForTests,
  __resetProcReaderForTests,
  __resetUnavailableWarnedForTests,
  __INTERNAL_FOR_TESTS,
  type ProcReader,
} from "./process-identity.js";

// ─── helpers ─────────────────────────────────────────────────────────────

/** Build a synthetic `/proc/<pid>/cmdline` payload — args separated by NUL. */
function makeCmdline(...args: string[]): string {
  // The kernel typically appends a trailing NUL; splitCmdline filters
  // empties so behaviour is identical either way.
  return args.join("\0") + "\0";
}

/**
 * Build a synthetic `/proc/<pid>/stat` line. Field-22 starttime lands
 * at the right position (state, ppid, pgrp, session, tty_nr, tpgid,
 * flags, minflt, cminflt, majflt, cmajflt, utime, stime, cutime, cstime,
 * priority, nice, num_threads, itrealvalue, starttime).
 */
function makeStatLine(comm: string, starttimeTicks: number): string {
  // 19 placeholder fields after the closing paren before starttime.
  const placeholders = Array.from({ length: 19 }, (_, i) => String(i + 1)).join(" ");
  return `1234 (${comm}) ${placeholders} ${starttimeTicks} extra_padding_field`;
}

/** Build a synthetic `/proc/stat` payload with a btime line. */
function makeBootStat(btimeSecs: number): string {
  return `cpu  100 200 300\nbtime ${btimeSecs}\nprocesses 999\n`;
}

const SESSION_ID = "sess_abc123";
const URL_TOKEN = `ws://localhost:3456/ws/cli/${SESSION_ID}`;
const BOOT_SECS = 1_700_000_000;
const CLK_TCK = 100;
// 1000 ticks @ 100Hz = 10s after boot
const START_TICKS = 1000;
const EXPECTED_START_MS = BOOT_SECS * 1000 + (START_TICKS * 1000) / CLK_TCK;

function installHappyReader(overrides: Partial<ProcReader> = {}): void {
  setProcReaderForTests({
    platform: () => "linux",
    killCheck: () => true,
    readCmdline: () => makeCmdline("claude", "--sdk-url", URL_TOKEN, "--resume", "cli_xyz"),
    readStat: () => makeStatLine("claude", START_TICKS),
    readBootStat: () => makeBootStat(BOOT_SECS),
    clkTck: CLK_TCK,
    ...overrides,
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  // AP-17: reset the one-time WARN flag so each test starts cold.
  __resetProcReaderForTests();
  __resetUnavailableWarnedForTests();
  const loggerModule = await import("./logger.js");
  warnSpy = vi.spyOn(loggerModule.log, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  __resetProcReaderForTests();
  __resetUnavailableWarnedForTests();
  vi.restoreAllMocks();
});

// ─── pure-internal slice ────────────────────────────────────────────────

describe("splitCmdline", () => {
  // Defensive: kernel often appends a trailing NUL → empty tail must
  // not become a phantom token (would shift indexOf("--sdk-url") off
  // by one in some pathological argv).
  it("strips empty tokens produced by trailing NULs", () => {
    expect(__INTERNAL_FOR_TESTS.splitCmdline("a\0b\0\0")).toEqual(["a", "b"]);
  });
});

describe("argvMatchesSessionId", () => {
  // Happy: `--sdk-url <url>` adjacent, URL's last path segment = sessionId.
  it("matches on exact-token, last-segment URL path", () => {
    const tokens = ["claude", "--sdk-url", URL_TOKEN, "--resume", "cli_x"];
    expect(__INTERNAL_FOR_TESTS.argvMatchesSessionId(tokens, SESSION_ID)).toBe(true);
  });

  // Anti-spec: substring match via String.includes would say yes —
  // exact-token must say no — when the sessionId is embedded in an
  // unrelated argv token (e.g., a cwd path).
  it("rejects substring-only embedding (e.g., sessionId in cwd token)", () => {
    const tokens = ["claude", "--cwd", `/tmp/${SESSION_ID}/work`, "--sdk-url", "ws://localhost/other"];
    expect(__INTERNAL_FOR_TESTS.argvMatchesSessionId(tokens, SESSION_ID)).toBe(false);
  });

  // The --sdk-url flag MUST be followed by its argument; trailing flag
  // = malformed argv = no match (rather than indexing past the end).
  it("rejects when --sdk-url is the last token (no value)", () => {
    const tokens = ["claude", "--sdk-url"];
    expect(__INTERNAL_FOR_TESTS.argvMatchesSessionId(tokens, SESSION_ID)).toBe(false);
  });

  // The URL token's last path segment must equal the sessionId exactly
  // — a sessionId that's a prefix of another should NOT match.
  it("rejects prefix-only URL path match", () => {
    const tokens = ["claude", "--sdk-url", `ws://localhost:3456/ws/cli/${SESSION_ID}_extra`];
    expect(__INTERNAL_FOR_TESTS.argvMatchesSessionId(tokens, SESSION_ID)).toBe(false);
  });

  // Malformed URL → no match (fail-CLOSED on parse error).
  it("rejects malformed URL token", () => {
    const tokens = ["claude", "--sdk-url", "not a url"];
    expect(__INTERNAL_FOR_TESTS.argvMatchesSessionId(tokens, SESSION_ID)).toBe(false);
  });
});

describe("parseBootTimeSecs", () => {
  it("extracts btime from /proc/stat", () => {
    expect(__INTERNAL_FOR_TESTS.parseBootTimeSecs(makeBootStat(BOOT_SECS))).toBe(BOOT_SECS);
  });

  it("throws when btime is missing", () => {
    expect(() => __INTERNAL_FOR_TESTS.parseBootTimeSecs("cpu 1 2 3\n")).toThrow(/btime/);
  });
});

describe("parseStartTimeTicks", () => {
  // The `comm` field can legitimately contain parens — the parser
  // must use the LAST `)`, not the first.
  it("handles comm containing parens", () => {
    const line = makeStatLine("bash) -i (login", 4242);
    expect(__INTERNAL_FOR_TESTS.parseStartTimeTicks(line)).toBe(4242);
  });
});

describe("ticksToWallMs", () => {
  it("converts ticks at CLK_TCK=100 to ms-since-epoch", () => {
    // boot at second BOOT_SECS, started 10s after boot:
    expect(__INTERNAL_FOR_TESTS.ticksToWallMs(1000, BOOT_SECS, 100)).toBe(BOOT_SECS * 1000 + 10_000);
  });
});

// ─── full verifyProcessIdentity ────────────────────────────────────────

describe("verifyProcessIdentity — match", () => {
  // Round-trip happy: liveness + argv + starttime all agree.
  it("returns {kind:'match'} when all three factors agree", () => {
    installHappyReader();
    expect(verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS)).toEqual({ kind: "match" });
  });

  // ±2s tolerance per spec — a 1s drift must still match (NTP slew is
  // commonly ~100ms per sync).
  it("tolerates ±2s starttime drift", () => {
    installHappyReader();
    expect(verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS + 1500)).toEqual({ kind: "match" });
    expect(verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS - 1500)).toEqual({ kind: "match" });
  });
});

describe("verifyProcessIdentity — mismatch", () => {
  // argv-shape mismatch — kernel says the process exists but its argv
  // doesn't carry our sessionId → PID reuse by an unrelated process.
  it("returns {kind:'mismatch', reason:'argv'} when argv lacks --sdk-url for this session", () => {
    installHappyReader({
      readCmdline: () => makeCmdline("other_proc", "--unrelated"),
    });
    expect(verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS)).toEqual({
      kind: "mismatch",
      reason: "argv",
    });
  });

  // starttime mismatch beyond tolerance — same argv shape (could be a
  // re-spawned process that grabbed the same URL after a crash) but the
  // wallclock anchor differs. Conservative: treat as mismatch.
  it("returns {kind:'mismatch', reason:'starttime'} when wallclock anchor differs by >2s", () => {
    installHappyReader();
    expect(verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS + 5000)).toEqual({
      kind: "mismatch",
      reason: "starttime",
    });
  });
});

describe("verifyProcessIdentity — gone", () => {
  // Liveness check fails → kernel reports the PID does not exist.
  it("returns {kind:'gone'} when process.kill returns false", () => {
    installHappyReader({ killCheck: () => false });
    expect(verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS)).toEqual({ kind: "gone" });
  });

  // Fail-CLOSED: ANY /proc read error → "gone". The spec is explicit
  // — we'd rather false-relaunch (idempotent) than false-skip-relaunch
  // (silent data loss).
  it("returns {kind:'gone'} when /proc/<pid>/cmdline read throws (race)", () => {
    installHappyReader({
      readCmdline: () => {
        const e: NodeJS.ErrnoException = new Error("ESRCH");
        e.code = "ESRCH";
        throw e;
      },
    });
    expect(verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS)).toEqual({ kind: "gone" });
  });

  // Same fail-CLOSED contract applies to /proc/<pid>/stat — race
  // between liveness check and starttime read.
  it("returns {kind:'gone'} when /proc/<pid>/stat read throws", () => {
    installHappyReader({
      readStat: () => {
        throw new Error("ESRCH");
      },
    });
    expect(verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS)).toEqual({ kind: "gone" });
  });

  // And to /proc/stat (the system-wide boot time file) — if it's
  // unreadable we can't anchor starttime, fail-CLOSED.
  it("returns {kind:'gone'} when /proc/stat read throws", () => {
    installHappyReader({
      readBootStat: () => {
        throw new Error("EACCES");
      },
    });
    expect(verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS)).toEqual({ kind: "gone" });
  });
});

describe("verifyProcessIdentity — Phase A two-factor degraded mode (expectedStartMs=null)", () => {
  // Phase A interim contract: when the sidecar isn't there yet, the
  // caller passes `null` and the helper skips the starttime check —
  // verdict reduces to liveness + argv. Strictly stronger than the
  // bare `process.kill(pid, 0)` it replaces (which had no argv check).
  it("returns {kind:'match'} when liveness + argv agree and expectedStartMs is null", () => {
    installHappyReader();
    expect(verifyProcessIdentity(1234, SESSION_ID, null)).toEqual({ kind: "match" });
  });

  // Argv mismatch must still propagate in degraded mode — the whole
  // point of the upgrade is to catch PID reuse by an unrelated process.
  it("still returns {kind:'mismatch', reason:'argv'} in degraded mode", () => {
    installHappyReader({
      readCmdline: () => makeCmdline("other", "--unrelated"),
    });
    expect(verifyProcessIdentity(1234, SESSION_ID, null)).toEqual({
      kind: "mismatch",
      reason: "argv",
    });
  });

  // Liveness-fail still surfaces — `gone` is the floor regardless of
  // anchor availability.
  it("still returns {kind:'gone'} when killCheck fails in degraded mode", () => {
    installHappyReader({ killCheck: () => false });
    expect(verifyProcessIdentity(1234, SESSION_ID, null)).toEqual({ kind: "gone" });
  });

  // EC-42 mutation resistance: deleting the `expectedStartMs === null`
  // early-return in production would route Phase A's call through the
  // starttime branch which would mismatch unless the anchor was 0 ±2s —
  // a fictitious value Phase A doesn't have. This test fails red in
  // that mutation.
  it("does NOT read /proc/<pid>/stat in degraded mode", () => {
    let statReads = 0;
    installHappyReader({
      readStat: () => {
        statReads += 1;
        return makeStatLine("claude", START_TICKS);
      },
    });
    verifyProcessIdentity(1234, SESSION_ID, null);
    expect(statReads).toBe(0);
  });
});

// ─── generalized argv-predicate seam (resource-reclamation keystone) ────────
//
// `verifyProcessIdentityByArgv` is the process-class-agnostic core. PTY
// terminals carry NO `--sdk-url <sessionId>` token, so the session probe
// would mismatch every one of them; the reaper supplies a terminal-shaped
// predicate instead, with uniqueness resting on liveness + starttime.
describe("verifyProcessIdentityByArgv — generalized predicate core", () => {
  // A shell argv (`/bin/bash -l`) carries no sessionId token, yet a
  // predicate matching the recorded shell binary + the live starttime
  // anchor yields a confident match. This is the path the PTY reaper uses.
  it("returns {kind:'match'} for a terminal-shaped argv when predicate + starttime agree", () => {
    setProcReaderForTests({
      platform: () => "linux",
      killCheck: () => true,
      readCmdline: () => makeCmdline("/bin/bash", "-l"),
      readStat: () => makeStatLine("bash", START_TICKS),
      readBootStat: () => makeBootStat(BOOT_SECS),
      clkTck: CLK_TCK,
    });
    const isOurShell = (tokens: string[]) => tokens[0] === "/bin/bash";
    expect(verifyProcessIdentityByArgv(4321, isOurShell, EXPECTED_START_MS)).toEqual({
      kind: "match",
    });
  });

  // Predicate rejection surfaces as the same {mismatch, argv} verdict the
  // session wrapper produces — PID reuse by an unrelated process class.
  it("returns {kind:'mismatch', reason:'argv'} when the predicate rejects the argv", () => {
    setProcReaderForTests({
      platform: () => "linux",
      killCheck: () => true,
      readCmdline: () => makeCmdline("/usr/bin/python3", "server.py"),
      readStat: () => makeStatLine("python3", START_TICKS),
      readBootStat: () => makeBootStat(BOOT_SECS),
      clkTck: CLK_TCK,
    });
    const isOurShell = (tokens: string[]) => tokens[0] === "/bin/bash";
    expect(verifyProcessIdentityByArgv(4321, isOurShell, EXPECTED_START_MS)).toEqual({
      kind: "mismatch",
      reason: "argv",
    });
  });

  // Starttime PID-reuse defense applies to terminals identically: a
  // matching shell argv but a divergent wallclock anchor → mismatch.
  it("returns {kind:'mismatch', reason:'starttime'} when the anchor differs by >2s", () => {
    setProcReaderForTests({
      platform: () => "linux",
      killCheck: () => true,
      readCmdline: () => makeCmdline("/bin/bash", "-l"),
      readStat: () => makeStatLine("bash", START_TICKS),
      readBootStat: () => makeBootStat(BOOT_SECS),
      clkTck: CLK_TCK,
    });
    const isOurShell = (tokens: string[]) => tokens[0] === "/bin/bash";
    expect(verifyProcessIdentityByArgv(4321, isOurShell, EXPECTED_START_MS + 5000)).toEqual({
      kind: "mismatch",
      reason: "starttime",
    });
  });

  // Degraded mode (no sidecar anchor) reduces to liveness + predicate,
  // mirroring the session wrapper's `expectedStartMs: null` contract.
  it("returns {kind:'match'} in degraded mode (null anchor) when liveness + predicate agree", () => {
    setProcReaderForTests({
      platform: () => "linux",
      killCheck: () => true,
      readCmdline: () => makeCmdline("/bin/bash", "-l"),
    });
    const isOurShell = (tokens: string[]) => tokens[0] === "/bin/bash";
    expect(verifyProcessIdentityByArgv(4321, isOurShell, null)).toEqual({ kind: "match" });
  });

  // Liveness is still the floor — a dead PID is `gone` regardless of the
  // predicate.
  it("returns {kind:'gone'} when the process is dead", () => {
    setProcReaderForTests({ platform: () => "linux", killCheck: () => false });
    expect(verifyProcessIdentityByArgv(4321, () => true, EXPECTED_START_MS)).toEqual({
      kind: "gone",
    });
  });

  // Non-Linux degrades to {unavailable} — the reaper caller no-ops safely
  // on macOS dev boxes (no /proc).
  it("returns {kind:'unavailable'} on non-Linux", () => {
    setProcReaderForTests({ platform: () => "darwin" });
    expect(verifyProcessIdentityByArgv(4321, () => true, EXPECTED_START_MS)).toEqual({
      kind: "unavailable",
      platform: "darwin",
    });
  });
});

describe("verifyProcessIdentity — unavailable (non-Linux)", () => {
  // macOS dev / windows / freebsd → no /proc, return unavailable so
  // the caller degrades gracefully (Phase D's reaper logs WARN and
  // skips, doesn't kill blindly).
  it("returns {kind:'unavailable', platform} on darwin", () => {
    installHappyReader({ platform: () => "darwin" });
    expect(verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS)).toEqual({
      kind: "unavailable",
      platform: "darwin",
    });
  });

  // AP-17 contract: the boot WARN fires EXACTLY ONCE per process,
  // not per call. This is the warn-path test AP-17 mandates.
  it("emits the process_identity.unavailable WARN exactly once per process", () => {
    installHappyReader({ platform: () => "darwin" });
    verifyProcessIdentity(1234, SESSION_ID, EXPECTED_START_MS);
    verifyProcessIdentity(5678, SESSION_ID, EXPECTED_START_MS);
    verifyProcessIdentity(9012, SESSION_ID, EXPECTED_START_MS);
    const unavailWarns = warnSpy.mock.calls.filter((c: unknown[]) => {
      const data = c[2] as Record<string, unknown> | undefined;
      return data?.event === "process_identity.unavailable";
    });
    expect(unavailWarns).toHaveLength(1);
    // Platform string is operator-facing — pin it.
    expect((unavailWarns[0][2] as Record<string, unknown>).platform).toBe("darwin");
  });

  // AP-17 reset: __reset* should clear the latch so a fresh test can
  // exercise the warn-path again (otherwise tests would couple to
  // ordering).
  it("re-arms the WARN after __resetUnavailableWarnedForTests", () => {
    installHappyReader({ platform: () => "darwin" });
    verifyProcessIdentity(1, SESSION_ID, EXPECTED_START_MS);
    __resetUnavailableWarnedForTests();
    verifyProcessIdentity(2, SESSION_ID, EXPECTED_START_MS);
    const unavailWarns = warnSpy.mock.calls.filter((c: unknown[]) => {
      const data = c[2] as Record<string, unknown> | undefined;
      return data?.event === "process_identity.unavailable";
    });
    expect(unavailWarns).toHaveLength(2);
  });
});
