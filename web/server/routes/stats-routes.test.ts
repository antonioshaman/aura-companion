import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { registerStatsRoutes, _resetStatsCacheForTest } from "./stats-routes.js";
import { globalStatsUpstream } from "../diagnostics/upstream-status.js";

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
  it("proxies the upstream stats Worker payload including onlineNow", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ activeInstances30d: 42, onlineNow: 3, totalInstances: 99 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const res = await app.request("/api/stats/global");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      activeInstances30d: number;
      onlineNow: number;
      totalInstances: number;
    };
    expect(json.activeInstances30d).toBe(42);
    expect(json.onlineNow).toBe(3);
    expect(json.totalInstances).toBe(99);
  });

  it("coerces a missing onlineNow to null (older Worker without presence)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ activeInstances30d: 5, totalInstances: 5 }), { status: 200 }),
    );

    const res = await app.request("/api/stats/global");
    const json = (await res.json()) as { onlineNow: number | null };
    expect(json.onlineNow).toBeNull();
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

// Diagnostics AC3 (plan Task 7): the public response stays nulls-with-200, but
// the outcome is recorded so the Diagnostics Usage card can say
// "KV quota exceeded since <time>" instead of rendering nothing.
describe("GET /api/stats/global — upstream status for Diagnostics", () => {
  beforeEach(() => {
    globalStatsUpstream.reset();
  });

  it("a 429 records kv-quota with its onset, keeps the onset across repeats, and the public body stays null", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("rate limited", { status: 429 }));
      const res = await app.request("/api/stats/global");
      expect(res.status).toBe(200);
      expect((await res.json()).onlineNow).toBeNull();
      expect(globalStatsUpstream.view()).toEqual({
        ok: false,
        lastOkAt: null,
        failure: { kind: "kv-quota", httpStatus: 429, since: 1_000_000 },
      });

      vi.setSystemTime(1_060_000);
      _resetStatsCacheForTest();
      await app.request("/api/stats/global");
      expect(globalStatsUpstream.view().failure?.since).toBe(1_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Worker exception (500, error code 1101) is classified as kv-quota", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error code: 1101", { status: 500 }));
    await app.request("/api/stats/global");
    expect(globalStatsUpstream.view().failure).toMatchObject({ kind: "kv-quota", httpStatus: 500 });
  });

  it("a success clears the failure and records lastOkAt", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("x", { status: 503 }));
    await app.request("/api/stats/global");
    expect(globalStatsUpstream.view().failure).toMatchObject({ kind: "http", httpStatus: 503 });
    _resetStatsCacheForTest();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ activeInstances30d: 1, onlineNow: 1, totalInstances: 1 }), { status: 200 }),
    );
    await app.request("/api/stats/global");
    const v = globalStatsUpstream.view();
    expect(v.ok).toBe(true);
    expect(v.failure).toBeNull();
    expect(typeof v.lastOkAt).toBe("number");
  });

  it("a network error is classified as network", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await app.request("/api/stats/global");
    expect(globalStatsUpstream.view().failure?.kind).toBe("network");
  });
});
