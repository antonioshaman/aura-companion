import type { Hono } from "hono";
import { getStatsBaseUrl } from "../telemetry.js";

/**
 * Public proxy for the global usage counter.
 *
 * The app fetches GET /api/stats/global from its own origin; this handler
 * forwards to the stats Worker and caches the result in-memory so a burst of
 * UI loads doesn't fan out to the Worker. Registered BEFORE the auth
 * middleware — the count is public, non-sensitive, and the unauthenticated
 * app shell (and shared landing) may read it.
 *
 * On any upstream failure it returns nulls with 200 so the UI can render a
 * graceful "—" rather than surface an error for a vanity metric.
 */

interface GlobalStats {
  activeInstances30d: number | null;
  totalInstances: number | null;
  generatedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { value: GlobalStats; fetchedAt: number } | null = null;

async function fetchGlobalStats(): Promise<GlobalStats> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${getStatsBaseUrl()}/stats/global`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`stats upstream ${res.status}`);
    const body = (await res.json()) as Partial<GlobalStats>;
    return {
      activeInstances30d:
        typeof body.activeInstances30d === "number" ? body.activeInstances30d : null,
      totalInstances: typeof body.totalInstances === "number" ? body.totalInstances : null,
      generatedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function registerStatsRoutes(api: Hono): void {
  api.get("/stats/global", async (c) => {
    const now = Date.now();
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return c.json(cached.value);
    }
    try {
      const value = await fetchGlobalStats();
      cached = { value, fetchedAt: now };
      return c.json(value);
    } catch {
      const fallback: GlobalStats = {
        activeInstances30d: null,
        totalInstances: null,
        generatedAt: now,
      };
      return c.json(fallback);
    }
  });
}

/** Test-only: clear the in-memory cache between cases. */
export function _resetStatsCacheForTest(): void {
  cached = null;
}
