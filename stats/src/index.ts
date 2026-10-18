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
 *   online:<id>    — one key per instance that currently has a human at the UI,
 *                    written on each presence ping with a short expirationTtl
 *                    (minutes). Presence == "active in the last few minutes".
 *                    Self-pruning like instance:, just a far shorter window.
 *                    The ping's headcount (distinct browsers at that install) is
 *                    stored in the key's KV metadata so GET /stats/global can SUM
 *                    people across installs without an extra read per key. Legacy
 *                    pings without a count fall back to 1.
 *   meta:total     — cumulative monotonic counter, bumped once the first time
 *                    an instance id is ever seen. Never decremented.
 *   meta:global    — aggregate snapshot of the whole /stats/global payload
 *                    ({activeInstances30d, onlineNow, totalInstances,
 *                    generatedAt}), written with a short expirationTtl after
 *                    each recompute. Lets an edge-cache miss cost ONE KV read
 *                    instead of two prefix lists — see the free-tier budget
 *                    note above handleGlobalStats.
 *
 * NOTE on scale: recomputing /stats/global counts active instances via
 * `STATS_KV.list` over the "instance:" prefix. KV list is paginated (1000
 * keys/page) and eventually-consistent; this is fine for hundreds–low-thousands
 * of installs. At larger scale, migrate the active count + total to a Durable
 * Object (or maintain meta:global transactionally) to avoid O(n) list scans.
 */

export interface Env {
  STATS_KV: KVNamespace;
}

// 30 days in seconds — an instance counts as "active" if it has sent a
// heartbeat within this window. KV expirationTtl prunes stale keys for us.
const ACTIVE_TTL_SECONDS = 30 * 24 * 60 * 60;

// 15 minutes in seconds — an instance counts as "online" if it has sent a
// presence ping within this window. The app pings every ~10 min while a human
// has the UI open (PRESENCE_INTERVAL_MS in web/server/telemetry.ts), so this
// tolerates one missed beat before dropping off. The cadence is budget-driven:
// every ping is a KV write and the free tier allows 1,000 writes/day in total.
const ONLINE_TTL_SECONDS = 15 * 60;

// Cache the /stats/global response at the edge to bound KV list cost under a
// burst of landing-page loads. Kept short so the "online now" count stays
// reasonably fresh (it's the most time-sensitive field in the response).
const STATS_CACHE_SECONDS = 30;

// Aggregate snapshot of the /stats/global payload, kept in KV (global, unlike
// the per-colo Cache API) so a cache miss costs one KV read, not two lists.
// Its TTL is the recompute cadence — see the budget note on handleGlobalStats.
const SNAPSHOT_TTL_SECONDS = 10 * 60;

const INSTANCE_PREFIX = "instance:";
const ONLINE_PREFIX = "online:";
const TOTAL_KEY = "meta:total";
const SNAPSHOT_KEY = "meta:global";

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
  count?: unknown;
}

// Upper bound on a single install's reported headcount — rejects a
// runaway/hostile client from dominating the global sum. A real install with
// thousands of concurrent humans behind one instance id is not a case we serve.
const MAX_PRESENCE_COUNT = 10000;

// Metadata shape stored on each online:<id> key — the distinct-browser headcount
// reported by that install's most recent presence ping.
interface OnlineMeta {
  count?: number;
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

/**
 * Presence ping — the app sends this every ~10 minutes ONLY while a human
 * has the UI open. It refreshes a short-lived online:<id> key so GET
 * /stats/global can report "people online right now" without any cron sweep.
 * Distinct from the 6-hourly heartbeat (which only proves the install exists).
 */
async function handlePresence(request: Request, env: Env): Promise<Response> {
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

  // Distinct-browser headcount for this install; clamp to [1, MAX]. Legacy
  // clients omit it → count as a single presence.
  const rawCount = typeof body.count === "number" ? body.count : 1;
  const count = Number.isFinite(rawCount)
    ? Math.min(Math.max(Math.floor(rawCount), 1), MAX_PRESENCE_COUNT)
    : 1;

  await env.STATS_KV.put(ONLINE_PREFIX + instanceId, String(Date.now()), {
    expirationTtl: ONLINE_TTL_SECONDS,
    metadata: { count } satisfies OnlineMeta,
  });

  return jsonResponse({ ok: true });
}

async function countByPrefix(env: Env, prefix: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await env.STATS_KV.list({ prefix, cursor });
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}

/**
 * Sum the distinct-browser headcount across all currently-online installs. Each
 * online:<id> key carries its install's count in KV metadata (populated by the
 * presence handler), so `list` returns it inline — no extra read per key. A key
 * missing/with an invalid count (legacy ping) contributes 1.
 */
async function sumOnlineHeadcount(env: Env): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await env.STATS_KV.list<OnlineMeta>({ prefix: ONLINE_PREFIX, cursor });
    for (const key of page.keys) {
      const c = key.metadata?.count;
      total += typeof c === "number" && Number.isFinite(c) && c > 0 ? Math.floor(c) : 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return total;
}

// Shape of the meta:global snapshot AND of the /stats/global response body.
// `generatedAt` is when the counts were computed, not when they were served.
interface GlobalSnapshot {
  activeInstances30d: number;
  onlineNow: number;
  totalInstances: number;
  generatedAt: number;
}

// A snapshot that fails to parse (corrupt / hand-edited / older shape) is
// treated as absent so the next request simply recomputes and overwrites it.
function parseSnapshot(raw: string | null): GlobalSnapshot | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<GlobalSnapshot>;
    if (
      typeof v.activeInstances30d === "number" &&
      typeof v.onlineNow === "number" &&
      typeof v.totalInstances === "number" &&
      typeof v.generatedAt === "number"
    ) {
      return v as GlobalSnapshot;
    }
  } catch {
    // fall through — treat as missing
  }
  return null;
}

// The expensive path: two prefix lists (+1 list per extra 1000-key page) and
// one read of the cumulative counter.
async function computeSnapshot(env: Env): Promise<GlobalSnapshot> {
  const [activeInstances30d, onlineNow, totalRaw] = await Promise.all([
    countByPrefix(env, INSTANCE_PREFIX),
    sumOnlineHeadcount(env),
    env.STATS_KV.get(TOTAL_KEY),
  ]);
  const totalInstances = Math.max(parseInt(totalRaw ?? "0", 10) || 0, activeInstances30d);
  return { activeInstances30d, onlineNow, totalInstances, generatedAt: Date.now() };
}

/**
 * GET /stats/global — three layers, cheapest first:
 *   1. edge Cache API (per-colo, STATS_CACHE_SECONDS) — free, no KV op at all;
 *   2. KV snapshot meta:global — one KV read (free tier: 100,000 reads/day);
 *   3. only if the snapshot is missing/expired: recompute via the two prefix
 *      lists and write the snapshot back with SNAPSHOT_TTL_SECONDS.
 *
 * Free-tier KV budget arithmetic (Workers free plan, per day: 1,000 writes,
 * 1,000 list operations, 100,000 reads). Before the snapshot every edge-cache
 * miss ran 2 lists; the Cache API is per-colo with a 30 s TTL and the app +
 * landing poll every 60 s from every install, so list cost was unbounded —
 * confirmed 2026-10-18: HTTP 500 "error code: 1101" on /stats/global and CF API
 * error 10048 "reached the free usage limit for this operation for today".
 * With the snapshot the lists only run when meta:global is absent, i.e. at most
 * once per SNAPSHOT_TTL_SECONDS regardless of how many colos/pollers hit us:
 *   86,400 s / 600 s             = ≤144 recomputes/day
 *   144 recomputes × 2 lists     = ≤288 list ops/day   (budget 1,000)
 *   144 recomputes × 1 put       = ≤144 snapshot writes/day
 *   every other cache miss       = 1 KV read            (budget 100,000)
 * Presence pings are the other write consumer: PRESENCE_INTERVAL_MS = 10 min in
 * web/server/telemetry.ts → ≤144 writes/day per install with a UI open, plus 4
 * heartbeats/day/install. 144 + 148·N ≤ 1,000 holds for ~5 installs online all
 * day, far more at realistic duty cycles. Caveat: KV is eventually consistent
 * (cross-colo visibility of a write can lag up to ~60 s), so right after the
 * snapshot expires a few colos may each recompute once before they see the new
 * one — a small constant per cycle, not a per-request cost.
 */
async function handleGlobalStats(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request("https://stats.invalid/stats/global");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let snapshot = parseSnapshot(await env.STATS_KV.get(SNAPSHOT_KEY));
  if (snapshot === null) {
    snapshot = await computeSnapshot(env);
    // Awaited (not waitUntil) so the very next miss — including one racing
    // this request at the same colo — finds the snapshot already in place.
    await env.STATS_KV.put(SNAPSHOT_KEY, JSON.stringify(snapshot), {
      expirationTtl: SNAPSHOT_TTL_SECONDS,
    });
  }

  const response = new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${STATS_CACHE_SECONDS}`,
      ...corsHeaders(),
    },
  });
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
    if (url.pathname === "/telemetry/presence" && request.method === "POST") {
      return handlePresence(request, env);
    }
    if (url.pathname === "/stats/global" && request.method === "GET") {
      return handleGlobalStats(env, ctx);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
