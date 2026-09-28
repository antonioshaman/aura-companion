import { log } from "./logger.js";

/**
 * Council Mode observer auto-heal (aura-meta-diet P4/OBS-AUTOHEAL).
 *
 * Incident 2026-09-28 (twice: 04:39 and 14:49): an idle Codex observer lost
 * its backend adapter (`adapter_missing`). The EC-13 failsafe kept polling for
 * readiness, every poll ended in `restart_catchup_adapter_wait_timed_out`, and
 * after the strike threshold the pair went `degraded` ("Observer offline ·
 * wake failed"). The only cure was a manual `POST /api/sessions/<observer>/
 * relaunch` — after it the adapter attached and the group was active again.
 * In the morning no reviews ran for ~5.5 h.
 *
 * This module does that relaunch automatically, for the OBSERVER half only,
 * with a hard budget:
 *   - at most {@link OBSERVER_AUTOHEAL_MAX_ATTEMPTS} relaunches per episode,
 *     spaced by {@link OBSERVER_AUTOHEAL_BACKOFF_MS};
 *   - at most {@link OBSERVER_AUTOHEAL_MAX_PER_HOUR} relaunches per group in
 *     any rolling hour (a flapping observer must not be relaunched forever);
 *   - one episode per group at a time.
 * After each relaunch it waits up to {@link OBSERVER_AUTOHEAL_READY_WAIT_MS}
 * for the adapter to become send-ready. The caller re-sends the missed wake on
 * `healed` and degrades the pair on `exhausted` — degrading stays the job of
 * the single degrade authority (`coordinator.applyEvent`), not this module.
 *
 * Never heals a session the user stopped on purpose (P4/KILL-INTENTIONAL,
 * EC-2): the caller's `blockedReason` reports user stops of EITHER half,
 * because relaunching one half of a stopped pair would bring the pair back.
 * The orchestrator half is never touched.
 *
 * Provider-agnostic: the relaunch and readiness callbacks are the same for a
 * Claude or a Codex observer.
 */

export const OBSERVER_AUTOHEAL_MAX_ATTEMPTS = 2;
/** Wait before attempt N (index = attempt number, 0-based). */
export const OBSERVER_AUTOHEAL_BACKOFF_MS: readonly number[] = [0, 30_000];
export const OBSERVER_AUTOHEAL_MAX_PER_HOUR = 4;
export const OBSERVER_AUTOHEAL_READY_WAIT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 250;
const HOUR_MS = 3_600_000;

export type ObserverAutohealTrigger = "adapter_missing" | "adapter_wait_timed_out";

export type ObserverAutohealResult =
  | { kind: "healed"; attempts: number }
  | { kind: "exhausted"; attempts: number; lastError?: string }
  | { kind: "skipped"; reason: "in_flight" | "rate_limited" | string };

export interface ObserverAutohealDeps {
  /** Relaunch ONLY the observer process (orchestrator's relaunch path). */
  relaunchObserver: (observerSessionId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Same send-readiness gate the wake dispatcher uses. */
  isObserverReadyForWake: (observerSessionId: string) => boolean;
  /**
   * Why healing must NOT happen right now, or null to proceed. Checked before
   * every attempt: user stop of either half, group torn down / not live.
   */
  blockedReason: (sessionGroupId: string, observerSessionId: string) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class ObserverAutoheal {
  private readonly inFlight = new Set<string>();
  /** Relaunch timestamps per group, pruned to the rolling hour. */
  private readonly relaunchLog = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ObserverAutohealDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  isHealing(sessionGroupId: string): boolean {
    return this.inFlight.has(sessionGroupId);
  }

  /** Drop per-group state on group teardown. */
  forgetGroup(sessionGroupId: string): void {
    this.relaunchLog.delete(sessionGroupId);
  }

  async heal(
    sessionGroupId: string,
    observerSessionId: string,
    trigger: ObserverAutohealTrigger,
    checkpointId: string,
  ): Promise<ObserverAutohealResult> {
    const base = { sessionGroupId, sessionId: observerSessionId, role: "observer", trigger, checkpointId };
    const blocked = this.deps.blockedReason(sessionGroupId, observerSessionId);
    if (blocked) {
      log.info("session-orchestrator", "observer.autoheal.skipped", { event: "observer.autoheal.skipped", ...base, reason: blocked });
      return { kind: "skipped", reason: blocked };
    }
    if (this.inFlight.has(sessionGroupId)) return { kind: "skipped", reason: "in_flight" };
    this.inFlight.add(sessionGroupId);
    let attempts = 0;
    let lastError: string | undefined;
    try {
      for (let i = 0; i < OBSERVER_AUTOHEAL_MAX_ATTEMPTS; i++) {
        const backoff = OBSERVER_AUTOHEAL_BACKOFF_MS[i] ?? 0;
        if (backoff > 0) await this.sleep(backoff);
        const reason = this.deps.blockedReason(sessionGroupId, observerSessionId);
        if (reason) {
          log.info("session-orchestrator", "observer.autoheal.skipped", { event: "observer.autoheal.skipped", ...base, reason, attempts });
          return { kind: "skipped", reason };
        }
        if (this.deps.isObserverReadyForWake(observerSessionId)) {
          // Recovered on its own during the backoff — no relaunch needed.
          log.info("session-orchestrator", "observer.autoheal.ok", { event: "observer.autoheal.ok", ...base, attempts, selfRecovered: true });
          return { kind: "healed", attempts };
        }
        if (!this.takeHourlySlot(sessionGroupId)) {
          log.warn("session-orchestrator", "observer.autoheal.rate_limited", {
            event: "observer.autoheal.rate_limited",
            ...base,
            attempts,
            maxPerHour: OBSERVER_AUTOHEAL_MAX_PER_HOUR,
          });
          if (attempts === 0) return { kind: "skipped", reason: "rate_limited" };
          break;
        }
        attempts++;
        log.warn("session-orchestrator", "observer.autoheal.attempt", {
          event: "observer.autoheal.attempt",
          ...base,
          attempt: attempts,
          maxAttempts: OBSERVER_AUTOHEAL_MAX_ATTEMPTS,
          backoffMs: backoff,
        });
        let result: { ok: boolean; error?: string };
        try {
          result = await this.deps.relaunchObserver(observerSessionId);
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (!result.ok) {
          lastError = result.error ?? "relaunch failed";
          log.warn("session-orchestrator", "observer.autoheal.relaunch_failed", {
            event: "observer.autoheal.relaunch_failed",
            ...base,
            attempt: attempts,
            error: lastError,
          });
          continue;
        }
        if (await this.waitForReady(sessionGroupId, observerSessionId)) {
          log.info("session-orchestrator", "observer.autoheal.ok", { event: "observer.autoheal.ok", ...base, attempts });
          return { kind: "healed", attempts };
        }
        lastError = "adapter_wait_timed_out";
      }
      log.warn("session-orchestrator", "observer.autoheal.exhausted", {
        event: "observer.autoheal.exhausted",
        ...base,
        attempts,
        ...(lastError ? { error: lastError } : {}),
      });
      return { kind: "exhausted", attempts, ...(lastError ? { lastError } : {}) };
    } finally {
      this.inFlight.delete(sessionGroupId);
    }
  }

  private takeHourlySlot(sessionGroupId: string): boolean {
    const cutoff = this.now() - HOUR_MS;
    const recent = (this.relaunchLog.get(sessionGroupId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= OBSERVER_AUTOHEAL_MAX_PER_HOUR) {
      this.relaunchLog.set(sessionGroupId, recent);
      return false;
    }
    recent.push(this.now());
    this.relaunchLog.set(sessionGroupId, recent);
    return true;
  }

  private async waitForReady(sessionGroupId: string, observerSessionId: string): Promise<boolean> {
    const deadline = this.now() + OBSERVER_AUTOHEAL_READY_WAIT_MS;
    while (this.now() < deadline) {
      if (this.deps.blockedReason(sessionGroupId, observerSessionId)) return false;
      if (this.deps.isObserverReadyForWake(observerSessionId)) return true;
      await this.sleep(READY_POLL_INTERVAL_MS);
    }
    return this.deps.isObserverReadyForWake(observerSessionId);
  }
}

/** The slice of a coordinator group record {@link observerAutohealBlockedReason} reads. */
export interface AutohealGroupView {
  status: string;
  primary: { sessionId: string };
  observer: { sessionId: string };
}

/**
 * Pure: why the observer of `group` must not be auto-healed now, or null.
 * `user_stopped` covers BOTH halves — relaunching the observer of a pair
 * whose orchestrator the user stopped would resume the pair (EC-2,
 * P4/KILL-INTENTIONAL). `intentional_kill` covers a kill in progress
 * (archive, manual relaunch, group teardown).
 */
export function observerAutohealBlockedReason(
  group: AutohealGroupView | null | undefined,
  observerSessionId: string,
  isStoppedByUser: (sessionId: string) => boolean,
  isIntentionalKill: (sessionId: string) => boolean,
): string | null {
  if (!group) return "group_gone";
  if (group.observer.sessionId !== observerSessionId) return "observer_changed";
  if (group.status !== "active" && group.status !== "reconnecting") return "group_not_live";
  if (isStoppedByUser(group.observer.sessionId) || isStoppedByUser(group.primary.sessionId)) {
    return "user_stopped";
  }
  if (isIntentionalKill(group.observer.sessionId)) return "intentional_kill";
  return null;
}
