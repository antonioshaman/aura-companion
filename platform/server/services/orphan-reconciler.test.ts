import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ getDb: vi.fn() }));

import {
  RECONCILER_LABEL_SELECTOR,
  reconcileOrphans,
  startOrphanReconciler,
  type KnownInstance,
  type ReconcilerDeps,
} from "./orphan-reconciler";

/**
 * Orphan reconciler: deletes labelled Hetzner resources no DB row claims.
 * Key invariants under test:
 *  - recorded resources and in-flight (provisioning) rows' resources are kept;
 *  - nothing younger than the grace period is touched (in-flight provisions);
 *  - stale provisioning rows are expired so their resources become orphans;
 *  - attached volumes of kept servers are never deleted;
 *  - dry-run deletes nothing; every action is logged.
 * The Hetzner client is a stub — the real API is never called.
 */

const NOW = new Date("2026-10-27T12:00:00Z");
const OLD = "2026-10-27T10:00:00Z"; // 2h old  → past 30 min grace
const FRESH = "2026-10-27T11:50:00Z"; // 10 min old → inside grace

function makeDeps(opts: {
  servers?: any[];
  volumes?: any[];
  rows?: KnownInstance[];
  expired?: string[];
  dryRun?: boolean;
}) {
  const hetzner = {
    listServers: vi.fn(async () => opts.servers ?? []),
    listVolumes: vi.fn(async () => opts.volumes ?? []),
    deleteServer: vi.fn(async (_id: string | number) => undefined),
    deleteVolume: vi.fn(async (_id: string | number) => undefined),
  };
  const deps: ReconcilerDeps = {
    hetzner,
    expireStaleProvisioning: vi.fn(async () => opts.expired ?? []),
    loadInstances: vi.fn(async () => opts.rows ?? []),
    graceMs: 30 * 60 * 1000,
    dryRun: opts.dryRun,
    now: () => NOW,
  };
  return { deps, hetzner };
}

function events(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map((c) => JSON.parse(String(c[0])));
}

describe("reconcileOrphans", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("deletes old unrecorded server+volume and keeps recorded ones", async () => {
    const { deps, hetzner } = makeDeps({
      rows: [{ id: "inst-1", machineStatus: "started", providerMachineId: "100", providerVolumeId: "200" }],
      servers: [
        { id: 100, name: "kept", created: OLD, labels: { app: "companion", organization: "o" } },
        { id: 101, name: "orphan", created: OLD, labels: { app: "companion", organization: "o", instance: "gone" } },
      ],
      volumes: [
        { id: 200, name: "kept", created: OLD, server: 100 },
        { id: 201, name: "orphan", created: OLD, server: 101 },
      ],
    });

    const result = await reconcileOrphans(deps);

    expect(hetzner.listServers).toHaveBeenCalledWith(RECONCILER_LABEL_SELECTOR);
    expect(hetzner.deleteServer).toHaveBeenCalledTimes(1);
    expect(hetzner.deleteServer).toHaveBeenCalledWith(101);
    // Volume attached to the deleted orphan server goes too.
    expect(hetzner.deleteVolume).toHaveBeenCalledTimes(1);
    expect(hetzner.deleteVolume).toHaveBeenCalledWith(201);
    expect(result).toMatchObject({ deletedServers: ["101"], deletedVolumes: ["201"], failed: [] });
    const logged = events(warnSpy).map((e) => e.event);
    expect(logged).toContain("reconciler.orphan_server_deleted");
    expect(logged).toContain("reconciler.orphan_volume_deleted");
  });

  it("never touches resources younger than the grace period (in-flight provision)", async () => {
    const { deps, hetzner } = makeDeps({
      servers: [{ id: 101, created: FRESH, labels: { app: "companion", organization: "o" } }],
      volumes: [{ id: 201, created: FRESH, server: null }, { id: 202, server: null /* unknown age */ }],
    });
    await reconcileOrphans(deps);
    expect(hetzner.deleteServer).not.toHaveBeenCalled();
    expect(hetzner.deleteVolume).not.toHaveBeenCalled();
  });

  it("keeps resources labelled with a row that is still provisioning (ids not yet recorded)", async () => {
    const { deps, hetzner } = makeDeps({
      rows: [{ id: "inst-p", machineStatus: "provisioning", providerMachineId: null, providerVolumeId: null }],
      servers: [{ id: 101, created: OLD, labels: { instance: "inst-p" } }],
      volumes: [{ id: 201, created: OLD, server: 101, labels: { instance: "inst-p" } }],
    });
    await reconcileOrphans(deps);
    expect(hetzner.deleteServer).not.toHaveBeenCalled();
    expect(hetzner.deleteVolume).not.toHaveBeenCalled();
  });

  it("deletes a leftover from a started instance's failed fallback attempt (same instance label, different id)", async () => {
    const { deps, hetzner } = makeDeps({
      rows: [{ id: "inst-1", machineStatus: "started", providerMachineId: "100", providerVolumeId: "200" }],
      volumes: [{ id: 299, created: OLD, server: null, labels: { instance: "inst-1" } }],
    });
    await reconcileOrphans(deps);
    expect(hetzner.deleteVolume).toHaveBeenCalledWith(299);
  });

  it("expires stale provisioning rows before computing orphans", async () => {
    const { deps } = makeDeps({ expired: ["inst-dead"] });
    const result = await reconcileOrphans(deps);
    expect(deps.expireStaleProvisioning).toHaveBeenCalledWith(new Date(NOW.getTime() - 30 * 60 * 1000));
    expect(result.expiredRows).toEqual(["inst-dead"]);
    expect(events(warnSpy).some((e) => e.event === "reconciler.stale_provisioning_row_deleted" && e.instanceId === "inst-dead")).toBe(true);
  });

  it("skips an unclaimed volume still attached to a server that is kept", async () => {
    const { deps, hetzner } = makeDeps({
      rows: [{ id: "inst-1", machineStatus: "started", providerMachineId: "100", providerVolumeId: "200" }],
      servers: [{ id: 100, created: OLD }],
      volumes: [{ id: 250, created: OLD, server: 100 }],
    });
    await reconcileOrphans(deps);
    expect(hetzner.deleteVolume).not.toHaveBeenCalled();
    expect(events(warnSpy).some((e) => e.event === "reconciler.orphan_volume_skipped_attached")).toBe(true);
  });

  it("dry-run logs orphans but deletes nothing and expires no rows", async () => {
    const { deps, hetzner } = makeDeps({
      dryRun: true,
      servers: [{ id: 101, created: OLD }],
      volumes: [{ id: 201, created: OLD, server: null }],
    });
    await reconcileOrphans(deps);
    expect(hetzner.deleteServer).not.toHaveBeenCalled();
    expect(hetzner.deleteVolume).not.toHaveBeenCalled();
    expect(deps.expireStaleProvisioning).not.toHaveBeenCalled();
    const logged = events(warnSpy).map((e) => e.event);
    expect(logged).toEqual(expect.arrayContaining(["reconciler.orphan_server_found", "reconciler.orphan_volume_found"]));
  });

  it("logs and continues when a delete fails; keeps the failed server's volume", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, hetzner } = makeDeps({
      servers: [{ id: 101, created: OLD }, { id: 102, created: OLD }],
      volumes: [{ id: 201, created: OLD, server: 101 }],
    });
    hetzner.deleteServer.mockImplementation(async (id: any) => {
      if (id === 101) throw new Error("locked");
    });

    const result = await reconcileOrphans(deps);

    expect(result.deletedServers).toEqual(["102"]);
    expect(result.failed).toEqual(["server:101"]);
    // Volume 201 is attached to a server we failed to delete → skipped, retried next pass.
    expect(hetzner.deleteVolume).not.toHaveBeenCalled();
    expect(events(errorSpy).some((e) => e.event === "reconciler.orphan_server_delete_failed" && e.serverId === 101)).toBe(true);
  });

  it("records a failed volume delete", async () => {
    const { deps, hetzner } = makeDeps({ volumes: [{ id: 201, created: OLD, server: null }] });
    hetzner.deleteVolume.mockRejectedValue(new Error("still attached"));
    const result = await reconcileOrphans(deps);
    expect(result.failed).toEqual(["volume:201"]);
  });
});

describe("startOrphanReconciler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const baseEnv = { HETZNER_API_TOKEN: "t", DATABASE_URL: "postgres://x", NODE_ENV: "production" } as NodeJS.ProcessEnv;

  it("is disabled in tests, without credentials, or with interval 0", () => {
    expect(startOrphanReconciler({ ...baseEnv, NODE_ENV: "test" })).toBeNull();
    expect(startOrphanReconciler({ ...baseEnv, HETZNER_API_TOKEN: "" })).toBeNull();
    expect(startOrphanReconciler({ ...baseEnv, PLATFORM_RECONCILER_INTERVAL_MS: "0" })).toBeNull();
  });

  it("runs passes on the configured interval with env grace (floored at 5 min) and dry-run", async () => {
    const { deps } = makeDeps({});
    const makeDepsFn = vi.fn(() => deps);
    const handle = startOrphanReconciler(
      {
        ...baseEnv,
        PLATFORM_RECONCILER_INTERVAL_MS: "120000",
        PLATFORM_RECONCILER_GRACE_MS: "1000",
        PLATFORM_RECONCILER_DRY_RUN: "1",
      },
      makeDepsFn,
    );
    expect(handle).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000); // first pass (min(60s, interval))
    expect(makeDepsFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(makeDepsFn).toHaveBeenCalledTimes(2);
    // dry-run → stale rows are never expired.
    expect(deps.expireStaleProvisioning).not.toHaveBeenCalled();

    handle!.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(makeDepsFn).toHaveBeenCalledTimes(2);
  });

  it("logs a failed pass instead of crashing the timer", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = startOrphanReconciler({ ...baseEnv, PLATFORM_RECONCILER_INTERVAL_MS: "1000" }, () => {
      throw new Error("db unreachable");
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events(errorSpy).some((e) => e.event === "reconciler.pass_failed" && e.error === "db unreachable")).toBe(true);
    handle!.stop();
  });
});
