import { log } from "./logger.js";
import type { ObserverAutoheal, ObserverAutohealResult } from "./council-observer-autoheal.js";

/**
 * W14 (b) — recover a Council pair that degraded because the observer
 * accepted a wake but never answered it (`wake_produced_no_review`).
 *
 * Prod 2026-10-16 (grp_879b81b6): the codex observer's wake went silent at
 * 12:01, the review deadline degraded the pair at 12:06, and nothing ever
 * healed it — `ObserverAutoheal` only ran for a MISSING adapter, and refused
 * `degraded` groups anyway. The next checkpoint (12:09) was dropped as
 * `group_not_active`; a manual relaunch at 12:14 fixed everything at once.
 *
 * This module does that relaunch automatically through the same bounded
 * auto-heal (per-episode attempts, hourly budget, user-stop / intentional
 * kill guards), with trigger `wake_produced_no_review`. The checkpoint the
 * observer owes is already re-queued in the group's pending slot by the
 * pipeline; the relaunch's recovery handshake (`half_respawned` /
 * `reconnect_ok`) drains it, and a `healed` result drains it once more as a
 * belt-and-braces (idempotent: an empty slot is a no-op).
 *
 * A wake turn that is still streaming when the deadline expires (a slow but
 * alive observer) is not killed mid-review: the relaunch waits for that turn
 * to end (`observer:turn-done`, at the latest the adapters' 6-minute
 * completion watchdog). Provider-agnostic — Claude and Codex observers take
 * the same path.
 */
export interface ObserverWakeRecoveryDeps {
  autoheal: Pick<ObserverAutoheal, "heal">;
  /** Current coordinator status of the group, or undefined when it is gone. */
  getGroupStatus: (sessionGroupId: string) => string | undefined;
  /** True while the observer adapter still has the wake turn in flight. */
  isObserverTurnInFlight: (observerSessionId: string) => boolean;
  /** Re-dispatch the group's queued checkpoint through the normal gates. */
  drainPendingObserverWake: (sessionGroupId: string) => void;
}

interface PendingRecovery {
  observerSessionId: string;
  checkpointId: string;
  phase: "awaiting_turn_end" | "healing";
}

export class ObserverWakeRecovery {
  private readonly pending = new Map<string, PendingRecovery>();

  constructor(private readonly deps: ObserverWakeRecoveryDeps) {}

  /** True while a recovery is scheduled or running for the group. */
  isRecovering(sessionGroupId: string): boolean {
    return this.pending.has(sessionGroupId);
  }

  /**
   * The pipeline degraded the pair for an unanswered wake. Start the
   * auto-heal now, or once the still-running wake turn ends.
   */
  onWakeUnanswered(sessionGroupId: string, observerSessionId: string, checkpointId: string): void {
    if (this.deps.getGroupStatus(sessionGroupId) !== "degraded") return;
    if (this.pending.has(sessionGroupId)) return;
    const base = { sessionGroupId, sessionId: observerSessionId, role: "observer", checkpointId };
    if (this.deps.isObserverTurnInFlight(observerSessionId)) {
      this.pending.set(sessionGroupId, { observerSessionId, checkpointId, phase: "awaiting_turn_end" });
      log.info("session-orchestrator", "observer wake recovery waits for the running turn to end", {
        event: "council.observer_wake_recovery.deferred",
        ...base,
      });
      return;
    }
    this.start(sessionGroupId, { observerSessionId, checkpointId, phase: "healing" });
  }

  /** The observer's wake turn ended (normally or via the completion watchdog). */
  onObserverTurnDone(sessionGroupId: string): void {
    const p = this.pending.get(sessionGroupId);
    if (!p || p.phase !== "awaiting_turn_end") return;
    if (this.deps.getGroupStatus(sessionGroupId) !== "degraded") {
      // Recovered some other way (manual relaunch) while we waited.
      this.pending.delete(sessionGroupId);
      return;
    }
    this.start(sessionGroupId, { ...p, phase: "healing" });
  }

  private start(sessionGroupId: string, p: PendingRecovery): void {
    this.pending.set(sessionGroupId, p);
    const base = { sessionGroupId, sessionId: p.observerSessionId, role: "observer", checkpointId: p.checkpointId };
    log.warn("session-orchestrator", "observer wake unanswered — auto-healing the observer", {
      event: "council.observer_wake_recovery.start",
      ...base,
    });
    void this.deps.autoheal
      .heal(sessionGroupId, p.observerSessionId, "wake_produced_no_review", p.checkpointId)
      .catch((err): ObserverAutohealResult => ({
        kind: "exhausted",
        attempts: 0,
        lastError: err instanceof Error ? err.message : String(err),
      }))
      .then((result) => {
        this.pending.delete(sessionGroupId);
        const status = this.deps.getGroupStatus(sessionGroupId);
        log.info("session-orchestrator", "observer wake recovery finished", {
          event: "council.observer_wake_recovery.done",
          ...base,
          result: result.kind,
          groupStatus: status ?? "gone",
          ...(result.kind === "skipped" ? { reason: result.reason } : { attempts: result.attempts }),
        });
        if (result.kind === "healed" && status === "active") {
          this.deps.drainPendingObserverWake(sessionGroupId);
        }
      });
  }
}
