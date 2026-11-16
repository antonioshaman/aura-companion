/**
 * Origin allowlist check for WebSocket upgrade handlers (PLAN Task 15a).
 *
 * WebSocket bypasses same-origin policy by design — a malicious page on
 * another origin can open `ws://localhost:3456/ws/browser/...` and read
 * session contents if no Origin check is enforced at upgrade time.
 *
 * Hunt security.md Principle 4 — "Origin not checked on WS upgrade" is
 * P1 in a multi-page browser context.
 *
 * This module exposes a pure {@link isOriginAllowed} predicate so the
 * dispatcher in `index.ts` can call it inline before `server.upgrade()`.
 * The dev port (5174) is always allowed; production origin is supplied
 * via `COMPANION_ALLOWED_ORIGIN` (comma-separated for multi-host setups,
 * e.g. tailscale + LAN).
 *
 * Localhost-originated requests (CLI subprocess, curl from same host)
 * carry no `Origin` header — those are accepted only when the caller
 * has already been classified as same-host via the IP check upstream.
 * This module does NOT make that determination; the caller passes
 * `localhost: true` when the request IP is loopback.
 */

import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

const DEV_FRONTEND_ORIGINS: ReadonlySet<string> = new Set([
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  // Vite preview / production-build dev server uses 5173 conventionally.
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function parseAllowedOriginsEnv(): ReadonlySet<string> {
  const raw = process.env.COMPANION_ALLOWED_ORIGIN;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export interface OriginCheckOptions {
  /** Origin header value from the request, or null if absent. */
  origin: string | null;
  /** True when the caller's IP is loopback (127.0.0.1 / ::1). */
  localhost: boolean;
  /**
   * Optional override for the production allowlist. Production callers
   * pass nothing — the env var drives the list. Tests inject a fixed
   * set so the assertion is hermetic across machines.
   */
  allowedOriginsOverride?: ReadonlySet<string>;
  /**
   * The request's Host header. A loopback caller whose Origin is this
   * server's own loopback origin (same host:port as Host) is the UI the
   * server itself served (council review 2026-11-15 P1 #1).
   */
  requestHost?: string | null;
}

function isLoopbackName(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1";
}

/** Origin is `http(s)://<loopback name>:<port>` and names the same host:port as the request. */
function isOwnLoopbackOrigin(origin: string, requestHost: string | null | undefined): boolean {
  if (!requestHost) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!isLoopbackName(url.hostname)) return false;
  return url.host.toLowerCase() === requestHost.trim().toLowerCase();
}

/**
 * Decide whether an upgrade request's origin is acceptable.
 *
 * Acceptance rules:
 *  1. Loopback IP without an Origin header → accept (CLI/curl/test).
 *  2. Origin is in the dev frontend set → accept.
 *  3. Origin is in the env-driven allowlist → accept.
 *  4. Loopback IP with an Origin in dev set → accept (browser localhost).
 *  5. Anything else → reject.
 *
 * Notably:
 *  - Cross-origin browser tab with `Origin: https://evil.example` → reject,
 *    even on loopback (rule 5).
 *  - `Origin: null` from a sandboxed iframe → reject unless loopback dev.
 *
 * Pure + injectable for testing.
 */
export function isOriginAllowed(opts: OriginCheckOptions): boolean {
  const { origin, localhost } = opts;
  const envAllowed = opts.allowedOriginsOverride ?? parseAllowedOriginsEnv();

  // Rule 1: localhost-originated request with no Origin header is a
  // non-browser caller — CLI/curl/test runner. Accept.
  if (localhost && origin === null) return true;

  // Rule 5 prefix: `Origin: null` from a non-loopback caller is a
  // sandbox-iframe or a cross-origin POST. Reject.
  if (origin === null) return false;

  // Rule 2: dev frontend origins are always allowed (no production
  // exposure since vite dev server doesn't run in deployed contexts).
  if (DEV_FRONTEND_ORIGINS.has(origin)) return true;

  // Rule 3: production-configured allowlist match.
  if (envAllowed.has(origin)) return true;

  // Rule 4: a loopback caller from the UI this server served (its own
  // loopback origin). Never for a non-loopback caller.
  if (localhost && isOwnLoopbackOrigin(origin, opts.requestHost)) return true;

  return false;
}

/**
 * CORS for `/api/*` (external audit S2). The browser UI is same-origin
 * (prod serves it from the API host; dev goes through the Vite proxy),
 * so no origin needs CORS by default. The old bare `cors()` answered
 * `Access-Control-Allow-Origin: *` to every page on the web. Now only
 * origins listed in `COMPANION_ALLOWED_ORIGIN` get the header; every
 * other origin gets none and the browser blocks the cross-origin read.
 */
export function apiCors(allowedOriginsOverride?: ReadonlySet<string>): MiddlewareHandler {
  return cors({
    origin: (origin) => {
      const allowed = allowedOriginsOverride ?? parseAllowedOriginsEnv();
      return allowed.has(origin) ? origin : null;
    },
  });
}

// ── Discoverability (council review 2026-11-15, friedman P2-2) ──────────────
// A browser on any non-localhost address is refused unless its origin is in
// COMPANION_ALLOWED_ORIGIN, and the UI only shows "Connection timeout". These
// say, in the server's own output, which exact line fixes it.

/** The env line that adds `origin` to the current list (kept, comma-joined). */
export function allowedOriginLine(origin: string, current: string | undefined = process.env.COMPANION_ALLOWED_ORIGIN): string {
  const list = (current ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.includes(origin)) list.push(origin);
  return `COMPANION_ALLOWED_ORIGIN=${list.join(",")}`;
}

/**
 * Startup hint: bound beyond loopback with no allowlist → every remote
 * browser will be refused. Null when there is nothing to say.
 */
export function startupOriginHint(host: string, port: number, current: string | undefined, remoteIps: readonly string[]): string | null {
  if (isLoopbackName(host)) return null;
  if ((current ?? "").trim() !== "") return null;
  const example = remoteIps.length > 0 ? remoteIps.map((ip) => `http://${ip}:${port}`).join(",") : `http://<this-server>:${port}`;
  return [
    `  Opening Aura from another machine? Allow its address first, or chats fail with "Connection timeout":`,
    `    COMPANION_ALLOWED_ORIGIN=${example}   (exact scheme://host:port; then restart)`,
    `  Links that sign a browser in: aura-companion token`,
  ].join("\n");
}

const reportedRefusals = new Set<string>();
const MAX_REPORTED_REFUSALS = 32;

/**
 * Once per origin (bounded): the WebSocket upgrade refused this browser's
 * origin. Returns the log line, or null when already reported / no origin.
 */
export function refusedOriginReport(origin: string | null): string | null {
  if (!origin || reportedRefusals.has(origin) || reportedRefusals.size >= MAX_REPORTED_REFUSALS) return null;
  reportedRefusals.add(origin);
  return `Refused a browser from ${origin} (origin not allowed; the UI shows "Connection timeout"). To allow it set ${allowedOriginLine(origin)} and restart.`;
}

/** Test seam. */
export function _resetRefusedOriginReportsForTest(): void {
  reportedRefusals.clear();
}
