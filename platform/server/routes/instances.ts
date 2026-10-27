import { and, eq, isNull, or } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import {
  requireAuth,
  requireOrganization,
  type AuthEnv,
} from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { instances as instancesTable } from "../db/schema.js";
import { randomBytes } from "node:crypto";
import { createInstanceToken } from "../lib/token.js";
import {
  bootstrapTokenTtlMs,
  generateBootstrapToken,
  hashBootstrapToken,
} from "../lib/bootstrap-token.js";
import { errorMessage, logEvent } from "../lib/log.js";
import { Provisioner, type Plan, type ProvisionProgressFn } from "../services/provisioner.js";

const instances = new Hono<AuthEnv>();
const VALID_PLANS: Plan[] = ["starter", "pro", "enterprise"];

function getProvisioner(): Provisioner {
  const hetznerToken = process.env.HETZNER_API_TOKEN;
  const companionImage = process.env.COMPANION_IMAGE;
  const missing = [
    !hetznerToken && "HETZNER_API_TOKEN",
    !companionImage && "COMPANION_IMAGE",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return new Provisioner({
    hetznerToken: hetznerToken!,
    companionImage: companionImage!,
    hetznerSshKeyId: process.env.HETZNER_SSH_KEY_ID,
    hetznerServerTypes: {
      starter: process.env.HETZNER_SERVER_TYPE_STARTER || undefined,
      pro: process.env.HETZNER_SERVER_TYPE_PRO || undefined,
      enterprise: process.env.HETZNER_SERVER_TYPE_ENTERPRISE || undefined,
    },
  });
}

function normalizeHostname(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\/.*$/, "");
}

function makeHostname(requested?: string): string {
  if (requested?.trim()) return normalizeHostname(requested);
  return "";
}

function isLocalHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("localhost:") ||
    normalized.startsWith("127.0.0.1:") ||
    normalized.startsWith("[::1]:")
  );
}

function resolveLoginUrl(c: any): string {
  const explicit = process.env.COMPANION_LOGIN_URL?.trim();
  if (explicit) return explicit;

  const forwardedHost = c.req.header("x-forwarded-host");
  const forwardedProto = c.req.header("x-forwarded-proto");
  const reqUrl = new URL(c.req.url);
  const host = (forwardedHost || reqUrl.host || "").trim();
  const proto = (forwardedProto || reqUrl.protocol.replace(/:$/, "") || "https").trim();

  if (!host || isLocalHost(host)) return "";
  return `${proto}://${host}/login`;
}

async function getAuthorizedInstance(instanceId: string, orgId: string, userId: string) {
  const db = getDb();
  const row = await db.query.instances.findFirst({
    where: and(
      eq(instancesTable.id, instanceId),
      eq(instancesTable.organizationId, orgId),
      or(eq(instancesTable.ownerType, "shared"), eq(instancesTable.ownerId, userId)),
    ),
  });

  return row ?? null;
}

async function getOwnedInstance(instanceId: string, orgId: string, userId: string) {
  const db = getDb();
  const row = await db.query.instances.findFirst({
    where: and(
      eq(instancesTable.id, instanceId),
      eq(instancesTable.organizationId, orgId),
      or(
        eq(instancesTable.ownerId, userId),
        and(eq(instancesTable.ownerType, "shared"), isNull(instancesTable.ownerId)),
      ),
    ),
  });

  return row ?? null;
}

instances.use("/*", requireAuth, requireOrganization);

/** Strip secrets (and secret-derived values) before returning a row to a browser. */
function sanitizeInstance(row: Record<string, unknown>) {
  const { authSecret, bootstrapTokenHash, bootstrapTokenExpiresAt, ...safe } = row as Record<string, unknown> & {
    authSecret?: unknown;
    bootstrapTokenHash?: unknown;
    bootstrapTokenExpiresAt?: unknown;
  };
  return safe;
}

function resolveAuthMode(row: { config?: unknown }): "managed_jwt" | "static_token" {
  const cfg = row.config;
  if (cfg && typeof cfg === "object") {
    const mode = (cfg as Record<string, unknown>).authMode;
    if (mode === "static_token" || mode === "managed_jwt") {
      return mode;
    }
  }
  // Backward-compatible default for existing instances created before authMode tracking.
  return "managed_jwt";
}

instances.get("/", async (c) => {
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  const db = getDb();

  const rows = await db.query.instances.findMany({
    where: and(
      eq(instancesTable.organizationId, orgId),
      or(eq(instancesTable.ownerType, "shared"), eq(instancesTable.ownerId, userId)),
    ),
  });

  return c.json({ instances: rows.map(sanitizeInstance), organizationId: orgId, userId });
});

interface CreateBody {
  plan?: string;
  region?: string;
  hostname?: string;
  ownerType?: "shared" | "personal";
}

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Returns the trimmed key, null when absent, or an error string when malformed. */
function readIdempotencyKey(c: any): { key: string | null } | { error: string } {
  const raw = c.req.header("idempotency-key");
  if (raw === undefined) return { key: null };
  const key = raw.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return { error: "Invalid Idempotency-Key header (1-255 printable ASCII characters)" };
  }
  return { key };
}

/**
 * URL the new instance calls once to exchange its bootstrap token. Must be
 * https and publicly reachable: it returns the instance's auth secret.
 */
function resolveBootstrapUrl(c: any): string {
  const explicit = process.env.COMPANION_CLOUD_PUBLIC_URL?.trim();
  let base = explicit || "";
  if (!base) {
    const reqUrl = new URL(c.req.url);
    const host = (c.req.header("x-forwarded-host") || reqUrl.host || "").trim();
    const proto = (c.req.header("x-forwarded-proto") || reqUrl.protocol.replace(/:$/, "")).trim();
    if (host && !isLocalHost(host)) base = `${proto}://${host}`;
  }
  if (!base) {
    throw new Error(
      "Cannot determine the control-plane public URL for instance bootstrap; set COMPANION_CLOUD_PUBLIC_URL",
    );
  }
  const url = new URL("/api/instance-bootstrap", base.replace(/\/+$/, "") + "/");
  if (url.protocol !== "https:") {
    throw new Error("Instance bootstrap URL must be https (set COMPANION_CLOUD_PUBLIC_URL to an https origin)");
  }
  return url.toString();
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

type ProvisionResult = Awaited<ReturnType<Provisioner["provision"]>>;

/**
 * Tear down Hetzner resources that were provisioned but could not be recorded
 * in the DB. Shared by POST / and POST /create-stream. Never throws: a failure
 * here is logged with the resource ids (the orphan reconciler is the backstop).
 */
async function deprovisionUnrecorded(
  provisioner: Provisioner,
  provisioned: ProvisionResult,
  ctx: { instanceId: string; organizationId: string },
): Promise<void> {
  try {
    await provisioner.deprovision(provisioned.providerMachineId, provisioned.providerVolumeId);
    logEvent("info", "provision.rollback.deprovisioned", {
      ...ctx,
      serverId: provisioned.providerMachineId,
      volumeId: provisioned.providerVolumeId,
    });
  } catch (err) {
    logEvent("error", "provision.rollback.deprovision_failed", {
      ...ctx,
      serverId: provisioned.providerMachineId,
      volumeId: provisioned.providerVolumeId,
      error: errorMessage(err),
    });
  }
}

async function deletePendingRow(instanceId: string, organizationId: string): Promise<void> {
  try {
    await getDb().delete(instancesTable).where(eq(instancesTable.id, instanceId));
  } catch (err) {
    // The reconciler expires stale "provisioning" rows, so this is recoverable.
    logEvent("error", "provision.rollback.row_delete_failed", {
      instanceId,
      organizationId,
      error: errorMessage(err),
    });
  }
}

async function findByIdempotencyKey(orgId: string, key: string) {
  const row = await getDb().query.instances.findFirst({
    where: and(eq(instancesTable.organizationId, orgId), eq(instancesTable.idempotencyKey, key)),
  });
  return row ?? null;
}

type CreateOutcome = { replay: boolean; instance: Record<string, unknown> };

/**
 * Single create path for POST / and POST /create-stream:
 *  1. idempotent replay if the org already has a row for this Idempotency-Key;
 *  2. insert a "provisioning" row first (durable record + `instance` label id);
 *  3. provision Hetzner resources with a one-time bootstrap token;
 *  4. record the resource ids; if that fails, deprovision and drop the row.
 */
async function createInstance(opts: {
  provisioner: Provisioner;
  organizationId: string;
  ownerId: string;
  ownerType: "shared" | "personal";
  plan: Plan;
  region: string;
  hostname: string;
  loginUrl: string;
  bootstrapUrl: string;
  idempotencyKey: string | null;
  onProgress?: ProvisionProgressFn;
  beforePersist?: () => Promise<void>;
}): Promise<CreateOutcome> {
  const { organizationId, idempotencyKey } = opts;
  const db = getDb();

  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(organizationId, idempotencyKey);
    if (existing) {
      logEvent("info", "provision.idempotent_replay", { instanceId: existing.id, organizationId });
      return { replay: true, instance: existing };
    }
  }

  const bootstrapToken = generateBootstrapToken();
  let pending: { id: string };
  try {
    const [row] = await db
      .insert(instancesTable)
      .values({
        organizationId,
        ownerId: opts.ownerId,
        ownerType: opts.ownerType,
        region: opts.region,
        machineStatus: "provisioning",
        authSecret: randomBytes(32).toString("hex"),
        idempotencyKey,
        bootstrapTokenHash: hashBootstrapToken(bootstrapToken),
        bootstrapTokenExpiresAt: new Date(Date.now() + bootstrapTokenTtlMs()),
        config: { plan: opts.plan, provider: "hetzner", authMode: "static_token" },
      })
      .returning();
    pending = row;
  } catch (err) {
    // Concurrent request with the same key won the insert race.
    if (idempotencyKey && isUniqueViolation(err)) {
      const existing = await findByIdempotencyKey(organizationId, idempotencyKey);
      if (existing) {
        logEvent("info", "provision.idempotent_replay", { instanceId: existing.id, organizationId });
        return { replay: true, instance: existing };
      }
    }
    throw err;
  }

  const ctx = { instanceId: pending.id, organizationId };
  logEvent("info", "provision.started", { ...ctx, plan: opts.plan, region: opts.region });

  let provisioned: ProvisionResult;
  try {
    provisioned = await opts.provisioner.provision({
      organizationId,
      plan: opts.plan,
      region: opts.region,
      hostname: opts.hostname,
      loginUrl: opts.loginUrl,
      instanceId: pending.id,
      bootstrap: { url: opts.bootstrapUrl, token: bootstrapToken },
      onProgress: opts.onProgress,
    });
  } catch (err) {
    logEvent("error", "provision.failed", { ...ctx, error: errorMessage(err) });
    await deletePendingRow(pending.id, organizationId);
    throw err;
  }

  try {
    await opts.beforePersist?.();
    const updated = await db
      .update(instancesTable)
      .set({
        providerMachineId: provisioned.providerMachineId,
        providerVolumeId: provisioned.providerVolumeId,
        hostname: provisioned.hostname,
        machineStatus: "started",
        updatedAt: new Date(),
      })
      .where(eq(instancesTable.id, pending.id))
      .returning();
    if (!updated[0]) {
      throw new Error("Instance record disappeared while provisioning");
    }
    logEvent("info", "provision.completed", {
      ...ctx,
      serverId: provisioned.providerMachineId,
      volumeId: provisioned.providerVolumeId,
    });
    return { replay: false, instance: updated[0] };
  } catch (err) {
    logEvent("error", "provision.persist_failed", {
      ...ctx,
      serverId: provisioned.providerMachineId,
      volumeId: provisioned.providerVolumeId,
      error: errorMessage(err),
    });
    await deprovisionUnrecorded(opts.provisioner, provisioned, ctx);
    await deletePendingRow(pending.id, organizationId);
    throw err;
  }
}

/** Parses + validates the shared create inputs; returns a ready-to-run create or an error response. */
async function prepareCreate(c: Context<AuthEnv>): Promise<
  | { error: string; status: 400 | 500 }
  | { run: (hooks?: { onProgress?: ProvisionProgressFn; beforePersist?: () => Promise<void> }) => Promise<CreateOutcome> }
> {
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  const body = await c.req.json<CreateBody>();

  const ownerType = body.ownerType || "shared";
  const plan = (body.plan || "starter") as Plan;
  const region = body.region || "iad";

  if (!VALID_PLANS.includes(plan)) {
    return { error: `Invalid plan: ${body.plan}`, status: 400 };
  }

  const keyResult = readIdempotencyKey(c);
  if ("error" in keyResult) return { error: keyResult.error, status: 400 };

  let provisioner: Provisioner;
  let bootstrapUrl: string;
  try {
    provisioner = getProvisioner();
    bootstrapUrl = resolveBootstrapUrl(c);
  } catch (error: any) {
    return { error: error.message, status: 500 };
  }

  const hostname = makeHostname(body.hostname);
  const loginUrl = resolveLoginUrl(c);

  return {
    run: (hooks) =>
      createInstance({
        provisioner,
        organizationId: orgId,
        ownerId: userId,
        ownerType,
        plan,
        region,
        hostname,
        loginUrl,
        bootstrapUrl,
        idempotencyKey: keyResult.key,
        ...hooks,
      }),
  };
}

instances.post("/", async (c) => {
  const prepared = await prepareCreate(c);
  if ("error" in prepared) return c.json({ error: prepared.error }, prepared.status);

  try {
    const outcome = await prepared.run();
    return c.json({
      message: outcome.replay ? "Instance already requested" : "Instance provisioned",
      instance: sanitizeInstance(outcome.instance),
      idempotentReplay: outcome.replay,
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) || "Instance creation failed" }, 500);
  }
});

instances.post("/create-stream", async (c) => {
  const prepared = await prepareCreate(c);
  if ("error" in prepared) return c.json({ error: prepared.error }, prepared.status);

  const emitProgress = (
    stream: SSEStreamingApi,
    step: string,
    label: string,
    status: "in_progress" | "done" | "error",
  ) =>
    stream.writeSSE({
      event: "progress",
      data: JSON.stringify({ step, label, status }),
    });

  return streamSSE(c, async (stream) => {
    let activeStep: { step: string; label: string } | null = null;

    try {
      const outcome = await prepared.run({
        onProgress: (step, label, status) => {
          if (status === "in_progress") activeStep = { step, label };
          else if (status === "done") activeStep = null;
          void emitProgress(stream, step, label, status).catch(() => {});
        },
        beforePersist: async () => {
          activeStep = { step: "saving_db", label: "Saving instance" };
          await emitProgress(stream, "saving_db", "Saving instance", "in_progress");
        },
      });
      if (activeStep) {
        await emitProgress(stream, "saving_db", "Saving instance", "done");
        activeStep = null;
      }

      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ instance: sanitizeInstance(outcome.instance), idempotentReplay: outcome.replay }),
      });
    } catch (err: any) {
      if (activeStep) {
        const step: { step: string; label: string } = activeStep;
        await emitProgress(stream, step.step, step.label, "error").catch(() => {});
      }

      const message = err?.message || "Instance creation failed";
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: message }),
      });
    }
  });
});

instances.get("/:id", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);

  return c.json(sanitizeInstance(row));
});

instances.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getOwnedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found or not owned by user" }, 404);

  if (row.providerMachineId && row.providerVolumeId) {
    const provisioner = getProvisioner();
    await provisioner.deprovision(row.providerMachineId, row.providerVolumeId);
  }

  const db = getDb();
  await db.delete(instancesTable).where(eq(instancesTable.id, id));
  return c.json({ id, message: "Instance destroyed" });
});

instances.post("/:id/start", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!row.providerMachineId) return c.json({ error: "Instance has no provisioned machine" }, 409);

  const provisioner = getProvisioner();
  await provisioner.start(row.providerMachineId);

  const db = getDb();
  await db
    .update(instancesTable)
    .set({ machineStatus: "started" })
    .where(eq(instancesTable.id, id));

  return c.json({ id, message: "Started" });
});

instances.post("/:id/stop", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!row.providerMachineId) return c.json({ error: "Instance has no provisioned machine" }, 409);

  const provisioner = getProvisioner();
  await provisioner.stop(row.providerMachineId);

  const db = getDb();
  await db
    .update(instancesTable)
    .set({ machineStatus: "stopped" })
    .where(eq(instancesTable.id, id));

  return c.json({ id, message: "Stopped" });
});

instances.post("/:id/restart", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!row.providerMachineId) return c.json({ error: "Instance has no provisioned machine" }, 409);

  const provisioner = getProvisioner();
  await provisioner.stop(row.providerMachineId);
  await provisioner.start(row.providerMachineId);

  const db = getDb();
  await db
    .update(instancesTable)
    .set({ machineStatus: "started" })
    .where(eq(instancesTable.id, id));

  return c.json({ id, message: "Restarted" });
});

instances.post("/:id/scale", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  const body = await c.req.json<{ plan?: string }>();
  const plan = body.plan as Plan;

  if (!VALID_PLANS.includes(plan)) {
    return c.json({ error: `Invalid plan: ${body.plan}` }, 400);
  }

  const row = await getOwnedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!row.providerMachineId) return c.json({ error: "Instance has no provisioned machine" }, 409);

  const provisioner = getProvisioner();
  await provisioner.resize(row.providerMachineId, plan);
  const currentConfig =
    row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>) : {};

  const db = getDb();
  await db
    .update(instancesTable)
    .set({
      machineStatus: "started",
      config: { ...currentConfig, plan, provider: "hetzner", authMode: currentConfig.authMode || "static_token" },
    })
    .where(eq(instancesTable.id, id));

  return c.json({ id, message: "Scaled", plan });
});

instances.post("/:id/token", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);

  const token =
    resolveAuthMode(row) === "static_token"
      ? row.authSecret
      : await createInstanceToken(row.authSecret);
  return c.json({ id, token });
});

instances.get("/:id/embed", async (c) => {
  const id = c.req.param("id");

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(id)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);

  const token =
    resolveAuthMode(row) === "static_token"
      ? row.authSecret
      : await createInstanceToken(row.authSecret);
  const isIpv4 = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(row.hostname || "");
  const protocol = isIpv4 ? "http" : "https";
  const url = new URL(`${protocol}://${row.hostname}`);
  url.searchParams.set("token", token);
  return c.redirect(url.toString());
});

export { instances };
