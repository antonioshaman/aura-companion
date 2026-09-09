/**
 * Silent-stdio watchdog for backend adapters.
 *
 * Detects the "subprocess alive, transport open, but no protocol frames
 * arriving from stdout for >threshold ms after we sent a user message"
 * failure mode. Observed in production 2026-09-09: the claude CLI kept
 * writing to its own `~/.claude/projects/*.jsonl` and burning API tokens
 * while its stream-json output silently stopped reaching the bun parent
 * process, so the browser showed six user messages in a row with no
 * assistant reply between them. `state=connected`, `browsers>=1`,
 * `pid` alive — every conventional health signal green.
 *
 * The watchdog is armed when a user message is sent, reset on any
 * parseable frame back from the CLI, and disarmed on the turn-terminator
 * frame (`result`) or transport close. If it fires, the adapter calls
 * `onSilent(reason)`; the orchestrator handles kill + relaunch through
 * the existing keepalive-hook infrastructure.
 *
 * Isolation: the watchdog does NOT know about kill, relaunch, transports,
 * or the bus. Callers wire it into their lifecycle.
 */

export interface SilentStdioWatchdogOptions {
  /** Ms after last frame with no arrivals before {@link onSilent} fires. */
  timeoutMs: number;
  /**
   * Callback fired when the deadline elapses. `sinceMs` is the actual
   * elapsed time — pass through to logs / UI, do not assume it equals
   * `timeoutMs` exactly (there's setTimeout jitter and the arm-time
   * clock skew).
   */
  onSilent: (info: { sinceMs: number; reason: string }) => void;
  /**
   * Optional injectable clock + timer plumbing for tests. Defaults to
   * `Date.now` and the global setTimeout/clearTimeout.
   */
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class SilentStdioWatchdog {
  private readonly timeoutMs: number;
  private readonly onSilent: SilentStdioWatchdogOptions["onSilent"];
  private readonly clock: () => number;
  private readonly setTimer: NonNullable<SilentStdioWatchdogOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<SilentStdioWatchdogOptions["clearTimer"]>;

  private timer: unknown = null;
  private armedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private armReason: string = "";

  constructor(opts: SilentStdioWatchdogOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.onSilent = opts.onSilent;
    this.clock = opts.clock ?? Date.now;
    // The global setTimeout/clearTimeout signature widens over Node/Bun/DOM;
    // wrap in `unknown` and cast at the seam.
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Start (or restart, if already armed) the deadline. Called when a
   * user message is dispatched to the CLI — that is the point at which
   * we expect stdout activity within {@link timeoutMs}.
   */
  arm(reason: string): void {
    this.armedAt = this.clock();
    this.lastFrameAt = this.armedAt;
    this.armReason = reason;
    this.scheduleTimer(this.timeoutMs);
  }

  /**
   * Record a parseable frame from the CLI. Slides the deadline forward
   * — as long as bytes keep arriving the CLI is not silent, even if the
   * turn itself is still in flight for many minutes (long tool calls,
   * multi-file reads).
   */
  onFrame(): void {
    if (this.armedAt === null) return;
    const now = this.clock();
    this.lastFrameAt = now;
    this.scheduleTimer(this.timeoutMs);
  }

  /**
   * Cancel the deadline entirely. Called on the turn-terminator
   * (`result` NDJSON frame) and on transport close — the "turn done"
   * or "connection gone" signals both mean the watchdog should not
   * fire anymore.
   */
  disarm(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.armedAt = null;
    this.lastFrameAt = null;
    this.armReason = "";
  }

  /** True when a deadline is currently active. Exposed for tests + diagnostics. */
  isArmed(): boolean {
    return this.armedAt !== null;
  }

  private scheduleTimer(ms: number): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.timer = this.setTimer(() => {
      // Re-check on wake — the timer may have raced with an arm-reset
      // that landed after clearTimeout was called on the old timer but
      // before the setTimer for the new one; be defensive.
      if (this.armedAt === null || this.lastFrameAt === null) return;
      const now = this.clock();
      const sinceLastFrame = now - this.lastFrameAt;
      if (sinceLastFrame < this.timeoutMs) {
        // A frame slid the deadline forward while the timer was pending;
        // re-schedule for the remaining window rather than fire.
        this.scheduleTimer(this.timeoutMs - sinceLastFrame);
        return;
      }
      const sinceMs = now - this.armedAt;
      const reason = this.armReason;
      // Clear state BEFORE firing so a re-arm inside the callback works.
      this.timer = null;
      this.armedAt = null;
      this.lastFrameAt = null;
      this.armReason = "";
      this.onSilent({ sinceMs, reason });
    }, ms);
  }
}
