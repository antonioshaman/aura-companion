import { describe, it, expect } from "vitest";
import { AuthTierCache, DEFAULT_TIER_TTL_MS } from "./auth-tier-cache.js";
import type { ClaudeTierResult } from "./auth-tier-prober.js";

function makeResult(tier: ClaudeTierResult["tier"] = "max_20x"): ClaudeTierResult {
  return { tier, plan: "Claude Max 20x", latencyMs: 42 };
}

describe("AuthTierCache", () => {
  it("returns null for never-set tokens", () => {
    const cache = new AuthTierCache();
    expect(cache.get("any-token", undefined)).toBeNull();
  });

  it("returns the stored result within TTL", () => {
    // Common path — cache hit must return the exact same shape stored.
    const cache = new AuthTierCache();
    const result = makeResult();
    cache.set("token", "org-1", result);
    expect(cache.get("token", "org-1")).toEqual(result);
  });

  it("expires entries past the TTL boundary", () => {
    // 1h default TTL; we inject a clock so the test doesn't sleep.
    let now = 1_000_000;
    const cache = new AuthTierCache({ ttlMs: 100, clock: () => now });
    cache.set("token", undefined, makeResult());
    now += 50;
    expect(cache.get("token", undefined)).not.toBeNull();
    now += 60; // 50 + 60 = 110 > ttl 100
    expect(cache.get("token", undefined)).toBeNull();
  });

  it("treats different orgIds as distinct entries for the same token", () => {
    // A user with two org IDs (rare but possible) should not get a
    // collision in the cache — verification result depends on the
    // org-scoped endpoint that's plan-distinct.
    const cache = new AuthTierCache();
    cache.set("same-token", "org-A", makeResult("max_20x"));
    cache.set("same-token", "org-B", makeResult("team"));
    expect(cache.get("same-token", "org-A")?.tier).toBe("max_20x");
    expect(cache.get("same-token", "org-B")?.tier).toBe("team");
  });

  it("invalidate() wipes only the targeted entry", () => {
    // Tokens long enough (>=8 chars) AND with distinct first/last-4
    // fingerprints so the cache key differs per token. Short tokens
    // share the "short" fingerprint by design (documented in the
    // module — see "uses a token fingerprint as the key" test).
    const cache = new AuthTierCache();
    cache.set("AAAA-middle-A-WXYZ", undefined, makeResult("max_20x"));
    cache.set("BBBB-middle-B-1234", undefined, makeResult("pro"));
    cache.invalidate("AAAA-middle-A-WXYZ", undefined);
    expect(cache.get("AAAA-middle-A-WXYZ", undefined)).toBeNull();
    expect(cache.get("BBBB-middle-B-1234", undefined)?.tier).toBe("pro");
  });

  it("clear() wipes every entry", () => {
    const cache = new AuthTierCache();
    cache.set("AAAA-middle-A-WXYZ", undefined, makeResult());
    cache.set("BBBB-middle-B-1234", undefined, makeResult());
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("uses a token fingerprint as the key (does NOT store the full token)", () => {
    // Anti-leak invariant — accidental log of cache keys must not
    // expose any credential. We can't assert on private map state
    // directly without breaking encapsulation, but we can prove that
    // two tokens sharing the SAME first/last 4 chars collide — which
    // is the by-design tradeoff documented in the source.
    const cache = new AuthTierCache();
    const tokenA = "abcd-middle-distinct-A-wxyz";
    const tokenB = "abcd-middle-distinct-B-wxyz";
    cache.set(tokenA, undefined, makeResult("max_20x"));
    expect(cache.get(tokenB, undefined)?.tier).toBe("max_20x");
  });

  it("defaults TTL to 1 hour", () => {
    // Sanity check — the constant is exported so the route + UI can
    // surface "stale by" affordance using the same number.
    expect(DEFAULT_TIER_TTL_MS).toBe(60 * 60 * 1000);
  });
});
