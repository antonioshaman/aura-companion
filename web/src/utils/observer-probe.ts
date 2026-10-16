/**
 * Liveness probes in an observer's chat (observer rigor, 2026-10-16).
 * Same tag rule as `server/observer-probe.ts`: a probe and the observer's
 * reply to it are probe traffic, not observer output, and are rendered as a
 * collapsed probe row instead of between the findings.
 */

export const OBSERVER_PROBE_TAG = /^\s*\[(?:liveness[\s-]?probe|probe|ping)\]/i;

export function isObserverProbeText(text: unknown): boolean {
  return typeof text === "string" && OBSERVER_PROBE_TAG.test(text);
}

interface FeedMessageLike {
  id: string;
  role: string;
  content: string;
  /** Set when the turn's `result` frame closed the turn at this message. */
  turnEnd?: boolean;
}

/**
 * Ids of probe user messages and of the assistant replies that answer them.
 *
 * A probe is bound to ITS turn: the span covers the probe and every message
 * up to and including the one the turn's `result` frame closed (`turnEnd`).
 * Every reply inside the probe turn is probe traffic even when it looks like
 * findings (`[]` answering "[probe] ответь []" is not a clean review); a
 * reply in a later turn never is.
 *
 * "Up to the next user message" alone is not a boundary: a wake is never
 * echoed into the browser feed as a user message. Prod 2026-10-16
 * (grp_879b81b6): one `[liveness probe]` early in the observer's history
 * turned every later findings reply into a collapsed probe row of raw JSON.
 * A new user message still closes the span (and may open a new one).
 */
export function probeMessageIds(messages: readonly FeedMessageLike[]): Set<string> {
  const ids = new Set<string>();
  let inProbe = false;
  for (const m of messages) {
    if (m.role === "user") {
      inProbe = isObserverProbeText(m.content);
      if (inProbe) ids.add(m.id);
    } else if (inProbe && m.role === "assistant") {
      ids.add(m.id);
    }
    if (m.turnEnd) inProbe = false;
  }
  return ids;
}
