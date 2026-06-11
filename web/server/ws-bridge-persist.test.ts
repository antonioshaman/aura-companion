import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  appendAndPersist,
  appendHistory,
  persistSession,
  serializeForStore,
  trimArchivedSessionState,
  MESSAGE_HISTORY_LIMIT,
  ARCHIVED_HISTORY_RETENTION,
} from "./ws-bridge-persist.js";
import type { Session } from "./ws-bridge-types.js";
import type { BrowserIncomingMessage } from "./session-types.js";
import { SessionStateMachine } from "./session-state-machine.js";
import { SessionStore } from "./session-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

function makeAssistantMsg(id: string): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: { id, type: "message", role: "assistant", model: "claude", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    parent_tool_use_id: null,
    timestamp: Date.now(),
  };
}

// ─── appendHistory ────────────────────────────────────────────────────────────

describe("appendHistory", () => {
  it("appends message to session history", () => {
    const session = makeSession();
    const msg = makeAssistantMsg("m1");
    appendHistory(session, msg);

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toBe(msg);
  });

  it("appends multiple messages in order", () => {
    const session = makeSession();
    const msg1 = makeAssistantMsg("m1");
    const msg2 = makeAssistantMsg("m2");
    const msg3 = makeAssistantMsg("m3");

    appendHistory(session, msg1);
    appendHistory(session, msg2);
    appendHistory(session, msg3);

    expect(session.messageHistory).toHaveLength(3);
    // Verify ordering is preserved
    expect((session.messageHistory[0] as any).message.id).toBe("m1");
    expect((session.messageHistory[1] as any).message.id).toBe("m2");
    expect((session.messageHistory[2] as any).message.id).toBe("m3");
  });

  it("trims oldest messages when history exceeds limit", () => {
    const session = makeSession();
    const limit = 5;

    // Add 7 messages with limit of 5
    for (let i = 0; i < 7; i++) {
      appendHistory(session, makeAssistantMsg(`m${i}`), limit);
    }

    expect(session.messageHistory).toHaveLength(5);
    // Oldest 2 (m0, m1) should be trimmed; m2-m6 remain
    expect((session.messageHistory[0] as any).message.id).toBe("m2");
    expect((session.messageHistory[4] as any).message.id).toBe("m6");
  });

  it("uses MESSAGE_HISTORY_LIMIT as default", () => {
    expect(MESSAGE_HISTORY_LIMIT).toBe(2000);
  });
});

// ─── persistSession ───────────────────────────────────────────────────────────

describe("persistSession", () => {
  let tempDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "persist-test-"));
    store = new SessionStore(tempDir);
    // Suppress console output
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    store.dispose();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("calls store.save with serialized session data", () => {
    const session = makeSession();
    const saveSpy = vi.spyOn(store, "save");

    persistSession(session, store);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const saved = saveSpy.mock.calls[0][0];
    expect(saved.id).toBe("test-session");
    expect(saved.state).toBe(session.state);
    expect(saved.messageHistory).toBe(session.messageHistory);
  });

  it("is a no-op when store is null", () => {
    const session = makeSession();
    // Should not throw
    expect(() => persistSession(session, null)).not.toThrow();
  });
});

// ─── appendAndPersist ─────────────────────────────────────────────────────────

describe("appendAndPersist", () => {
  let tempDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "persist-test-"));
    store = new SessionStore(tempDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    store.dispose();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("appends message to history AND calls store.save", () => {
    const session = makeSession();
    const msg = makeAssistantMsg("m1");
    const saveSpy = vi.spyOn(store, "save");

    appendAndPersist(session, msg, store);

    expect(session.messageHistory).toHaveLength(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("enforces history cap while persisting", () => {
    const session = makeSession();
    const limit = 3;

    for (let i = 0; i < 5; i++) {
      appendAndPersist(session, makeAssistantMsg(`m${i}`), store, limit);
    }

    expect(session.messageHistory).toHaveLength(3);
    expect((session.messageHistory[0] as any).message.id).toBe("m2");
  });

  it("works with null store (append only)", () => {
    const session = makeSession();
    const msg = makeAssistantMsg("m1");

    appendAndPersist(session, msg, null);

    expect(session.messageHistory).toHaveLength(1);
  });
});

// ─── serializeForStore ────────────────────────────────────────────────────────

describe("serializeForStore", () => {
  it("converts pendingPermissions Map to array of entries", () => {
    const session = makeSession();
    session.pendingPermissions.set("req-1", {
      request_id: "req-1",
      tool_name: "Bash",
      input: { command: "ls" },
      timestamp: 1000,
    } as any);
    session.pendingPermissions.set("req-2", {
      request_id: "req-2",
      tool_name: "Read",
      input: { file_path: "/test" },
      timestamp: 2000,
    } as any);

    const serialized = serializeForStore(session);

    expect(serialized.pendingPermissions).toHaveLength(2);
    expect(serialized.pendingPermissions[0][0]).toBe("req-1");
    expect(serialized.pendingPermissions[0][1].tool_name).toBe("Bash");
    expect(serialized.pendingPermissions[1][0]).toBe("req-2");
    expect(serialized.pendingPermissions[1][1].tool_name).toBe("Read");
  });

  it("includes eventBuffer and sequence counters", () => {
    const session = makeSession({
      eventBuffer: [{ seq: 1, message: { type: "cli_connected" } }],
      nextEventSeq: 42,
      lastAckSeq: 10,
    });

    const serialized = serializeForStore(session);

    expect(serialized.eventBuffer).toHaveLength(1);
    expect(serialized.nextEventSeq).toBe(42);
    expect(serialized.lastAckSeq).toBe(10);
  });

  it("includes processedClientMessageIds for browser dedup restoration", () => {
    const session = makeSession({
      processedClientMessageIds: ["id-1", "id-2", "id-3"],
    });

    const serialized = serializeForStore(session);
    expect(serialized.processedClientMessageIds).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("preserves message ordering through serialization", () => {
    const session = makeSession();
    for (let i = 0; i < 5; i++) {
      session.messageHistory.push(makeAssistantMsg(`m${i}`));
    }

    const serialized = serializeForStore(session);
    const parsed = JSON.parse(JSON.stringify(serialized));

    // Message ordering should survive JSON round-trip
    for (let i = 0; i < 5; i++) {
      expect(parsed.messageHistory[i].message.id).toBe(`m${i}`);
    }
  });

  it("produces identical output for same session state (idempotent)", () => {
    const session = makeSession();
    session.messageHistory.push(makeAssistantMsg("m1"));
    session.pendingPermissions.set("req-1", {
      request_id: "req-1",
      tool_name: "Bash",
      input: {},
      timestamp: 1000,
    } as any);

    const first = JSON.stringify(serializeForStore(session));
    const second = JSON.stringify(serializeForStore(session));

    expect(first).toBe(second);
  });
});

// ─── trimArchivedSessionState ─────────────────────────────────────────────────

describe("trimArchivedSessionState", () => {
  it("trims messageHistory to the last ARCHIVED_HISTORY_RETENTION entries", () => {
    const session = makeSession();
    // Simulate the upper bound: a session that hit MESSAGE_HISTORY_LIMIT
    // while active, now being archived.
    for (let i = 0; i < MESSAGE_HISTORY_LIMIT; i++) {
      session.messageHistory.push(makeAssistantMsg(`m${i}`));
    }
    expect(session.messageHistory).toHaveLength(MESSAGE_HISTORY_LIMIT);

    trimArchivedSessionState(session);

    expect(session.messageHistory).toHaveLength(ARCHIVED_HISTORY_RETENTION);
    // Retained slice is the tail — most recent context survives for unarchive.
    const firstRetainedIdx = MESSAGE_HISTORY_LIMIT - ARCHIVED_HISTORY_RETENTION;
    expect((session.messageHistory[0] as any).message.id).toBe(`m${firstRetainedIdx}`);
    expect((session.messageHistory[ARCHIVED_HISTORY_RETENTION - 1] as any).message.id).toBe(
      `m${MESSAGE_HISTORY_LIMIT - 1}`,
    );
  });

  it("leaves messageHistory untouched when already under retention", () => {
    const session = makeSession();
    for (let i = 0; i < 5; i++) {
      session.messageHistory.push(makeAssistantMsg(`m${i}`));
    }

    trimArchivedSessionState(session);

    expect(session.messageHistory).toHaveLength(5);
    expect((session.messageHistory[0] as any).message.id).toBe("m0");
  });

  it("clears eventBuffer entirely (transient resync buffer is zero-value once archived)", () => {
    const session = makeSession({
      eventBuffer: [
        { seq: 1, message: { type: "cli_connected" } },
        { seq: 2, message: { type: "cli_disconnected" } },
      ],
    });

    trimArchivedSessionState(session);

    expect(session.eventBuffer).toEqual([]);
  });

  it("is idempotent — second call on an already-trimmed session is a no-op", () => {
    const session = makeSession();
    for (let i = 0; i < MESSAGE_HISTORY_LIMIT; i++) {
      session.messageHistory.push(makeAssistantMsg(`m${i}`));
    }

    trimArchivedSessionState(session);
    const afterFirst = session.messageHistory.length;
    trimArchivedSessionState(session);
    const afterSecond = session.messageHistory.length;

    expect(afterFirst).toBe(ARCHIVED_HISTORY_RETENTION);
    expect(afterSecond).toBe(ARCHIVED_HISTORY_RETENTION);
  });

  it("accepts a custom retention bound", () => {
    const session = makeSession();
    for (let i = 0; i < 50; i++) {
      session.messageHistory.push(makeAssistantMsg(`m${i}`));
    }

    trimArchivedSessionState(session, 10);

    expect(session.messageHistory).toHaveLength(10);
    expect((session.messageHistory[0] as any).message.id).toBe("m40");
  });

  it("sets the runtime archived flag (single chokepoint for live-archive + restore-of-archived)", () => {
    // The bridge reads session.archived on the hot path (handleBrowserOpen /
    // deriveGroupCreatedForBrowser) to suppress ghost-group resurrection. This
    // function is the ONE place both archive paths converge, so it must stamp
    // the flag regardless of how much history there is to trim.
    const session = makeSession();
    expect(session.archived).toBeUndefined();

    trimArchivedSessionState(session);

    expect(session.archived).toBe(true);
  });

  it("exports ARCHIVED_HISTORY_RETENTION constant", () => {
    expect(ARCHIVED_HISTORY_RETENTION).toBe(100);
    // Lower bound assertion — keep the retention well below MESSAGE_HISTORY_LIMIT
    // so the eviction has meaningful effect.
    expect(ARCHIVED_HISTORY_RETENTION).toBeLessThan(MESSAGE_HISTORY_LIMIT);
  });
});
