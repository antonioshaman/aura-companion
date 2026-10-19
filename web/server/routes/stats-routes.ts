import type { Hono } from "hono";
import { getStatsBaseUrl } from "../telemetry.js";
import {
  classifyFetchError,
  classifyStatsHttpFailure,
  globalStatsUpstream,
} from "../diagnostics/upstream-status.js";

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
 * graceful "—" rather than surface an error for a vanity metric. The outcome
 * of every upstream fetch is ALSO recorded in `globalStatsUpstream`, which the
 * authenticated Diagnostics page reads (this public response is unchanged).
 */

interface GlobalStats {
  activeInstances30d: number | null;
  onlineNow: number | null;
  totalInstances: number | null;
  generatedAt: number;
}

// Short proxy cache: the "online now" field is time-sensitive, so we keep this
// well under the Worker's 15-minute online window (and its 10-minute
// meta:global snapshot) rather than the long landing cache. Still long enough
// to absorb a burst of UI loads.
const CACHE_TTL_MS = 30 * 1000;

let cached: { value: GlobalStats; fetchedAt: number } | null = null;

async function fetchGlobalStats(): Promise<GlobalStats> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${getStatsBaseUrl()}/stats/global`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      // Drain the body (frees the connection) and use it only to classify.
      const text = await res.text().catch(() => "");
      globalStatsUpstream.recordFailure(classifyStatsHttpFailure(res.status, text), res.status);
      throw new UpstreamRecordedError(`stats upstream ${res.status}`);
    }
    let body: Partial<GlobalStats>;
    try {
      body = (await res.json()) as Partial<GlobalStats>;
    } catch (err) {
      globalStatsUpstream.recordFailure("parse");
      throw new UpstreamRecordedError(err instanceof Error ? err.message : "parse");
    }
    globalStatsUpstream.recordOk();
    return {
      activeInstances30d:
        typeof body.activeInstances30d === "number" ? body.activeInstances30d : null,
      onlineNow: typeof body.onlineNow === "number" ? body.onlineNow : null,
      totalInstances: typeof body.totalInstances === "number" ? body.totalInstances : null,
      generatedAt: Date.now(),
    };
  } catch (err) {
    if (!(err instanceof UpstreamRecordedError)) globalStatsUpstream.recordFailure(classifyFetchError(err));
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A failure already recorded in `globalStatsUpstream` (so the catch-all does not re-classify it). */
class UpstreamRecordedError extends Error {}

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
        onlineNow: null,
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
