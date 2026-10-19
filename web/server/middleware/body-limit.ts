/**
 * Request body size cap (audit item S9).
 *
 * Two layers, one number:
 *  - `Bun.serve({ maxRequestBodySize })` rejects a declared
 *    `Content-Length` over the cap with 413 before the body is buffered.
 *  - Bun 1.3 does NOT apply that cap to `Transfer-Encoding: chunked`
 *    bodies (verified: a 5 KB chunked POST passes a 1 KB cap), so Hono's
 *    `bodyLimit` counts streamed bytes and answers 413 past the cap.
 *
 * 64 MiB leaves headroom for base64 image attachments; nothing the UI
 * sends over REST comes close.
 */
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

// For a body without Content-Length (chunked), `bodyLimit` replaces
// `c.req.raw` with a new Request wrapping a counting stream. Bun's
// `server.requestIP()` knows only the Request it handed to `fetch`, so it
// returns null for the wrapper and a local request would lose the localhost
// bypass (401). Downstream IP checks go through `originalRequest()`.
const originals = new WeakMap<Request, Request>();

/** The Request Bun received, before any body-limit wrapping. */
export function originalRequest(req: Request): Request {
  return originals.get(req) ?? req;
}

export function requestBodyLimit(maxSize: number = MAX_REQUEST_BODY_BYTES): MiddlewareHandler {
  const limit = bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  });
  return async (c, next) => {
    const original = c.req.raw;
    return limit(c, async () => {
      if (c.req.raw !== original) originals.set(c.req.raw, originalRequest(original));
      await next();
    });
  };
}
