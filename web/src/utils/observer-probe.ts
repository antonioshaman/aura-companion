/**
 * Liveness probes in an observer's chat (observer rigor, 2026-10-16).
 * Same tag rule as `server/observer-probe.ts`: a probe and the observer's
 * reply to it are probe traffic, not observer output, and are rendered as a
 * collapsed probe row instead of between the findings.
 */

import { parseObserverFindingsMessage } from "./observer-findings.js";

export const OBSERVER_PROBE_TAG = /^\s*\[(?:liveness[\s-]?probe|probe|ping)\]/i;

export function isObserverProbeText(text: unknown): boolean {
  return typeof text === "string" && OBSERVER_PROBE_TAG.test(text);
}

interface FeedMessageLike {
  id: string;
  role: string;
  content: string;
  contentBlocks?: ReadonlyArray<{ type: string }>;
}

/**
 * Ids of probe user messages and of the assistant replies that answer them.
 *
 * The span opened by a probe ends at the next user message — but a wake is
 * NOT a user message in the browser feed (the server injects it without
 * echoing it into the history), so "up to the next user message" alone
 * swallowed every later review. Prod 2026-10-16 (grp_879b81b6): one
 * `[liveness probe]` early in the observer's history turned every findings
 * reply after it into a collapsed "Ответ на пробу" row showing raw JSON.
 * The span therefore also ends:
 *   - at a findings-shaped reply (the observer reply contract — that is
 *     review output by definition, never probe traffic; not marked), and
 *   - at a tool call that follows the probe's text answer (the probe turn
 *     ended with that answer; a new tool call is the next wake's work).
 */
export function probeMessageIds(messages: readonly FeedMessageLike[]): Set<string> {
  const ids = new Set<string>();
  let inProbe = false;
  let answered = false;
  for (const m of messages) {
    if (m.role === "user") {
      inProbe = isObserverProbeText(m.content);
      answered = false;
      if (inProbe) ids.add(m.id);
      continue;
    }
    if (!inProbe || m.role !== "assistant") continue;
    if (parseObserverFindingsMessage(m.content) !== null) {
      inProbe = false;
      continue;
    }
    const hasToolUse = m.contentBlocks?.some((b) => b.type === "tool_use") ?? false;
    if (answered && hasToolUse) {
      inProbe = false;
      continue;
    }
    if (m.content.trim().length > 0) answered = true;
    ids.add(m.id);
  }
  return ids;
}
