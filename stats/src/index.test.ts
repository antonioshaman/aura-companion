import { describe, it, expect, beforeEach } from "vitest";
import worker, { type Env } from "./index.js";

// Minimal in-memory KVNamespace fake. Honours expirationTtl only by storing it
// (we never advance time in these tests, so expiry isn't exercised) and the
// list/get/put surface the Worker uses.
class FakeKV {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async list(opts: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = opts.prefix ?? "";
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

function makeEnv(): { env: Env; kv: FakeKV } {
  const kv = new FakeKV();
  return { env: { STATS_KV: kv as unknown as KVNamespace }, kv };
}

// caches.default is provided by the Workers runtime; under vitest it's absent,
// so stub a no-op cache that always misses.
const noopCache = {
  match: async () => undefined,
  put: async () => undefined,
};
(globalThis as unknown as { caches: { default: typeof noopCache } }).caches = {
  default: noopCache,
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function heartbeat(body: unknown): Request {
  return new Request("https://stats.example/telemetry/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function presence(body: unknown): Request {
  return new Request("https://stats.example/telemetry/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("stats worker", () => {
  let env: Env;
  let kv: FakeKV;

  beforeEach(() => {
    ({ env, kv } = makeEnv());
  });

  it("rejects a heartbeat with a malformed instanceId", async () => {
    const res = await worker.fetch(heartbeat({ instanceId: "short" }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("rejects non-JSON heartbeat bodies", async () => {
    const req = new Request("https://stats.example/telemetry/heartbeat", {
      method: "POST",
      body: "not json",
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it("records a valid heartbeat and bumps the total only on first sight", async () => {
    const id = "instance_abcdef123456";
    const r1 = await worker.fetch(heartbeat({ instanceId: id }), env, ctx);
    expect(r1.status).toBe(200);
    expect(await kv.get("meta:total")).toBe("1");

    // Second heartbeat from the same instance must NOT double-count.
    await worker.fetch(heartbeat({ instanceId: id, version: "1.8.0" }), env, ctx);
    expect(await kv.get("meta:total")).toBe("1");

    // A different instance bumps the total.
    await worker.fetch(heartbeat({ instanceId: "instance_zzzzzz999999" }), env, ctx);
    expect(await kv.get("meta:total")).toBe("2");
  });

  it("reports active + total counts via GET /stats/global", async () => {
    await worker.fetch(heartbeat({ instanceId: "instance_aaaaaa111111" }), env, ctx);
    await worker.fetch(heartbeat({ instanceId: "instance_bbbbbb222222" }), env, ctx);

    const res = await worker.fetch(
      new Request("https://stats.example/stats/global"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activeInstances30d: number;
      totalInstances: number;
      generatedAt: number;
    };
    expect(body.activeInstances30d).toBe(2);
    expect(body.totalInstances).toBe(2);
    expect(typeof body.generatedAt).toBe("number");
  });

  it("rejects a presence ping with a malformed instanceId", async () => {
    const res = await worker.fetch(presence({ instanceId: "short" }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("records a presence ping without bumping the cumulative total", async () => {
    const id = "instance_online111111";
    const res = await worker.fetch(presence({ instanceId: id }), env, ctx);
    expect(res.status).toBe(200);
    // Presence writes only the short-lived online: key — never instance:/meta:.
    expect(kv.store.has("online:" + id)).toBe(true);
    expect(kv.store.has("instance:" + id)).toBe(false);
    expect(await kv.get("meta:total")).toBeNull();
  });

  it("reports onlineNow distinctly from active30d via GET /stats/global", async () => {
    // Two installs are "active" (heartbeat in last 30d) but only one currently
    // has a human at the UI (presence ping in last few minutes).
    await worker.fetch(heartbeat({ instanceId: "instance_aaaaaa111111" }), env, ctx);
    await worker.fetch(heartbeat({ instanceId: "instance_bbbbbb222222" }), env, ctx);
    await worker.fetch(presence({ instanceId: "instance_aaaaaa111111" }), env, ctx);

    const res = await worker.fetch(
      new Request("https://stats.example/stats/global"),
      env,
      ctx,
    );
    const body = (await res.json()) as {
      activeInstances30d: number;
      onlineNow: number;
      totalInstances: number;
    };
    expect(body.activeInstances30d).toBe(2);
    expect(body.onlineNow).toBe(1);
    expect(body.totalInstances).toBe(2);
  });

  it("answers CORS preflight with permissive headers", async () => {
    const res = await worker.fetch(
      new Request("https://stats.example/telemetry/heartbeat", { method: "OPTIONS" }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("404s unknown routes", async () => {
    const res = await worker.fetch(new Request("https://stats.example/nope"), env, ctx);
    expect(res.status).toBe(404);
  });
});
