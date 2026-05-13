import { beforeEach, describe, expect, it, vi } from "vitest";
import { GROUP_ID_PATTERN } from "./group-authorization.js";
import {
  type CoordinatorErrorSink,
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
    // Beck F6: pin the structural invariants — length + prefix — alongside
    // the regex. These are the security-relevant facts (entropy budget,
    // canonical prefix); the regex alone could silently drift if both
    // producer and validator are mutated in lockstep.
    expect(record.sessionGroupId.length).toBe(36);
    expect(record.sessionGroupId.startsWith("grp_")).toBe(true);
    expect(record.sessionGroupId).toMatch(GROUP_ID_PATTERN);
  });

  // Beck F7: cross-family pairing is the experimental pairing's value-prop.
  // A bug passing req.primary to both spawn calls (ignoring req.observer)
  // would pass claude+claude tests but break claude+codex.
  it("propagates distinct backendType to each spawn for claude+codex pairing", async () => {
    await coord.createGroup({ cwd: "/work/repo", primary: "claude", observer: "codex" });
    expect(spawn.calls[0]?.backendType).toBe("claude");
    expect(spawn.calls[1]?.backendType).toBe("codex");
  });

  it("rejects unsupported pairings without spawning", async () => {
    await expect(
      coord.createGroup({ cwd: "/work/repo", primary: "codex", observer: "codex" }),
    ).rejects.toThrow(/unsupported pairing/);
    expect(spawn.calls).toHaveLength(0);
  });

  // Atomic rollback — if observer spawn fails after primary is live, the
  // primary must be killed before the error propagates.
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

  // Hunt #7 / Backend-TS F1 / Fowler F5: rollback-kill failures must surface
  // via onError, not silently swallow. Telemetry sink receives the event.
  it("reports rollback-kill failures via onError without masking the original error", async () => {
    let n = 0;
    const failingSpawn: SessionSpawner = async () => {
      n++;
      if (n === 2) throw new Error("observer-spawn-failed");
      return { sessionId: `sess-${n}` };
    };
    const failingKill = vi.fn(async () => {
      throw new Error("kill-also-failed");
    });
    const errors: Parameters<CoordinatorErrorSink>[0][] = [];
    const c = new SessionGroupCoordinator({
      spawn: failingSpawn,
      kill: failingKill,
      onError: (e) => errors.push(e),
    });
    await expect(
      c.createGroup({ cwd: "/work/repo", primary: "claude", observer: "claude" }),
    ).rejects.toThrow(/observer-spawn-failed/);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.op).toBe("rollback_kill");
    expect(errors[0]?.sessionId).toBe("sess-1");
  });

  // Defence-in-depth — if the FIRST spawn fails, no kill is attempted.
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

  // Beck F3: the ordering invariant — status MUST flip before any kill
  // call — was previously documented only in a comment. Now actually
  // asserted: the kill mock observes the status at the moment of each
  // invocation, and we expect both observations to read "archived".
  it("flips status to archived BEFORE either kill is invoked (ordering invariant)", async () => {
    const statusObservations: string[] = [];
    let observingCoord: SessionGroupCoordinator | null = null;
    let observingGroupId = "";
    const killFn = vi.fn(async (_id: string) => {
      statusObservations.push(observingCoord?.get(observingGroupId)?.status ?? "missing");
    });
    observingCoord = new SessionGroupCoordinator({ spawn, kill: killFn });
    const g = await observingCoord.createGroup({ cwd: "/w", primary: "claude", observer: "claude" });
    observingGroupId = g.sessionGroupId;
    await observingCoord.archiveGroup(g.sessionGroupId);
    expect(statusObservations).toEqual(["archived", "archived"]);
  });

  // Subprocess P2-1: re-archive of an already-archived group must early-
  // return WITHOUT firing the kills again. Doubled kill calls cause doubled
  // event traffic and noise; the state-machine discriminator means we can
  // (and should) early-return.
  it("re-archive of an already-archived group is a true no-op (no extra kills)", async () => {
    const g = await coord.createGroup({ cwd: "/w", primary: "claude", observer: "claude" });
    await coord.archiveGroup(g.sessionGroupId);
    expect(kill).toHaveBeenCalledTimes(2);
    // Second archive — should not fire any more kills.
    const ok = await coord.archiveGroup(g.sessionGroupId);
    expect(ok).toBe(true);
    expect(kill).toHaveBeenCalledTimes(2); // unchanged
  });

  // Hunt #7 / Backend-TS F1: archive-kill failures must surface, not swallow.
  it("reports archive-kill failures via onError; status still flips to archived", async () => {
    const killFn = vi.fn(async (id: string) => {
      if (id === "sess-1") throw new Error("kill-1-failed");
    });
    const errors: Parameters<CoordinatorErrorSink>[0][] = [];
    const c = new SessionGroupCoordinator({ spawn, kill: killFn, onError: (e) => errors.push(e) });
    const g = await c.createGroup({ cwd: "/w", primary: "claude", observer: "claude" });
    const ok = await c.archiveGroup(g.sessionGroupId);
    expect(ok).toBe(true);
    expect(c.get(g.sessionGroupId)?.status).toBe("archived");
    expect(killFn).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.op).toBe("archive_kill");
    expect(errors[0]?.sessionId).toBe("sess-1");
  });

  it("returns false for an unknown group", async () => {
    expect(await coord.archiveGroup("does-not-exist")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

// Coverage backfill: small surface methods + edge guards. Not part of any
// council review finding, just keeps the file above the 80% line gate when
// the `feat/council-mode-paired-sessions` diff grew the file enough that
// the original happy-path tests no longer cover ≥ 80% on their own.
describe("SessionGroupCoordinator.listGroupIds / clear / armReconnect edges", () => {
  it("listGroupIds returns an empty array when no groups have been created", () => {
    expect(coord.listGroupIds()).toEqual([]);
  });

  it("listGroupIds enumerates every active group id (snapshot at call time)", async () => {
    const g1 = await coord.createGroup({ cwd: "/w1", primary: "claude", observer: "claude" });
    const g2 = await coord.createGroup({ cwd: "/w2", primary: "claude", observer: "claude" });
    expect(coord.listGroupIds().sort()).toEqual([g1.sessionGroupId, g2.sessionGroupId].sort());
  });

  it("clear() empties the internal groups map (test-only teardown)", async () => {
    await coord.createGroup({ cwd: "/w", primary: "claude", observer: "claude" });
    expect(coord.listGroupIds()).toHaveLength(1);
    coord.clear();
    expect(coord.listGroupIds()).toEqual([]);
  });

  it("armReconnect returns null for an unknown sessionGroupId without scheduling a timer", () => {
    const result = coord.armReconnect({
      sessionGroupId: "grp_does_not_exist",
      deadRole: "observer",
      snapshotSessionId: "sess_x",
    });
    expect(result).toBeNull();
  });

  // The constructor falls back to a console.warn-based onError sink when
  // the caller does not pass one — exercising that path keeps the default
  // closure covered and asserts the fallback is observable to the operator.
  it("default onError sink prints a warning when archive_kill fails and no sink was supplied", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const killFn: SessionKiller = vi.fn(async (id: string) => {
      if (id === "sess-1") throw new Error("boom");
    });
    // No `onError` in deps — must exercise the default arrow at line ~138.
    const c = new SessionGroupCoordinator({ spawn, kill: killFn });
    const g = await c.createGroup({ cwd: "/w", primary: "claude", observer: "claude" });
    await c.archiveGroup(g.sessionGroupId);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});
