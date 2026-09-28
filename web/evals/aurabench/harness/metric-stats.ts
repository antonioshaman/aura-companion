/**
 * Aggregation over cell metrics for the D3 report (P6/FIX-D2-4). A null
 * metric is UNKNOWN (Codex cost, a Codex session without a token report) —
 * it is excluded from the mean and counted separately, never read as 0.
 * Pilot 1 wrote F/G cost 0, which would have averaged into "Codex is free".
 *
 * Pure. Firewall-clean.
 */

export interface KnownStats {
  /** Values given (known + unknown). */
  n: number;
  /** Values that were known (non-null, finite). */
  known: number;
  /** Values that were null / non-finite. */
  unknown: number;
  /** Mean of the known values; null when none is known. */
  mean: number | null;
  /** Sum of the known values; null when none is known. */
  sum: number | null;
}

export function knownStats(values: readonly (number | null | undefined)[]): KnownStats {
  let known = 0;
  let sum = 0;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    known++;
    sum += v;
  }
  return {
    n: values.length,
    known,
    unknown: values.length - known,
    mean: known ? sum / known : null,
    sum: known ? sum : null,
  };
}
