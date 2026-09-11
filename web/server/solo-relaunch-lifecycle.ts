/**
 * Solo-session relaunch/keepalive lifecycle bookkeeping (Fowler F5 —
 * Council Review 2026-09-11).
 *
 * Before this, the orchestrator smeared the solo-session relaunch lifecycle
 * across five uncoordinated `Set`/`Map` fields (`relaunchingSet`,
 * `autoRelaunchCounts`, `relaunchExhaustedNotified`, `intentionalKills`,
 * `keepaliveTimers`) whose cross-field ordering invariants lived only in
 * comments — the exact surface the 2026-09 churn kept re-patching (relaunch
 * flicker, wedged keepalive, deaf-but-alive PID).
 *
 * This class is the single cohesive OWNER of those five fields. It is a
 * behavior-preserving encapsulation: every method is a 1:1 wrapper over the
 * same underlying `Set`/`Map` operation the orchestrator used inline, so the
 * control flow and semantics are unchanged — the win is cohesion +
 * intention-revealing names + one isolated, unit-testable home for the
 * invariants (mirrors `group-state-machine.ts` for the group side, AP-2).
 *
 * NOTE — the ordering invariants that depend on WHERE in the flow a method is
 * called (e.g. "mark intentional BEFORE the SIGTERM", EC-2 "mark BOTH halves
 * before either kill") remain call-site obligations; a full transition-table
 * state machine that rejects invalid orderings is the tracked follow-up
 * (`TASK-solo-session-state-machine.md`).
 */
export class SoloRelaunchLifecycle {
  /** Sessions with a relaunch attempt currently in flight (guards re-entry). */
  private readonly relaunching = new Set<string>();
  /** Per-session auto-relaunch attempt counter (bounded by MAX_AUTO_RELAUNCHES). */
  private readonly autoRelaunchCounts = new Map<string, number>();
  /** Sessions already notified about relaunch exhaustion (no repeated warnings). */
  private readonly exhaustedNotified = new Set<string>();
  /** Sessions intentionally killed (idle-kill, manual delete/archive) so the
   *  proactive keepalive does NOT relaunch them. */
  private readonly intentionalKills = new Set<string>();
  /** Live proactive-keepalive relaunch timers, for cancellation on delete. */
  private readonly keepaliveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ── relaunch-in-flight guard ──────────────────────────────────────────────
  isRelaunching(sessionId: string): boolean { return this.relaunching.has(sessionId); }
  beginRelaunch(sessionId: string): void { this.relaunching.add(sessionId); }
  endRelaunch(sessionId: string): void { this.relaunching.delete(sessionId); }

  // ── auto-relaunch attempt counter ─────────────────────────────────────────
  /** Current attempt count, 0 when never attempted (matches the old `?? 0`). */
  relaunchAttempts(sessionId: string): number { return this.autoRelaunchCounts.get(sessionId) ?? 0; }
  setRelaunchAttempts(sessionId: string, count: number): void { this.autoRelaunchCounts.set(sessionId, count); }
  resetRelaunchAttempts(sessionId: string): void { this.autoRelaunchCounts.delete(sessionId); }

  // ── exhaustion-notified guard ─────────────────────────────────────────────
  isExhausted(sessionId: string): boolean { return this.exhaustedNotified.has(sessionId); }
  markExhausted(sessionId: string): void { this.exhaustedNotified.add(sessionId); }
  clearExhausted(sessionId: string): void { this.exhaustedNotified.delete(sessionId); }

  // ── intentional-kill guard ────────────────────────────────────────────────
  isIntentionalKill(sessionId: string): boolean { return this.intentionalKills.has(sessionId); }
  markIntentionalKill(sessionId: string): void { this.intentionalKills.add(sessionId); }
  clearIntentionalKill(sessionId: string): void { this.intentionalKills.delete(sessionId); }
  /** Snapshot of the session ids currently marked intentional-kill (EC-2 introspection). */
  intentionalKillSessionIds(): IterableIterator<string> { return this.intentionalKills.keys(); }

  // ── proactive-keepalive timers ────────────────────────────────────────────
  getKeepaliveTimer(sessionId: string): ReturnType<typeof setTimeout> | undefined {
    return this.keepaliveTimers.get(sessionId);
  }
  setKeepaliveTimer(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
    this.keepaliveTimers.set(sessionId, timer);
  }
  clearKeepaliveTimer(sessionId: string): void { this.keepaliveTimers.delete(sessionId); }
  /** Iterate the session ids that currently hold a live keepalive timer. */
  keepaliveSessionIds(): IterableIterator<string> { return this.keepaliveTimers.keys(); }
}
