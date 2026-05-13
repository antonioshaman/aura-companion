/**
 * Baseline security headers middleware (PLAN Task 15a).
 *
 * Hunt security.md Principles 5, 6:
 *  - Content-Security-Policy: defence-in-depth against XSS; rejects
 *    inline + remote scripts even if a renderer flaw exists.
 *  - X-Content-Type-Options: nosniff — prevents MIME-sniff XSS.
 *  - Referrer-Policy: strict-origin-when-cross-origin — leaks less to
 *    third-party embedded assets.
 *  - Permissions-Policy: closes powerful browser APIs we never need
 *    (camera, mic, payment, USB, etc.).
 *
 * Dev mode policy is loosened only where Vite HMR requires it
 * (websocket + inline scripts for HMR). Production policy is strict.
 *
 * CSP shape rationale:
 *   default-src 'self'           — fallback for every directive not
 *                                  explicitly set; rules out remote-anything.
 *   script-src 'self'            — no inline, no eval, no remote scripts.
 *   style-src 'self' 'unsafe-inline'  — Tailwind + CSS-in-JS need inline
 *                                  style attrs; styles cannot exfiltrate
 *                                  data the way scripts can.
 *   img-src 'self' data: blob:   — local + data URIs (icons, blobs from
 *                                  the PWA install path).
 *   connect-src 'self' ws: wss:  — REST + WebSocket back to the same
 *                                  origin; covers our own /ws/* upgrades.
 *   frame-ancestors 'none'       — equivalent of X-Frame-Options: DENY;
 *                                  no embedding the chat surface anywhere.
 *   base-uri 'self'              — defence-in-depth against base-tag XSS.
 *   form-action 'self'           — no form-submit redirect to attacker site.
 *   object-src 'none'            — no <object>/<embed>/<applet>.
 */

import type { Context, Next } from "hono";

interface SecurityHeadersOptions {
  /**
   * Enable production-strict CSP. Defaults to true when NODE_ENV is
   * "production"; false otherwise. Tests can force either branch.
   */
  productionCsp?: boolean;
}

function buildContentSecurityPolicy(productionCsp: boolean): string {
  const directives = [
    "default-src 'self'",
    productionCsp
      ? "script-src 'self'"
      // Vite HMR injects inline + eval'd snippets in dev. Production
      // never relaxes these — the dev affordance ships nowhere.
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    productionCsp
      ? "connect-src 'self' ws: wss:"
      // Vite uses ws://localhost:5174/__vite/hmr in dev.
      : "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  return directives.join("; ");
}

/**
 * Hono middleware that stamps the baseline security headers on every
 * response. Cheap — just sets headers; never short-circuits the request.
 */
export function securityHeaders(opts?: SecurityHeadersOptions) {
  const productionCsp = opts?.productionCsp ?? process.env.NODE_ENV === "production";
  const csp = buildContentSecurityPolicy(productionCsp);

  return async (c: Context, next: Next) => {
    await next();
    c.header("Content-Security-Policy", csp);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header(
      "Permissions-Policy",
      // Closed by default. Each policy entry is `feature=()` which
      // means "no origin may use this API in this document or any
      // descendant browsing context".
      [
        "accelerometer=()",
        "ambient-light-sensor=()",
        "autoplay=()",
        "battery=()",
        "camera=()",
        "display-capture=()",
        "encrypted-media=()",
        "fullscreen=(self)",
        "geolocation=()",
        "gyroscope=()",
        "magnetometer=()",
        "microphone=()",
        "midi=()",
        "payment=()",
        "picture-in-picture=()",
        "publickey-credentials-get=()",
        "screen-wake-lock=()",
        "sync-xhr=()",
        "usb=()",
        "xr-spatial-tracking=()",
      ].join(", "),
    );
  };
}

// Exported for tests — the CSP string is the integration contract.
export const __testing = { buildContentSecurityPolicy };
