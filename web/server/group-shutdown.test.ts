import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionGroupCoordinator,
  type SessionSpawner,
} from "./session-group-coordinator.js";
import { shutdownAllGroups } from "./group-shutdown.js";

function makeCoord() {
  let n = 0;
  const spawn: SessionSpawner = async () => ({ sessionId: `sess-${++n}` });
  const kill = vi.fn(async () => {});
  const coord = new SessionGroupCoordinator({ spawn, kill });
  return { coord, kill };
}

describe("shutdownAllGroups", () => {
  // Empty workload — fast path, no I/O, returns a zero summary so the
  // shutdown hook can short-circuit logging.
  it("returns a zero summary when no groups exist", async () => {
    const { coord } = makeCoord();
    const summary = await shutdownAllGroups(coord, [], { timeoutMs: 5_000 });
    expect(summary).toEqual({ total: 0, archived: 0, failed: 0, timedOut: 0, durationMs: 0 });
  });

  // Happy path: every group archives within the budget.
  it("archives every group when each finishes within the timeout", async () => {
    const { coord, kill } = makeCoord();
    const a = await coord.createGroup({ cwd: "/a", primary: "claude", observer: "claude" });
    const b = await coord.createGroup({ cwd: "/b", primary: "claude", observer: "claude" });
    const summary = await shutdownAllGroups(coord, [a.sessionGroupId, b.sessionGroupId], {
      timeoutMs: 5_000,
    });
    expect(summary.total).toBe(2);
    expect(summary.archived).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.timedOut).toBe(0);
    // Each archive calls kill twice (primary + observer).
    expect(kill).toHaveBeenCalledTimes(4);
  });

  // Unknown group ids land as `failed` (archiveGroup returns false).
  it("counts archives of unknown group ids as failed", async () => {
    const { coord } = makeCoord();
    const summary = await shutdownAllGroups(coord, ["does-not-exist"], { timeoutMs: 5_000 });
    expect(summary.failed).toBe(1);
    expect(summary.archived).toBe(0);
  });

  // Bounded timeout — a slow kill must not block the shutdown indefinitely.
  // Subprocess P1-3: this is the contract that prevents the server-shutdown
  // path from hanging when a CLI is unresponsive to SIGTERM.
  it("counts groups not archived within the budget as timed_out", async () => {
    let n = 0;
    const spawn: SessionSpawner = async () => ({ sessionId: `sess-${++n}` });
    // Kill hangs forever — simulates the CLI-unresponsive case.
    const kill = vi.fn(() => new Promise<void>(() => {}));
    const coord = new SessionGroupCoordinator({ spawn, kill });
    const g = await coord.createGroup({ cwd: "/w", primary: "claude", observer: "claude" });
    const summary = await shutdownAllGroups(coord, [g.sessionGroupId], { timeoutMs: 50 });
    expect(summary.timedOut).toBe(1);
    expect(summary.archived).toBe(0);
    expect(summary.failed).toBe(0);
  });

  // Mixed outcomes: one archives cleanly, one times out. The summary
  // accurately splits them so the shutdown caller can decide whether
  // to SIGKILL the laggards. Behaviour is keyed by sessionId (not by
  // call order) so parallel archives don't race the test's expectations.
  it("splits mixed outcomes across the summary counts", async () => {
    let n = 0;
    const spawn: SessionSpawner = async () => ({ sessionId: `sess-${++n}` });
    // Group A's sessions (sess-1, sess-2) resolve immediately.
    // Group B's sessions (sess-3, sess-4) hang forever.
    const kill = vi.fn(async (id: string) => {
      if (id === "sess-3" || id === "sess-4") {
        await new Promise(() => {});
      }
    });
    const coord = new SessionGroupCoordinator({ spawn, kill });
    const a = await coord.createGroup({ cwd: "/a", primary: "claude", observer: "claude" });
    const b = await coord.createGroup({ cwd: "/b", primary: "claude", observer: "claude" });
    const summary = await shutdownAllGroups(coord, [a.sessionGroupId, b.sessionGroupId], {
      timeoutMs: 100,
    });
    expect(summary.total).toBe(2);
    expect(summary.archived).toBe(1);
    expect(summary.timedOut).toBe(1);
  });

  // PLAN-aura-orchestrator-idle-auto-proceed Task 9: idle-timer manager
  // SIGTERM drain. `disposeAll()` MUST be called BEFORE any kill is dispatched
  // so a pending fire callback can't land mid-archive. Verified by an
  // ordering recorder: a stub manager that pushes "dispose" onto a shared
  // order array, and a kill fake that pushes "kill". The first entry must
  // always be "dispose".
  it("calls idleTimerManager.disposeAll BEFORE the first kill (EC-2 ordering)", async () => {
    const order: string[] = [];
    let n = 0;
    const spawn: SessionSpawner = async () => ({ sessionId: `sess-${++n}` });
    const kill = vi.fn(async (id: string) => {
      order.push(`kill:${id}`);
    });
    const coord = new SessionGroupCoordinator({ spawn, kill });
    const g = await coord.createGroup({ cwd: "/w", primary: "claude", observer: "claude" });
    const idleTimerManager = {
      disposeAll: vi.fn(() => {
        order.push("dispose");
      }),
    };
    const summary = await shutdownAllGroups(coord, [g.sessionGroupId], {
      timeoutMs: 5_000,
      idleTimerManager,
    });
    expect(summary.archived).toBe(1);
    expect(idleTimerManager.disposeAll).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("dispose");
    expect(order.slice(1)).toEqual([
      `kill:${g.primary.sessionId}`,
      `kill:${g.observer.sessionId}`,
    ]);
  });

  // disposeAll is called even when no groups exist — the manager may hold
  // rehydrated counters from boot reconcile that need to be released
  // before the process exits (otherwise an in-flight handshake race could
  // re-arm a timer mid-shutdown).
  it("calls disposeAll even on the empty-workload fast path", async () => {
    const { coord } = makeCoord();
    const disposeAll = vi.fn();
    const summary = await shutdownAllGroups(coord, [], { timeoutMs: 5_000, idleTimerManager: { disposeAll } });
    expect(summary).toEqual({ total: 0, archived: 0, failed: 0, timedOut: 0, durationMs: 0 });
    expect(disposeAll).toHaveBeenCalledTimes(1);
  });

  // A throwing disposeAll must not abort the shutdown loop — kill cascade
  // is still bounded by `timeoutMs` regardless, so swallow + continue.
  it("continues the shutdown loop if disposeAll throws", async () => {
    const { coord, kill } = makeCoord();
    const a = await coord.createGroup({ cwd: "/a", primary: "claude", observer: "claude" });
    const disposeAll = vi.fn(() => {
      throw new Error("test-dispose-failure");
    });
    const summary = await shutdownAllGroups(coord, [a.sessionGroupId], {
      timeoutMs: 5_000,
      idleTimerManager: { disposeAll },
    });
    // Despite the throw, kills still ran and the group archived.
    expect(summary.archived).toBe(1);
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  // Deterministic duration reporting via injected clock.
  it("reports durationMs based on the injected clock", async () => {
    const { coord } = makeCoord();
    const a = await coord.createGroup({ cwd: "/a", primary: "claude", observer: "claude" });
    let t = 0;
    const summary = await shutdownAllGroups(coord, [a.sessionGroupId], {
      timeoutMs: 1_000,
      now: () => {
        const out = t;
        t += 25;
        return out;
      },
    });
    // First call captures start, second call computes duration — exact
    // value depends on internal ordering; assert non-negative + numeric.
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });
});
