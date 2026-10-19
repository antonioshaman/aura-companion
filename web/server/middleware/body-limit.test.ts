import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { MAX_REQUEST_BODY_BYTES, originalRequest, requestBodyLimit } from "./body-limit.js";

// S9 (external audit): the server had no request body cap, so one POST could
// make the process buffer an arbitrarily large body. These tests pin the cap
// and the 413 refusal for both body framings a client can choose.

/** Echo app behind the limit; a small cap keeps the payloads tiny. */
function makeApp(maxSize = 1024) {
  const app = new Hono();
  app.use("/*", requestBodyLimit(maxSize));
  app.post("/echo", async (c) => c.text(String((await c.req.text()).length)));
  app.get("/ping", (c) => c.text("pong"));
  return app;
}

/** A body with no Content-Length, i.e. what arrives as Transfer-Encoding: chunked. */
function chunkedBody(totalBytes: number, chunkBytes = 256): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const n = Math.min(chunkBytes, totalBytes - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(120));
    },
  });
}

describe("requestBodyLimit", () => {
  it("defaults to 64 MiB — headroom for base64 image attachments", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(64 * 1024 * 1024);
  });

  it("passes a body at the cap through intact", async () => {
    const res = await makeApp().request("/echo", { method: "POST", body: "x".repeat(1024) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1024");
  });

  it("refuses a declared Content-Length over the cap with 413 JSON", async () => {
    const res = await makeApp().request("/echo", { method: "POST", body: "x".repeat(1025) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body too large" });
  });

  it("refuses a chunked body over the cap with 413 (Bun's maxRequestBodySize misses these)", async () => {
    // Bun 1.3 enforces maxRequestBodySize only against Content-Length; a
    // streamed body is counted here instead. Without this middleware the
    // handler would read all 5 KB.
    const req = new Request("http://localhost/echo", {
      method: "POST",
      body: chunkedBody(5 * 1024),
      duplex: "half",
    } as RequestInit);
    expect(req.headers.has("content-length")).toBe(false);
    const res = await makeApp().request(req);
    expect(res.status).toBe(413);
  });

  it("passes a chunked body under the cap through intact", async () => {
    const req = new Request("http://localhost/echo", {
      method: "POST",
      body: chunkedBody(1000),
      duplex: "half",
    } as RequestInit);
    const res = await makeApp().request(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1000");
  });

  it("keeps the client IP resolvable for a chunked body (localhost bypass survives)", async () => {
    // FIX-P7-REVIEW (2): bodyLimit swaps c.req.raw for a wrapper Request when
    // there is no Content-Length. Bun's requestIP() only knows the Request it
    // passed to fetch, so the wrapper gave null → local chunked POST got 401.
    // The fake env mimics Bun: it resolves only the original Request object.
    const req = new Request("http://localhost/ip", {
      method: "POST",
      body: chunkedBody(100),
      duplex: "half",
    } as RequestInit);
    const env = { requestIP: (r: Request) => (r === req ? { address: "127.0.0.1" } : null) };
    const app = new Hono<{ Bindings: typeof env }>();
    app.use("/*", requestBodyLimit(1024));
    app.post("/ip", async (c) => {
      await c.req.text();
      return c.json({
        wrapped: c.req.raw !== req,
        ip: c.env.requestIP(originalRequest(c.req.raw))?.address ?? null,
      });
    });
    const res = await app.request(req, undefined, env);
    expect(res.status).toBe(200);
    // wrapped=true proves the test exercises the swapped-Request path.
    expect(await res.json()).toEqual({ wrapped: true, ip: "127.0.0.1" });
  });

  it("originalRequest returns the request itself when nothing wrapped it", () => {
    const req = new Request("http://localhost/x");
    expect(originalRequest(req)).toBe(req);
  });

  it("leaves bodiless requests alone", async () => {
    const res = await makeApp().request("/ping");
    expect(res.status).toBe(200);
  });
});

describe("index.ts wiring (source canary — index.ts runs Bun.serve at import time)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");

  it("Bun.serve gets maxRequestBodySize from the shared constant", () => {
    expect(src).toMatch(/Bun\.serve<[^>]*>\(\{[^]*?maxRequestBodySize:\s*MAX_REQUEST_BODY_BYTES\b/);
  });

  it("the streaming limit is mounted before the /api routes", () => {
    const limitAt = src.indexOf('app.use("/*", requestBodyLimit())');
    const apiAt = src.indexOf('app.route("/api"');
    expect(limitAt).toBeGreaterThan(-1);
    expect(apiAt).toBeGreaterThan(limitAt);
  });
});
