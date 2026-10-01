import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { apiCors, isOriginAllowed } from "./origin-allowlist.js";

describe("isOriginAllowed", () => {
  // ── Rule 1: localhost without Origin header (CLI/curl/test) ─────────────

  it("accepts loopback request with no Origin header (CLI subprocess pattern)", () => {
    expect(isOriginAllowed({ origin: null, localhost: true })).toBe(true);
  });

  // ── Rule 5: Origin: null from non-loopback (cross-origin POST) ──────────

  it("rejects null Origin from a non-loopback caller (sandbox-iframe attack)", () => {
    expect(isOriginAllowed({ origin: null, localhost: false })).toBe(false);
  });

  // ── Rule 2: dev frontend origins ─────────────────────────────────────────

  it.each([
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ])("accepts dev frontend origin %s", (origin) => {
    expect(isOriginAllowed({ origin, localhost: true })).toBe(true);
    expect(isOriginAllowed({ origin, localhost: false })).toBe(true);
  });

  // ── Rule 3: env-driven allowlist match ──────────────────────────────────

  it("accepts an origin from the production allowlist", () => {
    expect(
      isOriginAllowed({
        origin: "https://companion.example.com",
        localhost: false,
        allowedOriginsOverride: new Set(["https://companion.example.com"]),
      }),
    ).toBe(true);
  });

  it("supports multi-origin production allowlist (tailscale + LAN pattern)", () => {
    const allow = new Set([
      "https://aura.tailnet.example.ts.net",
      "http://10.0.0.5:3456",
    ]);
    expect(isOriginAllowed({ origin: "https://aura.tailnet.example.ts.net", localhost: false, allowedOriginsOverride: allow })).toBe(true);
    expect(isOriginAllowed({ origin: "http://10.0.0.5:3456", localhost: false, allowedOriginsOverride: allow })).toBe(true);
  });

  // ── Rule 5: cross-origin browser tab ────────────────────────────────────

  it("rejects an arbitrary cross-origin (the canonical attack)", () => {
    expect(
      isOriginAllowed({
        origin: "https://evil.example",
        localhost: true,
        allowedOriginsOverride: new Set(),
      }),
    ).toBe(false);
  });

  it("rejects mismatched scheme even if host matches dev port", () => {
    // https://localhost:5174 isn't in the dev set — only http is. A
    // mismatched scheme indicates either a misconfigured client or an
    // adversarial proxy — reject conservatively.
    expect(isOriginAllowed({ origin: "https://localhost:5174", localhost: true })).toBe(false);
  });

  it("rejects empty-string Origin", () => {
    expect(isOriginAllowed({ origin: "", localhost: true })).toBe(false);
  });

  // ── Env-var parsing surface ─────────────────────────────────────────────

  it("uses COMPANION_ALLOWED_ORIGIN env when no override supplied", () => {
    const prev = process.env.COMPANION_ALLOWED_ORIGIN;
    process.env.COMPANION_ALLOWED_ORIGIN = "https://prod.example.com,https://second.example.com";
    try {
      expect(isOriginAllowed({ origin: "https://prod.example.com", localhost: false })).toBe(true);
      expect(isOriginAllowed({ origin: "https://second.example.com", localhost: false })).toBe(true);
      expect(isOriginAllowed({ origin: "https://other.example.com", localhost: false })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COMPANION_ALLOWED_ORIGIN;
      else process.env.COMPANION_ALLOWED_ORIGIN = prev;
    }
  });

  it("returns false on empty env var with non-dev origin", () => {
    // Per feedback_test_env_pollution_explicit_unset — explicit delete
    // rather than relying on shell baseline.
    const prev = process.env.COMPANION_ALLOWED_ORIGIN;
    delete process.env.COMPANION_ALLOWED_ORIGIN;
    try {
      expect(isOriginAllowed({ origin: "https://unknown.example", localhost: false })).toBe(false);
    } finally {
      if (prev !== undefined) process.env.COMPANION_ALLOWED_ORIGIN = prev;
    }
  });
});

// External audit S2: `/api/*` used a bare `cors()`, which answers
// `Access-Control-Allow-Origin: *` to any page on the web. apiCors() must
// only ever echo an origin from COMPANION_ALLOWED_ORIGIN and never `*`.
describe("apiCors", () => {
  const ALLOWED = new Set(["https://box.tail1234.ts.net"]);

  function makeApp(allowed?: ReadonlySet<string>) {
    const app = new Hono();
    app.use("/api/*", apiCors(allowed));
    app.get("/api/ping", (c) => c.json({ ok: true }));
    return app;
  }

  it("sends no Access-Control-Allow-Origin to an unlisted origin", async () => {
    const res = await makeApp(ALLOWED).request("/api/ping", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("never answers with a wildcard, even with an empty allowlist", async () => {
    // Default deployment: env unset -> nothing is cross-origin readable.
    const res = await makeApp(new Set()).request("/api/ping", {
      headers: { Origin: "http://localhost:5174" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("echoes an origin listed in the allowlist", async () => {
    const res = await makeApp(ALLOWED).request("/api/ping", {
      headers: { Origin: "https://box.tail1234.ts.net" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://box.tail1234.ts.net");
  });

  it("does not grant a preflight to an unlisted origin", async () => {
    const res = await makeApp(ALLOWED).request("/api/ping", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("requests without an Origin header (local curl/CLI) still succeed", async () => {
    // Same-host automation sends no Origin; CORS must not get in its way.
    const res = await makeApp(ALLOWED).request("/api/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reads COMPANION_ALLOWED_ORIGIN when no override is given", async () => {
    const prev = process.env.COMPANION_ALLOWED_ORIGIN;
    process.env.COMPANION_ALLOWED_ORIGIN = "https://a.example, https://b.example";
    try {
      const app = makeApp();
      const ok = await app.request("/api/ping", { headers: { Origin: "https://b.example" } });
      expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://b.example");
      const no = await app.request("/api/ping", { headers: { Origin: "https://c.example" } });
      expect(no.headers.get("Access-Control-Allow-Origin")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.COMPANION_ALLOWED_ORIGIN;
      else process.env.COMPANION_ALLOWED_ORIGIN = prev;
    }
  });

  it("index.ts mounts apiCors on /api and no bare cors()", () => {
    // index.ts is a bootstrap module (not unit-testable), so canary the
    // wiring at the source level: a regression back to `cors()` reopens S2.
    const here = dirname(fileURLToPath(import.meta.url));
    const indexSrc = readFileSync(join(here, "..", "index.ts"), "utf8");
    expect(indexSrc).toMatch(/app\.use\("\/api\/\*",\s*apiCors\(\)\)/);
    expect(indexSrc).not.toMatch(/\bcors\(\s*\)/);
  });
});
