import { getSettings } from "./settings-manager.js";
import { getOrCreateInstanceId } from "./instance-id.js";

/**
 * Anonymous, opt-in usage telemetry.
 *
 * When enabled, the server sends a periodic heartbeat carrying ONLY a random
 * per-install id (see instance-id.ts) and the app version to the global stats
 * Worker. This feeds the public "N people use Aura Companion" counter. It is
 * default-OFF and carries no user, account, host, or path data.
 */

// Default aggregator endpoint. Override with COMPANION_STATS_URL for self-host
// forks or before the production Worker is deployed.
export const DEFAULT_STATS_URL = "https://companion-stats.antonshmonin.workers.dev";

// Heartbeat every 6 hours; the Worker's active window is 30 days, so this is
// far more often than needed to stay "active" while surviving daily restarts.
const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Presence ping every 2 minutes; the Worker's online window is 5 minutes, so a
// single missed beat (restart, transient network) doesn't flap the "online"
// count. Only fires while a human actually has the UI open (see startPresencePing).
const PRESENCE_INTERVAL_MS = 2 * 60 * 1000;

export function getStatsBaseUrl(): string {
  const raw = process.env.COMPANION_STATS_URL?.trim();
  return (raw && raw.replace(/\/+$/, "")) || DEFAULT_STATS_URL;
}

/**
 * Resolve whether telemetry is on. The COMPANION_TELEMETRY env var is an
 * explicit override (managed deployments): "1"/"true" forces on, "0"/"false"
 * forces off. Absent → fall back to the user's opt-in setting (default false).
 */
export function isTelemetryEnabled(): boolean {
  const env = process.env.COMPANION_TELEMETRY?.trim().toLowerCase();
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  return getSettings().telemetryEnabled === true;
}

async function postTelemetry(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(`${getStatsBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch {
    // Telemetry is best-effort; a failed beat must never surface to the user.
  }
}

async function sendHeartbeat(instanceId: string, version: string): Promise<void> {
  await postTelemetry("/telemetry/heartbeat", { instanceId, version });
}

async function sendPresence(instanceId: string, count: number): Promise<void> {
  await postTelemetry("/telemetry/presence", { instanceId, count });
}

/**
 * Start the heartbeat loop if telemetry is enabled at boot. Fires once
 * immediately, then on a 6h interval. The interval is unref'd so it never
 * keeps the process alive. Returns a stop function.
 *
 * Note: the enabled-check is evaluated once at boot. Toggling the setting at
 * runtime takes effect on the next server restart — acceptable for a vanity
 * counter and avoids a settings-change observer for this low-stakes path.
 */
export function startTelemetryHeartbeat(version: string): () => void {
  if (!isTelemetryEnabled()) return () => {};

  const instanceId = getOrCreateInstanceId();
  void sendHeartbeat(instanceId, version);

  const interval = setInterval(() => {
    void sendHeartbeat(instanceId, version);
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  return () => clearInterval(interval);
}

/**
 * Start the presence-ping loop if telemetry is enabled at boot. Unlike the
 * heartbeat (which only proves the install exists), this reports "how many
 * humans have the UI open right now" and feeds the global "N online" figure.
 *
 * `getDistinctBrowsers` is polled on each tick and returns the count of DISTINCT
 * browsers (deduped by clientId) with the UI open; a ping is sent ONLY when it
 * returns > 0, so an idle server with no open tabs never counts as online. The
 * count travels in the payload so the aggregator sums people across installs
 * rather than counting installs. The interval is unref'd so it never keeps the
 * process alive. Returns a stop fn.
 */
export function startPresencePing(getDistinctBrowsers: () => number): () => void {
  if (!isTelemetryEnabled()) return () => {};

  const instanceId = getOrCreateInstanceId();
  const tick = () => {
    const count = getDistinctBrowsers();
    if (count > 0) void sendPresence(instanceId, count);
  };
  tick();

  const interval = setInterval(tick, PRESENCE_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  return () => clearInterval(interval);
}
