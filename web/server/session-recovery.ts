import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { containerManager } from "./container-manager.js";
import { companionBus } from "./event-bus.js";
import { metricsCollector } from "./metrics-collector.js";
import { log } from "./logger.js";
import { nextModelInChain, computeSilenceRotation } from "./model-fallback-chain.js";
import { checkDrift, resolveJsonlPath } from "./silent-stdio-drift-detector.js";
import { nextCompactionMilestone } from "./context-size-suggester.js";
import { homedir } from "node:os";
import { statSync } from "node:fs";

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
 * `silent-stdio-drift-detector.ts`). 60s is a middle ground — fast
 * enough to catch drift well before the 300s silence watchdog would,
 * slow enough to keep the cost of per-session `stat()` calls negligible.
 */
export const DRIFT_DETECTOR_TICK_MS = 60_000;

// Proactive keepalive: base delay before relaunching a crashed CLI (doubles per attempt)
export const KEEPALIVE_BASE_DELAY_MS = 3_000;

export interface SessionRecoveryDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  /**
   * Orchestrator-owned: sessions killed on purpose (idle-kill, archive,
   * delete, group degrade). Keepalive, silence and drift recovery skip them.
   */
  intentionalKills: Set<string>;
  /** Runs after every successful relaunch (manual, automatic, boot watchdog). */
  onRelaunchSucceeded: (sessionId: string) => void;
  /** Rate-limit / out-of-credits fallback pauses AFK auto-proceed. */
  noteApiLimitReached: (sessionId: string) => void;
}

export class SessionRecovery {
  private readonly launcher: CliLauncher;
  private readonly wsBridge: WsBridge;
  private readonly intentionalKills: Set<string>;
  private readonly onRelaunchSucceeded: (sessionId: string) => void;
  private readonly noteApiLimitReached: (sessionId: string) => void;

  // Auto-relaunch state
  private relaunchingSet = new Set<string>();
  private autoRelaunchCounts = new Map<string, number>();
  // Sessions that have already been notified about relaunch exhaustion.
  // Prevents repeated "keeps crashing" warnings for dead sessions.
  readonly relaunchExhaustedNotified = new Set<string>();

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
   * Per-session highest compaction-advisory milestone we've already
   * fired (in bytes; 0 = none yet). Prevents the drift-detector tick
   * from spamming the same `/compact` suggestion every 60s once the
   * user has been told. See `context-size-suggester.ts` for milestone
   * tiers and rationale.
   */
  private compactionAdvisoryFired = new Map<string, number>();

  constructor(deps: SessionRecoveryDeps) {
    this.launcher = deps.launcher;
    this.wsBridge = deps.wsBridge;
    this.intentionalKills = deps.intentionalKills;
    this.onRelaunchSucceeded = deps.onRelaunchSucceeded;
    this.noteApiLimitReached = deps.noteApiLimitReached;
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

  /** Drop all relaunch bookkeeping for a deleted session. */
  forgetSession(sessionId: string): void {
    this.autoRelaunchCounts.delete(sessionId);
    this.relaunchExhaustedNotified.delete(sessionId);
    this.relaunchingSet.delete(sessionId);
  }

  /** Session ids with a pending keepalive timer (sweep-orphans input). */
  keepaliveSessionIds(): IterableIterator<string> {
    return this.keepaliveTimers.keys();
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
        this.driftDetectorTick();
      } catch (err) {
        log.warn("session-orchestrator", "silent-stdio drift detector tick failed", {
          event: "silent_stdio_drift.tick_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, DRIFT_DETECTOR_TICK_MS);
    timer.unref?.();
    this.driftDetectorTimer = timer;
  }

  /**
   * One pass of the drift detector. For each active Claude session
   * with a resolved `cliSessionId + cwd`, resolve the CLI's jsonl
   * path, stat it against the bun transcript, and — if `checkDrift`
   * returns drifted=true — surface a browser toast + SIGTERM the
   * subprocess. The existing `session:exited` → `scheduleProactiveRelaunch`
   * path then respawns with `--resume`, giving a fresh stdio pipe.
   *
   * Codex-half sessions are skipped: Codex has a different jsonl
   * layout (or none) and different failure modes; the detector is
   * Claude-specific for now.
   */
  driftDetectorTick(): void {
    const claudeHome = `${homedir()}/.claude`;
    for (const info of this.launcher.listSessions()) {
      if (info.archived) continue;
      if (info.backendType === "codex") continue;
      if (info.state !== "connected" && info.state !== "running") continue;
      if (!info.cliSessionId || !info.cwd) continue;
      const jsonlPath = resolveJsonlPath(claudeHome, info.cwd, info.cliSessionId);
      if (!jsonlPath) continue;
      // Read the "bun freshness" signal from the live adapter, NOT from
      // the transcript file mtime. See {@link ClaudeAdapter.getLastCliFrameReceivedMs}
      // and `silent-stdio-drift-detector.ts` for why the transcript mtime
      // is unusable here (polluted by browser events + state mutations,
      // masked real stdio-pipe-death in the 2026-09-20 incident).
      // If the adapter isn't a ClaudeAdapter (unlikely — codex was
      // filtered above) or is missing, skip: nothing meaningful to check.
      const adapter = this.wsBridge.getSession(info.sessionId)?.backendAdapter;
      if (!(adapter instanceof ClaudeAdapter)) continue;
      const bunLastFrameMs = adapter.getLastCliFrameReceivedMs();
      const verdict = checkDrift(
        {
          sessionId: info.sessionId,
          bunLastFrameMs,
          jsonlPath,
        },
        {},
      );
      // Cache last snapshot for future delta-over-time detection.
      this.driftPrevSnapshot.set(info.sessionId, {
        jsonlMtimeMs: verdict.jsonlMtimeMs,
        bunLastFrameMs: verdict.bunLastFrameMs,
      });

      // Compaction-advisory piggyback: cheap stat on the same jsonl
      // we already tracked. If size crossed a new milestone since
      // last advisory, surface a browser toast suggesting `/compact`.
      // Prevents silent-stdio flares before they happen (empirical
      // pattern: sessions >1.5 MB start flaring, >3 MB flare hourly).
      // Fires at most once per milestone per session lifetime.
      try {
        const jsonlSize = statSync(jsonlPath).size;
        const lastFired = this.compactionAdvisoryFired.get(info.sessionId) ?? 0;
        const advisory = nextCompactionMilestone(jsonlSize, lastFired);
        if (advisory) {
          this.compactionAdvisoryFired.set(info.sessionId, advisory.milestoneBytes);
          log.warn(
            "session-orchestrator",
            "compaction advisory fired — session context large",
            {
              event: "context_size.compaction_advisory",
              sessionId: info.sessionId,
              jsonlSize,
              milestoneBytes: advisory.milestoneBytes,
            },
          );
          this.wsBridge.broadcastToSession(info.sessionId, {
            type: "error",
            message: advisory.message,
          });
        }
      } catch {
        // jsonl stat failed (file gone between checkDrift and here,
        // or permission changed) — skip silently. Next tick retries.
      }

      if (!verdict.drifted) continue;

      // Belt-and-braces guards mirroring `handleBackendSilent`:
      if (this.intentionalKills.has(info.sessionId)) continue;
      if (this.relaunchExhaustedNotified.has(info.sessionId)) continue;

      log.warn(
        "session-orchestrator",
        "silent-stdio drift detected — killing subprocess for relaunch",
        {
          event: "silent_stdio_drift.detected",
          sessionId: info.sessionId,
          mtimeDeltaMs: verdict.mtimeDeltaMs,
          reason: verdict.reason,
        },
      );
      this.wsBridge.broadcastToSession(info.sessionId, {
        type: "error",
        message: `Backend transcript ${Math.round(verdict.mtimeDeltaMs / 1000)}s behind CLI's jsonl — relaunching to recover.`,
      });
      // Fire-and-forget kill; the session:exited handler picks up.
      // We do NOT await here because the outer setInterval callback
      // is sync — a per-session kill blocking further sessions would
      // delay the whole tick. `launcher.kill` is idempotent on
      // already-dead sessions.
      void this.launcher.kill(info.sessionId);
    }
  }

  async handleAutoRelaunch(sessionId: string): Promise<void> {
    if (this.relaunchingSet.has(sessionId)) return;
    const info = this.launcher.getSession(sessionId);
    if (info?.archived) return;

    // If we've already notified the user about relaunch exhaustion, bail out
    // silently. Without this, every reconnect event from a dead session
    // (e.g. deleted container) re-logs the "limit reached" warning endlessly.
    if (this.relaunchExhaustedNotified.has(sessionId)) return;

    this.relaunchingSet.add(sessionId);

    await new Promise((r) => setTimeout(r, RELAUNCH_GRACE_MS));
    if (this.wsBridge.isCliConnected(sessionId)) { this.relaunchingSet.delete(sessionId); return; }
    const freshInfo = this.launcher.getSession(sessionId);
    if (freshInfo && (freshInfo.state === "connected" || freshInfo.state === "running")) {
      this.relaunchingSet.delete(sessionId); return;
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
    if (freshInfo && freshInfo.state !== "exited") {
      if (freshInfo.containerId) {
        const containerState = containerManager.isContainerAlive(freshInfo.containerId);
        if (containerState === "running") {
          this.relaunchingSet.delete(sessionId);
          return;
        }
      } else if (freshInfo.pid && adapterAttached) {
        try { process.kill(freshInfo.pid, 0); this.relaunchingSet.delete(sessionId); return; } catch {}
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
      // Council Review 2026-05-15-1015 CR-12 (Subprocess P2): mark this
      // session intentional BEFORE the launcher's SIGTERM on the old proc.
      // Without this, the old proc's `session:exited` event arms the
      // council reconnect timer (45s grace), then the new proc's spawn
      // clears it — producing a transient `reconnecting → active` UI
      // flicker on every relaunch. Marking intentional first short-circuits
      // the `session:exited` council listener in `session-orchestrator.ts`. ALWAYS clear in the
      // finally — failure paths must not leave the mark in place because
      // `scheduleProactiveRelaunch` reads `intentionalKills` to skip
      // proactive recovery and a stale mark would lock keepalive out.
      this.intentionalKills.add(sessionId);
      try {
        const result = await this.launcher.relaunch(sessionId);
        if (!result.ok && result.error) {
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
          // must fire on EVERY successful relaunch, not only the manual REST
          // one. This automatic path is the one that actually runs after a
          // codex init failure (session:exited → keepalive → here), so
          // omitting it left the fix's own target scenario unrecovered.
          this.onRelaunchSucceeded(sessionId);
        }
        // ok=false without error: keep count to preserve the retry budget
      } finally {
        // CR-12: clean up the intentional mark in ALL paths (success,
        // failure, throw). Leaving it set on failure would block the
        // next `scheduleProactiveRelaunch` indefinitely.
        this.intentionalKills.delete(sessionId);
        setTimeout(() => this.relaunchingSet.delete(sessionId), RELAUNCH_COOLDOWN_MS);
      }
    } else {
      this.relaunchingSet.delete(sessionId);
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
      this.wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message: `Model ${currentModel} silent on this session — rotating to ${decision.rotateTo} and relaunching.`,
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
            ? "Model hit a rate/session limit. Automatic fallback and AFK auto-proceed are paused; send a message manually after the reset."
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
    this.wsBridge.broadcastToSession(sessionId, {
      type: "error",
      message: `Model ${currentModel} hit ${reason}; falling back to ${nextModel}…`,
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
          console.log(`[orchestrator] CLI for session ${info.sessionId} did not reconnect, relaunching...`);
          const result = await this.launcher.relaunch(info.sessionId);
          // Council review 2026-09-08 #2: boot-recovery relaunch is the third
          // path that must re-arm the spawn-checkpoint poll — a server restart
          // that catches a council observer mid-spawn lands here.
          if (result.ok) this.onRelaunchSucceeded(info.sessionId);
        }
      }, RECONNECT_GRACE_MS);
    }
  }
}
