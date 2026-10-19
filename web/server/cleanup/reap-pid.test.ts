import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyArgv, splitCmdline } from "../orphan-reaper.js";

// The sentinel-marker fs helpers are mocked so no real `.reaping/<pid>.json` is
// written; we assert the reap SEQUENCE (write → verify → SIGTERM → delete) and
// its outcome mapping via injected syscall seams. writeReapingMarker's throw
// path is the only one we drive by making the mock throw.
const writeReapingMarker = vi.fn();
const deleteReapingMarker = vi.fn();
vi.mock("./sentinel-markers.js", () => ({
  writeReapingMarker: (...a: unknown[]) => writeReapingMarker(...a),
  deleteReapingMarker: (...a: unknown[]) => deleteReapingMarker(...a),
}));

import { reapPidWithSentinel } from "./reap-pid.js";

// A realistic Companion-spawned claude argv (NUL-joined like /proc/<pid>/cmdline)
// and the argv sha classifyArgv derives from it — the TOCTOU anchor.
const OWNED_CMDLINE = ["claude", "--print", "--output-format", "stream-json", "--model", "claude-opus-5"].join("\0");
const OWNED_SHA = classifyArgv(splitCmdline(OWNED_CMDLINE)).argvSha256;
// A DIFFERENT companion argv → still companion-shaped, but a different sha.
const OTHER_CMDLINE = ["claude", "--print", "--output-format", "stream-json", "--model", "claude-sonnet-5"].join("\0");
// /proc/<pid>/stat with ppid=1 (field 4) — a reparented orphan.
const STAT_PPID1 = "4321 (claude) S 1 0 0 0 -1";
const STAT_PPID2 = "4321 (claude) S 2 0 0 0 -1"; // reparented to a live parent → not an orphan

// Base seams: identity still matches at the re-check, process exits after SIGTERM.
function seams(over: Record<string, unknown> = {}) {
  return {
    sentinelRoot: "/tmp/reap-root",
    reason: "orphan",
    expectedArgvSha256: OWNED_SHA,
    readStat: () => STAT_PPID1,
    readCmdline: () => OWNED_CMDLINE,
    kill: vi.fn(),
    killCheck: () => false, // gone after SIGTERM → reaped
    sleep: vi.fn(async () => {}),
    now: () => 0,
    graceMs: 1500,
    pollMs: 100,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reapPidWithSentinel", () => {
  it("reaps an identity-verified orphan: sentinel written, SIGTERM sent, sentinel deleted", async () => {
    const s = seams();
    const outcome = await reapPidWithSentinel(4321, s);
    expect(outcome).toBe("reaped");
    expect(writeReapingMarker).toHaveBeenCalledOnce();
    expect(s.kill).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(deleteReapingMarker).toHaveBeenCalledWith("/tmp/reap-root", 4321);
  });

  it("returns already-gone (no double-signal) when SIGTERM races an ESRCH exit", async () => {
    const kill = vi.fn(() => { const e = new Error("no such process") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; });
    const outcome = await reapPidWithSentinel(4321, seams({ kill }));
    expect(outcome).toBe("already-gone");
    expect(deleteReapingMarker).toHaveBeenCalled();
  });

  it("aborts (no kill) when ppid is no longer 1 — the pid was reparented since classify (TOCTOU)", async () => {
    const kill = vi.fn();
    const outcome = await reapPidWithSentinel(4321, seams({ readStat: () => STAT_PPID2, kill }));
    expect(outcome).toBe("aborted-drift");
    expect(kill).not.toHaveBeenCalled();
    expect(deleteReapingMarker).toHaveBeenCalled(); // sentinel cleaned up on abort
  });

  it("aborts (no kill) when the argv no longer hashes to the classified sha — PID reuse", async () => {
    const kill = vi.fn();
    const outcome = await reapPidWithSentinel(4321, seams({ readCmdline: () => OTHER_CMDLINE, kill }));
    expect(outcome).toBe("aborted-drift");
    expect(kill).not.toHaveBeenCalled();
  });

  it("aborts when /proc read throws mid-window (pid vanished)", async () => {
    const kill = vi.fn();
    const outcome = await reapPidWithSentinel(4321, seams({
      readStat: () => { throw new Error("ENOENT"); }, kill,
    }));
    expect(outcome).toBe("aborted-drift");
    expect(kill).not.toHaveBeenCalled();
  });

  it("returns kill-failed and cleans the sentinel when SIGTERM errors non-ESRCH (e.g. EPERM)", async () => {
    const kill = vi.fn(() => { const e = new Error("perm") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; });
    const outcome = await reapPidWithSentinel(4321, seams({ kill }));
    expect(outcome).toBe("kill-failed");
    expect(deleteReapingMarker).toHaveBeenCalled();
  });

  it("returns sentinel-failed and NEVER signals when the sentinel write throws (EC-8 fail-closed)", async () => {
    writeReapingMarker.mockImplementationOnce(() => { const e = new Error("EROFS") as NodeJS.ErrnoException; e.code = "EROFS"; throw e; });
    const kill = vi.fn();
    const outcome = await reapPidWithSentinel(4321, seams({ kill }));
    expect(outcome).toBe("sentinel-failed");
    expect(kill).not.toHaveBeenCalled();
    expect(deleteReapingMarker).not.toHaveBeenCalled();
  });

  it("polls for exit after SIGTERM: waits while the pid is still alive, then reaps once it goes", async () => {
    // killCheck: alive on the first poll, gone on the second → the grace loop
    // sleeps once and then observes exit.
    let calls = 0;
    const killCheck = vi.fn(() => { calls += 1; return calls < 2; });
    const sleep = vi.fn(async () => {});
    let t = 0;
    const now = vi.fn(() => { t += 100; return t; });
    const outcome = await reapPidWithSentinel(4321, seams({ killCheck, sleep, now, graceMs: 100000 }));
    expect(outcome).toBe("reaped");
    expect(sleep).toHaveBeenCalled(); // at least one poll iteration ran
  });
});
