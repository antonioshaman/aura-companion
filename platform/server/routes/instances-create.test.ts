import { beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_USER_ID = "user-test-1";
const MOCK_ORG_ID = "org-test-1";

const provisionMock = vi.fn();
const deprovisionMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();
const resizeMock = vi.fn();
const createInstanceTokenMock = vi.fn();
const provisionerCtorMock = vi.fn();

const findManyMock = vi.fn();
const findFirstMock = vi.fn();
const insertReturningMock = vi.fn();
const insertValuesMock = vi.fn(() => ({ returning: insertReturningMock }));
const insertMock = vi.fn(() => ({ values: insertValuesMock }));
const updateReturningMock = vi.fn();
const updateWhereMock = vi.fn();
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));
const deleteWhereMock = vi.fn();
const deleteMock = vi.fn(() => ({ where: deleteWhereMock }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn(async (c: any, next: any) => {
    c.set("auth", {
      userId: MOCK_USER_ID,
      user: { id: MOCK_USER_ID, email: "test@example.com", name: "Test" },
      activeOrganizationId: MOCK_ORG_ID,
    });
    await next();
  }),
  requireOrganization: vi.fn(async (c: any, next: any) => {
    c.set("organizationId", MOCK_ORG_ID);
    await next();
  }),
}));

vi.mock("../db/index.js", () => ({
  getDb: vi.fn(() => ({
    query: {
      instances: {
        findMany: findManyMock,
        findFirst: findFirstMock,
      },
    },
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
  })),
}));

vi.mock("../services/provisioner.js", () => ({
  Provisioner: class {
    constructor(...args: any[]) {
      provisionerCtorMock(...args);
    }
    provision = provisionMock;
    deprovision = deprovisionMock;
    start = startMock;
    stop = stopMock;
    resize = resizeMock;
  },
}));

vi.mock("../lib/token.js", () => ({
  createInstanceToken: createInstanceTokenMock,
}));

const { instances } = await import("./instances");
const { hashBootstrapToken } = await import("../lib/bootstrap-token");

/**
 * Create-path safety tests (POST / and POST /create-stream share one helper):
 * - rollback: provisioned Hetzner resources are deprovisioned when the DB
 *   write that records them fails (the billable-orphan bug);
 * - idempotency: a retried create with the same Idempotency-Key never
 *   provisions a second server;
 * - secrets: only a one-time bootstrap token (hash stored) reaches the
 *   provisioner, and the control-plane URL it points at must be https.
 */

const PROVISIONED = {
  providerMachineId: "srv-123",
  providerVolumeId: "vol-123",
  hostname: "1.2.3.4",
};

function post(path: string, headers: Record<string, string> = {}, body: unknown = { plan: "starter" }) {
  return instances.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function loggedEvents(spy: { mock: { calls: unknown[][] } }): Array<Record<string, any>> {
  return spy.mock.calls.map((c) => {
    try {
      return JSON.parse(String(c[0]));
    } catch {
      return {};
    }
  });
}

describe("instance creation safety", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.HETZNER_API_TOKEN = "hcloud-token";
    process.env.COMPANION_IMAGE = "registry.example.com/img:latest";
    process.env.COMPANION_CLOUD_PUBLIC_URL = "https://cloud.example.com";
    delete process.env.COMPANION_LOGIN_URL;

    findFirstMock.mockResolvedValue(null);
    insertReturningMock.mockResolvedValue([{ id: "inst-1" }]);
    updateReturningMock.mockResolvedValue([{ id: "inst-1", hostname: "1.2.3.4", authSecret: "s3cret" }]);
    updateWhereMock.mockImplementation(() =>
      Object.assign(Promise.resolve(undefined), { returning: updateReturningMock }),
    );
    deleteWhereMock.mockResolvedValue(undefined);
    provisionMock.mockResolvedValue(PROVISIONED);
    deprovisionMock.mockResolvedValue(undefined);
  });

  // ── 1. Rollback on DB failure ───────────────────────────────────────────────

  it("POST / deprovisions the new server+volume when recording it in the DB fails", async () => {
    updateReturningMock.mockRejectedValue(new Error("duplicate key value violates unique constraint"));

    const res = await post("/");

    expect(res.status).toBe(500);
    expect(deprovisionMock).toHaveBeenCalledWith("srv-123", "vol-123");
    // The pending row is dropped too, so no half-record is left behind.
    expect(deleteWhereMock).toHaveBeenCalledTimes(1);
    expect(loggedEvents(errorSpy).some((e) => e.event === "provision.persist_failed")).toBe(true);
  });

  it("POST / treats an update that matched no row (reconciler expired it) as a failure and deprovisions", async () => {
    updateReturningMock.mockResolvedValue([]);
    const res = await post("/");
    expect(res.status).toBe(500);
    expect(deprovisionMock).toHaveBeenCalledWith("srv-123", "vol-123");
  });

  it("POST /create-stream uses the same rollback (deprovision + error event)", async () => {
    updateReturningMock.mockRejectedValue(new Error("db down"));
    const res = await post("/create-stream");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("db down");
    // saving_db step is reported as errored
    expect(text).toMatch(/"step":"saving_db","label":"Saving instance","status":"error"/);
    expect(deprovisionMock).toHaveBeenCalledWith("srv-123", "vol-123");
  });

  it("logs (does not swallow) a failed rollback deprovision, with resource ids", async () => {
    updateReturningMock.mockRejectedValue(new Error("db down"));
    deprovisionMock.mockRejectedValue(new Error("hetzner 503"));

    const res = await post("/");

    expect(res.status).toBe(500);
    const failure = loggedEvents(errorSpy).find((e) => e.event === "provision.rollback.deprovision_failed");
    expect(failure).toMatchObject({ instanceId: "inst-1", serverId: "srv-123", volumeId: "vol-123", error: "hetzner 503" });
  });

  it("drops the pending row and does not deprovision when provisioning itself fails", async () => {
    provisionMock.mockRejectedValue(new Error("no capacity"));
    const res = await post("/");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("no capacity");
    expect(deprovisionMock).not.toHaveBeenCalled(); // provisioner cleans its own attempts
    expect(deleteWhereMock).toHaveBeenCalledTimes(1);
  });

  it("logs when dropping the pending row fails (reconciler will expire it)", async () => {
    provisionMock.mockRejectedValue(new Error("no capacity"));
    deleteWhereMock.mockRejectedValue(new Error("db gone"));
    const res = await post("/");
    expect(res.status).toBe(500);
    expect(loggedEvents(errorSpy).some((e) => e.event === "provision.rollback.row_delete_failed")).toBe(true);
  });

  // ── 3. Idempotency ──────────────────────────────────────────────────────────

  it("stores the Idempotency-Key on the pending row", async () => {
    const res = await post("/", { "Idempotency-Key": "req-abc" });
    expect(res.status).toBe(200);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "req-abc" }));
    expect((await res.json()).idempotentReplay).toBe(false);
  });

  it("a retry with the same key returns the existing (in-progress) instance without provisioning again", async () => {
    findFirstMock.mockResolvedValue({
      id: "inst-1",
      machineStatus: "provisioning",
      authSecret: "s3cret",
      bootstrapTokenHash: "h",
    });

    const res = await post("/", { "Idempotency-Key": "req-abc" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotentReplay).toBe(true);
    expect(body.instance).toEqual({ id: "inst-1", machineStatus: "provisioning" });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("a concurrent duplicate that loses the insert race (unique violation) replays the winner", async () => {
    insertReturningMock.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }));
    // First lookup (pre-insert) misses, second (post-conflict) finds the winner.
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "inst-winner", machineStatus: "provisioning" });

    const res = await post("/", { "Idempotency-Key": "req-abc" });

    expect(res.status).toBe(200);
    expect((await res.json()).instance.id).toBe("inst-winner");
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("create-stream replays an existing key as an immediate done event", async () => {
    findFirstMock.mockResolvedValue({ id: "inst-1", machineStatus: "started" });
    const res = await post("/create-stream", { "Idempotency-Key": "req-abc" });
    const text = await res.text();
    expect(text).toContain("event: done");
    expect(text).toContain('"idempotentReplay":true');
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed Idempotency-Key", async () => {
    const res = await post("/", { "Idempotency-Key": "x".repeat(256) });
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  // ── 5. Secrets via one-time bootstrap token ─────────────────────────────────

  it("passes only a one-time bootstrap token to the provisioner and stores just its hash", async () => {
    await post("/");

    const input = provisionMock.mock.calls[0][0];
    expect(input.instanceId).toBe("inst-1");
    expect(input.bootstrap.url).toBe("https://cloud.example.com/api/instance-bootstrap");
    expect(input.tailscaleAuthKey).toBeUndefined();

    const values = (insertValuesMock.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(values.bootstrapTokenHash).toBe(hashBootstrapToken(input.bootstrap.token));
    expect(values.bootstrapTokenHash).not.toBe(input.bootstrap.token);
    expect(values.bootstrapTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
    // The long-lived auth secret is generated by the route and never handed to user_data.
    expect(JSON.stringify(input)).not.toContain(values.authSecret);
  });

  it("refuses to provision when no public control-plane URL is resolvable", async () => {
    delete process.env.COMPANION_CLOUD_PUBLIC_URL;
    const res = await post("/");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("COMPANION_CLOUD_PUBLIC_URL");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("refuses a plain-http bootstrap URL (it would carry the auth secret in clear)", async () => {
    process.env.COMPANION_CLOUD_PUBLIC_URL = "http://cloud.example.com";
    const res = await post("/");
    expect(res.status).toBe(500);
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("derives the bootstrap URL from forwarded headers when no explicit URL is set", async () => {
    delete process.env.COMPANION_CLOUD_PUBLIC_URL;
    await post("/", { "x-forwarded-host": "cloud.example.org", "x-forwarded-proto": "https" });
    expect(provisionMock.mock.calls[0][0].bootstrap.url).toBe("https://cloud.example.org/api/instance-bootstrap");
  });
});

