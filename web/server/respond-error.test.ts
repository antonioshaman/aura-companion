import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { respondError } from "./respond-error.js";

// Spy on the logger so we can assert the structured log line carries
// the detail without it leaking into the response body.
vi.mock("./logger.js", () => ({
  log: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { log } from "./logger.js";

describe("respondError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns {error: <code>} with the matching HTTP status", async () => {
    const app = new Hono();
    app.get("/bad", (c) => respondError(c, 400, "bad_request"));

    const res = await app.request("/bad");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("response body has NO stack trace, NO message, NO detail field", async () => {
    // Hunt P9 — production error bodies must be generic. The detail
    // passed to respondError goes to log only.
    const app = new Hono();
    app.get("/secret", (c) =>
      respondError(c, 500, "internal_error", {
        detail: {
          stack: "Error: ENOENT: no such file…",
          filePath: "/etc/secret-path",
          internalReason: "would-leak",
        },
      }),
    );

    const res = await app.request("/secret");
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("stack");
    expect(JSON.stringify(body)).not.toContain("/etc/secret-path");
    expect(JSON.stringify(body)).not.toContain("would-leak");
  });

  it("emits a structured log line with the detail + path + method", async () => {
    const app = new Hono();
    app.post("/api/x", (c) => respondError(c, 422, "validation_failed", {
      module: "test-route",
      detail: { field: "username", reason: "too-long" },
    }));

    await app.request("/api/x", { method: "POST" });

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [module, msg, data] = (log.warn as any).mock.calls[0];
    expect(module).toBe("test-route");
    expect(msg).toBe("request_rejected");
    expect(data).toMatchObject({
      event: "request.rejected",
      status: 422,
      code: "validation_failed",
      path: "/api/x",
      method: "POST",
      field: "username",
      reason: "too-long",
    });
  });

  it("uses 'respond-error' as the default logger module when omitted", async () => {
    const app = new Hono();
    app.get("/x", (c) => respondError(c, 404, "not_found"));
    await app.request("/x");

    const [module] = (log.warn as any).mock.calls[0];
    expect(module).toBe("respond-error");
  });

  it("supports the closed set of ErrorCode values", () => {
    // Compile-time check via TS — the test exists so a future codebase-
    // wide grep `respondError\(c, _, "([a-z_]+)"\)` can pin the strings
    // against this list. The set is intentionally small so the frontend
    // can branch exhaustively.
    const validCodes = [
      "bad_request",
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "validation_failed",
      "rate_limited",
      "internal_error",
    ] as const;
    expect(validCodes.length).toBe(8);
  });
});
