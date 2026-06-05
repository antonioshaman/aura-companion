import { describe, it, expect } from "vitest";
import {
  trackStreamForInterrupted,
  synthesiseInterruptedMessage,
} from "./ws-bridge-stream-status.js";
import type { Session } from "./ws-bridge-types.js";
import { SessionStateMachine } from "./session-state-machine.js";

// ─── Test fixtures ────────────────────────────────────────────────────────
//
// These tests cover the PLAN Task 12 streamStatus tracker in isolation
// from the bridge plumbing. The bridge wires the same calls into its
// `handleCLIClose` / `onDisconnect` paths; integration coverage that
// exercises the persisted-history shape lives in the consumer tests
// (ws-bridge.test.ts), but the algorithm itself is purely a function over
// wire frames + the in-memory tracker, so a focused suite catches drift
// without booting the full bridge harness.

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-under-test",
    backendType: "claude",
    backendAdapter: null,
    browserSockets: new Set(),
    state: {
      session_id: "session-under-test",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "",
      is_worktree: false,
      is_containerized: false,
      repo_root: "",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      aiValidationEnabled: false,
      aiValidationAutoApprove: false,
      aiValidationAutoDeny: false,
    },
    pendingPermissions: new Map(),
    messageHistory: [],
    pendingMessages: [],
    nextEventSeq: 1,
    eventBuffer: [],
    lastAckSeq: 0,
    processedClientMessageIds: [],
    processedClientMessageIdSet: new Set(),
    lastCliActivityTs: Date.now(),
    reachable: false,
    stateMachine: new SessionStateMachine("session-under-test"),
    streamingAssistant: null,
    ...overrides,
  };
}

// Helper — build a stream_event frame matching the wire shape from
// `parse_BrowserIncomingMessageBase.assistant.stream_event` flowing
// through `ws-bridge.ts` handleCliMessage.
function streamEvent(event: unknown, parentToolUseId: string | null = null) {
  return { type: "stream_event" as const, event, parent_tool_use_id: parentToolUseId };
}

// ─── trackStreamForInterrupted ────────────────────────────────────────────

describe("trackStreamForInterrupted", () => {
  it("starts a tracker on message_start with valid id", () => {
    const session = makeSession();
    trackStreamForInterrupted(
      session,
      streamEvent({
        type: "message_start",
        message: { id: "msg-abc", model: "claude-sonnet-4-6" },
      }),
      1700_000_000_000,
    );

    expect(session.streamingAssistant).toEqual({
      id: "msg-abc",
      text: "",
      parentToolUseId: null,
      model: "claude-sonnet-4-6",
      startedAt: 1700_000_000_000,
    });
  });

  it("captures parent_tool_use_id when the streaming message is from a sub-agent", () => {
    const session = makeSession();
    trackStreamForInterrupted(
      session,
      streamEvent(
        { type: "message_start", message: { id: "msg-sub", model: "claude-haiku" } },
        "tool-use-7",
      ),
    );
    expect(session.streamingAssistant?.parentToolUseId).toBe("tool-use-7");
  });

  it("ignores message_start without a string id", () => {
    const session = makeSession();
    trackStreamForInterrupted(
      session,
      streamEvent({ type: "message_start", message: { id: 42 } }),
    );
    expect(session.streamingAssistant).toBeNull();
  });

  it("accumulates text from content_block_delta text_deltas", () => {
    const session = makeSession();
    trackStreamForInterrupted(
      session,
      streamEvent({ type: "message_start", message: { id: "msg-1", model: "claude" } }),
    );
    trackStreamForInterrupted(
      session,
      streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }),
    );
    trackStreamForInterrupted(
      session,
      streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text: ", world" } }),
    );
    expect(session.streamingAssistant?.text).toBe("Hello, world");
  });

  it("ignores deltas that arrive before message_start", () => {
    // Defensive — out-of-order frames should not fabricate a tracker.
    const session = makeSession();
    trackStreamForInterrupted(
      session,
      streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "lost" } }),
    );
    expect(session.streamingAssistant).toBeNull();
  });

  it("ignores thinking_delta — partial-reasoning rebuild would mislead users", () => {
    // Only plain text deltas accumulate. A bubble whose interrupted state
    // shows a partial chain-of-thought would expose internal reasoning a
    // production reply wouldn't normally surface, so we deliberately drop
    // the thinking deltas from the tracker.
    const session = makeSession();
    trackStreamForInterrupted(
      session,
      streamEvent({ type: "message_start", message: { id: "msg-2", model: "claude" } }),
    );
    trackStreamForInterrupted(
      session,
      streamEvent({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "..." } }),
    );
    expect(session.streamingAssistant?.text).toBe("");
  });

  it("ignores frames with non-object event payloads", () => {
    const session = makeSession();
    trackStreamForInterrupted(session, streamEvent(null));
    trackStreamForInterrupted(session, streamEvent("not an object"));
    trackStreamForInterrupted(session, streamEvent(42));
    expect(session.streamingAssistant).toBeNull();
  });
});

// ─── synthesiseInterruptedMessage ─────────────────────────────────────────

describe("synthesiseInterruptedMessage", () => {
  it("returns null when no tracker is set", () => {
    const session = makeSession();
    expect(synthesiseInterruptedMessage(session)).toBeNull();
  });

  it("returns null when the tracker has no accumulated text", () => {
    // A `message_start` followed by an immediate disconnect produces no
    // partial reply worth surfacing — synthesising an empty bubble would
    // be a worse UX than dropping it.
    const session = makeSession({
      streamingAssistant: {
        id: "msg-empty",
        text: "",
        parentToolUseId: null,
        model: "claude",
        startedAt: 1,
      },
    });
    expect(synthesiseInterruptedMessage(session)).toBeNull();
  });

  it("builds a complete BrowserIncomingMessage with streamStatus: interrupted", () => {
    const session = makeSession({
      streamingAssistant: {
        id: "msg-mid",
        text: "Let me check the auth middleware. The current shape",
        parentToolUseId: "tool-7",
        model: "claude-sonnet-4-6",
        startedAt: 1700_000_000_000,
      },
    });
    const synth = synthesiseInterruptedMessage(session, 1700_000_005_000);
    expect(synth).not.toBeNull();
    if (!synth || synth.type !== "assistant") throw new Error("expected assistant frame");

    expect(synth.streamStatus).toBe("interrupted");
    expect(synth.message.id).toBe("msg-mid");
    expect(synth.message.role).toBe("assistant");
    expect(synth.message.model).toBe("claude-sonnet-4-6");
    expect(synth.message.content).toEqual([
      { type: "text", text: "Let me check the auth middleware. The current shape" },
    ]);
    expect(synth.message.stop_reason).toBeNull();
    expect(synth.parent_tool_use_id).toBe("tool-7");
    expect(synth.timestamp).toBe(1700_000_005_000);
  });

  it("does not mutate session.streamingAssistant — caller owns the clear", () => {
    // Intentional separation of concerns: the bridge calls this from
    // multiple paths (immediate disconnect + debounced disconnect-confirmed
    // + future SIGTERM). The clear belongs to the bridge so each call site
    // can decide what to do with the synthesised frame.
    const session = makeSession({
      streamingAssistant: {
        id: "msg-3",
        text: "still typing",
        parentToolUseId: null,
        startedAt: 1,
      },
    });
    synthesiseInterruptedMessage(session);
    expect(session.streamingAssistant).not.toBeNull();
    expect(session.streamingAssistant?.text).toBe("still typing");
  });

  it("falls back to empty-string model when the message_start carried none", () => {
    // Defensive: the wire shape allows model to be missing on
    // message_start in some test fixtures. The CLI ought to always send
    // it, but we don't want a stray undefined to crash the persisted shape.
    const session = makeSession({
      streamingAssistant: {
        id: "msg-no-model",
        text: "partial",
        parentToolUseId: null,
        startedAt: 1,
      },
    });
    const synth = synthesiseInterruptedMessage(session);
    if (!synth || synth.type !== "assistant") throw new Error("expected assistant frame");
    expect(synth.message.model).toBe("");
  });
});

// ─── End-to-end algorithmic flow ──────────────────────────────────────────

describe("stream tracker lifecycle", () => {
  it("synthesises an interrupted bubble after partial text + simulated disconnect", () => {
    const session = makeSession();
    trackStreamForInterrupted(
      session,
      streamEvent({ type: "message_start", message: { id: "msg-99", model: "claude" } }),
    );
    trackStreamForInterrupted(
      session,
      streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "I will" } }),
    );
    trackStreamForInterrupted(
      session,
      streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text: " refactor" } }),
    );
    // Simulated CLI disconnect — bridge calls synthesise then clears.
    const synth = synthesiseInterruptedMessage(session);
    session.streamingAssistant = null;

    if (!synth || synth.type !== "assistant") throw new Error("expected assistant frame");
    expect(synth.streamStatus).toBe("interrupted");
    expect(synth.message.id).toBe("msg-99");
    expect(synth.message.content).toEqual([{ type: "text", text: "I will refactor" }]);
    expect(session.streamingAssistant).toBeNull();
  });

  it("clears tracker idempotently on second flush", () => {
    const session = makeSession({
      streamingAssistant: {
        id: "msg-x",
        text: "anything",
        parentToolUseId: null,
        startedAt: 1,
      },
    });
    synthesiseInterruptedMessage(session);
    session.streamingAssistant = null;
    // Second flush — no tracker, no synth.
    expect(synthesiseInterruptedMessage(session)).toBeNull();
  });
});
