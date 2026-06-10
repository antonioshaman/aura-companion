import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { registerStatsRoutes, _resetStatsCacheForTest } from "./stats-routes.js";

let app: Hono;

beforeEach(() => {
  _resetStatsCacheForTest();
  vi.restoreAllMocks();
  app = new Hono();
  const api = new Hono();
  registerStatsRoutes(api);
  app.route("/api", api);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/stats/global", () => {
  it("proxies the upstream stats Worker payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ activeInstances30d: 42, totalInstances: 99 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await app.request("/api/stats/global");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { activeInstances30d: number; totalInstances: number };
    expect(json.activeInstances30d).toBe(42);
    expect(json.totalInstances).toBe(99);
  });

  it("serves a cached value without a second upstream fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ activeInstances30d: 1, totalInstances: 1 }), { status: 200 }),
    );

    await app.request("/api/stats/global");
    await app.request("/api/stats/global");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns nulls with 200 when the upstream fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const res = await app.request("/api/stats/global");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { activeInstances30d: null; totalInstances: null };
    expect(json.activeInstances30d).toBeNull();
    expect(json.totalInstances).toBeNull();
  });

  it("returns nulls when the upstream responds non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));

    const res = await app.request("/api/stats/global");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { activeInstances30d: null };
    expect(json.activeInstances30d).toBeNull();
  });
});
