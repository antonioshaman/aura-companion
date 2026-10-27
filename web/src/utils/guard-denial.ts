import type { ChatMessage, GuardDenial } from "../types.js";

/**
 * Chat-feed entry for a guards-pack denial. The id is derived from the
 * toolUseId so the live frame and the message_history replay of the same
 * denial collapse into one card (reconnect merge upserts by id, and the
 * history copy carries the latest resolved status).
 */
export function guardDenialChatMessage(denial: GuardDenial, timestamp?: number): ChatMessage {
  return {
    id: `guard-denial-${denial.toolUseId}`,
    role: "system",
    content: denial.reason,
    timestamp: timestamp || denial.deniedAt || Date.now(),
    guardDenial: denial,
  };
}
