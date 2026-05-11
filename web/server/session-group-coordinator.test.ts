import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionGroupCoordinator,
  type SessionKiller,
  type SessionSpawner,
  type SpawnedSession,
} from "./session-group-coordinator.js";

function makeSpawner(): SessionSpawner & { calls: Parameters<SessionSpawner>[0][] } {
  const calls: Parameters<SessionSpawner>[0][] = [];
  let n = 0;
  const fn: SessionSpawner = async (opts) => {
    calls.push(opts);
    n++;
    return { sessionId: `sess-${n}` } satisfies SpawnedSession;
  };
  (fn as SessionSpawner & { calls: Parameters<SessionSpawner>[0][] }).calls = calls;
  return fn as SessionSpawner & { calls: Parameters<SessionSpawner>[0][] };
}

let coord: SessionGroupCoordinator;
let spawn: ReturnType<typeof makeSpawner>;
let kill: ReturnType<typeof vi.fn<SessionKiller>>;

beforeEach(() => {
  spawn = makeSpawner();
  kill = vi.fn(async () => {});
  coord = new SessionGroupCoordinator({ spawn, kill });
});

describe("SessionGroupCoordinator.createGroup", () => {
  // Happy path: both spawns called with same sessionGroupId, both halves
  // recorded with their respective roles, status is `active`.
  it("spawns both halves with the same sessionGroupId and active status", async () => {
    const record = await coord.createGroup({
      cwd: "/work/repo",
      primary: "claude",
      observer: "claude",
    });
    expect(record.status).toBe("active");
    expect(record.primary.sessionId).toBe("sess-1");
    expect(record.observer.sessionId).toBe("sess-2");
    expect(spawn.calls).toHaveLength(2);
    expect(spawn.calls[0]?.sessionGroupRole).toBe("orchestrator");
    expect(spawn.calls[1]?.sessionGroupRole).toBe("observer");
    expect(spawn.calls[0]?.sessionGroupId).toBe(spawn.calls[1]?.sessionGroupId);
    expect(record.sessionGroupId).toMatch(/^grp_[a-f0-9]{32}$/);
  });

  // Hunt: server-side allow-list check. Browser-supplied unsupported
  // pairings must be rejected before any spawn runs.
  it("rejects unsupported pairings without spawning", async () => {
    await expect(
      coord.createGroup({ cwd: "/work/repo", primary: "codex", observer: "codex" }),
    ).rejects.toThrow(/unsupported pairing/);
    expect(spawn.calls).toHaveLength(0);
  });

  // Atomic rollback — TS-Async expert's "all-or-nothing" recommendation.
  // If the observer spawn fails after the primary is live, the primary
  // must be killed so no orphan survives.
  it("rolls back the primary when the observer spawn fails", async () => {
    let n = 0;
    const failingSpawn: SessionSpawner = async () => {
      n++;
      if (n === 2) throw new Error("observer-spawn-failed");
      return { sessionId: `sess-${n}` };
    };
    const failingKill = vi.fn(async () => {});
    const c = new SessionGroupCoordinator({ spawn: failingSpawn, kill: failingKill });
    await expect(
      c.createGroup({ cwd: "/work/repo", primary: "claude", observer: "claude" }),
    ).rejects.toThrow(/observer-spawn-failed/);
    expect(failingKill).toHaveBeenCalledOnce();
    expect(failingKill).toHaveBeenCalledWith("sess-1");
  });

  // Defence-in-depth — if the FIRST spawn fails there is nothing to roll
  // back and we must not pretend to kill a nonexistent session.
  it("does not call kill when the primary spawn itself fails", async () => {
    const alwaysFail: SessionSpawner = async () => {
      throw new Error("primary-spawn-failed");
    };
    const killFn = vi.fn(async () => {});
    const c = new SessionGroupCoordinator({ spawn: alwaysFail, kill: killFn });
    await expect(
      c.createGroup({ cwd: "/work/repo", primary: "claude", observer: "claude" }),
    ).rejects.toThrow(/primary-spawn-failed/);
    expect(killFn).not.toHaveBeenCalled();
  });

  // Two groups created in sequence must get distinct IDs. Collisions
  // would be a catastrophic confusion of pairs.
  it("generates a fresh sessionGroupId per group", async () => {
    const a = await coord.createGroup({ cwd: "/a", primary: "claude", observer: "claude" });
    const b = await coord.createGroup({ cwd: "/b", primary: "claude", observer: "claude" });
    expect(a.sessionGroupId).not.toBe(b.sessionGroupId);
  });
});

describe("SessionGroupCoordinator.applyEvent / lookup", () => {
  it("applies state-machine events and returns the resulting status", async () => {
    const g = await coord.createGroup({ cwd: "/work", primary: "claude", observer: "claude" });
    expect(coord.applyEvent(g.sessionGroupId, { type: "half_died", role: "observer" })).toBe("degraded");
    expect(coord.applyEvent(g.sessionGroupId, { type: "half_respawned", role: "observer" })).toBe("active");
  });

  it("returns null when applyEvent targets an unknown group", () => {
    expect(coord.applyEvent("does-not-exist", { type: "both_ready" })).toBeNull();
  });

  it("findBySessionId resolves either half to its group", async () => {
    const g = await coord.createGroup({ cwd: "/work", primary: "claude", observer: "claude" });
    expect(coord.findBySessionId(g.primary.sessionId)?.sessionGroupId).toBe(g.sessionGroupId);
    expect(coord.findBySessionId(g.observer.sessionId)?.sessionGroupId).toBe(g.sessionGroupId);
    expect(coord.findBySessionId("unrelated")).toBeUndefined();
  });
});

describe("SessionGroupCoordinator.archiveGroup", () => {
  it("transitions to archived and kills both halves", async () => {
    const g = await coord.createGroup({ cwd: "/work", primary: "claude", observer: "claude" });
    const ok = await coord.archiveGroup(g.sessionGroupId);
    expect(ok).toBe(true);
    expect(coord.get(g.sessionGroupId)?.status).toBe("archived");
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenNthCalledWith(1, g.primary.sessionId);
    expect(kill).toHaveBeenNthCalledWith(2, g.observer.sessionId);
  });

  // TS-Async: status flips BEFORE the kill calls so that a session-exit
  // event from the first kill cannot trigger a respawn racing the second.
  // We exercise this by checking that, even if kill throws on the first
  // call, the status is already terminal AND the second kill is still attempted.
  it("flips status to archived even if a kill call throws; both kills attempted", async () => {
    const killFn = vi.fn(async (id: string) => {
      if (id === "sess-1") throw new Error("kill-1-failed");
    });
    const c = new SessionGroupCoordinator({ spawn, kill: killFn });
    const g = await c.createGroup({ cwd: "/w", primary: "claude", observer: "claude" });
    const ok = await c.archiveGroup(g.sessionGroupId);
    expect(ok).toBe(true);
    expect(c.get(g.sessionGroupId)?.status).toBe("archived");
    expect(killFn).toHaveBeenCalledTimes(2);
  });

  it("returns false for an unknown group", async () => {
    expect(await coord.archiveGroup("does-not-exist")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
