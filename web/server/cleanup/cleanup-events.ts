// AURA-LOCAL
// Cleanup events counter store. PLAN task T5.
//
// ONE module-private array `recentCleanupEvents: CleanupEvent[]` with
// append-on-event + prune-then-count-at-read semantics. Bounded at insert
// (10K cap); when full, the oldest entry is dropped + a one-shot
// `dropped_counter_overflow` WARN fires so operators see saturation
// rather than silent drops.
//
// EC-21 single source of truth: the triplet
// `(evicted, orphan_reaped, drained_pending)` + the recordings pair
// derives from this one store. `metricsCollector` reads via
// `getCleanupEventCountLastHour(kind)` and exposes 5 projection methods —
// the store is the contract floor, `metricsCollector` is the read seam.
//
// AP-17: the module-scope mutable `droppedOverflowWarned` flag is bundled
// with `__resetCleanupCountersForTests` (also clears the events array) +
// a test exercising the warn-path + a `beforeEach` reset.
//
// `getCleanupEventCountLastHour` prunes BEFORE counting — events older
// than 1h are removed from the array. The prune is idempotent: calling
// the function 5 times in a row (once per projection method) is the
// same cost as once.

import { ageMs, nowMs } from "./age-ms.js";
import { log } from "../logger.js";

/**
 * Closed enum of cleanup-event kinds. Phase D ships `orphan_reaped`
 * emit sites; Phase F ships `drained_pending`; Phase E ships
 * `recordings_soft_archived` + `recordings_hard_deleted`; Phase H
 * ships `evicted`. The resource-reclamation plan ships `terminal_reaped`.
 * Adding a new kind requires extending this union (Fowler P5 + primitive
 * obsession — every consumer narrows on `kind`).
 */
export type CleanupEventKind =
  | "evicted"
  | "orphan_reaped"
  | "drained_pending"
  | "recordings_soft_archived"
  | "recordings_hard_deleted"
  | "terminal_reaped";

interface CleanupEvent {
  readonly kind: CleanupEventKind;
  readonly ts: number;
}

const MAX_RECENT_EVENTS = 10_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const recentCleanupEvents: CleanupEvent[] = [];
let droppedOverflowWarned = false;

/**
 * Append a cleanup event. Bounded by `MAX_RECENT_EVENTS`; on overflow,
 * the oldest entry is dropped to make room AND a one-shot WARN fires
 * (subsequent overflow drops are silent until the flag is reset, which
 * happens only via `__resetCleanupCountersForTests`).
 *
 * The `ts` field is captured here (one clock read at emit) so the read
 * path's age check uses the actual emit time, not the read time.
 */
export function recordCleanupEvent(kind: CleanupEventKind): void {
  if (recentCleanupEvents.length >= MAX_RECENT_EVENTS) {
    if (!droppedOverflowWarned) {
      droppedOverflowWarned = true;
      log.warn("cleanup-events", "Counter store at capacity — dropping oldest events", {
        event: "dropped_counter_overflow",
        cap: MAX_RECENT_EVENTS,
        droppedKind: recentCleanupEvents[0]?.kind ?? "unknown",
      });
    }
    recentCleanupEvents.shift();
  }
  // Use `nowMs()` (age-ms clock seam), NOT `Date.now()`. Both read and
  // write paths MUST go through the same seam — otherwise a test that
  // injects a deterministic clock via `setClockSourceForTests` sees the
  // emit-side timestamp diverge from the read-side window, and the
  // prune appears to silently leak. EC-21 single-source-of-truth at the
  // clock-source axis, not just the event triplet.
  recentCleanupEvents.push({ kind, ts: nowMs() });
}

/**
 * Count events of `kind` recorded within the last hour. Prunes the store
 * of any entry older than 1h BEFORE counting (sliding-window) so a quiet
 * day's old entries don't accumulate.
 *
 * `nowMs` is the optional injected clock — when omitted, `ageMs` reads
 * the module-scope clock source (default `Date.now()`, test-overridable
 * via `setClockSourceForTests` from age-ms.js).
 */
export function getCleanupEventCountLastHour(kind: CleanupEventKind, nowMs?: number): number {
  pruneOlderThan(ONE_HOUR_MS, nowMs);
  let count = 0;
  for (const ev of recentCleanupEvents) {
    if (ev.kind === kind) count++;
  }
  return count;
}

/**
 * Drop events older than `windowMs` from the head of the array. Uses
 * `ageMs` so the EC-38 clock-skew clamp + `clock.skew_detected` WARN
 * fire at exactly one site (the helper). After NTP correction, a clamped
 * 0 age means "treat as fresh" — events survive backward time jumps
 * rather than being silently purged.
 */
function pruneOlderThan(windowMs: number, nowMs?: number): void {
  let dropIndex = 0;
  while (dropIndex < recentCleanupEvents.length) {
    if (ageMs(recentCleanupEvents[dropIndex].ts, nowMs) <= windowMs) break;
    dropIndex++;
  }
  if (dropIndex > 0) {
    recentCleanupEvents.splice(0, dropIndex);
  }
}

/**
 * Test seam (AP-17): clear the events array AND the
 * `droppedOverflowWarned` flag. Production callers MUST NOT call this —
 * the `ForTests` suffix is the project's boundary marker.
 *
 * Any test suite that records events MUST call this in `beforeEach`
 * (or equivalent) so previous tests' events don't leak into the new
 * test's count expectations.
 */
export function __resetCleanupCountersForTests(): void {
  recentCleanupEvents.length = 0;
  droppedOverflowWarned = false;
}

/**
 * Test-only inspection helper: returns the current store size without
 * mutating it. Used by the AP-17 warn-path test to confirm the bound
 * behaviour at the overflow boundary.
 */
export function __getCleanupEventStoreSizeForTests(): number {
  return recentCleanupEvents.length;
}
