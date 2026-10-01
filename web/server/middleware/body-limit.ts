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
import { bodyLimit } from "hono/body-limit";

export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

export function requestBodyLimit(maxSize: number = MAX_REQUEST_BODY_BYTES) {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  });
}
