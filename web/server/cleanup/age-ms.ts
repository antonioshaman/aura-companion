// AURA-LOCAL
// ONE wallclock-delta helper. PLAN task T2. Every TTL predicate, eviction-grace
// check, sliding-window prune in the cleanup subsystem routes through this
// so the EC-38 negative-skew clamp + the `clock.skew_detected` WARN happen
// at exactly one site.
//
// EC-38: bare `(now - past) > ttlMs` silently fails-OPEN when the host clock
// jumps backward (NTP correction, VM resume, suspended laptop wake). The
// `Math.max(0, raw)` clamp treats negative skew as zero-age — still bounded
// by the threshold going forward — and the WARN log gives the operator a
// trail.
//
// EC-40: the test-only clock-source override (`setClockSourceForTests`,
// `__resetClockSourceForTests`) is a plain ESM export — NO inline
// `require()` + eslint-disable.
//
// AP-17: the module-scope mutable `clockSource` is bundled with both
// reset helpers + at least one test exercising the warn-path + an explicit
// reset in `beforeEach`/`afterEach` of every suite that calls it.

import { log } from "../logger.js";

type ClockSource = () => number;
const DEFAULT_CLOCK_SOURCE: ClockSource = () => Date.now();
let clockSource: ClockSource = DEFAULT_CLOCK_SOURCE;

/**
 * Test seam: install a deterministic clock source. Pair with
 * `__resetClockSourceForTests` in `afterEach` to avoid cross-test leakage.
 * Production callers MUST NOT call this — `setClockSourceForTests` does
 * not enforce that at runtime, but the `ForTests` suffix is the project's
 * convention for the boundary.
 */
export function setClockSourceForTests(fn: ClockSource): void {
  clockSource = fn;
}

/** Test seam: restore the default `Date.now` clock source. */
export function __resetClockSourceForTests(): void {
  clockSource = DEFAULT_CLOCK_SOURCE;
}

/**
 * Wallclock age in ms, clamped to ≥0. If the raw difference is negative
 * (clock jumped backward), the return value is clamped to 0 AND a
 * `clock.skew_detected` WARN is emitted naming the negative skew so
 * operators can correlate cache-invalidation anomalies with NTP events.
 *
 * The caller's threshold check remains correct: a clamped 0 < ttlMs
 * means "treat as fresh until wall-clock catches up," which is the
 * documented EC-38 contract.
 *
 * `nowMs` parameter exists so callers that already have a snapshot of
 * the clock (e.g., a sweep tick that captures `Date.now()` once and
 * compares against many rows) can avoid re-reading the clock per row.
 * When omitted, the module-scope clock source is read (default
 * `Date.now`, test-overrideable via `setClockSourceForTests`).
 */
export function ageMs(pastMs: number, nowMs?: number): number {
  const now = nowMs ?? clockSource();
  const raw = now - pastMs;
  if (raw < 0) {
    log.warn("age-ms", "clock skew detected — negative age clamped to 0", {
      event: "clock.skew_detected",
      now,
      pastMs,
      skewMs: raw,
    });
    return 0;
  }
  return raw;
}
