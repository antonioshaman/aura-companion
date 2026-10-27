import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { instances as instancesTable } from "../db/schema.js";
import { errorMessage, logEvent } from "../lib/log.js";
import { HetznerCloudClient, type HetznerServer, type HetznerVolume } from "./hetzner-cloud.js";
import { INSTANCE_LABEL, RESOURCE_LABELS } from "./provisioner.js";

/**
 * Orphan reconciler — the backstop for every path that can leave a billable
 * Hetzner server/volume without a DB record (process death mid-provision,
 * failed rollback, failed fallback-attempt cleanup).
 *
 * Each pass:
 *  1. deletes "provisioning" rows older than the grace period (their request
 *     died; provisions finish in minutes), turning their resources into orphans;
 *  2. lists Hetzner servers + volumes labelled `app=companion` that also carry
 *     an `organization` label (the platform stamps both);
 *  3. deletes every one older than the grace period that no DB row claims.
 *
 * A resource is claimed when its id is a recorded providerMachineId /
 * providerVolumeId, or when its `instance` label names a row that is still
 * provisioning (ids not yet recorded). Volumes still attached to a server we
 * are keeping are never deleted. Every action is logged as structured JSON.
 */

export const DEFAULT_RECONCILER_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_RECONCILER_GRACE_MS = 30 * 60 * 1000;
export const RECONCILER_LABEL_SELECTOR = `app=${RESOURCE_LABELS.app},organization`;

export interface KnownInstance {
  id: string;
  machineStatus: string;
  providerMachineId: string | null;
  providerVolumeId: string | null;
}

export interface ReconcilerDeps {
  hetzner: Pick<HetznerCloudClient, "listServers" | "listVolumes" | "deleteServer" | "deleteVolume">;
  /** Delete "provisioning" rows created before `cutoff`; returns their ids. */
  expireStaleProvisioning: (cutoff: Date) => Promise<string[]>;
  loadInstances: () => Promise<KnownInstance[]>;
  graceMs?: number;
  dryRun?: boolean;
  now?: () => Date;
}

export interface ReconcileResult {
  expiredRows: string[];
  deletedServers: string[];
  deletedVolumes: string[];
  failed: string[];
}

function olderThan(created: string | undefined, cutoff: Date): boolean {
  if (!created) return false; // unknown age → treat as possibly in flight
  const ts = Date.parse(created);
  return Number.isFinite(ts) && ts < cutoff.getTime();
}

export async function reconcileOrphans(deps: ReconcilerDeps): Promise<ReconcileResult> {
  const graceMs = deps.graceMs ?? DEFAULT_RECONCILER_GRACE_MS;
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - graceMs);
  const dryRun = deps.dryRun ?? false;
  const result: ReconcileResult = { expiredRows: [], deletedServers: [], deletedVolumes: [], failed: [] };

  logEvent("info", "reconciler.pass_started", { graceMs, dryRun, cutoff: cutoff.toISOString() });

  if (!dryRun) {
    result.expiredRows = await deps.expireStaleProvisioning(cutoff);
    for (const id of result.expiredRows) {
      logEvent("warn", "reconciler.stale_provisioning_row_deleted", { instanceId: id });
    }
  }

  // DB first, Hetzner second: a resource created between the two reads is
  // younger than the grace period and therefore skipped anyway.
  const rows = await deps.loadInstances();
  const knownServers = new Set(rows.map((r) => r.providerMachineId).filter((v): v is string => !!v));
  const knownVolumes = new Set(rows.map((r) => r.providerVolumeId).filter((v): v is string => !!v));
  const inFlight = new Set(rows.filter((r) => r.machineStatus === "provisioning").map((r) => r.id));

  const [servers, volumes] = await Promise.all([
    deps.hetzner.listServers(RECONCILER_LABEL_SELECTOR),
    deps.hetzner.listVolumes(RECONCILER_LABEL_SELECTOR),
  ]);

  const isClaimed = (id: number, labels: Record<string, string> | undefined, known: Set<string>) =>
    known.has(String(id)) || (!!labels?.[INSTANCE_LABEL] && inFlight.has(labels[INSTANCE_LABEL]));

  const orphanServers = servers.filter(
    (s: HetznerServer) => !isClaimed(s.id, s.labels, knownServers) && olderThan(s.created, cutoff),
  );
  const doomedServerIds = new Set(orphanServers.map((s) => s.id));

  for (const server of orphanServers) {
    const fields = { serverId: server.id, name: server.name, labels: server.labels, created: server.created, dryRun };
    if (dryRun) {
      logEvent("warn", "reconciler.orphan_server_found", fields);
      continue;
    }
    try {
      await deps.hetzner.deleteServer(server.id);
      result.deletedServers.push(String(server.id));
      logEvent("warn", "reconciler.orphan_server_deleted", fields);
    } catch (err) {
      result.failed.push(`server:${server.id}`);
      doomedServerIds.delete(server.id);
      logEvent("error", "reconciler.orphan_server_delete_failed", { ...fields, error: errorMessage(err) });
    }
  }

  for (const volume of volumes as HetznerVolume[]) {
    if (isClaimed(volume.id, volume.labels, knownVolumes) || !olderThan(volume.created, cutoff)) continue;
    const fields = {
      volumeId: volume.id,
      name: volume.name,
      labels: volume.labels,
      created: volume.created,
      attachedServerId: volume.server ?? null,
      dryRun,
    };
    if (volume.server != null && !doomedServerIds.has(volume.server)) {
      logEvent("warn", "reconciler.orphan_volume_skipped_attached", fields);
      continue;
    }
    if (dryRun) {
      logEvent("warn", "reconciler.orphan_volume_found", fields);
      continue;
    }
    try {
      await deps.hetzner.deleteVolume(volume.id);
      result.deletedVolumes.push(String(volume.id));
      logEvent("warn", "reconciler.orphan_volume_deleted", fields);
    } catch (err) {
      // Typically "still attached" right after its server was deleted — the next pass retries.
      result.failed.push(`volume:${volume.id}`);
      logEvent("error", "reconciler.orphan_volume_delete_failed", { ...fields, error: errorMessage(err) });
    }
  }

  logEvent("info", "reconciler.pass_completed", {
    expiredRows: result.expiredRows.length,
    deletedServers: result.deletedServers.length,
    deletedVolumes: result.deletedVolumes.length,
    failed: result.failed.length,
    dryRun,
  });
  return result;
}

/** DB-backed deps using the shared Drizzle client. */
export function dbReconcilerDeps(): Pick<ReconcilerDeps, "expireStaleProvisioning" | "loadInstances"> {
  return {
    expireStaleProvisioning: async (cutoff) => {
      const deleted = await getDb()
        .delete(instancesTable)
        .where(and(eq(instancesTable.machineStatus, "provisioning"), lt(instancesTable.createdAt, cutoff)))
        .returning({ id: instancesTable.id });
      return deleted.map((r) => r.id);
    },
    loadInstances: async () =>
      getDb()
        .select({
          id: instancesTable.id,
          machineStatus: instancesTable.machineStatus,
          providerMachineId: instancesTable.providerMachineId,
          providerVolumeId: instancesTable.providerVolumeId,
        })
        .from(instancesTable),
  };
}

function positiveMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Start the periodic reconciler. Disabled (returns null) unless both
 * HETZNER_API_TOKEN and DATABASE_URL are set, under NODE_ENV=test, or when
 * PLATFORM_RECONCILER_INTERVAL_MS=0.
 *
 * Env: PLATFORM_RECONCILER_INTERVAL_MS (default 15 min),
 *      PLATFORM_RECONCILER_GRACE_MS (default 30 min, minimum 5 min),
 *      PLATFORM_RECONCILER_DRY_RUN=1 (log orphans, delete nothing).
 */
export function startOrphanReconciler(
  env: NodeJS.ProcessEnv = process.env,
  makeDeps: () => ReconcilerDeps = () => ({
    hetzner: new HetznerCloudClient(env.HETZNER_API_TOKEN!),
    ...dbReconcilerDeps(),
  }),
): { stop: () => void } | null {
  const intervalMs = positiveMs(env.PLATFORM_RECONCILER_INTERVAL_MS, DEFAULT_RECONCILER_INTERVAL_MS);
  if (env.NODE_ENV === "test" || !env.HETZNER_API_TOKEN || !env.DATABASE_URL || intervalMs === 0) {
    logEvent("info", "reconciler.disabled", {
      reason: env.NODE_ENV === "test" ? "test_env" : intervalMs === 0 ? "interval_zero" : "missing_env",
    });
    return null;
  }
  // Floor the grace period so a misconfiguration can't race in-flight provisions.
  const graceMs = Math.max(5 * 60 * 1000, positiveMs(env.PLATFORM_RECONCILER_GRACE_MS, DEFAULT_RECONCILER_GRACE_MS));
  const dryRun = env.PLATFORM_RECONCILER_DRY_RUN === "1";

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap passes
    running = true;
    try {
      await reconcileOrphans({ ...makeDeps(), graceMs, dryRun });
    } catch (err) {
      logEvent("error", "reconciler.pass_failed", { error: errorMessage(err) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  const first = setTimeout(() => void tick(), Math.min(60_000, intervalMs));
  (first as { unref?: () => void }).unref?.();
  logEvent("info", "reconciler.started", { intervalMs, graceMs, dryRun });

  return {
    stop: () => {
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}
