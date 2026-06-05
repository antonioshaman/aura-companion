import { describe, expect, it } from "vitest";
import { selectDrainTargets, shouldSuppressDrain } from "./drain-selector.js";
import type { Session } from "../ws-bridge-types.js";
import { makeDefaultState } from "../ws-bridge-types.js";
import { SessionStateMachine } from "../session-state-machine.js";

// Build a minimal Session shim suitable for the pure selector tests
// — only the fields the selector reads need to be populated. The
// wider Session shape lives in ws-bridge-types.ts and carries
// backend-adapter / state-machine plumbing the selector ignores.
function makeSession(opts: {
  id?: string;
  pendingMessages?: string[];
  browserCount?: number;
}): Session {
  const sessionId = opts.id ?? "sess_test";
  const browsers = new Set<never>();
  for (let i = 0; i < (opts.browserCount ?? 0); i++) {
    browsers.add({} as never);
  }
  return {
    id: sessionId,
    backendType: "claude",
    backendAdapter: null,
    browserSockets: browsers as unknown as Session["browserSockets"],
    state: makeDefaultState(sessionId, "claude"),
    pendingPermissions: new Map(),
    messageHistory: [],
    pendingMessages: opts.pendingMessages ?? [],
    nextEventSeq: 1,
    eventBuffer: [],
    lastAckSeq: 0,
    processedClientMessageIds: [],
    processedClientMessageIdSet: new Set(),
    lastCliActivityTs: 0,
    stateMachine: new SessionStateMachine(sessionId),
  } as Session;
}

describe("selectDrainTargets — pure selector", () => {
  it("carries pendingMessages.length into wrapper.pendingCount and frame.drainedCount", () => {
    const session = makeSession({
      pendingMessages: ["a", "b", "c"],
      browserCount: 2,
    });
    const sel = selectDrainTargets(session, "relaunch_exhausted", 42, 12345);
    expect(sel.pendingCount).toBe(3);
    expect(sel.frame.drainedCount).toBe(3);
    expect(sel.frame.seq).toBe(42);
    expect(sel.frame.firedAt).toBe(12345);
    expect(sel.frame.reason).toBe("relaunch_exhausted");
    expect(sel.frame.subprocessAlive).toBe(false);
  });

  it("produces one browserId placeholder per browser socket", () => {
    const session = makeSession({ browserCount: 3 });
    const sel = selectDrainTargets(session, "binary_missing", 1, 0);
    expect(sel.browserIds).toHaveLength(3);
  });

  it("does not mutate the session (pendingMessages / nextEventSeq / browserSockets preserved)", () => {
    const pending = ["m1", "m2"];
    const session = makeSession({ pendingMessages: pending, browserCount: 1 });
    const seqBefore = session.nextEventSeq;
    const pendingLenBefore = session.pendingMessages.length;
    const browsersSizeBefore = session.browserSockets.size;
    selectDrainTargets(session, "container_missing", 9, 100);
    expect(session.nextEventSeq).toBe(seqBefore);
    expect(session.pendingMessages.length).toBe(pendingLenBefore);
    expect(session.browserSockets.size).toBe(browsersSizeBefore);
    expect(session.pendingMessages).toBe(pending);
  });

  it("sets subprocessAlive=true on browser_closed_no_reconnect", () => {
    const session = makeSession({ pendingMessages: ["x"] });
    const sel = selectDrainTargets(session, "browser_closed_no_reconnect", 1, 0);
    expect(sel.frame.subprocessAlive).toBe(true);
  });

  it("threads optional details through the frame", () => {
    const session = makeSession({});
    const sha = "b".repeat(64);
    const sel = selectDrainTargets(session, "container_stopped", 1, 0, { lastErrorSha256: sha });
    expect(sel.frame.details?.lastErrorSha256).toBe(sha);
  });
});

describe("shouldSuppressDrain — Story 2 AC suppression rule", () => {
  it("suppresses browser_closed_no_reconnect with drainedCount === 0", () => {
    expect(shouldSuppressDrain("browser_closed_no_reconnect", 0)).toBe(true);
  });

  it("fires browser_closed_no_reconnect with drainedCount > 0", () => {
    expect(shouldSuppressDrain("browser_closed_no_reconnect", 1)).toBe(false);
    expect(shouldSuppressDrain("browser_closed_no_reconnect", 200)).toBe(false);
  });

  it.each([
    "relaunch_exhausted" as const,
    "container_missing" as const,
    "container_stopped" as const,
    "binary_missing" as const,
  ])("fires %s even with drainedCount === 0 (always-fire)", (reason) => {
    expect(shouldSuppressDrain(reason, 0)).toBe(false);
  });
});
