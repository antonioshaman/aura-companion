/**
 * Auto-resume executor — the action taken when a usage-limit schedule fires
 * (see `auto-resume-scheduler.ts`). Dependency-injected (AP-1) so the
 * orchestrator wires real launcher / bridge / council calls and tests use
 * fakes.
 *
 *  - Solo session / council orchestrator: relaunch the CLI if its process is
 *    dead (the bridge queues the injected frame until the new CLI attaches),
 *    make sure a council observer partner is alive too, then inject the
 *    continuation prompt through the regular user-message path with origin
 *    `server:auto-resume` (rendered in chat as an automatic resume).
 *  - Council observer: observer turns are wake-driven, so it never gets a
 *    "continue" user prompt — it is revived if dead and its pending/missed
 *    checkpoint wake is re-dispatched.
 *
 * The group role is resolved LIVE at fire time (not from the persisted
 * schedule) so a pair re-formed across a restart is handled correctly.
 */
import type { AutoResumeOutcome, AutoResumeSchedule } from "./auto-resume-scheduler.js";

export const AUTO_RESUME_PROMPT = "Лимит сброшен — продолжай с того места, где остановился.";

export interface AutoResumeGroupRef {
  sessionGroupId: string;
  orchestratorSessionId: string;
  observerSessionId: string;
}

export interface AutoResumeExecutorDeps {
  getSession: (sessionId: string) => { archived?: boolean } | undefined;
  isAlive: (sessionId: string) => boolean;
  relaunch: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  findGroup: (sessionId: string) => AutoResumeGroupRef | null;
  inject: (sessionId: string, content: string) => void;
  wakeObserver: (sessionGroupId: string) => void;
  /**
   * True when a person sent the session a message at/after `since` (epoch
   * ms). Checked right before injecting to close the cancel/fire race: the
   * schedule is gone once firing starts, so a message typed during the
   * relaunch would otherwise get a stale "continue" stacked on top.
   */
  userMessagedSince?: (sessionId: string, since: number) => boolean;
}

export function createAutoResumeExecutor(deps: AutoResumeExecutorDeps) {
  const usable = (id: string): boolean => {
    const info = deps.getSession(id);
    return !!info && !info.archived;
  };

  /** Relaunch `id` when its process is dead. */
  const ensureAlive = async (id: string): Promise<{ ok: boolean; relaunched: boolean; error?: string }> => {
    if (deps.isAlive(id)) return { ok: true, relaunched: false };
    const result = await deps.relaunch(id);
    return { ok: result.ok, relaunched: result.ok, error: result.error };
  };

  return async function resume(schedule: AutoResumeSchedule): Promise<AutoResumeOutcome> {
    const id = schedule.sessionId;
    if (!usable(id)) return { ok: false, outcome: "session_gone" };

    const group = deps.findGroup(id);
    const self = await ensureAlive(id);
    if (!self.ok) return { ok: false, outcome: "relaunch_failed", error: self.error, relaunched: false };

    if (group && group.observerSessionId === id) {
      deps.wakeObserver(group.sessionGroupId);
      return { ok: true, outcome: "observer_woken", relaunched: self.relaunched };
    }

    let partnerRelaunched = false;
    if (group && group.observerSessionId !== id && usable(group.observerSessionId)) {
      const partner = await ensureAlive(group.observerSessionId);
      partnerRelaunched = partner.relaunched;
    }

    if (deps.userMessagedSince?.(id, schedule.scheduledAt)) {
      return { ok: true, outcome: "user_took_over", relaunched: self.relaunched, partnerRelaunched };
    }
    deps.inject(id, AUTO_RESUME_PROMPT);
    return { ok: true, outcome: "injected", relaunched: self.relaunched, partnerRelaunched };
  };
}
