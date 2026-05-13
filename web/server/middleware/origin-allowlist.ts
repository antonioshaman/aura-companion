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

  return false;
}
