import { describe, it, expect, beforeEach } from "vitest";
import worker, { type Env } from "./index.js";

// Minimal in-memory KVNamespace fake. Honours expirationTtl only by storing it
// (we never advance time in these tests, so expiry isn't exercised) and the
// list/get/put surface the Worker uses. `listCalls` counts list operations —
// the free tier allows only 1,000/day, so tests pin how many each path spends.
class FakeKV {
  store = new Map<string, string>();
  meta = new Map<string, unknown>();
  ttl = new Map<string, number>();
  listCalls = 0;

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async put(
    key: string,
    value: string,
    opts?: { metadata?: unknown; expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, value);
    if (opts?.metadata !== undefined) this.meta.set(key, opts.metadata);
    if (opts?.expirationTtl !== undefined) this.ttl.set(key, opts.expirationTtl);
  }

  async list(opts: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    this.listCalls += 1;
    const prefix = opts.prefix ?? "";
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name, metadata: this.meta.get(name) }));
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

  // Variant-2 headcount: onlineNow is the SUM of each install's distinct-browser
  // count, not the number of online installs. Two installs reporting 3 and 2
  // humans => 5 people online, not 2.
  it("sums the distinct-browser headcount across installs for onlineNow", async () => {
    await worker.fetch(presence({ instanceId: "instance_aaaaaa111111", count: 3 }), env, ctx);
    await worker.fetch(presence({ instanceId: "instance_bbbbbb222222", count: 2 }), env, ctx);

    const res = await worker.fetch(new Request("https://stats.example/stats/global"), env, ctx);
    const body = (await res.json()) as { onlineNow: number };
    expect(body.onlineNow).toBe(5);
  });

  // A legacy client that pings without a count still contributes exactly 1.
  it("counts a countless (legacy) presence ping as a single person", async () => {
    await worker.fetch(presence({ instanceId: "instance_legacy111111" }), env, ctx);
    await worker.fetch(presence({ instanceId: "instance_counted11111", count: 4 }), env, ctx);

    const res = await worker.fetch(new Request("https://stats.example/stats/global"), env, ctx);
    const body = (await res.json()) as { onlineNow: number };
    expect(body.onlineNow).toBe(5);
  });

  // Guard against a runaway/hostile client inflating the global sum: the count
  // is clamped to [1, MAX_PRESENCE_COUNT] and non-finite/absurd values collapse.
  it("clamps an out-of-range headcount to the [1, MAX] window", async () => {
    await worker.fetch(presence({ instanceId: "instance_toolow111111", count: 0 }), env, ctx);
    await worker.fetch(presence({ instanceId: "instance_toohigh11111", count: 1e9 }), env, ctx);

    const res = await worker.fetch(new Request("https://stats.example/stats/global"), env, ctx);
    const body = (await res.json()) as { onlineNow: number };
    // 0 -> clamped up to 1; 1e9 -> clamped down to MAX_PRESENCE_COUNT (10000).
    expect(body.onlineNow).toBe(1 + 10000);
  });

  // ---- meta:global snapshot (free-tier KV budget) -------------------------
  // Context: the Worker runs on the Workers free tier (1,000 KV list ops/day,
  // 1,000 writes/day). Before the snapshot every edge-cache miss ran two prefix
  // lists, which exhausted the quota (HTTP 500 / CF error 10048, 2026-10-18).
  // These tests pin the contract: lists run ONLY when the snapshot is absent.

  it("on a snapshot miss runs exactly two lists and persists meta:global with a 10-min TTL", async () => {
    await worker.fetch(heartbeat({ instanceId: "instance_aaaaaa111111" }), env, ctx);
    await worker.fetch(heartbeat({ instanceId: "instance_bbbbbb222222" }), env, ctx);
    await worker.fetch(presence({ instanceId: "instance_aaaaaa111111", count: 2 }), env, ctx);
    expect(kv.listCalls).toBe(0); // heartbeat/presence never list

    const res = await worker.fetch(new Request("https://stats.example/stats/global"), env, ctx);
    const body = (await res.json()) as {
      activeInstances30d: number;
      onlineNow: number;
      totalInstances: number;
      generatedAt: number;
    };
    // One list per prefix (instance:, online:) — the full recompute cost.
    expect(kv.listCalls).toBe(2);
    expect(body).toEqual({
      activeInstances30d: 2,
      onlineNow: 2,
      totalInstances: 2,
      generatedAt: expect.any(Number),
    });

    // The snapshot is written back verbatim with the recompute-cadence TTL
    // (600 s → ≤144 recomputes/day → ≤288 lists, ≤144 snapshot writes).
    expect(JSON.parse((await kv.get("meta:global"))!)).toEqual(body);
    expect(kv.ttl.get("meta:global")).toBe(600);
  });

  it("serves an existing meta:global snapshot with zero list calls", async () => {
    // Live data deliberately disagrees with the snapshot so we can prove the
    // response came from the snapshot, not from a recompute.
    await worker.fetch(heartbeat({ instanceId: "instance_aaaaaa111111" }), env, ctx);
    const snapshot = { activeInstances30d: 7, onlineNow: 3, totalInstances: 9, generatedAt: 123 };
    await kv.put("meta:global", JSON.stringify(snapshot));

    const res = await worker.fetch(new Request("https://stats.example/stats/global"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(snapshot);
    expect(kv.listCalls).toBe(0);
    // Edge-cache headers are kept on the snapshot path too (layer 1 still applies).
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=30");
  });

  // Staleness contract: a presence ping does NOT invalidate the snapshot. The
  // "online now" figure may lag by up to the snapshot TTL; that is the price
  // of fitting the list budget and is documented in handleGlobalStats.
  it("does not invalidate the snapshot on a new presence ping", async () => {
    const snapshot = { activeInstances30d: 1, onlineNow: 1, totalInstances: 1, generatedAt: 1 };
    await kv.put("meta:global", JSON.stringify(snapshot));
    await worker.fetch(presence({ instanceId: "instance_newcomer1111", count: 5 }), env, ctx);

    const res = await worker.fetch(new Request("https://stats.example/stats/global"), env, ctx);
    expect(await res.json()).toEqual(snapshot);
    expect(kv.listCalls).toBe(0);
  });

  it("treats a corrupt meta:global as a miss: recomputes and overwrites it", async () => {
    await worker.fetch(heartbeat({ instanceId: "instance_aaaaaa111111" }), env, ctx);
    await kv.put("meta:global", "not json");

    const res = await worker.fetch(new Request("https://stats.example/stats/global"), env, ctx);
    const body = (await res.json()) as { activeInstances30d: number; onlineNow: number };
    expect(body.activeInstances30d).toBe(1);
    expect(body.onlineNow).toBe(0);
    expect(kv.listCalls).toBe(2);
    expect(JSON.parse((await kv.get("meta:global"))!)).toEqual(body);
  });

  it("treats a snapshot with a missing field as a miss", async () => {
    // Older/foreign shape (no onlineNow) must not be served as-is — the app
    // relies on every field being a number.
    await kv.put("meta:global", JSON.stringify({ activeInstances30d: 1, totalInstances: 1 }));

    const res = await worker.fetch(new Request("https://stats.example/stats/global"), env, ctx);
    const body = (await res.json()) as { onlineNow: number };
    expect(body.onlineNow).toBe(0);
    expect(kv.listCalls).toBe(2);
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
