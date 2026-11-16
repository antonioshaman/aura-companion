import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "./types.js";
import { describeTurnFailure, formatAction } from "../server/auth-status/auth-catalog.js";

const INTERVAL_MS = 1500;
const MAX_CHARS = 240;
const spokenText = (message: ChatMessage) => message.streamingPhase === "thinking" ? "" : message.contentBlocks
  ? message.contentBlocks.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("\n")
  : message.content;

/** A small live region announces new prose, never the history or tool/thinking blocks.
 * It samples incremental text at most once per 1.5s and drops backlog: the full
 * answer stays available in the ordinary transcript for deliberate navigation.
 */
export function useChatAnnouncement(sessionId: string, messages: ChatMessage[]): string {
  const [announcement, setAnnouncement] = useState("");
  const state = useRef<{
    sessionId: string; mountedAt: number; seen: Set<string>; activeId: string | null;
    offset: number; text: string; timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  if (!state.current) state.current = { sessionId, mountedAt: Date.now(), seen: new Set(messages.map((m) => m.id)), activeId: null, offset: 0, text: "", timer: null };

  useEffect(() => {
    const current = state.current!;
    if (current.sessionId !== sessionId) {
      if (current.timer) clearTimeout(current.timer);
      state.current = { sessionId, mountedAt: Date.now(), seen: new Set(messages.map((m) => m.id)), activeId: null, offset: 0, text: "", timer: null };
      setAnnouncement("");
    }
    const s = state.current!;
    // A turn that failed (sign-in expired, limit hit) is a system card, not
    // assistant prose: say why and what to do, once, when it arrives live
    // (watson P2-5). History replays (`hist-` ids, or present at mount) stay silent.
    const failure = messages.find((m) => m.systemVariant === "turn-failure" && m.turnFailure && !s.seen.has(m.id) && !m.id.startsWith("hist-"));
    if (failure?.turnFailure) {
      const entry = describeTurnFailure(failure.turnFailure.kind, failure.turnFailure.provider);
      const action = entry.action.kind === "none" ? "" : ` ${formatAction(entry.action)}`;
      setAnnouncement(`Turn failed: ${entry.title}.${action}`);
      s.seen = new Set(messages.map((m) => m.id));
      return;
    }
    const latest = [...messages].reverse().find((m) => m.role === "assistant" && !m.parentToolUseId && spokenText(m).trim());
    if (!latest) return;
    const text = spokenText(latest);
    if (latest.isStreaming) {
      if (s.activeId !== latest.id) {
        if (s.timer) clearTimeout(s.timer);
        s.timer = null; s.activeId = latest.id; s.offset = 0;
        setAnnouncement("Assistant is replying.");
      }
      s.text = text;
      if (!s.timer && text.length > s.offset) {
        s.timer = setTimeout(() => {
          const delta = s.text.slice(s.offset, s.offset + MAX_CHARS);
          s.offset = s.text.length; s.timer = null;
          if (delta.trim()) setAnnouncement(delta);
        }, INTERVAL_MS);
      }
    } else if (s.activeId === latest.id) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      const delta = text.slice(s.offset, s.offset + MAX_CHARS);
      const end = latest.streamStatus === "interrupted" ? "interrupted" : latest.streamStatus === "errored" ? "failed" : "complete";
      setAnnouncement(`Assistant message ${end}.${delta.trim() ? ` ${delta}` : ""}`);
      s.activeId = null;
    } else if (!s.seen.has(latest.id) && latest.timestamp >= s.mountedAt) {
      setAnnouncement(`Assistant: ${text.slice(0, MAX_CHARS)}`);
    }
    s.seen = new Set(messages.map((m) => m.id));
  }, [sessionId, messages]);

  useEffect(() => () => {
    if (state.current?.timer) { clearTimeout(state.current.timer); state.current.timer = null; }
  }, []);
  return announcement;
}
