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
}

/**
 * Ids of probe user messages and of the assistant replies that answer them
 * (every assistant message after a probe, up to the next user message).
 */
export function probeMessageIds(messages: readonly FeedMessageLike[]): Set<string> {
  const ids = new Set<string>();
  let inProbe = false;
  for (const m of messages) {
    if (m.role === "user") {
      inProbe = isObserverProbeText(m.content);
      if (inProbe) ids.add(m.id);
      continue;
    }
    if (inProbe && m.role === "assistant") ids.add(m.id);
  }
  return ids;
}
