import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToken } from "./middleware/managed-auth.js";
import { authenticateManagedWebSocket, checkCliSocketUpgrade } from "./ws-auth.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_SECRET = "test-secret-key-for-ws-auth";

describe("authenticateManagedWebSocket", () => {
  const savedSecret = process.env.COMPANION_AUTH_SECRET;

  beforeEach(() => {
    process.env.COMPANION_AUTH_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.COMPANION_AUTH_SECRET;
    else process.env.COMPANION_AUTH_SECRET = savedSecret;
  });

  it("returns 401 when no token is provided", async () => {
    const req = new Request("https://example.com/ws/browser/abc");
    const result = await authenticateManagedWebSocket(req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("accepts a valid query token", async () => {
    const token = await createToken(TEST_SECRET, 60);
    const req = new Request(`https://example.com/ws/browser/abc?token=${token}`);
    const result = await authenticateManagedWebSocket(req);
    expect(result.ok).toBe(true);
  });

  it("accepts a valid cookie token", async () => {
    const token = await createToken(TEST_SECRET, 60);
    const req = new Request("https://example.com/ws/browser/abc", {
      headers: { cookie: `companion_token=${token}` },
    });
    const result = await authenticateManagedWebSocket(req);
    expect(result.ok).toBe(true);
  });

  it("prefers query token over cookie", async () => {
    const token = await createToken(TEST_SECRET, 60);
    const req = new Request(`https://example.com/ws/browser/abc?token=${token}`, {
      headers: { cookie: "companion_token=bad.token" },
    });
    const result = await authenticateManagedWebSocket(req);
    expect(result.ok).toBe(true);
  });

  it("returns 500 when secret is missing", async () => {
    delete process.env.COMPANION_AUTH_SECRET;
    const req = new Request("https://example.com/ws/browser/abc");
    const result = await authenticateManagedWebSocket(req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });
});


// SEC-S3 (external audit): `/ws/cli/:id` carries no token. Before this gate any
// client that could reach the port — including a remote one relayed through a
// local reverse proxy (Tailscale Funnel/Serve, nginx → 127.0.0.1) — could dial
// it, and on the default stdio transport the new socket replaced a live
// session's control channel (ws-bridge `openCliTransport` → `attachTransport`).
describe("checkCliSocketUpgrade", () => {
  const LOOPBACK = "127.0.0.1";

  it("refuses every upgrade on the stdio transport, even a clean loopback one", () => {
    // stdio CLIs never dial back, so the endpoint has no legitimate caller;
    // 404 rather than 403 so it looks like the route does not exist.
    for (const address of [LOOPBACK, "::1", "203.0.113.7"]) {
      const r = checkCliSocketUpgrade({ address, headers: new Headers(), transportMode: "stdio" });
      expect(r).toMatchObject({ ok: false, status: 404 });
    }
  });

  it("accepts a direct loopback upgrade on the ws transport (legacy --sdk-url CLI)", () => {
    for (const address of [LOOPBACK, "::1", "::ffff:127.0.0.1"]) {
      const r = checkCliSocketUpgrade({ address, headers: new Headers(), transportMode: "ws" });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects non-loopback and unknown source addresses on the ws transport", () => {
    for (const address of ["192.168.1.5", "100.64.0.3", "", undefined, null]) {
      const r = checkCliSocketUpgrade({ address, headers: new Headers(), transportMode: "ws" });
      expect(r).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("rejects a loopback upgrade carrying reverse-proxy headers on the ws transport", () => {
    // A local proxy connects from 127.0.0.1 but relays a remote client.
    for (const [name, value] of [
      ["X-Forwarded-For", "203.0.113.7"],
      ["Forwarded", "for=203.0.113.7"],
      ["X-Real-IP", "203.0.113.7"],
      ["Tailscale-User-Login", "someone@example.com"],
    ]) {
      const r = checkCliSocketUpgrade({
        address: LOOPBACK,
        headers: new Headers({ [name]: value }),
        transportMode: "ws",
      });
      expect(r).toMatchObject({ ok: false, status: 403 });
    }
  });
});

// index.ts is a bootstrap module (not unit-testable directly), so canary the
// wiring at source level: inside the `/ws/cli/` branch the gate must run and
// return before `server.upgrade(...)` is reached.
describe("index.ts — /ws/cli upgrade is gated", () => {
  const indexSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

  it("calls checkCliSocketUpgrade with the live transport mode before upgrading the CLI socket", () => {
    const branch = indexSrc.match(/if \(cliMatch\) \{([\s\S]*?)kind: "cli"/);
    expect(branch).not.toBeNull();
    const body = branch![1];
    const gateAt = body.indexOf("checkCliSocketUpgrade(");
    const rejectAt = body.search(/if \(!\w+\.ok\)\s*\{\s*return new Response/);
    const upgradeAt = body.indexOf("server.upgrade(");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(body).toMatch(/transportMode:\s*claudeTransportMode\(\)/);
    expect(rejectAt).toBeGreaterThan(gateAt);
    expect(upgradeAt).toBeGreaterThan(rejectAt);
  });
});
