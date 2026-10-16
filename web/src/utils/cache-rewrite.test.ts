import { describe, expect, it } from "vitest";
import {
  CACHE_HINT_IDLE_MINUTES,
  CACHE_HINT_MIN_TOKENS,
  estimateIdleCacheRewrite,
  estimateModelSwitchCacheRewrite,
  formatIdleGap,
} from "./cache-rewrite.js";

// W7(b) — pure estimate behind the "кеш истёк/сбросится" hint. The estimate
// is the last known full prompt (last_context_tokens, server-tracked from the
// main thread's last request): that is what a cold cache must write again.

const NOW = Date.parse("2026-10-16T12:00:00Z");
const BIG = 120_000;

describe("estimateIdleCacheRewrite", () => {
  it("returns the token estimate once the session sat idle past the TTL with a large context", () => {
    const r = estimateIdleCacheRewrite({ last_turn_completed_at: NOW - 61 * 60_000, last_context_tokens: BIG }, NOW);
    expect(r).toEqual({ tokens: BIG, idleMinutes: 61 });
  });

  it("is null within the TTL window (cache still warm)", () => {
    expect(estimateIdleCacheRewrite({ last_turn_completed_at: NOW - (CACHE_HINT_IDLE_MINUTES - 1) * 60_000, last_context_tokens: BIG }, NOW)).toBeNull();
  });

  it("is null for small contexts — a rewrite there is not worth a hint", () => {
    expect(estimateIdleCacheRewrite({ last_turn_completed_at: NOW - 5 * 3_600_000, last_context_tokens: CACHE_HINT_MIN_TOKENS - 1 }, NOW)).toBeNull();
  });

  it("is null when either input is unknown (fresh session, pre-upgrade state)", () => {
    expect(estimateIdleCacheRewrite({ last_context_tokens: BIG }, NOW)).toBeNull();
    expect(estimateIdleCacheRewrite({ last_turn_completed_at: NOW - 5 * 3_600_000 }, NOW)).toBeNull();
    expect(estimateIdleCacheRewrite(undefined, NOW)).toBeNull();
  });
});

describe("estimateModelSwitchCacheRewrite", () => {
  it("returns the estimate for a large context regardless of idle time (a switch always rebuilds)", () => {
    expect(estimateModelSwitchCacheRewrite({ last_context_tokens: BIG })).toEqual({ tokens: BIG });
  });
  it("is null for small or unknown contexts", () => {
    expect(estimateModelSwitchCacheRewrite({ last_context_tokens: 1000 })).toBeNull();
    expect(estimateModelSwitchCacheRewrite({})).toBeNull();
  });
});

describe("formatIdleGap", () => {
  it("renders minutes under two hours, hours above, days above two days", () => {
    expect(formatIdleGap(75)).toBe("75 мин");
    expect(formatIdleGap(181)).toBe("3 ч");
    expect(formatIdleGap(60 * 50)).toBe("2 дн");
  });
});
