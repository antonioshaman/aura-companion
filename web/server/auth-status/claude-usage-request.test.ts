import { describe, expect, it, vi } from "vitest";
import { CLAUDE_USAGE_URL, requestClaudeUsage } from "./claude-usage-request.js";

// One classification of the token-free usage response, shared by the status
// probe and the usage-limits panel: 401/403 = rejected (credentials), other
// non-2xx = http, thrown fetch = network. Error bodies must be drained.

const res = (status: number, body: string) => new Response(body, { status });

describe("requestClaudeUsage", () => {
  it("returns the body on 200 and sends only a bearer token to the usage URL", async () => {
    const fetchImpl = vi.fn(async () => res(200, JSON.stringify({ five_hour: null })));
    const out = await requestClaudeUsage("synthetic-token", fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ kind: "ok", body: { five_hour: null } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLAUDE_USAGE_URL);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-token");
  });

  it.each([401, 403])("classifies %i as rejected and drains the body", async (status) => {
    const response = res(status, "denied");
    const cancel = vi.spyOn(response.body!, "cancel");
    const out = await requestClaudeUsage("t", (async () => response) as unknown as typeof fetch);
    expect(out).toEqual({ kind: "rejected", status });
    expect(cancel).toHaveBeenCalled();
  });

  it("classifies other statuses and non-object bodies as http", async () => {
    expect(await requestClaudeUsage("t", (async () => res(500, "x")) as unknown as typeof fetch)).toEqual({ kind: "http", status: 500 });
    expect(await requestClaudeUsage("t", (async () => res(200, "not json")) as unknown as typeof fetch)).toEqual({ kind: "http", status: 200 });
  });

  it("classifies a thrown fetch as network", async () => {
    const out = await requestClaudeUsage("t", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch);
    expect(out.kind).toBe("network");
  });
});
