import type { BrowserIncomingMessage, ContentBlock } from "./session-types.js";
import type { Session } from "./ws-bridge-types.js";

// ─── Stream-status tracking ────────────────────────────────────────────────
//
// PLAN Task 12 — closes the data-loss window between the CLI emitting a
// streaming `message_start` and the consolidated `assistant` frame that
// closes the turn. If the CLI dies inside that window the persisted
// `messageHistory` carries no record of the partial reply at all — the
// browser re-mounts and the user sees the prompt with no answer, no error,
// nothing. This module accumulates the in-flight stream on the server side
// (event-bus is browser-only) so a confirmed disconnect can synthesise a
// best-effort assistant frame with `streamStatus: "interrupted"`.
//
// Pure functions over wire frames + `Session`: no I/O, no clock other than
// `Date.now()` (injected via `nowMs` in tests). The bridge call sites are:
//   - `trackStreamForInterrupted` on every `stream_event` from the CLI.
//   - `synthesiseInterruptedMessage` from the disconnect-confirmed path.

interface StreamEventLike {
  type: "stream_event";
  event: unknown;
  parent_tool_use_id: string | null;
}

interface StreamEventFrame {
  type?: unknown;
  message?: { id?: unknown; model?: unknown };
  delta?: { type?: unknown; text?: unknown };
}

/**
 * Apply one CLI `stream_event` to the session's in-flight stream tracker.
 *
 * Recognised frame types:
 *   - `message_start` — resets the tracker with the new message's id/model.
 *   - `content_block_delta` with `text_delta` — appends the text chunk.
 *
 * Other frame types (thinking_delta, message_delta, tool_use deltas) are
 * deliberately ignored: an interrupted bubble that re-renders a tool use
 * mid-formation would lie about CLI state. Plain-text reconstruction is
 * the only safe partial we can surface.
 */
export function trackStreamForInterrupted(
  session: Session,
  msg: StreamEventLike,
  nowMs: number = Date.now(),
): void {
  const evt = msg.event as StreamEventFrame | null;
  if (!evt || typeof evt !== "object") return;

  if (evt.type === "message_start") {
    const message = evt.message;
    if (!message || typeof message !== "object") return;
    const id = typeof message.id === "string" ? message.id : null;
    if (!id) return;
    session.streamingAssistant = {
      id,
      text: "",
      parentToolUseId: msg.parent_tool_use_id,
      model: typeof message.model === "string" ? message.model : undefined,
      startedAt: nowMs,
    };
    return;
  }

  if (evt.type === "content_block_delta") {
    const tracker = session.streamingAssistant;
    if (!tracker) return;
    const delta = evt.delta;
    if (!delta || typeof delta !== "object") return;
    if (delta.type !== "text_delta") return;
    const chunk = delta.text;
    if (typeof chunk !== "string") return;
    tracker.text += chunk;
  }
}

/**
 * Build a synthetic `assistant` BrowserIncomingMessage representing the
 * interrupted stream. Returns `null` if no tracker is set or the tracker
 * has no text yet (a `message_start` with zero deltas before disconnect is
 * indistinguishable from a turn that produced no output — better to drop
 * than fabricate a bubble for it).
 *
 * Caller is responsible for clearing `session.streamingAssistant` after
 * appending the result to history. We keep the clear out of this function
 * so the caller can decide whether to persist the synthesised frame at
 * all (e.g. unit tests that just want to inspect the projection).
 */
export function synthesiseInterruptedMessage(
  session: Session,
  nowMs: number = Date.now(),
): BrowserIncomingMessage | null {
  const tracker = session.streamingAssistant;
  if (!tracker) return null;
  if (tracker.text.length === 0) return null;

  const contentBlock: ContentBlock = { type: "text", text: tracker.text };

  return {
    type: "assistant",
    message: {
      id: tracker.id,
      type: "message",
      role: "assistant",
      model: tracker.model ?? "",
      content: [contentBlock],
      stop_reason: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: tracker.parentToolUseId,
    timestamp: nowMs,
    streamStatus: "interrupted",
  };
}
