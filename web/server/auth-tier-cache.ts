import type { ClaudeTierResult } from "./auth-tier-prober.js";

// ─── In-memory Claude tier cache (PLAN Task 7) ────────────────────────────
//
// Tier verification is rate-limited at Anthropic AND user-visible — UI
// must not hammer the upstream on every render. Cache with explicit TTL
// + manual `invalidate()` called when the user saves Codex credentials
// (which can flip the tier) or hits "Re-verify".
//
// In-memory only — survives across REST calls within one server run but
// not across restart. That's acceptable: tier is cheap to re-fetch, and
// persisting to disk would require another file in `~/.companion/` plus
// migration semantics for what's effectively ephemeral state.

interface CacheEntry {
  result: ClaudeTierResult;
  storedAtMs: number;
}

/** Default TTL: 1 hour. Tier rarely changes mid-session. */
export const DEFAULT_TIER_TTL_MS = 60 * 60 * 1000;

export class AuthTierCache {
  private entries = new Map<string, CacheEntry>();
  private ttlMs: number;
  private clock: () => number;

  constructor(options: { ttlMs?: number; clock?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TIER_TTL_MS;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Cache key combines token (first/last 4 chars for log safety) + orgId.
   * Full token NEVER stored as the key — log lines accidentally leaking
   * the map's keys would expose credentials. We hash visible chars only,
   * which is unique enough for cache purposes since per-deployment token
   * count is tiny.
   */
  private keyOf(token: string, organizationId: string | undefined): string {
    const tokenFingerprint = token.length >= 8
      ? `${token.slice(0, 4)}...${token.slice(-4)}`
      : "short";
    return `${tokenFingerprint}|${organizationId ?? ""}`;
  }

  /** Returns the cached entry if still within TTL; otherwise null. */
  get(token: string, organizationId: string | undefined): ClaudeTierResult | null {
    const entry = this.entries.get(this.keyOf(token, organizationId));
    if (!entry) return null;
    if (this.clock() - entry.storedAtMs > this.ttlMs) {
      this.entries.delete(this.keyOf(token, organizationId));
      return null;
    }
    return entry.result;
  }

  set(token: string, organizationId: string | undefined, result: ClaudeTierResult): void {
    this.entries.set(this.keyOf(token, organizationId), {
      result,
      storedAtMs: this.clock(),
    });
  }

  /** Wipe one cache entry (used when the user saves new credentials). */
  invalidate(token: string, organizationId: string | undefined): void {
    this.entries.delete(this.keyOf(token, organizationId));
  }

  /** Wipe everything — for tests and shutdown. */
  clear(): void {
    this.entries.clear();
  }

  /** Size accessor for tests. */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Singleton instance — the route reads from this. Constructed at module
 * load time so test suites that import the route get a fresh cache by
 * resetting via `tierCache.clear()` in their `beforeEach`.
 */
export const tierCache = new AuthTierCache();
