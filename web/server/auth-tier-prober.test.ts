import { describe, it, expect, vi } from "vitest";
import {
  probeClaudeTier,
  inferTierFromPlanName,
  PROBE_CANDIDATE_URLS,
  type FetchLike,
} from "./auth-tier-prober.js";

// ─── Test fixtures ────────────────────────────────────────────────────────
//
// `probeClaudeTier` is pure-functional with an injected `fetcher` so the
// suite controls every candidate response. The point of these tests is
// NOT to exercise live Anthropic endpoints — it's to verify the chain
// behaviour: first 200 wins, parse-fail or non-ok fall through, network
// throw doesn't crash the route, org-scoped candidate prepends when
// configured, and unknown plan-name strings degrade to `tier: "unknown"`
// (the explicit knowable/unknowable bounds Friedman called for).

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function notFound(): Awaited<ReturnType<FetchLike>> {
  return { ok: false, status: 404, text: () => Promise.resolve("not found") };
}

// ─── inferTierFromPlanName ────────────────────────────────────────────────

describe("inferTierFromPlanName", () => {
  it("recognises Max 20x and beats plain Max alone", () => {
    // Order matters in the prober — "Claude Max 20x" must classify as
    // max_20x, not as max, because the user-driver feature ask
    // (verify-MAX-20x) hinges on the distinction.
    expect(inferTierFromPlanName("Claude Max 20x")).toBe("max_20x");
    expect(inferTierFromPlanName("Claude max 20 x")).toBe("max_20x");
    expect(inferTierFromPlanName("CLAUDE MAX 20X")).toBe("max_20x");
  });

  it("recognises plain Max separately from Max 20x", () => {
    expect(inferTierFromPlanName("Claude Max")).toBe("max");
    expect(inferTierFromPlanName("claude max")).toBe("max");
  });

  it("recognises common other tiers", () => {
    expect(inferTierFromPlanName("Claude Pro")).toBe("pro");
    expect(inferTierFromPlanName("Claude Team")).toBe("team");
    expect(inferTierFromPlanName("Enterprise")).toBe("enterprise");
    expect(inferTierFromPlanName("Free")).toBe("free");
    expect(inferTierFromPlanName("API")).toBe("api");
  });

  it("returns unknown for unrecognised plan strings", () => {
    // Friedman P4: explicit knowable/unknowable bound. Don't fabricate
    // a tier for a string we don't understand.
    expect(inferTierFromPlanName("Some New Plan")).toBe("unknown");
    expect(inferTierFromPlanName("")).toBe("unknown");
    expect(inferTierFromPlanName(null)).toBe("unknown");
    expect(inferTierFromPlanName(undefined)).toBe("unknown");
  });
});

// ─── probeClaudeTier — basic chain behaviour ──────────────────────────────

describe("probeClaudeTier", () => {
  it("returns unknown immediately when no token is configured", async () => {
    // Empty/whitespace token must short-circuit — no network call, no
    // chance of leaking the token to a remote even by accident.
    const fetcher = vi.fn();
    const result = await probeClaudeTier("", undefined, fetcher as never);
    expect(result.tier).toBe("unknown");
    expect(result.rawExcerpt).toBe("no token configured");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns first 200 OK match and stops probing further candidates", async () => {
    // userinfo (candidate #1) answers with a recognised plan → chain
    // halts. `/v1/me` and `/v1/organizations` MUST NOT be called.
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://api.anthropic.com/api/oauth/userinfo") {
        return jsonResponse(200, { plan: "Claude Max 20x" });
      }
      throw new Error("should not be called");
    });
    const result = await probeClaudeTier("test-token", undefined, fetcher as never);

    expect(result.tier).toBe("max_20x");
    expect(result.plan).toBe("Claude Max 20x");
    expect(result.probedEndpoint).toBe("https://api.anthropic.com/api/oauth/userinfo");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls through 404 to the next candidate", async () => {
    // Userinfo 404 → fall to /v1/me → answers with plan. This is the
    // primary "first-time-prod-discovery" path: we don't know which
    // candidate actually answers, so each must be tried in order.
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://api.anthropic.com/api/oauth/userinfo") return notFound();
      if (url === "https://api.anthropic.com/v1/me") {
        return jsonResponse(200, { plan: "Claude Pro" });
      }
      return notFound();
    });
    const result = await probeClaudeTier("token", undefined, fetcher as never);

    expect(result.tier).toBe("pro");
    expect(result.probedEndpoint).toBe("https://api.anthropic.com/v1/me");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls through 401/403/5xx the same way as 404", async () => {
    // Auth-error 401 on one endpoint must NOT crash the chain — token
    // may be scoped to a different endpoint that returns 200.
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://api.anthropic.com/api/oauth/userinfo") {
        return { ok: false, status: 401, text: () => Promise.resolve("unauthorized") };
      }
      if (url === "https://api.anthropic.com/v1/me") {
        return { ok: false, status: 500, text: () => Promise.resolve("upstream blip") };
      }
      if (url === "https://api.anthropic.com/v1/organizations") {
        return jsonResponse(200, { data: [{ plan: "Claude Team" }] });
      }
      return notFound();
    });
    const result = await probeClaudeTier("token", undefined, fetcher as never);
    expect(result.tier).toBe("team");
  });

  it("treats a network throw on one candidate as 'try the next'", async () => {
    // Transient connectivity failure must not surface as a 500 to the
    // user. Per-candidate try/catch lets the chain keep going.
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://api.anthropic.com/api/oauth/userinfo") {
        throw new Error("ENETUNREACH");
      }
      if (url === "https://api.anthropic.com/v1/me") {
        return jsonResponse(200, { plan: "Claude Max" });
      }
      return notFound();
    });
    const result = await probeClaudeTier("token", undefined, fetcher as never);
    expect(result.tier).toBe("max");
  });

  it("falls through to next candidate when response is non-JSON", async () => {
    // Some endpoints return HTML on misconfigured paths. The probe must
    // not throw a JSON parse error — fall through.
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://api.anthropic.com/api/oauth/userinfo") {
        return jsonResponse(200, "<html>error page</html>");
      }
      if (url === "https://api.anthropic.com/v1/me") {
        return jsonResponse(200, { plan: "Claude Pro" });
      }
      return notFound();
    });
    const result = await probeClaudeTier("token", undefined, fetcher as never);
    expect(result.tier).toBe("pro");
  });

  it("falls through when parsed JSON lacks a plan field", async () => {
    // 200 OK but the shape doesn't carry a plan field we understand —
    // must keep trying rather than committing to a wrong default.
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://api.anthropic.com/api/oauth/userinfo") {
        return jsonResponse(200, { sub: "user-123", email: "x@y.z" });
      }
      if (url === "https://api.anthropic.com/v1/me") {
        return jsonResponse(200, { plan: "Claude Max 20x" });
      }
      return notFound();
    });
    const result = await probeClaudeTier("token", undefined, fetcher as never);
    expect(result.tier).toBe("max_20x");
    expect(result.probedEndpoint).toBe("https://api.anthropic.com/v1/me");
  });

  it("returns unknown with rawExcerpt when every candidate fails", async () => {
    // No endpoint answered with a recognised shape. The operator needs
    // a forensic crumb (last response body) to narrow the chain in a
    // follow-up PR.
    const fetcher = vi.fn(async () => jsonResponse(200, { mystery: "field" }));
    const result = await probeClaudeTier("token", undefined, fetcher as never);
    expect(result.tier).toBe("unknown");
    expect(result.rawExcerpt).toContain("mystery");
  });

  it("prepends an org-scoped candidate when organizationId is configured", async () => {
    // User-provided org ID gets tried FIRST — most specific endpoint,
    // highest chance of carrying the plan field. The default chain
    // remains as fallback.
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "https://api.anthropic.com/v1/organizations/bed3566a-41bd-4dcc-9ad7-329b880deaf8") {
        return jsonResponse(200, { plan: "Claude Max 20x" });
      }
      return notFound();
    });
    const result = await probeClaudeTier("token", "bed3566a-41bd-4dcc-9ad7-329b880deaf8", fetcher as never);

    expect(result.tier).toBe("max_20x");
    expect(calls[0]).toBe("https://api.anthropic.com/v1/organizations/bed3566a-41bd-4dcc-9ad7-329b880deaf8");
  });

  it("sanitises organizationId — strips non-uuid chars before interpolating into URL", async () => {
    // Defence against accidental newline/slash leakage even though the
    // input flows through a Zod validator at the route boundary.
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url);
      return notFound();
    });
    await probeClaudeTier("token", "../../etc/passwd\nadmin", fetcher as never);
    // The first probed URL must not contain `..`, `/`, or newline.
    const first = calls[0];
    expect(first).not.toContain("..");
    expect(first).not.toContain("\n");
    expect(first.startsWith("https://api.anthropic.com/v1/organizations/")).toBe(true);
  });

  it("uses the default chain when organizationId is empty string", async () => {
    // Empty `anthropicOrganizationId` setting must behave the same as
    // undefined (the default factory value).
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url);
      return notFound();
    });
    await probeClaudeTier("token", "", fetcher as never);
    // First call must be candidate #1 of the static chain, NOT a
    // half-built `/v1/organizations/` URL.
    expect(calls[0]).toBe(PROBE_CANDIDATE_URLS[0]);
  });

  it("includes anthropic-version header on every probe (Anthropic API requirement)", async () => {
    // Some Anthropic endpoints reject calls missing the version header
    // even on read-only GETs. Without this, the chain would 400 on
    // every candidate.
    const seen: Record<string, string>[] = [];
    const fetcher = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return notFound();
    });
    await probeClaudeTier("token", undefined, fetcher as never);
    for (const headers of seen) {
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Authorization"]).toBe("Bearer token");
    }
  });
});

// ─── PROBE_CANDIDATE_URLS export ──────────────────────────────────────────

describe("PROBE_CANDIDATE_URLS", () => {
  it("exposes the static chain as an ordered readonly list", () => {
    // The export is the contract for the test suite — when the chain
    // narrows after first real production response, this list is the
    // single source the suite asserts against.
    expect(PROBE_CANDIDATE_URLS.length).toBeGreaterThan(0);
    expect(PROBE_CANDIDATE_URLS).toEqual([
      "https://api.anthropic.com/api/oauth/userinfo",
      "https://api.anthropic.com/v1/me",
      "https://api.anthropic.com/v1/organizations",
    ]);
  });
});
