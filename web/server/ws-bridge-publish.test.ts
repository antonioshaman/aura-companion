import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  broadcastToBrowsers,
  sendToBrowser,
  EVENT_BUFFER_LIMIT,
} from "./ws-bridge-publish.js";
import type { Session, SocketData } from "./ws-bridge-types.js";
import type { BrowserIncomingMessage } from "./session-types.js";
import { SessionStateMachine } from "./session-state-machine.js";
import type { ServerWebSocket } from "bun";

function makeMockSocket(sessionId = "test-session") {
  return {
    data: { kind: "browser", sessionId } as SocketData,
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as unknown as ServerWebSocket<SocketData>;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session",
    backendType: "claude",
    backendAdapter: null,
    browserSockets: new Set(),
    state: {
      session_id: "test-session",
      model: "claude-sonnet-4-6",
      cwd: "/test",
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
    stateMachine: new SessionStateMachine("test-session"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── broadcastToBrowsers ──────────────────────────────────────────────────────

describe("broadcastToBrowsers", () => {
  it("sends message to all connected browser sockets", () => {
    const ws1 = makeMockSocket();
    const ws2 = makeMockSocket();
    const session = makeSession();
    session.browserSockets.add(ws1);
    session.browserSockets.add(ws2);

    const msg: BrowserIncomingMessage = { type: "cli_connected" };
    broadcastToBrowsers(session, msg, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: null,
      persistFn: vi.fn(),
    });

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);

    // Both should receive the same JSON
    const sent1 = (ws1.send as any).mock.calls[0][0];
    const sent2 = (ws2.send as any).mock.calls[0][0];
    expect(sent1).toBe(sent2);
  });

  it("removes broken sockets that throw on send", () => {
    const goodWs = makeMockSocket();
    const badWs = makeMockSocket();
    (badWs.send as any).mockImplementation(() => { throw new Error("broken"); });

    const session = makeSession();
    session.browserSockets.add(goodWs);
    session.browserSockets.add(badWs);

    broadcastToBrowsers(session, { type: "cli_connected" }, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: null,
      persistFn: vi.fn(),
    });

    // Good socket still connected, bad one removed
    expect(session.browserSockets.has(goodWs)).toBe(true);
    expect(session.browserSockets.has(badWs)).toBe(false);
  });

  it("assigns monotonically increasing seq numbers", () => {
    const ws = makeMockSocket();
    const session = makeSession();
    session.browserSockets.add(ws);

    const opts = {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: null,
      persistFn: vi.fn(),
    };

    // Send 3 messages
    broadcastToBrowsers(session, { type: "cli_connected" }, opts);
    broadcastToBrowsers(session, { type: "cli_disconnected" }, opts);
    broadcastToBrowsers(session, { type: "cli_connected" }, opts);

    const seqs = (ws.send as any).mock.calls.map((call: any) => {
      const parsed = JSON.parse(call[0]);
      return parsed.seq;
    });

    // seq numbers should be strictly increasing
    expect(seqs[0]).toBeLessThan(seqs[1]);
    expect(seqs[1]).toBeLessThan(seqs[2]);
  });

  it("calls recorder.record when recorder is provided", () => {
    const ws = makeMockSocket();
    const session = makeSession();
    session.browserSockets.add(ws);

    const recorder = {
      record: vi.fn(),
    };

    broadcastToBrowsers(session, { type: "cli_connected" }, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: recorder as any,
      persistFn: vi.fn(),
    });

    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith(
      "test-session", "out", expect.any(String), "browser", "claude", "/test",
    );
  });

  it("logs warning when broadcasting to 0 browsers for assistant/stream_event/result", () => {
    const session = makeSession(); // no browser sockets
    const logSpy = vi.mocked(console.log);

    broadcastToBrowsers(session, { type: "assistant", message: {} as any, parent_tool_use_id: null, timestamp: 1 }, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: null,
      persistFn: vi.fn(),
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Broadcasting assistant to 0 browsers"),
    );
  });

  it("does not warn for non-critical message types with 0 browsers", () => {
    const session = makeSession();
    const logSpy = vi.mocked(console.log);
    logSpy.mockClear();

    broadcastToBrowsers(session, { type: "cli_connected" }, {
      eventBufferLimit: EVENT_BUFFER_LIMIT,
      recorder: null,
      persistFn: vi.fn(),
    });

    // Should not have the "Broadcasting ... to 0 browsers" warning
    const warningCalls = logSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("0 browsers"),
    );
    expect(warningCalls).toHaveLength(0);
  });
});

// ─── Council wire variants — seq coverage ────────────────────────────────────
//
// PLAN-aura-consolidated-refactor.md Task 1 acceptance criterion (promoted
// from Risks v2 → Task 1 v2 patch): every `group_*` and `observer_review`
// emit MUST pass through the same `sequenceEvent` + `eventBuffer` path as
// `assistant`/`stream_event`, so reconnect-replay (`session_subscribe
// { last_seq }`) covers them. Monotonic seq is necessary but NOT sufficient
// per v3 NOTE — must also verify the seq originates from the shared
// `nextEventSeq` counter (not from an independent counter that happens to
// be monotonic too).
//
// The shared-counter assertion is structural: `sequenceEvent` reads + bumps
// `session.nextEventSeq`; we verify each broadcast bumps it by exactly 1
// and the emitted msg's `seq` equals the pre-bump value.
describe("broadcastToBrowsers — council wire variants seq coverage", () => {
  const councilWireFixtures: BrowserIncomingMessage[] = [
    {
      type: "group_created",
      sessionGroupId: "grp_t1",
      primarySessionId: "sess_orch",
      observerSessionId: "sess_obs",
      pairing: "claude+claude",
    },
    {
      type: "group_exited",
      sessionGroupId: "grp_t1",
      reason: "user_archived",
    },
    {
      type: "group_degraded",
      sessionGroupId: "grp_t1",
      deadRole: "observer",
    },
    {
      type: "group_reconnecting",
      sessionGroupId: "grp_t1",
      survivingRole: "orchestrator",
      deadlineMs: Date.now() + 45_000,
    },
    {
      type: "group_checkpoint",
      sessionGroupId: "grp_t1",
      checkpointId: "chk_1",
      phase: "council-plan",
      sequence: 0,
      timestamp: Date.now(),
    },
    {
      type: "observer_review",
      sessionGroupId: "grp_t1",
      checkpointId: "chk_1",
      phase: "council-plan",
      findings: [],
      downgrades: [],
      observerModel: "claude-opus-4-7",
      observerProvider: "claude",
      timestamp: Date.now(),
    },
  ];

  it.each(councilWireFixtures.map((m) => [m.type, m] as const))(
    "%s carries a `seq` field originating from session.nextEventSeq AND lands in eventBuffer for reconnect-replay",
    (_type, msg) => {
      const ws = makeMockSocket();
      const session = makeSession();
      session.browserSockets.add(ws);

      const startingSeq = session.nextEventSeq;
      const startingBufferLen = session.eventBuffer.length;
      broadcastToBrowsers(session, msg, {
        eventBufferLimit: EVENT_BUFFER_LIMIT,
        recorder: null,
        persistFn: vi.fn(),
      });

      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse((ws.send as any).mock.calls[0][0]);
      // The emitted seq must equal the pre-broadcast value of nextEventSeq
      // (sequenceEvent reads then post-increments). Any other source would
      // produce a different value — this is the shared-counter assertion.
      expect(sent.seq).toBe(startingSeq);
      // And the counter must have advanced by exactly 1.
      expect(session.nextEventSeq).toBe(startingSeq + 1);
      // eventBuffer half of the v2 acceptance criterion: every council frame
      // MUST also land in the replay buffer, otherwise reconnect via
      // `session_subscribe { last_seq }` silently drops council frames even
      // though `nextEventSeq` advanced. A regression that bumps the counter
      // but skips the buffer write (e.g. a type-gated `if (msg.type === "assistant")`
      // around eventBuffer.push) would pass every seq assertion above.
      expect(session.eventBuffer).toHaveLength(startingBufferLen + 1);
      expect(session.eventBuffer[session.eventBuffer.length - 1]?.seq).toBe(startingSeq);
      expect(session.eventBuffer[session.eventBuffer.length - 1]?.message).toEqual(msg);
    },
  );

  it("all six council variants share the same monotonic seq counter AND populate eventBuffer contiguously", () => {
    const ws = makeMockSocket();
    const session = makeSession();
    session.browserSockets.add(ws);

    const startingSeq = session.nextEventSeq;
    for (const msg of councilWireFixtures) {
      broadcastToBrowsers(session, msg, {
        eventBufferLimit: EVENT_BUFFER_LIMIT,
        recorder: null,
        persistFn: vi.fn(),
      });
    }

    // Every call.send received exactly one frame; collect their seqs.
    const seqs = (ws.send as any).mock.calls.map((call: any) => JSON.parse(call[0]).seq);
    expect(seqs).toHaveLength(councilWireFixtures.length);
    // Seqs are strictly monotonic AND contiguous starting from startingSeq —
    // contiguous-from-counter is the "shared sequenceEvent path" proof:
    // a parallel counter or fresh start would break contiguity.
    for (let i = 0; i < seqs.length; i++) {
      expect(seqs[i]).toBe(startingSeq + i);
    }
    expect(session.nextEventSeq).toBe(startingSeq + councilWireFixtures.length);
    // The eventBuffer must mirror the wire-frame sequence one-for-one.
    // This is the load-bearing reconnect-replay invariant: a browser
    // reconnecting with `last_seq < startingSeq` MUST receive every
    // council frame in order.
    expect(session.eventBuffer).toHaveLength(councilWireFixtures.length);
    const bufferedSeqs = session.eventBuffer.map((entry) => entry.seq);
    expect(bufferedSeqs).toEqual(seqs);
    const bufferedTypes = session.eventBuffer.map((entry) => entry.message.type);
    expect(bufferedTypes).toEqual(councilWireFixtures.map((m) => m.type));
  });
});

// ─── sendToBrowser ────────────────────────────────────────────────────────────

describe("sendToBrowser", () => {
  it("sends JSON-serialized message to socket", () => {
    const ws = makeMockSocket();
    const msg: BrowserIncomingMessage = { type: "cli_connected" };

    sendToBrowser(ws, msg);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((ws.send as any).mock.calls[0][0]);
    expect(sent.type).toBe("cli_connected");
  });

  it("does not throw when socket.send fails", () => {
    const ws = makeMockSocket();
    (ws.send as any).mockImplementation(() => { throw new Error("broken"); });

    // Should not throw
    expect(() => sendToBrowser(ws, { type: "cli_connected" })).not.toThrow();
  });
});

// ─── EVENT_BUFFER_LIMIT ───────────────────────────────────────────────────────

describe("EVENT_BUFFER_LIMIT", () => {
  it("is 600", () => {
    expect(EVENT_BUFFER_LIMIT).toBe(600);
  });
});
