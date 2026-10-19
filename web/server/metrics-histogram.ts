// Fixed-bucket timing histogram shared by the runtime metrics modules
// (metrics-collector.ts, delivery-metrics.ts). In-memory only.

import type { HistogramSnapshot } from "./metrics-types.js";

// ── Histogram bucket boundaries (ms) ──────────────────────────────────────

export const TIMING_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000] as const;

// ── Internal histogram data structure ─────────────────────────────────────

export interface Histogram {
  /** Upper bucket boundaries (ms), ascending. A final +Infinity bucket is implicit. */
  bounds: readonly number[];
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Frequency bucket counts. buckets[i] = count of values in (bounds[i-1], bounds[i]]. */
  buckets: number[];
}

export function createHistogram(bounds: readonly number[] = TIMING_BUCKETS_MS): Histogram {
  return {
    bounds,
    count: 0,
    sum: 0,
    min: Infinity,
    max: -Infinity,
    buckets: new Array(bounds.length + 1).fill(0), // +1 for +Infinity bucket
  };
}

export function recordHistogramValue(h: Histogram, value: number): void {
  h.count++;
  h.sum += value;
  if (value < h.min) h.min = value;
  if (value > h.max) h.max = value;

  // Find the appropriate bucket
  for (let i = 0; i < h.bounds.length; i++) {
    if (value <= h.bounds[i]) {
      h.buckets[i]++;
      return;
    }
  }
  // Falls into the +Infinity bucket
  h.buckets[h.bounds.length]++;
}

export function serializeHistogram(h: Histogram): HistogramSnapshot {
  const buckets: Record<string, number> = {};
  for (let i = 0; i < h.bounds.length; i++) {
    buckets[String(h.bounds[i])] = h.buckets[i];
  }
  buckets["Infinity"] = h.buckets[h.bounds.length];

  return {
    count: h.count,
    sum: h.sum,
    min: h.count > 0 ? h.min : 0,
    max: h.count > 0 ? h.max : 0,
    avg: h.count > 0 ? Math.round(h.sum / h.count) : 0,
    p50Bucket: computePercentileBucket(h, 0.5),
    p95Bucket: computePercentileBucket(h, 0.95),
    p99Bucket: computePercentileBucket(h, 0.99),
    buckets,
  };
}

/** Approximate the bucket boundary for a given percentile. */
function computePercentileBucket(h: Histogram, p: number): number {
  if (h.count === 0) return 0;
  const target = Math.ceil(h.count * p);
  let cumulative = 0;
  for (let i = 0; i < h.bounds.length; i++) {
    cumulative += h.buckets[i];
    if (cumulative >= target) return h.bounds[i];
  }
  return Infinity;
}
