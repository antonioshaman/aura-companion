/**
 * Liveness probes to a council observer (observer rigor, 2026-10-16).
 *
 * Operators (and agents, via `POST /api/sessions/:id/inject`) check that an
 * observer is alive by sending it a short tagged message, e.g.
 * `[liveness probe] Ответь одной строкой: кто ты…`. Observed live
 * 2026-10-15 (grp_879b81b6): the reply "Я Observer, независимый ревьюер
 * Council…" landed on the findings channel. Probe traffic is not review
 * traffic:
 *   - a wake is never dispatched while a probe turn runs (the probe's prose
 *     would be captured as the wake's reply) — the pipeline queues it and
 *     drains it when the probe turn ends;
 *   - a probe that lands mid-wake can only produce a `probe_turn` outcome,
 *     never a review or a rejection strike (`observer-reply.ts`);
 *   - the browser renders the probe exchange as a collapsed probe row, not
 *     as observer output (`src/utils/observer-probe.ts`, same tag rule).
 */

/** Leading tag that marks a probe: `[liveness probe]`, `[liveness-probe]`,
 *  `[probe]`, `[ping]` (case-insensitive, leading whitespace allowed). */
export const OBSERVER_PROBE_TAG = /^\s*\[(?:liveness[\s-]?probe|probe|ping)\]/i;

export function isObserverProbeText(text: unknown): boolean {
  return typeof text === "string" && OBSERVER_PROBE_TAG.test(text);
}

/** A probe turn that never reports its end stops blocking wakes after this. */
export const PROBE_TURN_MAX_MS = 120_000;

/**
 * Per-observer-session count of probe turns started but not yet ended.
 * Fed by the probe injection (start) and every `result` frame (end).
 */
export class ObserverProbeTracker {
  private readonly pending = new Map<string, { count: number; sinceMs: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  noteProbe(sessionId: string): void {
    const cur = this.pending.get(sessionId);
    this.pending.set(sessionId, { count: (cur?.count ?? 0) + 1, sinceMs: cur?.sinceMs ?? this.now() });
  }

  /** A turn of this session ended. `true` when that ended the LAST pending
   *  probe turn (the caller then drains a wake queued behind it). */
  noteTurnEnded(sessionId: string): boolean {
    const cur = this.pending.get(sessionId);
    if (!cur) return false;
    if (cur.count <= 1) {
      this.pending.delete(sessionId);
      return true;
    }
    this.pending.set(sessionId, { count: cur.count - 1, sinceMs: this.now() });
    return false;
  }

  inFlight(sessionId: string): boolean {
    const cur = this.pending.get(sessionId);
    if (!cur) return false;
    if (this.now() - cur.sinceMs > PROBE_TURN_MAX_MS) {
      this.pending.delete(sessionId);
      return false;
    }
    return true;
  }

  forget(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}
