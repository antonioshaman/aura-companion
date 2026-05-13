/**
 * Shared error-response helper (PLAN Task 15a).
 *
 * Production error responses must be generic — no stack trace, no path,
 * no internal detail. The full error is structured-logged server-side
 * via {@link logServerError}; the client receives only a stable code
 * ({@link ErrorCode}) and the matching HTTP status.
 *
 * Hunt security.md Principle 9: "Stack traces in error responses" are
 * a P1 in production. The fix is centralised here so a new route can't
 * silently bypass the discipline by hand-rolling `c.json({error: err.message}, ...)`.
 */

import type { Context } from "hono";
import { log } from "./logger.js";

/**
 * Stable error codes consumed by the frontend. Strings, not numbers,
 * so a future client can branch on them without depending on HTTP
 * status semantics. Keep the list closed — every reachable error path
 * must map to a code here so the response body shape is predictable.
 */
export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "rate_limited"
  | "internal_error";

/**
 * Status codes accepted by Hono's `c.json` overload. Restricting to the
 * supported set means a typo at a call site is a compile error rather
 * than a 500-with-Hono-internal-error.
 */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;

interface RespondErrorOptions {
  /**
   * Optional server-side context for the log line (sessionId, route,
   * underlying error message, etc). Never echoed in the response body —
   * goes to {@link log.warn} only.
   */
  detail?: Record<string, unknown>;
  /**
   * Optional logger module name. Defaults to "respond-error" so the
   * log entry is grep-able even if the caller forgets to pass one.
   */
  module?: string;
}

/**
 * Emit a generic error response and structured server-side log entry.
 *
 * Body shape is always `{error: <code>}` — no `message`, no `stack`, no
 * `path`. The code is the stable signal the frontend keys on.
 *
 * Pass `opts.detail` for any field that helps server-side diagnosis —
 * it lands in the log line, not the wire.
 */
export function respondError(
  c: Context,
  status: ErrorStatus,
  code: ErrorCode,
  opts?: RespondErrorOptions,
) {
  log.warn(opts?.module ?? "respond-error", "request_rejected", {
    event: "request.rejected",
    status,
    code,
    path: new URL(c.req.url).pathname,
    method: c.req.method,
    ...(opts?.detail ?? {}),
  });
  return c.json({ error: code }, status);
}
