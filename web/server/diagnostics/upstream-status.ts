/**
 * Upstream health record for the Diagnostics Usage card (plan Task 7, AC3).
 *
 * The usage proxies deliberately hide failures from their own responses
 * (`/api/stats/global` returns nulls with 200; `/usage-limits` returns an
 * empty object), which is why the sidebar badge vanished without a trace.
 * Each fetch site now ALSO records its outcome here; the Diagnostics overview
 * reads it through `view()`. Only a closed failure kind and an HTTP status are
 * kept — never an upstream body or OAuth error text (hunt 7).
 *
 * `since` is the onset: set on the first failure after a success (or after a
 * different failure kind) and kept across repeats, so the card can say
 * "KV quota exceeded since 14:02" truthfully.
 */

import type { UpstreamFailureKind, UpstreamStatus } from "./diagnostics-types.js";

export class UpstreamTracker {
  private lastOkAt: number | null = null;
  private failure: UpstreamStatus["failure"] = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  recordOk(): void {
    this.lastOkAt = this.now();
    this.failure = null;
  }

  recordFailure(kind: UpstreamFailureKind, httpStatus?: number): void {
    const same = this.failure && this.failure.kind === kind && this.failure.httpStatus === httpStatus;
    this.failure = {
      kind,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      since: same ? this.failure!.since : this.now(),
    };
  }

  view(): UpstreamStatus {
    return { ok: this.failure === null && this.lastOkAt !== null, lastOkAt: this.lastOkAt, failure: this.failure };
  }

  /** Test-only. */
  reset(): void {
    this.lastOkAt = null;
    this.failure = null;
  }
}

/**
 * Cloudflare Workers answer an exhausted free-tier KV quota either with 429 or
 * with a thrown-exception 500 whose body is "error code: 1101" (seen
 * 2026-09-08 and 2026-10-18 on companion-stats).
 */
export function classifyStatsHttpFailure(status: number, body: string): UpstreamFailureKind {
  if (status === 429) return "kv-quota";
  if (status >= 500 && /\b1101\b/.test(body)) return "kv-quota";
  return "http";
}

export function classifyFetchError(err: unknown): UpstreamFailureKind {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return "timeout";
  if (err instanceof SyntaxError) return "parse";
  return "network";
}

export const globalStatsUpstream = new UpstreamTracker();
export const usageLimitsUpstream = new UpstreamTracker();
