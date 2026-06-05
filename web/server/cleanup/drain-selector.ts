// AURA-LOCAL — PLAN T11 (Story 2b). Pure selector extracted per
// Fowler R5 from the bridge's 4-step drain dispatch. Inputs:
// `(session, reason, seq, firedAt, details?)`. Outputs the snapshot
// the call site needs to perform the inline drain (browserIds + the
// typed frame + the pendingMessages length). The call site KEEPS
// the 4-step dispatch INLINE so the `pendingMessages` mutation
// stays visible at the place that owns the side effects:
//
//   (1) snapshot pendingMessages (this selector reads `.length`
//       only — caller still holds the array for clear+broadcast)
//   (2) clear Map entry + persist BEFORE broadcast (Persistence R7)
//   (3) broadcastToBrowsers(session, frame)
//   (4) recordCleanupEvent("drained_pending")
//
// The selector itself is pure: it reads from `session` but does not
// mutate it; it calls `buildCliFailedFrame` (the AP-14 sole assembly
// site) so the wire shape stays single-sourced. Tests can verify
// the selector's output without spinning up a bridge.

import { buildCliFailedFrame, type CliFailedReason } from "../cli-failed-frame.js";
import type { CliFailedFrame } from "../cli-failed-frame.js";
import type { Session } from "../ws-bridge-types.js";

/**
 * Per-selector output: the frozen view of the session that drain
 * needs. The selector itself never mutates the seq counter — even
 * by reading it; the bridge's broadcast path owns the increment.
 */
export interface DrainSelection {
  /** Placeholder ids — one per attached browser socket — so EC-9
   *  log payloads can report fanout cardinality without leaking
   *  any browser-specific fingerprint (Hunt R5 — never serialise
   *  raw ws handles). Sufficient for debug + test assertions. */
  browserIds: string[];
  /** The fully-assembled `cli_failed` frame, ready for
   *  `broadcastToBrowsers`. The caller MUST NOT mutate this object
   *  after receiving it — the AP-14 invariant assumes the frame is
   *  immutable after build. */
  frame: CliFailedFrame;
  /** Number of `pendingMessages` entries the caller will clear in
   *  step (2). Captured here so the value is single-sourced (the
   *  same value lands in `frame.drainedCount`, in EC-9 log, and in
   *  the `recordCleanupEvent("drained_pending")` counter). */
  pendingCount: number;
}

/**
 * Pure selector. Does NOT mutate the session. Calls
 * `buildCliFailedFrame` exactly once to materialise the wire shape.
 *
 * `seq` is caller-supplied (NOT `session.nextEventSeq++`) so the
 * selector remains pure. The bridge's broadcast path increments
 * the counter at send time; the seq passed here MUST match the
 * value the bridge will assign when calling `broadcastToBrowsers`.
 * That "MUST match" is no longer prose-only (Realtime finding #13):
 * `sequenceEvent` asserts the pre-built seq equals the authoritative
 * counter before overwriting it, so a broadcast inserted between this
 * build and dispatch throws instead of silently desyncing replay.
 */
export function selectDrainTargets(
  session: Session,
  reason: CliFailedReason,
  seq: number,
  firedAt: number,
  details?: { lastErrorSha256?: string },
): DrainSelection {
  const pendingCount = session.pendingMessages.length;
  const browserIds: string[] = [];
  let i = 0;
  for (const _ of session.browserSockets) {
    void _;
    browserIds.push(`browser_${i}`);
    i++;
  }
  const frame = buildCliFailedFrame(reason, session.id, {
    seq,
    drainedCount: pendingCount,
    firedAt,
    ...(details ? { details } : {}),
  });
  return { browserIds, frame, pendingCount };
}

/**
 * Suppression predicate per the Story 2 AC:
 *   "Given a session has zero queued messages on close, Then no
 *    spurious broadcast fires."
 *
 * Resolution:
 *   - `browser_closed_no_reconnect` with drainedCount === 0 -> SUPPRESS
 *     (no queued messages, no user-visible loss, no point waking
 *     the next-reconnecting browser with an empty-drain notice)
 *   - any other reason -> ALWAYS-FIRE (Realtime R2 silent-death
 *     prevention: structural failures with zero queued messages
 *     STILL need a `cli_failed` so the next browser sees the dead
 *     CLI on reconnect)
 *
 * Caller checks this BEFORE the 4-step dispatch. If suppressed,
 * the dispatch is a complete no-op (no clear, no persist, no
 * broadcast, no counter). The selector's output is discarded.
 */
export function shouldSuppressDrain(reason: CliFailedReason, drainedCount: number): boolean {
  return reason === "browser_closed_no_reconnect" && drainedCount === 0;
}
