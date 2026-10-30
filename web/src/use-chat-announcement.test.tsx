// @vitest-environment jsdom
/** Both CLI adapters feed the same ChatMessage contract. History, tool output and
 * thinking remain silent; new assistant prose is bounded and sampled, not debounced.
 */
import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatAnnouncement } from "./use-chat-announcement.js";
import type { ChatMessage } from "./types.js";
const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: "a", role: "assistant", content: "hello", timestamp: Date.now(), ...over });
function Feed({ messages, session = "one" }: { messages: ChatMessage[]; session?: string }) {
  const text = useChatAnnouncement(session, messages);
  return <p role="status" aria-live="polite">{text}</p>;
}
afterEach(() => vi.useRealTimers());

describe("chat announcements", () => {
  it("keeps sampling after StrictMode replays effect setup and cleanup", () => {
    vi.useFakeTimers(); render(<StrictMode><Feed messages={[message({ isStreaming: true })]} /></StrictMode>);
    act(() => vi.advanceTimersByTime(1500)); expect(screen.getByRole("status").textContent).toBe("hello");
  });

  it("does not replay initial or later-loaded historical messages", () => {
    const view = render(<Feed messages={[message()]} />);
    expect(screen.getByRole("status").textContent).toBe("");
    view.rerender(<Feed messages={[message(), message({ id: "history", timestamp: 0 })]} />);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it.each(["claude", "codex"])("samples %s stream deltas without restarting its timer on every token", (backend) => {
    vi.useFakeTimers();
    const view = render(<Feed messages={[]} />);
    const update = (text: string, isStreaming = true) => view.rerender(<Feed messages={[message({ content: text, isStreaming, model: backend })]} />);
    update("first "); expect(screen.getByRole("status").textContent).toBe("Assistant is replying.");
    act(() => vi.advanceTimersByTime(1000)); update("first sentence.");
    act(() => vi.advanceTimersByTime(500)); expect(screen.getByRole("status").textContent).toBe("first sentence.");
    update("first sentence. next"); act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("status").textContent).toBe(" next");
    update("first sentence. next final", false);
    expect(screen.getByRole("status").textContent).toBe("Assistant message complete.  final");
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds announcements, drops backlog, and cancels pending timers on session change", () => {
    vi.useFakeTimers(); const view = render(<Feed messages={[]} />);
    view.rerender(<Feed messages={[message({ content: "x".repeat(1000), isStreaming: true })]} />);
    act(() => vi.advanceTimersByTime(1500)); expect(screen.getByRole("status").textContent).toHaveLength(240);
    view.rerender(<Feed messages={[message({ content: "more", id: "new", isStreaming: true })]} />);
    view.rerender(<Feed session="two" messages={[message({ content: "old second session" })]} />);
    act(() => vi.advanceTimersByTime(2000)); expect(screen.getByRole("status").textContent).toBe("");
  });

  it("ignores tool/thinking and subagent messages; announces new complete prose once", () => {
    const view = render(<Feed messages={[]} />);
    view.rerender(<Feed messages={[message({ contentBlocks: [{ type: "thinking", thinking: "private" }] })]} />);
    expect(screen.getByRole("status").textContent).toBe("");
    view.rerender(<Feed messages={[message({ id: "sub", parentToolUseId: "task" })]} />);
    expect(screen.getByRole("status").textContent).toBe("");
    view.rerender(<Feed messages={[message({ id: "final", contentBlocks: [{ type: "text", text: "done" }] })]} />);
    expect(screen.getByRole("status").textContent).toBe("Assistant: done");
  });

  it.each(["interrupted", "errored"] as const)("does not call an %s stream complete", (streamStatus) => {
    const view = render(<Feed messages={[message({ isStreaming: true })]} />);
    view.rerender(<Feed messages={[message({ streamStatus })]} />);
    expect(screen.getByRole("status").textContent).toContain(streamStatus === "errored" ? "failed" : "interrupted");
  });
});
