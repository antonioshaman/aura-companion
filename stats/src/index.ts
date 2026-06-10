/**
 * Companion Stats Worker
 *
 * A Cloudflare Worker that aggregates anonymous, opt-in usage telemetry for
 * Aura Companion and exposes a global count for the app + landing page.
 *
 * Architecture:
 *   Self-hosted instance (opt-in) --> POST /telemetry/heartbeat --> Stats Worker
 *                                                                      | (KV write)
 *   App / landing page             --> GET  /stats/global       <-- Stats Worker
 *
 * KV layout (binding STATS_KV):
 *   instance:<id>  — one key per active instance, written on each heartbeat
 *                    with a 30-day expirationTtl. Presence == "active in the
 *                    last 30 days". The key auto-expires, so the active count
 *                    is self-pruning with no cron sweep.
 *   meta:total     — cumulative monotonic counter, bumped once the first time
 *                    an instance id is ever seen. Never decremented.
 *
 * NOTE on scale: GET /stats/global counts active instances via `STATS_KV.list`
 * over the "instance:" prefix. KV list is paginated (1000 keys/page) and
 * eventually-consistent; this is fine for hundreds–low-thousands of installs.
 * At larger scale, migrate the active count + total to a Durable Object (or a
 * single aggregate KV key updated transactionally) to avoid O(n) list scans.
 */

export interface Env {
  STATS_KV: KVNamespace;
}

// 30 days in seconds — an instance counts as "active" if it has sent a
// heartbeat within this window. KV expirationTtl prunes stale keys for us.
const ACTIVE_TTL_SECONDS = 30 * 24 * 60 * 60;

// Cache the /stats/global response at the edge to bound KV list cost under a
// burst of landing-page loads.
const STATS_CACHE_SECONDS = 300;

const INSTANCE_PREFIX = "instance:";
const TOTAL_KEY = "meta:total";

// Instance ids are opaque random tokens generated client-side. Bound shape to
// reject junk before it touches KV (length + charset only — no PII parsing).
const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/;

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

interface HeartbeatBody {
  instanceId?: unknown;
  version?: unknown;
}

async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  let body: HeartbeatBody;
  try {
    body = (await request.json()) as HeartbeatBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const instanceId = typeof body.instanceId === "string" ? body.instanceId : "";
  if (!INSTANCE_ID_RE.test(instanceId)) {
    return jsonResponse({ error: "Invalid instanceId" }, 400);
  }
  const version =
    typeof body.version === "string" && VERSION_RE.test(body.version) ? body.version : undefined;

  const key = INSTANCE_PREFIX + instanceId;
  const existing = await env.STATS_KV.get(key);

  // Refresh the 30-day active window on every heartbeat.
  await env.STATS_KV.put(
    key,
    JSON.stringify({ lastSeen: Date.now(), version: version ?? null }),
    { expirationTtl: ACTIVE_TTL_SECONDS },
  );

  // First-ever sight of this instance → bump the cumulative total. The window
  // is wide (active keys expire after 30d) so a long-dormant instance returning
  // can double-count; acceptable for a vanity "total installs" figure.
  if (existing === null) {
    const current = parseInt((await env.STATS_KV.get(TOTAL_KEY)) ?? "0", 10);
    const next = Number.isFinite(current) ? current + 1 : 1;
    await env.STATS_KV.put(TOTAL_KEY, String(next));
  }

  return jsonResponse({ ok: true });
}

async function countActiveInstances(env: Env): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await env.STATS_KV.list({ prefix: INSTANCE_PREFIX, cursor });
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}

async function handleGlobalStats(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request("https://stats.invalid/stats/global");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [activeInstances30d, totalRaw] = await Promise.all([
    countActiveInstances(env),
    env.STATS_KV.get(TOTAL_KEY),
  ]);
  const totalInstances = Math.max(parseInt(totalRaw ?? "0", 10) || 0, activeInstances30d);

  const response = new Response(
    JSON.stringify({ activeInstances30d, totalInstances, generatedAt: Date.now() }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${STATS_CACHE_SECONDS}`,
        ...corsHeaders(),
      },
    },
  );
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === "/telemetry/heartbeat" && request.method === "POST") {
      return handleHeartbeat(request, env);
    }
    if (url.pathname === "/stats/global" && request.method === "GET") {
      return handleGlobalStats(env, ctx);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
