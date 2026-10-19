import { trackSync } from "./event-loop-lag-monitor.js";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { containerManager } from "./container-manager.js";
import { companionBus } from "./event-bus.js";
import { metricsCollector } from "./metrics-collector.js";
import { deliveryMetrics } from "./delivery-metrics.js";
import { log } from "./logger.js";
import { nextModelInChain, computeSilenceRotation } from "./model-fallback-chain.js";
import {
  checkDrift,
  countUndeliveredAssistantRecords,
  readUndeliveredAssistantRecords,
  RECOVERY_LOOKBACK_MS,
  defaultSubagentActivitySince,
  defaultSubagentOpenToolCallSince,
  resolveCliSessionPaths,
  subagentTreeLive,
  SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION,
  type DriftVerdict,
  mainThreadOpenToolCallStartedAt,
  SUBAGENT_OPEN_TOOL_CALL_CEILING_MS,
} from "./silent-stdio-drift-detector.js";
import {
  CODEX_COMPACTION_LADDER,
  TRANSCRIPT_BYTES_LADDER,
  decodeContextAdvisory,
  nextContextMilestone,
  type ContextLadder,
} from "./context-size-suggester.js";
import type { ContextAdvisoryRecord } from "./session-types.js";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { summarizeWaitChannels } from "./process-wait-channels.js";
import type { IntentionalKills } from "./intentional-kills.js";

/**
 * Session recovery controller (aura-meta-diet P4/C1d).
 *
 * Owns every path that brings a dead or deaf CLI subprocess back:
 *  - auto-relaunch with a per-session budget ({@link MAX_AUTO_RELAUNCHES}),
 *    grace + cooldown, and the `session:relaunch-failed` signal the council
 *    reconnect listener short-circuits on;
 *  - proactive keepalive (exponential backoff after `session:exited`);
 *  - silence recovery (`session:backend-silent` kill + recurring-silence
 *    model rotation) and rate-limit / unknown-model fallback;
 *  - the silent-stdio drift detector tick (+ compaction advisory);
 *  - the boot reconnection watchdog for sessions stuck in `starting`.
 *
 * P4/FIX-AUTOHEAL-1: every relaunch — manual (REST), observer auto-heal,
 * auto-relaunch, boot watchdog — goes through {@link SessionRecovery.relaunchOnce},
 * a per-session single-flight gate. Two paths firing together (after a server
 * restart the boot watchdog and the observer catch-up poll both wake at ~30 s)
 * used to spawn two CLIs with `--resume` on one cliSessionId, orphaning one.
 *
 * Extracted verbatim from `session-orchestrator.ts`. The orchestrator owns
 * `intentionalKills` (council lifecycle, archive and delete write it too) and
 * hands it in (AP-1 DI); the council-specific follow-ups of a successful
 * relaunch (got-050 spawn-checkpoint re-arm) and the API-limit pause of
 * auto-proceed are injected callbacks, so this module knows nothing about
 * council groups.
 */

export const MAX_AUTO_RELAUNCHES = 3;
export const RELAUNCH_GRACE_MS = 10_000;
export const RELAUNCH_COOLDOWN_MS = 5_000;
/**
 * P4/FIX-AUTOHEAL-1: after a successful relaunch the new CLI needs time to
 * attach (Codex `thread/resume` ~16 s). Automatic paths (auto-relaunch, boot
 * watchdog, observer auto-heal) do not relaunch the same session again inside
 * this window; an explicit manual relaunch always runs.
 */
export const RELAUNCH_SETTLE_MS = 60_000;

export type RelaunchSource = "manual" | "autoheal" | "auto_relaunch" | "boot_watchdog" | "drift_recovery";

export interface RelaunchOutcome {
  ok: boolean;
  error?: string;
  /** Set when an automatic caller found a relaunch already settling. */
  skipped?: "recently_relaunched";
}
export const RECONNECT_GRACE_MS = Number(process.env.COMPANION_RECONNECT_GRACE_MS || "30000");

/**
 * How many consecutive `session:backend-silent` events on the SAME
 * session AND the SAME model trigger a model-rotation (via
 * `nextModelInChain`) before the subprocess is killed for respawn.
 * `2` means "one silence is a hiccup, two on the same model is a
 * pattern → downgrade before the next respawn tries the same model
 * again". Reset by a successful `orchestrator:turn-done` (proof the
 * current model works). See `handleBackendSilent` for full mechanics
 * and `feedback_claude_cli_opus5_stdout_dead_jsonl_alive.md` for the
 * incident that motivated this.
 */
export const RECURRING_SILENCE_ROTATE_THRESHOLD = 2;

/**
 * Interval for the silent-stdio drift detector tick (see
 * `silent-stdio-drift-detector.ts`). 15s tightens the silent-stdio
 * drift auto-heal window to ~105s (15s tick + 90s
 * `DEFAULT_LAG_TOLERANCE_MS`) vs the old ~150s (60s + 90s) — still well
 * inside the 300s silence watchdog. Per-session `stat()` on every tick is
 * negligible at any realistic session count.
 */
export const DRIFT_DETECTOR_TICK_MS = 15_000;

/**
 * Drift-recovery rate guard (PLAN Task 4b). A clean relaunch resets
 * `autoRelaunchCounts`, so a chronically false-firing detector never trips the
 * crash budget — it loops invisibly (destroy work → burn tokens → re-read a
 * growing jsonl). Past this many drift recoveries of one session inside
 * {@link DRIFT_RECOVERY_RATE_WINDOW_MS}, the tick stops relaunching and surfaces
 * one diagnostic instead.
 */
export const DRIFT_RECOVERY_RATE_MAX = 3;
export const DRIFT_RECOVERY_RATE_WINDOW_MS = 30 * 60_000;

/**
 * First stage of the drift decision (PLAN Tasks 3 + review #5): what a verdict
 * means for this tick, given the session's queued-message count and the
 * recovery guards. Pure — the tick does the I/O and side effects around it.
 *
 * - `skip`      nothing to do (healthy, or a guard says the session is not ours to recover);
 * - `suppress`  the detector withheld the kill — log it (once per stall + reason);
 * - `candidate` recovery is warranted pending the kill-time guards ({@link decideDriftKill}).
 *
 * The suppression override is per reason (PLAN Task 3, switch without default):
 * - `no_undelivered_output` — queued user messages override it: a subprocess
 *   stuck on an incomplete previous turn (context-limit hard-cut, no `result`
 *   frame) looks idle while it blocks the queue (#327).
 * - `live_subagent_activity` — NOT overridable: a queued prompt is not
 *   evidence the CLI is dead, and killing it destroys an in-flight Task
 *   fan-out. The prompt waits for the fan-out to collapse.
 */
export type DriftTickAction =
  | { kind: "skip" }
  | { kind: "suppress"; reason: NonNullable<DriftVerdict["suppressedReason"]>; pendingMessages: number }
  | { kind: "candidate"; trigger: "drift" | "pending_override"; pendingMessages: number };

export function decideDriftAction(
  verdict: Pick<DriftVerdict, "drifted" | "suppressedReason">,
  ctx: { pendingMessages: number; intentionallyKilled: boolean; relaunchExhausted: boolean },
): DriftTickAction {
  let trigger: "drift" | "pending_override";
  const reason = verdict.suppressedReason;
  if (reason === null) {
    if (!verdict.drifted) return { kind: "skip" };
    trigger = "drift";
  } else {
    switch (reason) {
      case "no_undelivered_output":
        if (ctx.pendingMessages === 0) return { kind: "suppress", reason, pendingMessages: 0 };
        trigger = "pending_override";
        break;
      case "live_subagent_activity":
        return { kind: "suppress", reason, pendingMessages: ctx.pendingMessages };
      default: {
        const unknown: never = reason;
        throw new Error(`unhandled drift suppression reason: ${String(unknown)}`);
      }
    }
  }
  // Belt-and-braces guards mirroring `handleBackendSilent`.
  if (ctx.intentionallyKilled || ctx.relaunchExhausted) return { kind: "skip" };
  return { kind: "candidate", trigger, pendingMessages: ctx.pendingMessages };
}

/** A CLI thread parked in `pipe_write` = bun stopped draining its stdout. */
export function waitChannelsShowPipeWrite(waitChannels: string | null): boolean {
  return waitChannels !== null && /(^|, )pipe_write×/.test(waitChannels);
}

/**
 * Second stage, run only for a `candidate` (PLAN Tasks 2 + 4b). Pure.
 *
 * Task 2 — the model-output signal alone cannot tell "stdout pipe dead" from
 * "CLI busy on a long multi-subagent turn". A destructive kill requires
 * liveness evidence of actual stdout death: a `pipe_write` wait channel (bun
 * stalled draining — the pipe really is wedged) OR no recent subagent
 * activity. The 2026-10-14 incident signature `futex_wait_queue/ep_poll, NO
 * pipe_write` with a live subagent tree is a busy CLI → `withhold_live`. This
 * is what guards the `pending_override` path, which never ran the detector's
 * liveness gate. Unknown wait channels (no pid / no /proc) fall back to the
 * subagent evidence alone.
 *
 * Task 4b — a recovery the guard allows still respects the per-session rate
 * cap; past it → `rate_limited` (diagnostic, no kill).
 */
export type DriftKillDecision =
  | { kind: "recover"; pipeWrite: boolean }
  | { kind: "withhold_live" }
  | { kind: "withhold_open_tool_call" }
  | { kind: "rate_limited"; recentRecoveries: number };

export function decideDriftKill(input: {
  waitChannels: string | null;
  subagentActive: boolean;
  recentRecoveries: number;
  /**
   * The main thread is inside the ONE tool call that was open when this stall
   * was first seen, and that call is younger than
   * `SUBAGENT_OPEN_TOOL_CALL_CEILING_MS` (owner incident 2026-10-18: every
   * drift kill landed mid Bash call and lost it — the kill waits for the
   * tool_result to reach the jsonl, then relaunches from it). Regardless of
   * `pipe_write`: the tool runs and writes the jsonl whatever stdout does.
   */
  mainToolCallOpen?: boolean;
}): DriftKillDecision {
  const pipeWrite = waitChannelsShowPipeWrite(input.waitChannels);
  if (!pipeWrite && input.subagentActive) return { kind: "withhold_live" };
  if (input.mainToolCallOpen) return { kind: "withhold_open_tool_call" };
  if (input.recentRecoveries >= DRIFT_RECOVERY_RATE_MAX) {
    return { kind: "rate_limited", recentRecoveries: input.recentRecoveries };
  }
  return { kind: "recover", pipeWrite };
}

/** Drop timestamps outside the rate window; returns the kept (recent) ones. */
export function pruneDriftRecoveries(history: readonly number[], now: number): number[] {
  return history.filter((t) => now - t < DRIFT_RECOVERY_RATE_WINDOW_MS);
}

// Proactive keepalive: base delay before relaunching a crashed CLI (doubles per attempt)
export const KEEPALIVE_BASE_DELAY_MS = 3_000;

/**
 * W2: spacing between the proactive boot resumes of sessions that were alive
 * before a server restart, so N CLIs are not spawned in the same instant.
 * Session i fires at `(i + 1) * BOOT_RESUME_STAGGER_MS`, then goes through
 * {@link SessionRecovery.handleAutoRelaunch} (its own grace + guards).
 */
export const BOOT_RESUME_STAGGER_MS = Number(process.env.COMPANION_BOOT_RESUME_STAGGER_MS || "1500");

export interface SessionRecoveryDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  /**
   * Orchestrator-owned: sessions killed on purpose (idle-kill, archive,
   * delete, group degrade). Keepalive, silence and drift recovery skip them.
   */
  intentionalKills: IntentionalKills;
  /** Runs after every successful relaunch (manual, automatic, boot watchdog). */
  onRelaunchSucceeded: (sessionId: string) => void;
  /** Rate-limit / out-of-credits fallback pauses AFK auto-proceed. */
  noteApiLimitReached: (sessionId: string) => void;
  /** Kernel wait channels of a CLI pid (tests inject; default reads /proc). */
  readWaitChannels?: (pid: number) => string | null;
  /** Subagent-tree liveness probe (tests inject; default stats the CLI's sibling dir). */
  subagentActivitySince?: (sessionDir: string, sinceMs: number) => boolean;
  /** Open-subagent-tool-call probe (tests inject; default tails `subagents/*.jsonl`). */
  subagentOpenToolCallSince?: (sessionDir: string, sinceMs: number) => boolean;
  /**
   * Diagnostics drift feed (plan Task 4): receives the SAME payload object the
   * `silent_stdio_drift.*` log line carries, so the page and journalctl can
   * never disagree. Optional; default no-op.
   */
  onDriftEvent?: (payload: Record<string, unknown>) => void;
}

export class SessionRecovery {
  private readonly launcher: CliLauncher;
  private readonly wsBridge: WsBridge;
  private readonly intentionalKills: IntentionalKills;
  private readonly onRelaunchSucceeded: (sessionId: string) => void;
  private readonly noteApiLimitReached: (sessionId: string) => void;
  private readonly readWaitChannels: (pid: number) => string | null;
  private readonly subagentActivitySince: (sessionDir: string, sinceMs: number) => boolean;
  private readonly subagentOpenToolCallSince: (sessionDir: string, sinceMs: number) => boolean;
  private readonly onDriftEvent: (payload: Record<string, unknown>) => void;

  // Auto-relaunch state
  private relaunchingSet = new Set<string>();
  private autoRelaunchCounts = new Map<string, number>();
  /** P4/FIX-AUTOHEAL-1: the one `launcher.relaunch` running per session. */
  private readonly relaunchInFlight = new Map<string, Promise<RelaunchOutcome>>();
  /** P4/FIX-AUTOHEAL-1: time of the last successful relaunch (settle window). */
  private readonly lastRelaunchOkAt = new Map<string, number>();
  /**
   * P4/FIX-AUTOHEAL-2: an automatic relaunch skipped because another one was
   * running or settling re-checks the session once the window is over. A CLI
   * that hangs in `starting` would otherwise never be recovered.
   */
  private readonly settleRechecks = new Map<string, ReturnType<typeof setTimeout>>();
  // Sessions that have already been notified about relaunch exhaustion.
  // Prevents repeated "keeps crashing" warnings for dead sessions.
  readonly relaunchExhaustedNotified = new Set<string>();

  /**
   * P4/KILL-INTENTIONAL (ASK #19): sessions the user stopped on purpose (REST
   * `POST /sessions/:id/kill`, the UI kill button). Unlike an idle-kill, a
   * returning browser or a transport-drop `session:relaunch-needed` must NOT
   * bring them back — only an explicit relaunch or a new browser-typed user
   * message does, and both clear the mark first (see the orchestrator's
   * `resumeUserStopped`). In memory only: a server restart forgets it.
   */
  private readonly stoppedByUser = new Set<string>();

  // Timers for proactive keepalive relaunches (for cancellation on delete)
  private keepaliveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Per-session silence-recurrence bookkeeping. Keyed by Companion
   * `sessionId`; value is the running count + the model that was
   * silent. Bumped on every `session:backend-silent`; when count
   * reaches {@link RECURRING_SILENCE_ROTATE_THRESHOLD} the handler
   * rotates the model via `nextModelInChain` and clears the entry.
   * Cleared on `orchestrator:turn-done` (successful turn = model
   * works, no rotation needed).
   */
  readonly silenceRecurrenceCounts = new Map<string, { count: number; lastSilentModel: string }>();

  /**
   * Recurring tick handle for the silent-stdio drift detector (see
   * `silent-stdio-drift-detector.ts`). Compares each active Claude
   * session's `~/.claude/projects/<slug>/<cliSid>.jsonl` freshness
   * against its bun-managed transcript; if the CLI is actively
   * writing to jsonl but the transcript has stalled, we've detected
   * the two-writer divergence pattern (silent-stdio in the act) and
   * kill the subprocess to force respawn. Started in
   * {@link initialize}, cleared in {@link shutdown}. Complements —
   * does not replace — the `SilentStdioWatchdog` on the adapter
   * (arm-on-user-message, 300s deadline).
   */
  private driftDetectorTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Per-session `(jsonlLines, transcriptLen)` snapshot from the last
   * drift-detector tick — reserved for future delta-over-time
   * detection. Currently unused; the mtime-based check is sufficient
   * for the 2026-09-11 failure pattern.
   */
  private driftPrevSnapshot = new Map<string, { jsonlMtimeMs: number; bunLastFrameMs: number }>();

  /**
   * `<bunLastFrameMs>:<reason>` of the stall whose suppressed kill was already
   * logged, per session — one `silent_stdio_drift.suppressed` line per stall
   * and reason, not one every tick (a reason switch mid-stall logs again).
   */
  private readonly driftSuppressedLogged = new Map<string, string>();
  /**
   * Per session: the main-thread tool call the drift kill is waiting on
   * (keyed by the stall's `bunLastFrameMs`). A tick that finds a DIFFERENT
   * open call under the same stall knows the deferred one completed and
   * recovers at once — the deferral covers exactly one call.
   */
  private readonly driftDeferredToolCall = new Map<string, { bunLastFrameMs: number; toolCallStartedAtMs: number }>();

  /** Timestamps of recent drift recoveries per session (rate guard, Task 4b). */
  private readonly driftRecoveryTimes = new Map<string, number[]>();
  /** Oldest in-window recovery already reported as rate-limited (one diagnostic per window). */
  private readonly driftRateLimitNotified = new Map<string, number>();
  /** Sessions whose CLI version differs from the verified subagent layout (logged once). */
  private readonly driftLayoutUnverifiedLogged = new Set<string>();
  /** A drift recovery (kill → relaunch) in flight, per session. */
  private readonly driftRecoveryInFlight = new Set<string>();

  /**
   * Per-session highest compaction-advisory milestone we've already
   * fired (in bytes; 0 = none yet). Prevents the drift-detector tick
   * from spamming the same `/compact` suggestion every 60s once the
   * user has been told. See `context-size-suggester.ts` for milestone
   * tiers and rationale.
   */
  private contextAdvisoryFired = new Map<string, number>();
  /** Sessions already warned once about an advisory that could not be recorded (no bridge session). */
  private readonly contextAdvisoryUnrecordedLogged = new Set<string>();

  constructor(deps: SessionRecoveryDeps) {
    this.launcher = deps.launcher;
    this.wsBridge = deps.wsBridge;
    this.intentionalKills = deps.intentionalKills;
    this.onRelaunchSucceeded = deps.onRelaunchSucceeded;
    this.noteApiLimitReached = deps.noteApiLimitReached;
    this.readWaitChannels = deps.readWaitChannels ?? ((pid) => summarizeWaitChannels(pid));
    this.subagentActivitySince = deps.subagentActivitySince ?? defaultSubagentActivitySince;
    this.subagentOpenToolCallSince = deps.subagentOpenToolCallSince ?? defaultSubagentOpenToolCallSince;
    this.onDriftEvent = deps.onDriftEvent ?? (() => {});
  }

  /**
   * One assembly site for every `silent_stdio_drift.*` line: log it exactly as
   * before, then hand the same payload to the diagnostics sink. A throwing
   * sink must never break recovery.
   */
  private emitDriftEvent(
    level: "warn" | "info",
    module: string,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    log[level](module, message, payload);
    try {
      this.onDriftEvent(payload);
    } catch {
      /* diagnostics are best-effort */
    }
  }

  stopDriftDetector(): void {
    if (this.driftDetectorTimer) {
      clearInterval(this.driftDetectorTimer);
      this.driftDetectorTimer = null;
    }
  }

  isRelaunchExhausted(sessionId: string): boolean {
    return this.relaunchExhaustedNotified.has(sessionId);
  }

  /** Successful orchestrator turn = the current model works; reset silence strikes. */
  noteTurnSucceeded(sessionId: string): void {
    this.silenceRecurrenceCounts.delete(sessionId);
  }

  clearAutoRelaunchCount(sessionId: string): void {
    this.autoRelaunchCounts.delete(sessionId);
    this.relaunchExhaustedNotified.delete(sessionId);
  }

  markStoppedByUser(sessionId: string): void {
    this.stoppedByUser.add(sessionId);
  }

  /** Returns true when the session was marked (and is now cleared). */
  clearStoppedByUser(sessionId: string): boolean {
    return this.stoppedByUser.delete(sessionId);
  }

  isStoppedByUser(sessionId: string): boolean {
    return this.stoppedByUser.has(sessionId);
  }

  /** Drop all relaunch bookkeeping for a deleted session. */
  forgetSession(sessionId: string): void {
    this.stoppedByUser.delete(sessionId);
    this.autoRelaunchCounts.delete(sessionId);
    this.relaunchExhaustedNotified.delete(sessionId);
    this.relaunchingSet.delete(sessionId);
    this.lastRelaunchOkAt.delete(sessionId);
    this.cancelSettleRecheck(sessionId);
    this.driftRecoveryTimes.delete(sessionId);
    this.driftRateLimitNotified.delete(sessionId);
    this.driftLayoutUnverifiedLogged.delete(sessionId);
  }

  private cancelSettleRecheck(sessionId: string): void {
    const timer = this.settleRechecks.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.settleRechecks.delete(sessionId);
  }

  /**
   * P4/FIX-AUTOHEAL-2: arm (once per session) a re-check for when the settle
   * window closes. If the CLI is then still `starting` without an attached
   * adapter, it goes through {@link handleAutoRelaunch} — the crash budget
   * bounds a CLI that keeps hanging. Still settling → re-arm.
   */
  private scheduleSettleRecheck(sessionId: string): void {
    if (this.settleRechecks.has(sessionId)) return;
    const at = this.lastRelaunchOkAt.get(sessionId);
    const delay =
      this.relaunchInFlight.has(sessionId) || at === undefined
        ? RELAUNCH_SETTLE_MS
        : Math.max(0, at + RELAUNCH_SETTLE_MS - Date.now());
    const timer = setTimeout(() => {
      this.settleRechecks.delete(sessionId);
      const info = this.launcher.getSession(sessionId);
      if (!info || info.archived || info.state !== "starting") return;
      if (this.intentionalKills.has(sessionId) || this.stoppedByUser.has(sessionId)) return;
      if (this.isRelaunchSettling(sessionId)) {
        this.scheduleSettleRecheck(sessionId);
        return;
      }
      // handleAutoRelaunch re-checks this too; here it keeps the log honest.
      if (this.wsBridge.getSession(sessionId)?.backendAdapter != null) return;
      log.warn("orchestrator", "CLI still starting after the settle window; recovering", {
        event: "session.relaunch.settle_expired",
        sessionId,
        settleMs: RELAUNCH_SETTLE_MS,
      });
      void this.handleAutoRelaunch(sessionId);
    }, delay);
    timer.unref?.();
    this.settleRechecks.set(sessionId, timer);
  }

  isRelaunchInFlight(sessionId: string): boolean {
    return this.relaunchInFlight.has(sessionId);
  }

  /**
   * A relaunch is running, or one succeeded less than
   * {@link RELAUNCH_SETTLE_MS} ago and its CLI is still `starting` (not yet
   * attached). A CLI that crashed after the relaunch (`exited`) is not
   * settling — it gets the normal auto-relaunch.
   */
  isRelaunchSettling(sessionId: string): boolean {
    if (this.relaunchInFlight.has(sessionId)) return true;
    const at = this.lastRelaunchOkAt.get(sessionId);
    if (at === undefined || Date.now() - at >= RELAUNCH_SETTLE_MS) return false;
    return this.launcher.getSession(sessionId)?.state === "starting";
  }

  /**
   * P4/FIX-AUTOHEAL-1: the single entry point to `launcher.relaunch`.
   *
   * - A call while another relaunch of the same session runs JOINS it (same
   *   result, no second spawn). A manual call never joins: it waits for the
   *   running one and then relaunches with its own options — the running one
   *   may have read the old model, env or credentials before the user changed
   *   them (Settings → apply credentials; P4/FIX-AUTOHEAL-2).
   * - Automatic sources skip (`skipped: "recently_relaunched"`) while the
   *   previous successful relaunch is inside {@link RELAUNCH_SETTLE_MS}; a
   *   re-check is armed for when the window closes.
   * - The session is marked intentional for the old-process kill (CR-12); the
   *   mark is released only if no one else claimed it meanwhile (EC-2).
   * - If the session was archived while the spawn was awaited, the
   *   fresh process is killed instead of left running.
   */
  async relaunchOnce(
    sessionId: string,
    source: RelaunchSource,
    opts?: { model?: string },
  ): Promise<RelaunchOutcome> {
    for (;;) {
      const running = this.relaunchInFlight.get(sessionId);
      if (!running) break;
      if (source !== "manual") {
        log.info("orchestrator", "relaunch joined an in-flight relaunch", {
          event: "session.relaunch.joined",
          sessionId,
          source,
        });
        return running;
      }
      await running.catch(() => undefined);
    }
    if (source !== "manual" && this.isRelaunchSettling(sessionId)) {
      log.info("orchestrator", "relaunch skipped: previous relaunch still settling", {
        event: "session.relaunch.skipped_settling",
        sessionId,
        source,
        settleMs: RELAUNCH_SETTLE_MS,
      });
      this.scheduleSettleRecheck(sessionId);
      return { ok: true, skipped: "recently_relaunched" };
    }
    const run = this.runRelaunch(sessionId, source, opts);
    this.relaunchInFlight.set(sessionId, run);
    try {
      return await run;
    } finally {
      if (this.relaunchInFlight.get(sessionId) === run) this.relaunchInFlight.delete(sessionId);
    }
  }

  private async runRelaunch(
    sessionId: string,
    source: RelaunchSource,
    opts: { model?: string } | undefined,
  ): Promise<RelaunchOutcome> {
    const ownsMark = this.intentionalKills.addTransient(sessionId);
    try {
      const result = opts ? await this.launcher.relaunch(sessionId, opts) : await this.launcher.relaunch(sessionId);
      if (!result.ok) return result;
      const info = this.launcher.getSession(sessionId);
      // A deleted session has no launcher record left to kill through.
      if (info?.archived) {
        log.warn("orchestrator", "session archived during relaunch; killing the new process", {
          event: "session.relaunch.archived_during_flight",
          sessionId,
          source,
        });
        await this.launcher.kill(sessionId);
        return { ok: false, error: "Session was archived during relaunch" };
      }
      this.lastRelaunchOkAt.set(sessionId, Date.now());
      this.onRelaunchSucceeded(sessionId);
      return result;
    } finally {
      if (ownsMark) this.intentionalKills.releaseTransient(sessionId);
    }
  }

  /** Session ids with a pending keepalive timer (sweep-orphans input). */
  keepaliveSessionIds(): IterableIterator<string> {
    return this.keepaliveTimers.keys();
  }

  /**
   * W2: every session an automatic relaunch is still owed to — a pending
   * keepalive / boot-resume timer, a `handleAutoRelaunch` inside its grace
   * pause (the timer is already gone, state still `exited`), or a
   * `relaunchOnce` in flight. Graceful shutdown marks all of them
   * `resumeOnBoot`; otherwise a second restart landing in the grace pause
   * would drop the session for good.
   */
  pendingRelaunchSessionIds(): string[] {
    return Array.from(new Set([
      ...this.keepaliveTimers.keys(),
      ...this.relaunchingSet,
      ...this.relaunchInFlight.keys(),
    ]));
  }

  /**
   * Silent-stdio drift detector — recurring tick. Idempotent: a
   * second call while already armed is a no-op. Complements the
   * adapter-side `SilentStdioWatchdog` (arm-on-user-message, 300s):
   * this tick runs every {@link DRIFT_DETECTOR_TICK_MS} regardless
   * of user activity and catches the same failure mode via jsonl-
   * vs-transcript mtime divergence — often minutes before the
   * watchdog would fire.
   */
  startDriftDetector(): void {
    if (this.driftDetectorTimer) return;
    const timer = setInterval(() => {
      try {
        trackSync("drift-detector.tick", () => this.driftDetectorTick());
      } catch (err) {
        this.emitDriftEvent("warn", "session-orchestrator", "silent-stdio drift detector tick failed", {
          event: "silent_stdio_drift.tick_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Sibling pass on the same cadence: the context-size advisory has its
      // own gates (only `archived`), so it must not ride the drift pass.
      try {
        trackSync("context-advisory.tick", () => this.contextAdvisoryTick());
      } catch (err) {
        log.warn("session-orchestrator", "context advisory tick failed", {
          event: "context_advisory.tick_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, DRIFT_DETECTOR_TICK_MS);
    timer.unref?.();
    this.driftDetectorTimer = timer;
  }

  /**
   * One pass of the drift detector. For each active Claude session with a
   * resolved `cliSessionId + cwd`: compute the verdict (pure `checkDrift`),
   * decide (pure {@link decideDriftAction} → {@link decideDriftKill}), then act
   * — log a suppression, withhold, report a rate limit, or recover via
   * {@link recoverFromDrift} (kill → `--resume` relaunch, EC-52).
   *
   * Codex-half sessions are skipped: Codex has a different jsonl
   * layout (or none) and different failure modes; the detector is
   * Claude-specific for now.
   */
  driftDetectorTick(): void {
    const claudeHome = `${homedir()}/.claude`;
    const sessions = this.launcher.listSessions();
    const listed = new Set(sessions.map((s) => s.sessionId));
    for (const id of this.driftSuppressedLogged.keys()) if (!listed.has(id)) this.driftSuppressedLogged.delete(id);
    for (const id of this.driftPrevSnapshot.keys()) if (!listed.has(id)) this.driftPrevSnapshot.delete(id);
    for (const id of this.driftDeferredToolCall.keys()) if (!listed.has(id)) this.driftDeferredToolCall.delete(id);
    for (const info of sessions) {
      if (info.archived) continue;
      if (info.backendType === "codex") continue;
      if (info.state !== "connected" && info.state !== "running") continue;
      if (this.driftRecoveryInFlight.has(info.sessionId)) continue;
      // One slug derivation for both the main jsonl and its sibling
      // `<cliSid>/` dir (subagents/ + tool-results/). Null = not initialised
      // yet, or a cliSessionId that is not a single id-shaped path segment.
      const paths = resolveCliSessionPaths(claudeHome, info.cwd, info.cliSessionId);
      if (!paths) continue;
      const { jsonlPath, sessionDir } = paths;
      // Read the "bun freshness" signal from the live adapter, NOT from
      // the transcript file mtime. See {@link ClaudeAdapter.getLastCliFrameReceivedMs}
      // and `silent-stdio-drift-detector.ts` for why the transcript mtime
      // is unusable here (polluted by browser events + state mutations,
      // masked real stdio-pipe-death in the 2026-09-20 incident).
      // If the adapter isn't a ClaudeAdapter (unlikely — codex was
      // filtered above) or is missing, skip: nothing meaningful to check.
      const bridgeSession = this.wsBridge.getSession(info.sessionId);
      const adapter = bridgeSession?.backendAdapter;
      if (!(adapter instanceof ClaudeAdapter)) continue;
      const bunLastFrameMs = adapter.getLastCliFrameReceivedMs();
      const verdict = checkDrift(
        { sessionId: info.sessionId, bunLastFrameMs, jsonlPath, sessionDir },
        {
          undeliveredOutput: countUndeliveredAssistantRecords,
          subagentActivitySince: this.subagentActivitySince,
          subagentOpenToolCallSince: this.subagentOpenToolCallSince,
        },
      );
      // Cache last snapshot for future delta-over-time detection.
      this.driftPrevSnapshot.set(info.sessionId, {
        jsonlMtimeMs: verdict.jsonlMtimeMs,
        bunLastFrameMs: verdict.bunLastFrameMs,
      });
      const cliVersion = bridgeSession?.state?.claude_code_version || null;
      const action = decideDriftAction(verdict, {
        pendingMessages:
          verdict.suppressedReason === null ? 0 : this.wsBridge.getSessionPendingMessageCount(info.sessionId),
        intentionallyKilled: this.intentionalKills.has(info.sessionId),
        relaunchExhausted: this.relaunchExhaustedNotified.has(info.sessionId),
      });
      if (action.kind === "skip") continue;
      if (action.kind === "suppress") {
        const key = `${bunLastFrameMs}:${action.reason}`;
        if (this.driftSuppressedLogged.get(info.sessionId) !== key) {
          this.driftSuppressedLogged.set(info.sessionId, key);
          this.emitDriftEvent("info",
            "session-recovery",
            action.reason === "live_subagent_activity"
              ? "silent-stdio drift kill suppressed — CLI alive mid subagent fan-out"
              : "silent-stdio drift kill suppressed — no undelivered model output",
            {
              event: "silent_stdio_drift.suppressed",
              sessionId: info.sessionId,
              reason: action.reason,
              mtimeDeltaMs: verdict.mtimeDeltaMs,
              bunLastFrameMs,
              undeliveredAssistantRecords: verdict.undeliveredAssistantRecords,
              pendingMessages: action.pendingMessages,
              cliVersion,
            },
          );
        }
        continue;
      }

      // `candidate`: kill-time guards. Bounded sync /proc read + a second
      // liveness probe, only on a crossed-tolerance tick (rare).
      this.noteUnverifiedLayout(info.sessionId, cliVersion);
      const waitChannels = info.pid ? this.readWaitChannels(info.pid) : null;
      const now = Date.now();
      const subagentActive = subagentTreeLive(sessionDir, bunLastFrameMs, now, {
        subagentActivitySince: this.subagentActivitySince,
        subagentOpenToolCallSince: this.subagentOpenToolCallSince,
      });
      const recent = pruneDriftRecoveries(this.driftRecoveryTimes.get(info.sessionId) ?? [], now);
      this.driftRecoveryTimes.set(info.sessionId, recent);
      // Owner incident 2026-10-18: wait for the main thread's running tool
      // call (one call, ≤ ceiling from its own start) before the kill, so the
      // relaunch resumes from its tool_result instead of losing it.
      const openStartedAt = mainThreadOpenToolCallStartedAt(jsonlPath);
      const deferred = this.driftDeferredToolCall.get(info.sessionId);
      const sameStall = deferred !== undefined && deferred.bunLastFrameMs === bunLastFrameMs;
      let mainToolCallOpen = false;
      if (openStartedAt !== null && now - openStartedAt <= SUBAGENT_OPEN_TOOL_CALL_CEILING_MS) {
        if (!sameStall || deferred.toolCallStartedAtMs === openStartedAt) {
          mainToolCallOpen = true;
          this.driftDeferredToolCall.set(info.sessionId, { bunLastFrameMs, toolCallStartedAtMs: openStartedAt });
        }
      }
      const kill = decideDriftKill({ waitChannels, subagentActive, recentRecoveries: recent.length, mainToolCallOpen });
      const evidence = {
        sessionId: info.sessionId,
        trigger: action.trigger,
        pendingMessages: action.pendingMessages,
        mtimeDeltaMs: verdict.mtimeDeltaMs,
        undeliveredAssistantRecords: verdict.undeliveredAssistantRecords,
        reason: verdict.reason,
        // P7/SERVER-STDOUT-STALL: which side stopped? A CLI thread in
        // `pipe_write` means bun stopped draining stdout; none means the
        // CLI itself stopped writing (or is busy).
        cliWaitChannels: waitChannels,
        subagentActive,
        cliVersion,
      };
      if (kill.kind === "withhold_open_tool_call") {
        const key = `${bunLastFrameMs}:withhold_open_tool_call`;
        if (this.driftSuppressedLogged.get(info.sessionId) !== key) {
          this.driftSuppressedLogged.set(info.sessionId, key);
          this.emitDriftEvent("info", "session-recovery", "silent-stdio drift kill withheld — main thread is inside a tool call", {
            event: "silent_stdio_drift.withheld_open_tool_call",
            ...evidence,
            toolCallStartedAtMs: openStartedAt,
          });
          this.wsBridge.broadcastToSession(info.sessionId, {
            type: "error",
            message:
              "Backend output stalled while a tool call is running — waiting for it to finish before relaunching, " +
              "so its result is not lost.",
          });
        }
        continue;
      }
      this.driftDeferredToolCall.delete(info.sessionId);
      if (kill.kind === "withhold_live") {
        const key = `${bunLastFrameMs}:withhold_live`;
        if (this.driftSuppressedLogged.get(info.sessionId) !== key) {
          this.driftSuppressedLogged.set(info.sessionId, key);
          this.emitDriftEvent("info", "session-recovery", "silent-stdio drift kill withheld — CLI busy (no pipe_write) with live subagents", {
            event: "silent_stdio_drift.withheld_live",
            ...evidence,
          });
        }
        continue;
      }
      if (kill.kind === "rate_limited") {
        if (this.driftRateLimitNotified.get(info.sessionId) !== recent[0]) {
          this.driftRateLimitNotified.set(info.sessionId, recent[0]);
          this.emitDriftEvent("warn", "session-recovery", "silent-stdio drift recovery rate-limited — detector may be misfiring", {
            event: "silent_stdio_drift.rate_limited",
            ...evidence,
            recentRecoveries: kill.recentRecoveries,
            windowMs: DRIFT_RECOVERY_RATE_WINDOW_MS,
          });
          this.wsBridge.broadcastToSession(info.sessionId, {
            type: "error",
            message:
              `Backend output looks stalled, but it was already auto-recovered ${kill.recentRecoveries} times in ` +
              `${Math.round(DRIFT_RECOVERY_RATE_WINDOW_MS / 60_000)} min — automatic recovery paused. ` +
              "Relaunch the session manually if it stays stuck.",
          });
        }
        continue;
      }
      this.emitDriftEvent("warn", "session-recovery", "silent-stdio drift detected — relaunching subprocess to recover", {
        event: "silent_stdio_drift.detected",
        ...evidence,
      });
      recent.push(now);
      deliveryMetrics.recordDriftRecovery(info.sessionId, info.backendType ?? "claude");
      this.wsBridge.broadcastToSession(info.sessionId, {
        type: "error",
        message: `Backend transcript ${Math.round(verdict.mtimeDeltaMs / 1000)}s behind CLI's jsonl — relaunching to recover.`,
      });
      // Fire-and-forget: the outer setInterval callback is sync — a
      // per-session recovery blocking further sessions would delay the
      // whole tick. `driftRecoveryInFlight` keeps the next tick off it.
      void this.recoverFromDrift(info.sessionId, { jsonlPath, bunLastFrameMs });
    }
  }

  /**
   * Drift recovery (PLAN Task 4a, EC-2 / EC-52). Mark the session intentional
   * BEFORE the kill so its `session:exited` neither arms the council reconnect
   * cycle (a healthy sibling would flicker `reconnecting`/`degraded`) nor
   * schedules a keepalive relaunch racing this one; `launcher.kill` gives the
   * stuck CLI SIGTERM → 5 s → SIGKILL so no second writer survives on the
   * cliSessionId; then relaunch with `--resume` through the single-flight gate.
   * The mark is transient and always released in `finally` (EC-52) — unless a
   * durable writer (archive / delete / group teardown) claimed it meanwhile.
   *
   * Only the drifting half is marked: the sibling is not killed, and a durable
   * mark on it would lock it out of its own recovery. A failed relaunch falls
   * back to the budgeted keepalive path so the session is never left dead.
   */
  private async recoverFromDrift(
    sessionId: string,
    stall?: { jsonlPath: string; bunLastFrameMs: number },
  ): Promise<void> {
    this.driftRecoveryInFlight.add(sessionId);
    const ownsMark = this.intentionalKills.addTransient(sessionId);
    let outcome: RelaunchOutcome | null = null;
    try {
      await this.launcher.kill(sessionId);
      if (this.launcher.getSession(sessionId)?.archived) return;
      // The killed CLI's jsonl is final now: deliver the reply it wrote but
      // never put on stdout. The `--resume`d CLI will not re-emit it.
      if (stall) this.deliverStalledReply(sessionId, stall);
      this.wsBridge.getSession(sessionId)?.stateMachine?.transition("starting", "relaunch_initiated");
      outcome = await this.relaunchOnce(sessionId, "drift_recovery");
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (ownsMark) this.intentionalKills.releaseTransient(sessionId);
      this.driftRecoveryInFlight.delete(sessionId);
    }
    if (outcome && !outcome.ok) {
      this.emitDriftEvent("warn", "session-recovery", "drift recovery relaunch failed — falling back to keepalive", {
        event: "silent_stdio_drift.relaunch_failed",
        sessionId,
        error: outcome.error,
      });
      if (outcome.error) this.wsBridge.broadcastToSession(sessionId, { type: "error", message: outcome.error });
      this.scheduleProactiveRelaunch(sessionId);
    }
  }

  /**
   * W1 (prod 40f03a1e, 2026-10-15 15:03): before this, recovery = kill +
   * `--resume` only. The CLI had written tool call + answer + end_turn to its
   * jsonl by 15:03:34, bun got zero frames after `system.init`, and the
   * resumed CLI never replays past turns on stdout — so the answer reached
   * nobody and the user had to type "продолжай". Read the records the CLI
   * wrote after bun's last frame (minus {@link RECOVERY_LOOKBACK_MS}) and hand
   * them to the bridge, which delivers each exactly once (history-deduped).
   * Never throws: a failure here must not block the relaunch.
   */
  private deliverStalledReply(sessionId: string, stall: { jsonlPath: string; bunLastFrameMs: number }): void {
    try {
      const records = readUndeliveredAssistantRecords(stall.jsonlPath, stall.bunLastFrameMs - RECOVERY_LOOKBACK_MS);
      if (records.length === 0) return;
      const { delivered, alreadyDelivered } = this.wsBridge.deliverRecoveredAssistantRecords(sessionId, records);
      this.emitDriftEvent("warn", "session-recovery", "silent-stdio drift: delivered the reply the CLI wrote only to its jsonl", {
        event: "silent_stdio_drift.reply_recovered",
        sessionId,
        records: records.length,
        delivered,
        alreadyDelivered,
      });
    } catch (err) {
      this.emitDriftEvent("warn", "session-recovery", "silent-stdio drift: could not deliver the stalled reply", {
        event: "silent_stdio_drift.reply_recovery_failed",
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Version canary (PLAN Task 5): the liveness gate rests on the subagent
   * sibling-tree layout verified for {@link SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION}.
   * A session on another CLI version is logged once, so a layout change after
   * a CLI bump shows up next to the kills it may cause.
   */
  private noteUnverifiedLayout(sessionId: string, cliVersion: string | null): void {
    if (!cliVersion || cliVersion === SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION) return;
    if (this.driftLayoutUnverifiedLogged.has(sessionId)) return;
    this.driftLayoutUnverifiedLogged.add(sessionId);
    this.emitDriftEvent("warn", "session-recovery", "drift liveness gate running on an unverified CLI layout", {
      event: "silent_stdio_drift.cli_layout_unverified",
      sessionId,
      cliVersion,
      verifiedCliVersion: SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION,
    });
  }

  /**
   * Context-size advisory pass (council plan 2026-10-17). Runs on the drift
   * detector's interval but with its OWN gate — only `archived` sessions are
   * skipped — so a session whose CLI is exited/idle-killed still gets the
   * one-click "Continue in a new session" offer (the handoff route works from
   * persisted history alone), and Codex sessions get it too.
   *
   * Per backend the pass measures ONE number and hands it to the pure ladder:
   *   - Claude → `statSync` of the CLI transcript jsonl (bytes ladder; one
   *     stat per session per tick, skipped once the ceiling tier has fired);
   *   - Codex → `state.codex_compactions`, the adapter's count of main-thread
   *     `thread/compacted` notifications (compactions ladder; no I/O). Codex
   *     rollouts on disk are tiny, so bytes would never fire, and the window
   *     percent is cyclic, so it cannot drive a fire-once latch.
   * Each milestone fires at most once per session lifetime; the seed comes
   * from the in-memory map AND the persisted record (same signal only), so a
   * restart never resurrects a banner the user already saw.
   */
  contextAdvisoryTick(): void {
    const sessions = this.launcher.listSessions();
    const listed = new Set(sessions.map((s) => s.sessionId));
    for (const id of this.contextAdvisoryFired.keys()) if (!listed.has(id)) this.contextAdvisoryFired.delete(id);
    for (const id of this.contextAdvisoryUnrecordedLogged) if (!listed.has(id)) this.contextAdvisoryUnrecordedLogged.delete(id);
    for (const info of sessions) {
      if (info.archived) continue;
      try {
        this.maybeFireContextAdvisory(info);
      } catch (err) {
        // One bad session must not starve the rest of the list this tick.
        log.warn("session-orchestrator", "context advisory pass failed for a session", {
          event: "context_advisory.tick_session_failed",
          sessionId: info.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Highest milestone already advised for `sessionId` on `ladder`'s signal: in-memory ∪ persisted record. */
  private seededLastFired(sessionId: string, persisted: ContextAdvisoryRecord | null | undefined, ladder: ContextLadder): number {
    // One decoder for the dual-shape record (legacy = bytes); a record on
    // another signal's axis never seeds this ladder.
    const decoded = persisted ? decodeContextAdvisory(persisted) : null;
    const persistedValue = decoded && decoded.signal === ladder.signal ? decoded.milestone : 0;
    return Math.max(this.contextAdvisoryFired.get(sessionId) ?? 0, persistedValue);
  }

  private maybeFireContextAdvisory(info: SdkSessionInfo): void {
    const sessionId = info.sessionId;
    const bridgeSession = this.wsBridge.getSession(sessionId);
    const persisted = bridgeSession?.state?.context_advisory;
    let ladder: ContextLadder;
    let measured: number;
    if (info.backendType === "codex") {
      // Compactions of the main thread, counted by the adapter from
      // `thread/compacted`. Monotonic per thread (reset to 0 on a fresh
      // thread), so the fire-once-per-milestone latch is exact.
      const compactions = bridgeSession?.state?.codex_compactions;
      if (typeof compactions !== "number" || !Number.isFinite(compactions) || compactions < 0) return;
      ladder = CODEX_COMPACTION_LADDER;
      measured = compactions;
    } else {
      const paths = resolveCliSessionPaths(`${homedir()}/.claude`, info.cwd, info.cliSessionId);
      if (!paths) return;
      ladder = TRANSCRIPT_BYTES_LADDER;
      // Ceiling already advised → nothing left to say; skip the stat. These
      // are exactly the dead, huge transcripts this pass newly covers.
      const ceiling = ladder.milestones[ladder.milestones.length - 1] ?? 0;
      if (this.seededLastFired(sessionId, persisted, ladder) >= ceiling) return;
      try {
        measured = statSync(paths.jsonlPath).size;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        // Transcript not (yet / any more) readable: operational, next tick retries.
        if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return;
        throw err;
      }
    }
    const lastFired = this.seededLastFired(sessionId, persisted, ladder);
    const advisory = nextContextMilestone(measured, lastFired, ladder);
    if (!advisory) return;
    log.warn("session-orchestrator", "context advisory fired — session context large", {
      event: "context_size.compaction_advisory",
      sessionId,
      backendType: info.backendType,
      signal: advisory.signal,
      measured,
      milestone: advisory.milestone,
      action: advisory.action,
    });
    const isBytes = advisory.signal === "transcript_bytes";
    if (advisory.action === "continue_in_new") {
      // Handoff tier: record on the session state FIRST so the banner
      // survives a reload and reaches tabs that open later. Mark the tier as
      // fired only once the record committed — a session without a bridge
      // twin (restored launcher row, mid-restart race) retries next tick
      // instead of silently never showing the banner for the process lifetime.
      const recorded = this.wsBridge.recordContextAdvisory(sessionId, {
        signal: advisory.signal,
        milestone: advisory.milestone,
        ...(isBytes ? { milestoneBytes: advisory.milestone } : {}),
        message: advisory.message,
        action: "continue_in_new",
      });
      if (!recorded) {
        if (!this.contextAdvisoryUnrecordedLogged.has(sessionId)) {
          this.contextAdvisoryUnrecordedLogged.add(sessionId);
          log.warn("session-orchestrator", "context advisory could not be recorded — no bridge session; will retry", {
            event: "context_advisory.record_skipped",
            sessionId,
            signal: advisory.signal,
            milestone: advisory.milestone,
            reason: "bridge_session_missing",
          });
        }
        return;
      }
    }
    // The `/compact` tiers (1.5 / 3 MB) are not persisted, so after a server
    // restart they would re-fire into every exited session on the first tick —
    // a "/compact" line nobody can act on (ritchie A-1). Only a session with a
    // live CLI can run /compact, so only such a session gets that tier, and
    // the mark is set so it is not retried every tick.
    this.contextAdvisoryFired.set(sessionId, advisory.milestone);
    const cliLive = info.state === "connected" || info.state === "running";
    if (advisory.action === "compact" && !cliLive) return;
    // Legacy text frame + structured payload, bytes ladder only: the browser's
    // frame handler compares `milestoneBytes`, so a non-bytes payload would be
    // swallowed. For Codex the `session_update` from recordContextAdvisory is
    // the authoritative (and only) path.
    if (isBytes) {
      this.wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message: advisory.message,
        advisory: {
          kind: "context_advisory",
          signal: advisory.signal,
          milestone: advisory.milestone,
          milestoneBytes: advisory.milestone,
          action: advisory.action,
        },
      });
    }
  }

  async handleAutoRelaunch(sessionId: string): Promise<void> {
    if (this.relaunchingSet.has(sessionId)) return;
    const info = this.launcher.getSession(sessionId);
    if (info?.archived) return;
    // P4/KILL-INTENTIONAL: a user-stopped session stays down until an explicit
    // relaunch or a new user message clears the mark.
    if (this.stoppedByUser.has(sessionId)) {
      log.info("orchestrator", "auto-relaunch skipped: session stopped by user", {
        event: "session.relaunch.skipped_user_stopped",
        sessionId,
      });
      return;
    }

    // If we've already notified the user about relaunch exhaustion, bail out
    // silently. Without this, every reconnect event from a dead session
    // (e.g. deleted container) re-logs the "limit reached" warning endlessly.
    if (this.relaunchExhaustedNotified.has(sessionId)) return;

    this.relaunchingSet.add(sessionId);

    await new Promise((r) => setTimeout(r, RELAUNCH_GRACE_MS));
    // P4/FIX-RECONNECT-RELAUNCH: every "alive, not relaunching" exit below is
    // logged (EC-9) — a silent return here is how a deaf observer sat dead for
    // 12 h while each returning browser logged "requesting relaunch".
    const skipAlive = (reason: string, extra: Record<string, unknown> = {}) => {
      log.info("orchestrator", "auto-relaunch skipped: backend considered alive", {
        event: "session.relaunch.skipped_alive",
        sessionId,
        role: info?.sessionGroupRole,
        reason,
        ...extra,
      });
      this.relaunchingSet.delete(sessionId);
    };
    if (this.wsBridge.isCliConnected(sessionId)) { skipAlive("cli_connected"); return; }
    // P4/FIX-AUTOHEAL-1: another path (manual, observer auto-heal, boot
    // watchdog) is relaunching this session or just did — a fresh CLI sits in
    // `starting` with no adapter for up to ~16 s (Codex), which the deaf
    // check below would read as "relaunch again". Leave it to settle.
    if (this.isRelaunchSettling(sessionId)) {
      log.info("orchestrator", "auto-relaunch skipped: another relaunch in flight or settling", {
        event: "session.relaunch.skipped_settling",
        sessionId,
        source: "auto_relaunch",
      });
      this.scheduleSettleRecheck(sessionId);
      this.relaunchingSet.delete(sessionId);
      return;
    }
    const freshInfo = this.launcher.getSession(sessionId);
    // W2 review Q1: the guards at the top ran BEFORE the grace pause. A user
    // stop or an archive that landed inside it must still win — else the
    // pause spawns a CLI for a session the user just stopped. (A deleted
    // session has no record and ends in `unknown_session` below.)
    if (freshInfo?.archived || this.stoppedByUser.has(sessionId)) {
      log.info("orchestrator", "auto-relaunch skipped: stopped or archived during grace", {
        event: "session.relaunch.skipped_during_grace",
        sessionId,
        reason: freshInfo?.archived ? "archived" : "stopped_by_user",
      });
      this.relaunchingSet.delete(sessionId);
      return;
    }
    // Only check PID liveness if the session is NOT already "exited".
    // After idle-kill or explicit kill(), the PID field stays set but the
    // process is dead. If the kernel recycles the PID to a different process,
    // kill(pid, 0) would incorrectly succeed, preventing any relaunch.
    // For containerized sessions, use container liveness instead of PID check
    // (the PID is the `docker exec` wrapper, which exits immediately for some
    // transports and is unreliable for container health).
    // Prod 2026-09-10: a surviving PID is NOT proof the session is usable.
    // After a Bun restart under `KillMode=process` the Codex app-server PID
    // (and, on stdio, the claude subprocess) survives — but its WS proxy /
    // backend adapter died with the parent, so its pipes are deaf. Both the
    // PID-liveness skip below AND the `state !== "starting"` relaunch guard
    // further down treated such a session as alive/initializing, blocking
    // auto-relaunch and forcing a MANUAL Reconnect. Gate both on the backend
    // adapter still being attached: a live PID with a dead adapter must
    // relaunch (with `--resume`) instead of masquerading as alive.
    const adapterAttached = this.wsBridge.getSession(sessionId)?.backendAdapter != null;
    // P4/FIX-RECONNECT-RELAUNCH (prod 2026-09-29/30): the same holds for the
    // launcher's `connected`/`running` state. When a Codex app-server's WS to
    // the bridge drops, the adapter is nulled but the process lives on and the
    // launcher still says `connected` — this check used to return here,
    // silently, on every returning browser. Only an attached adapter makes
    // that state believable.
    if (freshInfo && (freshInfo.state === "connected" || freshInfo.state === "running") && adapterAttached) {
      skipAlive("launcher_state", { state: freshInfo.state });
      return;
    }
    if (freshInfo && freshInfo.state !== "exited") {
      if (freshInfo.containerId) {
        const containerState = containerManager.isContainerAlive(freshInfo.containerId);
        if (containerState === "running") {
          skipAlive("container_running", { adapterAttached });
          return;
        }
      } else if (freshInfo.pid && adapterAttached) {
        try { process.kill(freshInfo.pid, 0); skipAlive("pid_alive"); return; } catch {}
      }
    }

    const count = this.autoRelaunchCounts.get(sessionId) ?? 0;
    if (count >= MAX_AUTO_RELAUNCHES) {
      metricsCollector.recordRelaunchExhausted();
      log.warn("orchestrator", "Auto-relaunch limit reached", { sessionId, maxAttempts: MAX_AUTO_RELAUNCHES });
      this.wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message: "Session keeps crashing. Please relaunch manually.",
      });
      this.relaunchExhaustedNotified.add(sessionId);
      // PLAN Task 5: signal council reconnect listeners that this session's
      // budget is spent — they can short-circuit `reconnecting → degraded`
      // without waiting for the 45s timer.
      companionBus.emit("session:relaunch-failed", { sessionId, reason: "budget_exhausted" });
      this.relaunchingSet.delete(sessionId);
      return;
    }

    // A `starting` session is normally mid-spawn and must not be double-
    // relaunched — EXCEPT the surviving-but-deaf case above: a session stuck
    // in `starting` after a Bun restart, whose PID lives but whose adapter
    // died, will never leave `starting` on its own. Allow it to relaunch.
    if (freshInfo && (freshInfo.state !== "starting" || !adapterAttached)) {
      this.autoRelaunchCounts.set(sessionId, count + 1);
      metricsCollector.recordRelaunchAttempted();
      log.info("orchestrator", "Auto-relaunching CLI", { sessionId, attempt: count + 1, maxAttempts: MAX_AUTO_RELAUNCHES });
      const session = this.wsBridge.getSession(sessionId);
      if (session?.stateMachine) {
        session.stateMachine.transition("starting", "relaunch_initiated");
      }
      // Council Review 2026-05-15-1015 CR-12 (Subprocess P2): the session is
      // marked intentional BEFORE the launcher's SIGTERM on the old proc, so
      // its `session:exited` does not arm the council reconnect timer
      // (transient `reconnecting → active` flicker). `relaunchOnce` owns that
      // mark and releases it in ALL paths — a stale mark would lock
      // `scheduleProactiveRelaunch` out of recovery — unless archive/delete
      // claimed it meanwhile (P4/FIX-AUTOHEAL-1, EC-2).
      try {
        const result = await this.relaunchOnce(sessionId, "auto_relaunch");
        if (result.skipped) {
          // Another relaunch just finished — not an attempt of ours.
          this.autoRelaunchCounts.set(sessionId, count);
        } else if (!result.ok && result.error) {
          this.wsBridge.broadcastToSession(sessionId, { type: "error", message: result.error });
          // Council Review 2026-05-15-1015 CR-2 + CR-17: errors the
          // launcher emitted on the typed channel itself — skip the
          // duplicate orchestrator emit + rollback the retry counter
          // (deterministic, retrying cannot fix). Includes:
          // - `observer spawn config load failed` (CR-2)
          // - `observer-prompt-source-drift-refused:` (CR-17 — workspace
          //   ↔ bundled boundary requires operator ack via group restart)
          const isLauncherEmittedFailure =
            result.error.startsWith("observer spawn config load failed") ||
            result.error.startsWith("observer-prompt-source-drift-refused:");
          if (isLauncherEmittedFailure) {
            this.autoRelaunchCounts.set(sessionId, count);
          } else {
            companionBus.emit("session:relaunch-failed", { sessionId, reason: result.error });
          }
        } else if (result.ok) {
          metricsCollector.recordRelaunchSucceeded();
          this.autoRelaunchCounts.delete(sessionId);
          this.relaunchExhaustedNotified.delete(sessionId);
          // Council review 2026-09-08 #2: the got-050 spawn-checkpoint re-arm
          // fires on EVERY successful relaunch — `relaunchOnce` runs
          // `onRelaunchSucceeded` for this automatic path too (it is the one
          // that runs after a codex init failure).
        }
        // ok=false without error: keep count to preserve the retry budget
      } finally {
        setTimeout(() => this.relaunchingSet.delete(sessionId), RELAUNCH_COOLDOWN_MS);
      }
    } else {
      skipAlive(freshInfo ? "starting" : "unknown_session");
    }
  }

  // ── Private: Proactive keepalive ────────────────────────────────────────────

  /**
   * Schedules a proactive relaunch of a crashed CLI process, regardless of
   * whether any browsers are connected. Uses exponential backoff (3s, 6s, 12s)
   * based on the auto-relaunch attempt count.
   *
   * Skips relaunch for:
   * - Intentional kills (idle-kill, manual delete/archive)
   * - Archived sessions
   * - Sessions that have exhausted their relaunch budget
   */
  scheduleProactiveRelaunch(sessionId: string): void {
    // Skip if this was an intentional kill. Use has() instead of delete() so
    // the guard is preserved for handleAutoRelaunch (debounce path fires later).
    if (this.intentionalKills.has(sessionId)) return;

    const info = this.launcher.getSession(sessionId);
    if (!info || info.archived) return;

    // Skip if already at relaunch limit
    if (this.relaunchExhaustedNotified.has(sessionId)) return;

    // Skip if a relaunch is already in progress (e.g. triggered by browser reconnect)
    if (this.relaunchingSet.has(sessionId)) return;

    // Exponential backoff: 3s → 6s → 12s based on attempt count
    const attempt = this.autoRelaunchCounts.get(sessionId) ?? 0;
    const delay = KEEPALIVE_BASE_DELAY_MS * Math.pow(2, attempt);

    log.info("orchestrator", "Scheduling proactive keepalive relaunch", {
      sessionId,
      attempt: attempt + 1,
      maxAttempts: MAX_AUTO_RELAUNCHES,
      delayMs: delay,
    });

    // Cancel any existing keepalive timer for this session
    this.cancelKeepaliveTimer(sessionId);

    const timer = setTimeout(async () => {
      this.keepaliveTimers.delete(sessionId);

      // Re-check conditions — state may have changed during the delay
      const freshInfo = this.launcher.getSession(sessionId);
      if (!freshInfo || freshInfo.archived) return;
      if (freshInfo.state === "connected" || freshInfo.state === "running") return;

      // Delegate to the existing auto-relaunch mechanism which handles
      // budget, PID checks, state transitions, and cooldowns.
      await this.handleAutoRelaunch(sessionId);
    }, delay);

    this.keepaliveTimers.set(sessionId, timer);
  }

  /**
   * W2: proactively relaunch (`--resume`) the sessions that were alive before
   * the server restart, without waiting for a browser to open them. Before
   * this, stdio Claude and host Codex sessions came back `exited` and stayed
   * down until a browser connected (`session:relaunch-needed`) — browserless
   * orchestrators, council pairs and CLI crons were dead for hours.
   *
   * Launches are staggered by {@link BOOT_RESUME_STAGGER_MS}. Each timer lives
   * in `keepaliveTimers`, so archive / delete / user kill cancel it like a
   * keepalive. When it fires, a session that is gone, archived, intentionally
   * killed, stopped by user or no longer `exited` (a returning browser already
   * relaunched it) is skipped; the rest go through `handleAutoRelaunch`, which
   * shares `relaunchingSet` + `relaunchOnce` with the browser path (no double
   * spawn) and enforces the crash budget.
   */
  scheduleBootResume(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    log.info("orchestrator", "Scheduling boot resume of sessions alive before restart", {
      event: "session.boot_resume.scheduled",
      count: sessionIds.length,
      staggerMs: BOOT_RESUME_STAGGER_MS,
      sessionIds,
    });
    sessionIds.forEach((sessionId, i) => {
      this.cancelKeepaliveTimer(sessionId);
      const timer = setTimeout(async () => {
        if (this.keepaliveTimers.get(sessionId) === timer) this.keepaliveTimers.delete(sessionId);
        const info = this.launcher.getSession(sessionId);
        const skip = (reason: string) =>
          log.info("orchestrator", "boot resume skipped", {
            event: "session.boot_resume.skipped",
            sessionId,
            role: info?.sessionGroupRole,
            reason,
          });
        if (!info) return skip("unknown_session");
        if (info.archived) return skip("archived");
        if (this.intentionalKills.has(sessionId)) return skip("intentional_kill");
        if (this.stoppedByUser.has(sessionId)) return skip("stopped_by_user");
        if (info.state !== "exited") return skip(`state_${info.state}`);
        log.info("orchestrator", "Boot-resuming session alive before restart", {
          event: "session.boot_resume.firing",
          sessionId,
          role: info.sessionGroupRole,
          backendType: info.backendType,
        });
        await this.handleAutoRelaunch(sessionId);
      }, (i + 1) * BOOT_RESUME_STAGGER_MS);
      this.keepaliveTimers.set(sessionId, timer);
    });
  }

  cancelKeepaliveTimer(sessionId: string): void {
    const timer = this.keepaliveTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.keepaliveTimers.delete(sessionId);
    }
  }

  // ── Private: Backend silence + model fallback (silence-recovery) ───────────

  /**
   * Handler for `session:backend-silent`. The adapter's silent-stdio
   * watchdog fires when a user turn is in flight but no stdout frame
   * arrives from the CLI within its threshold. We SIGTERM the
   * subprocess; the existing `session:exited` listener above schedules
   * a `--resume` relaunch, restoring a fresh stdio pipe. Skips when
   * the session is already archived / intentionally killed / gone.
   */
  async handleBackendSilent(
    sessionId: string,
    sinceMs: number,
    reason: string,
  ): Promise<void> {
    const info = this.launcher.getSession(sessionId);
    if (!info || info.archived) return;
    if (this.intentionalKills.has(sessionId)) return;
    if (this.relaunchExhaustedNotified.has(sessionId)) return;

    // Recurring-silence rotation (model-agnostic durable fix, 2026-09-10).
    // The named-list substitution in `broken-model-substitution.ts` is
    // reactive to KNOWN-broken model ids; this loop discovers a NEWLY-
    // broken model empirically. Delegates to the pure
    // {@link computeSilenceRotation} for the counting + threshold +
    // chain-lookup rules (kept in `model-fallback-chain.ts` for
    // testability). Reset on `orchestrator:turn-done` (successful turn
    // = model works; clear silence bookkeeping for that session).
    const currentModel = info.model ?? "";
    const decision = computeSilenceRotation(
      this.silenceRecurrenceCounts.get(sessionId),
      currentModel,
      RECURRING_SILENCE_ROTATE_THRESHOLD,
    );
    if (decision.rotateTo) {
      log.warn("orchestrator", "Recurring silence on same model — rotating to next chain entry", {
        sessionId,
        from: currentModel,
        to: decision.rotateTo,
      });
      // Task A.2: a persistent from→to notice (banner with "switch back"),
      // recorded on the session state — not an ephemeral toast.
      this.wsBridge.recordModelFallback(sessionId, {
        from: currentModel,
        to: decision.rotateTo,
        reason: "unresponsive",
        detail: "The model went silent on repeated turns; Aura relaunched on the next model in the fallback chain.",
      });
      this.launcher.setModel(sessionId, decision.rotateTo);
      this.silenceRecurrenceCounts.delete(sessionId);
    } else if (decision.newRecord) {
      this.silenceRecurrenceCounts.set(sessionId, decision.newRecord);
      if (decision.newRecord.count >= RECURRING_SILENCE_ROTATE_THRESHOLD) {
        // Threshold reached but chain exhausted — flag it so operators
        // notice via journalctl. Handler still kills + respawns below,
        // but on the same broken model (no better target available).
        log.warn("orchestrator", "Recurring silence but no chain successor — model rotation exhausted", {
          sessionId,
          currentModel,
          occurrences: decision.newRecord.count,
        });
      }
    }

    log.warn("orchestrator", "Backend silent — killing subprocess for relaunch", {
      sessionId,
      sinceMs,
      reason,
    });
    // No need to schedule relaunch here — `launcher.kill` triggers
    // `session:exited` which the sibling handler above already routes
    // through `scheduleProactiveRelaunch`.
    await this.launcher.kill(sessionId);
  }

  /**
   * Handler for `session:model-fallback`. Downgrades the session to
   * the next model in the fallback chain and kills the subprocess so
   * the keepalive path relaunches with the new `--model` argument. If
   * no downgrade target exists in the chain (the current model isn't
   * listed, or it is already the tail), we surface an informational
   * error and leave the session alone — an operator-visible dead end
   * beats a silent no-op.
   */
  async handleModelFallback(
    sessionId: string,
    from: string,
    to: string,
    reason: "rate_limit" | "out_of_credits" | "unknown_model" | "model_not_available",
  ): Promise<void> {
    if (reason === "rate_limit" || reason === "out_of_credits") {
      this.noteApiLimitReached(sessionId);
    }

    const info = this.launcher.getSession(sessionId);
    if (!info || info.archived) return;
    if (this.intentionalKills.has(sessionId)) return;

    if (reason === "rate_limit" || reason === "out_of_credits") {
      this.wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message:
          reason === "rate_limit"
            ? "Model hit a rate/session limit. Automatic fallback and AFK auto-proceed are paused until the reset; with \"Автопродолжение после лимита\" on, Aura continues the session automatically after it (otherwise send a message manually)."
            : "Account credits are exhausted. Automatic fallback and AFK auto-proceed are paused until billing/credits recover.",
      });
      log.warn("orchestrator", "Model fallback paused for API limit", {
        sessionId,
        currentModel: info.model || from,
        eventFrom: from,
        eventTo: to,
        reason,
      });
      return;
    }

    // The adapter emits `from` from the message's own `model` field,
    // which is `<synthetic>` in exactly the failure surface we act on.
    // The launcher's stored model is the real spawn argument; prefer
    // it when the event value is unresolvable in the chain.
    const currentModel = info.model || from;
    const nextModel = nextModelInChain(currentModel);
    if (!nextModel) {
      this.wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message: `Model ${currentModel || "unknown"} hit ${reason}; no fallback available. Choose another model manually.`,
      });
      log.warn("orchestrator", "Model fallback requested but no chain successor", {
        sessionId,
        currentModel,
        eventFrom: from,
        eventTo: to,
        reason,
      });
      return;
    }
    log.info("orchestrator", "Model fallback triggered", {
      sessionId,
      from: currentModel,
      to: nextModel,
      reason,
    });
    // Task A.2: persistent from→to notice instead of an ephemeral toast.
    this.wsBridge.recordModelFallback(sessionId, {
      from: currentModel,
      to: nextModel,
      reason: "unavailable",
      detail: `The API reported ${reason.replace(/_/g, " ")}.`,
    });
    this.launcher.setModel(sessionId, nextModel);
    await this.launcher.kill(sessionId);
    // `session:exited` → `scheduleProactiveRelaunch` → `launcher.relaunch`
    // reads the updated info.model in `buildClaudeArgs`.
  }

  startReconnectionWatchdog(): void {
    const starting = this.launcher.getStartingSessions();
    if (starting.length > 0) {
      console.log(`[orchestrator] Waiting ${RECONNECT_GRACE_MS / 1000}s for ${starting.length} CLI process(es) to reconnect...`);
      setTimeout(async () => {
        const stale = this.launcher.getStartingSessions();
        for (const info of stale) {
          if (info.archived) continue;
          // P4/FIX-AUTOHEAL-1: the observer catch-up poll wakes at the same
          // ~30 s and may already be auto-healing this session — join or skip
          // through the single-flight gate instead of spawning a second CLI.
          console.log(`[orchestrator] CLI for session ${info.sessionId} did not reconnect, relaunching...`);
          // Council review 2026-09-08 #2: boot-recovery relaunch re-arms the
          // spawn-checkpoint poll (via `relaunchOnce` → `onRelaunchSucceeded`)
          // — a server restart that catches a council observer mid-spawn
          // lands here.
          await this.relaunchOnce(info.sessionId, "boot_watchdog");
        }
      }, RECONNECT_GRACE_MS);
    }
  }
}
