import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { securityHeaders, __testing } from "./security-headers.js";

describe("securityHeaders middleware", () => {
  function buildApp(productionCsp: boolean) {
    const app = new Hono();
    app.use("/*", securityHeaders({ productionCsp }));
    app.get("/x", (c) => c.text("ok"));
    return app;
  }

  it("stamps the four baseline headers on every response", async () => {
    const app = buildApp(true);
    const res = await app.request("/x");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Permissions-Policy")).toBeTruthy();
  });

  it("stamps headers on 404 responses too (defence in depth)", async () => {
    const app = buildApp(true);
    const res = await app.request("/never-defined");
    expect(res.status).toBe(404);
    // Missing routes are the precisely-attack-prone surface — a 404
    // body that ends up rendered in a browser tab must carry CSP too.
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  // ── CSP shape ──────────────────────────────────────────────────────────

  it("production CSP forbids inline + eval scripts (script-src directive)", () => {
    // style-src intentionally allows 'unsafe-inline' for Tailwind +
    // CSS-in-JS — styles can't exfiltrate the way scripts can. The
    // assertion below isolates the script-src directive so the
    // style-src exception doesn't false-positive at the file-substring
    // level.
    const csp = __testing.buildContentSecurityPolicy(true);
    const scriptDirective = csp.split(";").find((d) => d.trim().startsWith("script-src "));
    expect(scriptDirective).toBeDefined();
    expect(scriptDirective).toContain("'self'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
  });

  it("dev CSP relaxes script-src for Vite HMR — only in dev", () => {
    const csp = __testing.buildContentSecurityPolicy(false);
    const scriptDirective = csp.split(";").find((d) => d.trim().startsWith("script-src "));
    expect(scriptDirective).toContain("'unsafe-inline'");
    expect(scriptDirective).toContain("'unsafe-eval'");
  });

  it("CSP locks down embedding (frame-ancestors 'none')", () => {
    const csp = __testing.buildContentSecurityPolicy(true);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("CSP forbids object/embed/applet (object-src 'none')", () => {
    const csp = __testing.buildContentSecurityPolicy(true);
    expect(csp).toContain("object-src 'none'");
  });

  it("CSP allows WebSocket connect-src on production (the bridge needs it)", () => {
    const csp = __testing.buildContentSecurityPolicy(true);
    const connectDirective = csp.split(";").find((d) => d.trim().startsWith("connect-src "));
    expect(connectDirective).toContain("ws:");
    expect(connectDirective).toContain("wss:");
  });

  // ── Permissions-Policy ─────────────────────────────────────────────────

  it("Permissions-Policy closes camera/microphone/geolocation by default", async () => {
    const app = buildApp(true);
    const res = await app.request("/x");
    const policy = res.headers.get("Permissions-Policy") ?? "";
    expect(policy).toContain("camera=()");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("geolocation=()");
  });
});
