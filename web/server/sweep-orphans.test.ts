import { describe, it, expect, vi } from "vitest";
import {
  computeSweepCandidates,
  executeSweep,
  sweepPreviewToken,
  type SweepComputeDeps,
  type SweepCandidate,
} from "./sweep-orphans.js";
import { classifyArgv, splitCmdline } from "./orphan-reaper.js";

// A realistic Companion-spawned claude argv (NUL-joined as /proc/<pid>/cmdline
// would present it). classifyArgv derives the ownership sha from it; we mirror
// that so the test is robust to the exact hashing.
const OWNED_CMDLINE = ["claude", "--print", "--output-format", "stream-json", "--model", "claude-opus-5"].join("\0");
const OWNED_SHA = classifyArgv(splitCmdline(OWNED_CMDLINE)).argvSha256;

function baseDeps(over: Partial<SweepComputeDeps> = {}): SweepComputeDeps {
  return {
    listSessions: () => [],
    sessionsRoot: "/tmp/does-not-matter",
    now: () => 10_000_000,
    ageThresholdMs: 1000,
    // No real /proc reads — everything injected.
    listProcPids: () => [],
    readCmdline: () => OWNED_CMDLINE,
    killCheck: () => true,
    readOwnedArgvShas: () => new Map(),
    listOrphanTimers: () => [],
    ...over,
  };
}

describe("computeSweepCandidates — safety core", () => {
  it("lists a server-owned orphan process (argv sha in the owned map, pid not a live session)", () => {
    const out = computeSweepCandidates(baseDeps({
      listProcPids: () => [4321],
      readOwnedArgvShas: () => new Map([[OWNED_SHA, "sess_owner"]]),
    }));
    const orphan = out.find((c) => c.reason === "orphan");
    expect(orphan).toBeDefined();
    expect(orphan!.pid).toBe(4321);
    expect(orphan!.sessionId).toBe("sess_owner");
    expect(orphan!.argvSha256).toBe(OWNED_SHA);
  });

  it("NEVER lists a process whose argv sha is not server-owned (a foreign agent's process)", () => {
    const out = computeSweepCandidates(baseDeps({
      listProcPids: () => [4321],
      readOwnedArgvShas: () => new Map(), // owned map empty → not ours
    }));
    expect(out.some((c) => c.reason === "orphan")).toBe(false);
  });

  it("excludes the caller's own session pid from orphan candidates (AC3)", () => {
    const out = computeSweepCandidates(baseDeps({
      callerSessionId: "sess_me",
      listSessions: () => [{ sessionId: "sess_me", pid: 4321, state: "connected", createdAt: 0 } as any],
      listProcPids: () => [4321],
      readOwnedArgvShas: () => new Map([[OWNED_SHA, "sess_me"]]),
    }));
    expect(out.some((c) => c.pid === 4321)).toBe(false);
  });

  it("excludes a live (non-archived connected/running) session's pid from orphan candidates (AC3)", () => {
    const out = computeSweepCandidates(baseDeps({
      listSessions: () => [{ sessionId: "sess_live", pid: 4321, state: "running", createdAt: 0 } as any],
      listProcPids: () => [4321],
      readOwnedArgvShas: () => new Map([[OWNED_SHA, "sess_live"]]),
    }));
    expect(out.some((c) => c.pid === 4321)).toBe(false);
  });

  it("lists an archived-leak: archived session, alive pid, older than threshold", () => {
    const out = computeSweepCandidates(baseDeps({
      listSessions: () => [{ sessionId: "sess_arch", pid: 777, archived: true, createdAt: 0 } as any],
      killCheck: (pid) => pid === 777,
    }));
    const leak = out.find((c) => c.reason === "archived-leak");
    expect(leak).toBeDefined();
    expect(leak!.sessionId).toBe("sess_arch");
    expect(leak!.pid).toBe(777);
  });

  it("does NOT list an archived session that is too fresh (age <= threshold)", () => {
    const out = computeSweepCandidates(baseDeps({
      now: () => 500, // createdAt 0, threshold 1000 → age 500 < 1000
      listSessions: () => [{ sessionId: "sess_fresh", pid: 777, archived: true, createdAt: 0 } as any],
    }));
    expect(out.some((c) => c.reason === "archived-leak")).toBe(false);
  });

  it("lists a stale-session: exited record older than threshold", () => {
    const out = computeSweepCandidates(baseDeps({
      listSessions: () => [{ sessionId: "sess_stale", state: "exited", createdAt: 0 } as any],
    }));
    expect(out.some((c) => c.reason === "stale-session" && c.sessionId === "sess_stale")).toBe(true);
  });

  it("lists orphaned timers from the injected registry diff", () => {
    const out = computeSweepCandidates(baseDeps({
      listOrphanTimers: () => [{ id: "grp_x", kind: "council-watcher", sessionId: "sess_dead" } as any],
    }));
    const t = out.find((c) => c.reason === "orphan-timer");
    expect(t).toBeDefined();
    expect(t!.id).toBe("orphan-timer:grp_x");
  });

  it("returns an empty set when nothing qualifies (AC6)", () => {
    expect(computeSweepCandidates(baseDeps())).toEqual([]);
  });
});

describe("sweepPreviewToken", () => {
  it("is deterministic and order-independent over candidate ids", () => {
    const a = [{ id: "orphan:1" }, { id: "stale-session:x" }] as SweepCandidate[];
    const b = [{ id: "stale-session:x" }, { id: "orphan:1" }] as SweepCandidate[];
    expect(sweepPreviewToken(a)).toBe(sweepPreviewToken(b));
    expect(sweepPreviewToken(a)).not.toBe(sweepPreviewToken([{ id: "orphan:2" }] as SweepCandidate[]));
  });
});

describe("executeSweep", () => {
  it("is a safe no-op on an empty candidate set (AC6)", async () => {
    const killTrackedSession = vi.fn();
    const res = await executeSweep([], { sentinelRoot: "/tmp/s", killTrackedSession });
    expect(res).toEqual({ requested: 0, swept: 0, skipped: 0, perReason: { orphan: 0, "archived-leak": 0, "stale-session": 0, "orphan-timer": 0 } });
    expect(killTrackedSession).not.toHaveBeenCalled();
  });

  it("routes archived-leak / stale-session kills through the launcher's tracked-kill seam", async () => {
    const killTrackedSession = vi.fn();
    const audit = vi.fn();
    const res = await executeSweep(
      [
        { id: "archived-leak:a", reason: "archived-leak", sessionId: "a", evidence: "", ageMs: 0 },
        { id: "stale-session:b", reason: "stale-session", sessionId: "b", evidence: "", ageMs: 0 },
      ],
      { sentinelRoot: "/tmp/s", killTrackedSession, audit },
    );
    expect(killTrackedSession).toHaveBeenCalledWith("a");
    expect(killTrackedSession).toHaveBeenCalledWith("b");
    expect(res.swept).toBe(2);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("clears an orphan-timer via the orchestrator teardown seam, stripping the id prefix", async () => {
    const clearOrphanTimer = vi.fn();
    const res = await executeSweep(
      [{ id: "orphan-timer:grp_x", reason: "orphan-timer", sessionId: "s", evidence: "", ageMs: 0 }],
      { sentinelRoot: "/tmp/s", killTrackedSession: vi.fn(), clearOrphanTimer },
    );
    expect(clearOrphanTimer).toHaveBeenCalledWith("grp_x");
    expect(res.swept).toBe(1);
  });

  it("reaps an orphan pid through the sentinel helper (injected seam) and counts it swept", async () => {
    const kill = vi.fn();
    const res = await executeSweep(
      [{ id: "orphan:999", reason: "orphan", pid: 999, argvSha256: OWNED_SHA, evidence: "", ageMs: 0 }],
      {
        sentinelRoot: "/tmp/s",
        killTrackedSession: vi.fn(),
        // Inject the reap seam so no real /proc or SIGTERM happens: identity
        // still matches at the TOCTOU re-check, process "exits" after SIGTERM.
        reapSeam: {
          readStat: () => "999 (claude) S 1 0 0", // stable across the re-check
          readCmdline: () => OWNED_CMDLINE,
          kill,
          killCheck: () => false, // already gone after signal → reaped
          sleep: async () => {},
          now: () => 0,
        },
      },
    );
    expect(res.swept).toBe(1);
    expect(res.perReason.orphan).toBe(1);
  });
});
