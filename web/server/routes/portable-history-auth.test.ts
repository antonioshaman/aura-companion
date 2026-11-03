import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createRoutes } from "../routes.js";
import { _resetForTest } from "../auth-manager.js";

// AC3/4/8/9: exercise the real router registration and real token verifier.
// No auth-manager mock: otherwise an endpoint accidentally outside middleware could pass.
const originalToken = process.env.COMPANION_AUTH_TOKEN;
afterEach(() => {
  if (originalToken === undefined) delete process.env.COMPANION_AUTH_TOKEN;
  else process.env.COMPANION_AUTH_TOKEN = originalToken;
  _resetForTest();
});
describe("portable history installation auth integration", () => {
  it("protects every archive route and accepts the installation's real token", async () => {
    process.env.COMPANION_AUTH_TOKEN = "portable-integration-test-token-123456789";
    const createSession = vi.fn();
    const listSessions = vi.fn(() => []);
    const inventory = vi.fn(() => ({ sessions: [], skipped: 0 }));
    const app = new Hono();
    app.route("/api", createRoutes(
      { createSession } as never,
      { listSessions } as never,
      {} as never, {} as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { loadForPortableExport: inventory } as never,
    ));
    const id = "a".repeat(64);
    const endpoints = [
      ["GET", "/portable-history"], ["POST", "/portable-history/export"], ["POST", "/portable-history/import"],
      ["GET", `/portable-history/${id}`], ["GET", `/portable-history/${id}/context?sessionId=x`],
      ["GET", `/portable-history/${id}/markdown`], ["POST", `/portable-history/${id}/continue`],
    ];
    for (const [method, path] of endpoints) {
      for (const token of [undefined, "wrong-token"]) {
        const response = await app.request(`http://remote.test/api${path}`, { method, headers: { "X-Forwarded-For": "203.0.113.3", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    }
    expect(inventory).not.toHaveBeenCalled(); expect(listSessions).not.toHaveBeenCalled(); expect(createSession).not.toHaveBeenCalled();
    // Export has no store initialization or provider side effects, so authorized
    // requests can prove real middleware success without touching operator files.
    for (const headers of [new Headers({ Authorization: `Bearer ${process.env.COMPANION_AUTH_TOKEN}` }), new Headers({ Cookie: `companion_auth=${process.env.COMPANION_AUTH_TOKEN}` })]) {
      const response = await app.request("http://remote.test/api/portable-history/export", { method: "POST", headers, body: "{}" });
      expect(response.status).toBe(200);
      expect((await response.json()).sessions).toEqual([]);
    }
    expect(createSession).not.toHaveBeenCalled();
  });
});
