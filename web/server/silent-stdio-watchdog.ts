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

/**
 * Multiplier applied to {@link SilentStdioWatchdogOptions.timeoutMs} while a
 * tool_use is outstanding (see {@link SilentStdioWatchdog.setHeld}). A tool the
 * CLI runs locally (Bash build/download/deploy, large multi-file op) can emit
 * zero stdout frames for its whole duration; without this widening the silence
 * watchdog misreads a legitimately-busy turn as a dead stream and kills it
 * mid-work. A genuine hang is still bounded — it fires at this multiple of the
 * base timeout. The classic "stream stopped with no assistant output at all"
 * bug is unaffected: `held` is false until the first tool_use frame arrives.
 */
export const HELD_TIMEOUT_MULTIPLIER = 2;

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
  /** True while a tool_use is outstanding — widens the deadline (see setHeld). */
  private held = false;

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
    // Fresh turn: no tool_use outstanding yet, so the classic
    // no-output-after-user-message bug fires on the normal (un-widened)
    // deadline.
    this.held = false;
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
    this.held = false;
  }

  /** True when a deadline is currently active. Exposed for tests + diagnostics. */
  isArmed(): boolean {
    return this.armedAt !== null;
  }

  /**
   * Mark whether a tool_use is currently outstanding. When the CLI emits an
   * assistant message containing a tool_use block it is about to run a tool
   * locally and may produce NO stdout frames until the tool returns — a long
   * build/download/deploy legitimately looks identical to a dead stream. While
   * held, the silence deadline is widened by {@link HELD_TIMEOUT_MULTIPLIER}.
   * Set false again once the tool result / a plain-text assistant message /
   * the turn terminator arrives. Idempotent; safe to call every frame.
   */
  setHeld(held: boolean): void {
    this.held = held;
  }

  /** True while a tool_use holds the deadline open. Exposed for tests. */
  isHeld(): boolean {
    return this.held;
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
      // While a tool_use is outstanding the CLI is legitimately busy and may
      // emit no frames until the tool returns; widen the deadline so a long
      // local build/deploy isn't misread as a dead stream. A genuine hang is
      // still bounded — it fires at HELD_TIMEOUT_MULTIPLIER x the base timeout.
      const effectiveTimeout = this.held
        ? this.timeoutMs * HELD_TIMEOUT_MULTIPLIER
        : this.timeoutMs;
      if (sinceLastFrame < effectiveTimeout) {
        // A frame slid the deadline forward while the timer was pending, or a
        // tool is holding it open; re-schedule for the remaining window.
        this.scheduleTimer(effectiveTimeout - sinceLastFrame);
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
