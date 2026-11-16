import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WsBridge, type CredentialDeliveryGate, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { companionBus } from "./event-bus.js";
import type { TurnFailure } from "./auth-status/auth-types.js";

/**
 * LLM auth task 13 — the bridge side of the credential renewal gate. The
 * renewal logic lives in `credential-renewal.ts`; here a fake gate pins what
 * the bridge does with its answers:
 *  - every `user_message` sender (browser, Retry, injected council/cron/
 *    auto-resume) is asked at the ONE point; held → queued, visible in the
 *    chat, NOT sent to the old process, phase not moved to streaming;
 *  - while held, no flush path delivers the queue to the old process, but a
 *    control frame (interrupt) still reaches the running CLI;
 *  - release delivers the held input once; a failed relaunch drops it to a
 *    "turn needs to be repeated" card (history-backed), nothing re-sent;
 *  - council wakes are answered `busy` (newest-wins queue), not sent;
 *  - a sign-in failure is re-tagged by the gate.
 */

function socket(data: SocketData) {
  return { data, send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

let bridge: WsBridge;
let tempDir: string;
let store: SessionStore;
let holding: Set<string>;
let asked: string[];

function gate(): CredentialDeliveryGate {
  return {
    holdUserMessage: (id) => {
      asked.push(id);
      return holding.has(id);
    },
    isHolding: (id) => holding.has(id),
    adjustTurnFailure: (_id, f) => (f.kind === "auth_rejected" ? { kind: "stale_session_credentials", provider: f.provider, providerMessage: f.providerMessage } : f),
  };
}

function attach(sessionId: string) {
  const browser = socket({ kind: "browser", sessionId });
  bridge.handleBrowserOpen(browser, sessionId);
  let emit: ((msg: any) => void) | undefined;
  let meta: ((m: any) => void) | undefined;
  const send = vi.fn(() => true);
  const wake = vi.fn(() => ({ kind: "sent" as const }));
  const adapter = {
    isConnected: () => true,
    send,
    disconnect: async () => {},
    onBrowserMessage: (cb: (msg: any) => void) => {
      emit = cb;
    },
    onSessionMeta: (cb: (m: any) => void) => {
      meta = cb;
    },
    onDisconnect: () => {},
    onInitError: () => {},
    sendUserFrameFromServer: wake,
  };
  bridge.attachBackendAdapter(sessionId, adapter as any, "codex");
  send.mockClear();
  return { browser, send, wake, emit: (msg: any) => emit?.(msg), meta: (m: any) => meta?.(m), session: bridge.getSession(sessionId)! };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bridge-gate-"));
  store = new SessionStore(tempDir);
  bridge = new WsBridge();
  bridge.setStore(store);
  companionBus.clear();
  holding = new Set();
  asked = [];
  bridge.setCredentialGate(gate());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  store.dispose();
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

afterAll(() => {
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  console.error = noop;
});

const userTypes = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([m]: any[]) => m.type);

describe("WsBridge credential gate", () => {
  it("passes user messages through when the gate does not hold", () => {
    const s = attach("g1");
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "user_message", content: "hi" }));
    expect(asked).toEqual(["g1"]);
    expect(userTypes(s.send)).toEqual(["user_message"]);
  });

  it("holds a browser message: queued, in the chat history, not sent, phase not streaming", () => {
    const s = attach("g2");
    holding.add("g2");
    const phaseBefore = s.session.stateMachine.phase;
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "user_message", content: "while renewing" }));
    expect(s.send).not.toHaveBeenCalled();
    expect(s.session.pendingMessages).toHaveLength(1);
    expect(s.session.messageHistory.some((m: any) => m.type === "user_message" && m.content === "while renewing")).toBe(true);
    expect(s.session.stateMachine.phase).toBe(phaseBefore);
  });

  it("holds injected messages too (council peer / cron / auto-resume go through the same point)", () => {
    const s = attach("g3");
    holding.add("g3");
    bridge.injectUserMessage("g3", "wake up", "council:peer");
    bridge.injectUserMessage("g3", "cron prompt", "server:cron");
    bridge.injectUserMessage("g3", "continue", "server:auto-resume");
    expect(s.send).not.toHaveBeenCalled();
    expect(s.session.pendingMessages).toHaveLength(3);
  });

  it("while holding, an interrupt reaches the running CLI directly and does NOT flush the held message to it", () => {
    const s = attach("g4");
    holding.add("g4");
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "user_message", content: "held" }));
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "interrupt" }));
    expect(userTypes(s.send)).toEqual(["interrupt"]);
    expect(s.session.pendingMessages).toHaveLength(1);
  });

  it("no adapter-driven flush (session meta) delivers held input to the old process", () => {
    const s = attach("g4b");
    holding.add("g4b");
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "user_message", content: "held" }));
    s.meta({ cliSessionId: "thr-x", model: "gpt-x", cwd: "/test" });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.session.pendingMessages).toHaveLength(1);
  });

  it("release delivers the held input exactly once", () => {
    const s = attach("g5");
    holding.add("g5");
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "user_message", content: "once" }));
    holding.delete("g5");
    bridge.releaseHeldMessages("g5");
    bridge.releaseHeldMessages("g5");
    expect(userTypes(s.send)).toEqual(["user_message"]);
    expect(s.session.pendingMessages).toHaveLength(0);
  });

  // Council review dahl #1: a renewal releases the held message right after
  // the relaunch, while the new CLI is still starting/initializing (Claude
  // sends system.init only after its first input). The turn must show as
  // `streaming`, and the later system.init must not demote it to `ready`.
  it("a message released into a relaunching CLI starts the turn, and system.init keeps it streaming", () => {
    const s = attach("g5b");
    holding.add("g5b");
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "user_message", content: "continue" }));
    // The renewal relaunch: the old process is gone, the new one is initializing.
    s.session.stateMachine.transition("terminated", "test_relaunch");
    s.session.stateMachine.transition("starting", "test_relaunch");
    s.session.stateMachine.transition("initializing", "test_relaunch");
    holding.delete("g5b");

    bridge.releaseHeldMessages("g5b");
    expect(userTypes(s.send)).toEqual(["user_message"]);
    expect(s.session.stateMachine.phase).toBe("streaming");

    s.emit({ type: "session_init", session: { session_id: "cli-x", model: "m", cwd: "/w" } });
    expect(s.session.stateMachine.phase).toBe("streaming");
  });

  it("a failed renewal drops held user messages into a history-backed 'repeat this turn' card", () => {
    const s = attach("g6");
    holding.add("g6");
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "user_message", content: "lost?" }));
    holding.delete("g6");
    const failure: TurnFailure = { kind: "stale_session_credentials", provider: "codex", providerMessage: "Reconnecting with the new sign-in failed: x" };
    bridge.failHeldMessages("g6", failure);
    expect(s.session.pendingMessages).toHaveLength(0);
    expect(s.send).not.toHaveBeenCalled();
    const last = s.session.messageHistory.at(-1) as any;
    expect(last).toMatchObject({ type: "error", turnFailure: failure });
    expect(typeof last.timestamp).toBe("number");
    // The user's message is still in the chat — Retry re-sends it on click.
    expect(s.session.messageHistory.some((m: any) => m.type === "user_message" && m.content === "lost?")).toBe(true);
    expect(bridge.hasPendingSignInRetry("g6")).toBe(true);
  });

  it("answers a council wake `busy` while holding (queued newest-wins, not sent to the old process)", () => {
    const s = attach("g7");
    holding.add("g7");
    expect(bridge.sendObserverWakeFrame("g7", "checkpoint")).toEqual({ kind: "busy" });
    expect(s.wake).not.toHaveBeenCalled();
    holding.delete("g7");
    expect(bridge.sendObserverWakeFrame("g7", "checkpoint")).toEqual({ kind: "sent" });
  });

  it("re-tags a sign-in failure frame through the gate before it is stored", () => {
    const s = attach("g8");
    s.emit({ type: "error", message: "x", turnFailure: { kind: "auth_rejected", provider: "codex", providerMessage: "401", credentialsCompared: true } });
    const last = s.session.messageHistory.at(-1) as any;
    expect(last.turnFailure.kind).toBe("stale_session_credentials");
  });

  it("publishes the renewal record to the session state (replayed in session_init)", () => {
    const s = attach("g9");
    bridge.publishCredentialRenewal("g9", { provider: "codex", promotedAt: 42, state: "reconnecting" });
    expect(s.session.state.credential_renewal).toEqual({ provider: "codex", promotedAt: 42, state: "reconnecting" });
    const frames = s.browser.send.mock.calls.map(([raw]: any[]) => JSON.parse(raw));
    expect(frames.some((f: any) => f.type === "session_update" && f.session.credential_renewal?.state === "reconnecting")).toBe(true);
  });
});
