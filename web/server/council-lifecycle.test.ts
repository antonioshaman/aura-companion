import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionGroupRole } from "./session-types.js";
import { companionBus } from "./event-bus.js";
import { SessionGroupCoordinator } from "./session-group-coordinator.js";
import { CheckpointLineSnapshots } from "./observer-line-snapshots.js";
import type { CouncilWatcherEntry } from "./council-checkpoint-pipeline.js";
import {
  CouncilLifecycle,
  type CouncilDegradedReason,
  type CouncilGroupMeta,
} from "./council-lifecycle.js";

// P4/C1e: pair creation, the coordinator, boot reconcile, the reconnect
// handshake / relaunch-failed short-circuit, the `group:*` fanout, the
// `.council/` watchers and the REST bootstrap reads were extracted verbatim
// from session-orchestrator.ts. The orchestrator suite (230 cases) still pins
// that behaviour end-to-end through the orchestrator's thin delegates. These
// tests pin the NEW seam: the module works with nothing but its DI deps, it
// writes into the orchestrator-OWNED maps / coordinator slot / intentionalKills
// set (not private copies — the orchestrator's test seams and archive path
// read the same objects), and pipeline follow-ups reach the injected callbacks.

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  companionBus.clear();
});

function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "council-lifecycle-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function info(sessionId: string, overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return { sessionId, state: "connected", cwd: "/tmp", createdAt: 1, ...overrides } as SdkSessionInfo;
}

function makeLifecycle(sessions = new Map<string, SdkSessionInfo>()) {
  const launcher = {
    getSession: vi.fn((id: string) => sessions.get(id)),
    listSessions: vi.fn(() => [...sessions.values()]),
  };
  const wsBridge = {
    markCouncilSession: vi.fn(),
    broadcastToGroup: vi.fn(),
    getSession: vi.fn(() => undefined),
  };
  const slot: { coordinator: SessionGroupCoordinator | null } = { coordinator: null };
  const watchers = new Map<string, CouncilWatcherEntry>();
  const groupMeta = new Map<string, CouncilGroupMeta>();
  const groupBySessionId = new Map<string, string>();
  const degradedReason = new Map<string, CouncilDegradedReason>();
  const deadRole = new Map<string, SessionGroupRole>();
  const intentionalKills = new Set<string>();
  let nextId = 0;
  const deps = {
    launcher: launcher as unknown as CliLauncher,
    getWsBridge: () => wsBridge as unknown as WsBridge,
    watchers,
    groupMeta,
    groupBySessionId,
    degradedReason,
    deadRole,
    intentionalKills,
    getCoordinator: () => slot.coordinator,
    setCoordinator: (c: SessionGroupCoordinator) => {
      slot.coordinator = c;
    },
    idleTimerEnactor: { arm: vi.fn(), cancel: vi.fn(), noteUserMessage: vi.fn() },
    isRelaunchExhausted: vi.fn(() => false),
    // Spawn stub: registers the half in the fake launcher so the post-spawn
    // `launcher.getSession` lookup inside createCouncilGroup resolves.
    createSession: vi.fn(async (body: { cwd?: string; backend?: string; model?: string; sessionGroupId?: string }) => {
      const sessionId = `s${++nextId}`;
      const s = info(sessionId, {
        cwd: body.cwd,
        backendType: (body.backend ?? "claude") as SdkSessionInfo["backendType"],
        model: body.model,
        sessionGroupId: body.sessionGroupId,
      });
      sessions.set(sessionId, s);
      return { ok: true as const, session: s };
    }),
    killSession: vi.fn(async () => undefined),
    handleCouncilCheckpoint: vi.fn(),
    handleCouncilReview: vi.fn(),
    normalizeObserverReviewRaw: vi.fn((_g: string, raw: string) => raw),
    drainPendingObserverWake: vi.fn(),
    scanForMissedObserverWakes: vi.fn(),
    scheduleSpawnCheckpointWhenObserverReady: vi.fn(async () => undefined),
    forgetScheduledGroup: vi.fn(),
    markDisputedStops: vi.fn(),
    replyCapture: { forget: vi.fn() },
    lineSnapshots: new CheckpointLineSnapshots(),
    readLedger: { forget: vi.fn() },
  };
  const lifecycle = new CouncilLifecycle(deps);
  cleanups.push(() => {
    for (const id of [...watchers.keys()]) lifecycle.stopCouncilWatchers(id);
  });
  return { lifecycle, deps, slot, launcher, wsBridge, sessions };
}

/** Register a pair directly (as reconcile does) so listener tests have a group. */
function seedGroup(ctx: ReturnType<typeof makeLifecycle>, groupId = "grp_seed") {
  ctx.deps.groupMeta.set(groupId, {
    primarySessionId: "p1",
    observerSessionId: "o1",
    pairing: "claude+claude",
    createdAt: 1,
    lastCheckpointReceivedAt: null,
  });
  ctx.deps.groupBySessionId.set("p1", groupId);
  ctx.deps.groupBySessionId.set("o1", groupId);
  const coord = ctx.lifecycle.getOrCreateCoordinatorSync();
  coord.registerExternalGroup({
    sessionGroupId: groupId,
    primary: { sessionId: "p1", backendType: "claude" },
    observer: { sessionId: "o1", backendType: "claude" },
    status: "active",
    createdAt: 1,
  });
  return coord;
}

describe("CouncilLifecycle (P4/C1e DI seam)", () => {
  it("fills the orchestrator's coordinator slot lazily and then reuses whatever the slot holds", () => {
    // The orchestrator suite overwrites `orchestrator.coordinator` with stubs;
    // the module must read the slot through the getter, never cache its own.
    const ctx = makeLifecycle();
    const first = ctx.lifecycle.getOrCreateCoordinatorSync();
    expect(ctx.slot.coordinator).toBe(first);
    expect(ctx.lifecycle.getOrCreateCoordinatorSync()).toBe(first);

    const replaced = new SessionGroupCoordinator({
      spawn: async () => ({ sessionId: "x" }),
      kill: async () => undefined,
    });
    ctx.slot.coordinator = replaced;
    expect(ctx.lifecycle.getOrCreateCoordinatorSync()).toBe(replaced);
  });

  it("rejects an unsupported pairing with 400 before any spawn, and refuses a missing cwd", async () => {
    const ctx = makeLifecycle();
    const bad = await ctx.lifecycle.createCouncilGroup({
      pairing: "codex+gemini" as "claude+claude",
      base: { cwd: "/tmp" },
    });
    expect(bad).toEqual({ ok: false, error: "unsupported pairing: codex+gemini", status: 400 });
    expect(ctx.deps.createSession).not.toHaveBeenCalled();

    await expect(ctx.lifecycle.createCouncilGroup({ pairing: "claude+claude", base: {} })).rejects.toThrow(
      /explicit cwd is required/,
    );
  });

  // FIX-AP-1 (5): the per-pair auto-proceed opt-in rides the shared base body
  // into BOTH spawns with the role attached; the launcher keeps it only on the
  // orchestrator half (cli-launcher.test pins that side), which is what the
  // controller reads via launcher.getSession.
  it("createCouncilGroup passes the autoProceedOnIdle opt-in through to the spawn with the half's role", async () => {
    const ctx = makeLifecycle();
    const cwd = tmpWorkspace();
    const autoProceedOnIdle = { idleMs: 90_000, maxIterations: 2 };
    const result = await ctx.lifecycle.createCouncilGroup({
      pairing: "claude+codex",
      base: { cwd, autoProceedOnIdle } as never,
    });
    expect(result.ok).toBe(true);
    const bodies = ctx.deps.createSession.mock.calls.map((c) => c[0] as { sessionGroupRole?: string; autoProceedOnIdle?: unknown });
    expect(bodies.map((b) => b.sessionGroupRole)).toEqual(["orchestrator", "observer"]);
    expect(bodies[0]!.autoProceedOnIdle).toEqual(autoProceedOnIdle);
  });

  it("createCouncilGroup spawns both halves via the injected createSession and registers the pair in the injected maps", async () => {
    const ctx = makeLifecycle();
    const cwd = tmpWorkspace();
    const created = vi.fn();
    companionBus.on("group:created", created);

    const result = await ctx.lifecycle.createCouncilGroup({
      pairing: "claude+claude",
      base: { cwd, model: "m-1" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gid = result.sessionGroupId;
    // Both halves went through the orchestrator's createSession (not a copy).
    expect(ctx.deps.createSession).toHaveBeenCalledTimes(2);
    expect(ctx.deps.createSession.mock.calls.map((c) => c[0].sessionGroupId)).toEqual([gid, gid]);
    // Orchestrator-owned maps populated — the orchestrator's own readers
    // (turn-done drain, archive, getCouncilGroupBySessionId) see the pair.
    expect(ctx.deps.groupMeta.get(gid)).toMatchObject({
      primarySessionId: result.primary.sessionId,
      observerSessionId: result.observer.sessionId,
      pairing: "claude+claude",
      observerModel: "m-1",
    });
    expect(ctx.deps.groupBySessionId.get(result.observer.sessionId)).toBe(gid);
    expect(ctx.deps.watchers.get(gid)?.cwd).toBe(cwd);
    expect(ctx.lifecycle.getCouncilGroupBySessionId(result.primary.sessionId)).toEqual({
      sessionGroupId: gid,
      role: "orchestrator",
    });
    expect(ctx.wsBridge.markCouncilSession).toHaveBeenCalledWith(result.observer.sessionId, gid, "observer");
    expect(created).toHaveBeenCalledTimes(1);
    // Spawn-ack checkpoint goes through the injected scheduler entry point.
    expect(ctx.deps.scheduleSpawnCheckpointWhenObserverReady).toHaveBeenCalledWith(
      gid,
      result.observer.sessionId,
      cwd,
    );
  });

  it("relaunch-failed short-circuit marks BOTH halves in the injected intentionalKills set (EC-2)", () => {
    // Mutation guard: a module that copied the set at construction would
    // leave the orchestrator's keepalive free to relaunch the dead pair.
    const ctx = makeLifecycle();
    const coord = seedGroup(ctx);
    ctx.lifecycle.wireReconnectListeners();
    coord.armReconnect({ sessionGroupId: "grp_seed", deadRole: "observer", snapshotSessionId: "o1" });

    companionBus.emit("session:relaunch-failed", { sessionId: "o1", reason: "budget_exhausted" });

    expect([...ctx.deps.intentionalKills].sort()).toEqual(["o1", "p1"]);
    expect(coord.get("grp_seed")?.status).toBe("degraded");
    coord.cancelAllReconnectTimers();
  });

  it("council session:exited consults the injected isRelaunchExhausted and degrades without arming a grace window", () => {
    const ctx = makeLifecycle();
    const coord = seedGroup(ctx);
    ctx.lifecycle.wireGroupListeners();
    ctx.deps.isRelaunchExhausted.mockReturnValue(true);

    companionBus.emit("session:exited", { sessionId: "p1", exitCode: 1 });

    expect(ctx.deps.isRelaunchExhausted).toHaveBeenCalledWith("p1");
    expect(coord.getReconnectContext("grp_seed")).toBeUndefined();
    expect(coord.get("grp_seed")?.status).toBe("degraded");
    expect(ctx.deps.intentionalKills.has("o1")).toBe(true);
    // The degrade fanout recorded the dead half in the injected map.
    expect(ctx.deps.deadRole.get("grp_seed")).toBe("orchestrator");
  });

  it("a post-grace observer handshake on a degraded pair recovers it and drains through the injected callback", () => {
    const ctx = makeLifecycle();
    const coord = seedGroup(ctx);
    ctx.lifecycle.wireReconnectListeners();
    coord.applyEvent("grp_seed", { type: "half_died", role: "observer" });
    expect(coord.get("grp_seed")?.status).toBe("degraded");

    companionBus.emit("session:cli-id-received", { sessionId: "o1", cliSessionId: "cli-o1" });

    expect(coord.get("grp_seed")?.status).toBe("active");
    expect(ctx.deps.drainPendingObserverWake).toHaveBeenCalledWith("grp_seed");
  });

  it("stop + teardown release the group everywhere it is tracked, including the injected pipeline/scheduler state", () => {
    const ctx = makeLifecycle();
    seedGroup(ctx);
    const cwd = tmpWorkspace();
    ctx.deps.degradedReason.set("grp_seed", "observer_exited");
    ctx.deps.deadRole.set("grp_seed", "observer");
    ctx.lifecycle.startCouncilWatchers("grp_seed", cwd);
    const entry = ctx.deps.watchers.get("grp_seed")!;
    expect(entry).toBeDefined();

    ctx.lifecycle.stopCouncilWatchers("grp_seed");
    expect(entry.abort.signal.aborted).toBe(true);
    expect(ctx.deps.watchers.has("grp_seed")).toBe(false);
    expect(ctx.deps.replyCapture.forget).toHaveBeenCalledWith("o1");

    ctx.lifecycle.tearDownCouncilGroupTracking("grp_seed");
    expect(ctx.deps.groupMeta.has("grp_seed")).toBe(false);
    expect(ctx.deps.groupBySessionId.size).toBe(0);
    expect(ctx.deps.degradedReason.has("grp_seed")).toBe(false);
    expect(ctx.deps.deadRole.has("grp_seed")).toBe(false);
    expect(ctx.deps.forgetScheduledGroup).toHaveBeenCalledWith("grp_seed");
  });

  it("boot reconcile restores a complete pair from launcher state into the injected maps and the coordinator slot", () => {
    const cwd = tmpWorkspace();
    const sessions = new Map<string, SdkSessionInfo>([
      ["p9", info("p9", { cwd, sessionGroupId: "grp_boot", sessionGroupRole: "orchestrator" })],
      ["o9", info("o9", { cwd, sessionGroupId: "grp_boot", sessionGroupRole: "observer" })],
    ]);
    const ctx = makeLifecycle(sessions);

    ctx.lifecycle.reconcileCouncilGroups();

    expect(ctx.deps.groupMeta.get("grp_boot")).toMatchObject({ primarySessionId: "p9", observerSessionId: "o9" });
    expect(ctx.deps.watchers.has("grp_boot")).toBe(true);
    expect(ctx.slot.coordinator?.get("grp_boot")?.status).toBe("active");
    expect(ctx.lifecycle.getAllGroupsForBootstrap().map((g) => g.sessionGroupId)).toEqual(["grp_boot"]);
  });
});
