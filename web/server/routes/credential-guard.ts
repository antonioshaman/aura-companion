import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { isDirectLocalRequest, verifyToken } from "../auth-manager.js";
import { originalRequest } from "../middleware/body-limit.js";
import { isOriginAllowed } from "../middleware/origin-allowlist.js";

/**
 * Shared guard + forensics for routes that change which account sessions use
 * (council review 2026-11-15, hunt #4/#6): the sign-in routes and the
 * credential-bearing settings fields. Secret-free by construction (EC-23).
 */

/** How the request authenticated: the Aura bearer header, the cookie, or neither. */
export function authChannel(c: Context): "bearer" | "cookie" | "none" {
  const header = c.req.header("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (verifyToken(bearer)) return "bearer";
  if (verifyToken(getCookie(c, "companion_auth") ?? null)) return "cookie";
  return "none";
}

export function hasAuraToken(c: Context): boolean {
  return authChannel(c) !== "none";
}

export function isJsonContentType(value: string | undefined): boolean {
  return (value ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * Origin rule: absent → allowed (CLI, same-origin GET); `null` → refused; the
 * request's own origin, the dev frontend and `COMPANION_ALLOWED_ORIGIN` →
 * allowed; anything else → refused.
 */
export function credentialOriginAllowed(origin: string | undefined, requestUrl: string, allowed?: ReadonlySet<string>): boolean {
  if (origin === undefined) return true;
  if (origin === "null") return false;
  let own: string | null = null;
  try {
    own = new URL(requestUrl).origin;
  } catch {
    own = null;
  }
  if (own !== null && origin === own) return true;
  return isOriginAllowed({ origin, localhost: false, allowedOriginsOverride: allowed });
}

/** Why a credential-changing request is refused, or null. Token ALWAYS (no localhost bypass), Origin, JSON. */
export function credentialRequestRefusal(c: Context, allowed?: ReadonlySet<string>): { status: 401 | 403 | 415; error: string; why: string } | null {
  if (!hasAuraToken(c)) return { status: 401, error: "unauthorized", why: "token" };
  if (!credentialOriginAllowed(c.req.header("Origin"), c.req.url, allowed)) return { status: 403, error: "origin_not_allowed", why: "origin" };
  if (c.req.method !== "GET" && !isJsonContentType(c.req.header("Content-Type"))) return { status: 415, error: "json_required", why: "content_type" };
  return null;
}

/**
 * Who called, for the log only (never the response): loopback or the remote
 * address, the Origin (or "absent"), and the auth channel.
 */
export function callerFields(c: Context): { caller: string; origin: string; auth: string } {
  let address: string | undefined;
  try {
    const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
    address = server?.requestIP?.(originalRequest(c.req.raw))?.address;
  } catch {
    address = undefined;
  }
  const caller = address === undefined ? "unknown" : isDirectLocalRequest(address, c.req.raw.headers) ? "loopback" : `remote:${address}`;
  return { caller, origin: c.req.header("Origin") ?? "absent", auth: authChannel(c) };
}
