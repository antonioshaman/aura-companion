// AURA-LOCAL — PLAN T10 (Story 2a). SOLE assembly site for the
// `cli_failed` browser frame per AP-14: every CliFailedFrame
// instantiation in production code MUST route through
// `buildCliFailedFrame`. The EC-37 call-site canary
// (cli-failed-frame.test.ts) greps the repo for raw
// `type: "cli_failed"` literals in non-test code and asserts
// zero hits — every emit goes through this builder.
//
// Reason union is a CLOSED 5-variant union (Willison R3 —
// enum-only payload, no raw drained-message content). Adding a
// sixth reason is a typecheck error at the exhaustive
// `switch(reason)` below: the `const _: never = reason;` tail
// forces the new variant to be classified explicitly before it
// can ship.
//
// The frame lands in the per-session `eventBuffer` via the
// bridge's existing `broadcastToBrowsers` helper (Realtime R1 —
// reconnect replay). Clients dedupe on `(sessionId, type,
// firedAt)` so the same logical failure replayed on browser
// reconnect renders exactly once. The
// `origin: "server:cleanup-drain"` discriminator is stamped
// here so recorder attribution and EC-9 logs distinguish
// drain-fanouts from other server-synthesised emits (council
// wake, auto-proceed).

/**
 * Closed reason union for `cli_failed`. Each variant maps to a
 * distinct operator-facing recovery path:
 *
 *   - `relaunch_exhausted`         retry budget spent OR a
 *                                  structural relaunch failure
 *                                  that mapped to the catch-all
 *                                  (observer-prompt config
 *                                  failure, source-drift refusal).
 *   - `container_missing`          Docker container was deleted
 *                                  externally.
 *   - `container_stopped`          Docker container is stopped
 *                                  and could not be restarted.
 *   - `binary_missing`             `claude` / `codex` binary is
 *                                  absent inside the container
 *                                  (image needs rebuilding).
 *   - `browser_closed_no_reconnect` last browser closed and the
 *                                  drain-grace window expired
 *                                  without a reconnect.
 *                                  Subprocess is still alive
 *                                  (Subprocess R10) — drain is
 *                                  queue+notify only, NEVER
 *                                  calls `proc.kill()` in this
 *                                  branch.
 */
export type CliFailedReason =
  | "relaunch_exhausted"
  | "container_missing"
  | "container_stopped"
  | "binary_missing"
  | "browser_closed_no_reconnect";

/**
 * Wire shape of the `cli_failed` browser frame.
 * Discriminated-union variant of `BrowserIncomingMessageBase`
 * (see `session-types.ts`).
 *
 * `seq` is assigned by the bridge's per-session monotonic counter
 * via `nextEventSeq` (Realtime R1 — replay-safe ordering).
 * `firedAt` is the server wallclock at emit time, used by the
 * client deduper.
 *
 * `details` is intentionally narrow: an OPTIONAL `lastErrorSha256`
 * for server-side correlation only. NO raw error strings /
 * message bodies flow through the wire (Willison R3 + EC-23
 * redaction at the source).
 */
export interface CliFailedFrame {
  type: "cli_failed";
  seq: number;
  sessionId: string;
  reason: CliFailedReason;
  /** Number of `pendingMessages` entries cleared at emit time.
   *  Zero is valid for `subprocessAlive: false` reasons
   *  (always-fire path); zero suppresses the server-side
   *  broadcast for `browser_closed_no_reconnect` (Story 2 AC
   *  suppression rule). */
  drainedCount: number;
  /** Whether the CLI subprocess is still alive at frame-build
   *  time. `false` for cli-launcher structural failures (process
   *  gone, not recoverable); `true` for
   *  `browser_closed_no_reconnect` (drain is queue+notify only —
   *  process untouched). The frontend uses this axis to phrase
   *  the recovery action correctly. */
  subprocessAlive: boolean;
  firedAt: number;
  origin: "server:cleanup-drain";
  details?: {
    lastErrorSha256?: string;
  };
}

/**
 * Options accepted by {@link buildCliFailedFrame}. All numerics
 * are caller-supplied so the builder stays pure (no clock reads,
 * no counter mutations) — drain-selector.ts owns the seq claim
 * and the `pendingMessages.length` snapshot, this builder owns
 * the type narrowing + exhaustive switch + `subprocessAlive`
 * derivation.
 */
export interface BuildCliFailedFrameOpts {
  seq: number;
  drainedCount: number;
  firedAt: number;
  details?: {
    lastErrorSha256?: string;
  };
}

/**
 * SOLE assembly site for {@link CliFailedFrame}. Routes every
 * reason through an exhaustive `switch` with a
 * `const _: never = reason;` tripwire — adding a sixth reason
 * breaks the build until the new `subprocessAlive` mapping is
 * added explicitly.
 *
 * The `subprocessAlive` axis is DERIVED from `reason` (not
 * caller-supplied) so the invariant
 * "browser_closed_no_reconnect implies true, everything else
 * implies false" is single-sourced. A drain dispatcher that
 * wants to fire `relaunch_exhausted` with
 * `subprocessAlive: true` (or vice-versa) is a bug; the builder
 * produces only the canonical shape.
 */
export function buildCliFailedFrame(
  reason: CliFailedReason,
  sessionId: string,
  opts: BuildCliFailedFrameOpts,
): CliFailedFrame {
  let subprocessAlive: boolean;
  switch (reason) {
    case "relaunch_exhausted":
    case "container_missing":
    case "container_stopped":
    case "binary_missing":
      subprocessAlive = false;
      break;
    case "browser_closed_no_reconnect":
      subprocessAlive = true;
      break;
    default: {
      // Exhaustiveness tripwire — adding a sixth variant to
      // `CliFailedReason` without updating this switch is a
      // typecheck error here.
      const _: never = reason;
      void _;
      throw new Error(`buildCliFailedFrame: unhandled reason ${String(reason)}`);
    }
  }
  return {
    type: "cli_failed",
    seq: opts.seq,
    sessionId,
    reason,
    drainedCount: opts.drainedCount,
    subprocessAlive,
    firedAt: opts.firedAt,
    origin: "server:cleanup-drain",
    ...(opts.details ? { details: opts.details } : {}),
  };
}
