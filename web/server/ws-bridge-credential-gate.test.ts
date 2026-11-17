import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WsBridge, type CredentialDeliveryGate, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { companionBus } from "./event-bus.js";
import type { TurnFailure } from "./auth-status/auth-types.js";
import { describeTurnFailure } from "./auth-status/auth-catalog.js";

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

  it("while holding, set_model / set_permission_mode queue behind the held message and reach the NEW process in order (dahl #6)", () => {
    // Sent straight through, they would hit the process the renewal is about to
    // stop, ahead of the held message on the wire.
    const s = attach("g4c");
    holding.add("g4c");
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "user_message", content: "held" }));
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "set_model", model: "gpt-x" }));
    bridge.handleBrowserMessage(s.browser, JSON.stringify({ type: "set_permission_mode", mode: "plan" }));
    expect(s.send).not.toHaveBeenCalled();
    expect(s.session.pendingMessages.map((raw) => JSON.parse(raw).type)).toEqual(["user_message", "set_model", "set_permission_mode"]);
    holding.delete("g4c");
    bridge.releaseHeldMessages("g4c");
    expect(userTypes(s.send)).toEqual(["user_message", "set_model", "set_permission_mode"]);
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
    // Same envelope shape as an adapter-built frame: title + provider text.
    expect(last.message).toBe(`${describeTurnFailure("stale_session_credentials", "codex").title}: Reconnecting with the new sign-in failed: x`);
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
    // dahl #3: the `message` fallback (old browsers, exports) is rebuilt from
    // the FINAL kind, so it never says "sign in again" next to a "repeat the turn" card.
    expect(last.message).toBe(`${describeTurnFailure("stale_session_credentials", "codex").title}: 401`);
  });

  it("publishes the renewal record to the session state (replayed in session_init)", () => {
    const s = attach("g9");
    bridge.publishCredentialRenewal("g9", { provider: "codex", promotedAt: 42, state: "reconnecting" });
    expect(s.session.state.credential_renewal).toEqual({ provider: "codex", promotedAt: 42, state: "reconnecting" });
    const frames = s.browser.send.mock.calls.map(([raw]: any[]) => JSON.parse(raw));
    expect(frames.some((f: any) => f.type === "session_update" && f.session.credential_renewal?.state === "reconnecting")).toBe(true);
  });
});

/**
 * beck B-3 (council review 2026-11-15): the contract "nothing reaches the old
 * process, the new process gets it once" was proven for one flush path and
 * one adapter object. Here: every flush trigger while holding (table), an
 * adapter swap, a release that arrives before the new adapter is connected,
 * and the Claude path (`handleCLIOpen`).
 */
function codexAdapter(connected = true) {
  let emit: ((msg: any) => void) | undefined;
  let meta: ((m: any) => void) | undefined;
  const state = { connected };
  const send = vi.fn(() => true);
  const adapter = {
    isConnected: () => state.connected,
    send,
    disconnect: async () => {},
    onBrowserMessage: (cb: (msg: any) => void) => { emit = cb; },
    onSessionMeta: (cb: (m: any) => void) => { meta = cb; },
    onDisconnect: () => {},
    onInitError: () => {},
    sendUserFrameFromServer: vi.fn(() => ({ kind: "sent" as const })),
  };
  return { adapter, send, state, emit: (m: any) => emit?.(m), meta: (m: any) => meta?.(m) };
}

describe("credential gate — every flush path while holding (beck B-3)", () => {
  const triggers: Array<{ name: string; fire: (id: string, a: ReturnType<typeof codexAdapter>) => void }> = [
    { name: "backend_session_meta", fire: (_id, a) => a.meta({ cliSessionId: "thr-1", model: "gpt-x", cwd: "/test" }) },
    { name: "backend_session_update", fire: (_id, a) => a.emit({ type: "session_update", session: { model: "gpt-y" } }) },
    { name: "turn_completed_flush", fire: (_id, a) => a.emit({ type: "result", data: { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, uuid: "u", session_id: "c" } }) },
    { name: "adapter_attach (a second adapter attached while holding)", fire: (id) => bridge.attachBackendAdapter(id, codexAdapter().adapter as any, "codex") },
    { name: "backend_connected_send (another browser frame arrives)", fire: (id) => bridge.handleBrowserMessage(bridge.getSession(id)!.browserSockets.values().next().value!, JSON.stringify({ type: "mcp_get_status" })) },
  ];

  for (const t of triggers) {
    it(`${t.name}: the held user_message is not sent to the running process`, () => {
      const id = `fp-${t.name.split(" ")[0]}`;
      const browser = socket({ kind: "browser", sessionId: id });
      bridge.handleBrowserOpen(browser, id);
      const a = codexAdapter();
      bridge.attachBackendAdapter(id, a.adapter as any, "codex");
      holding.add(id);
      bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "held" }));
      a.send.mockClear();
      t.fire(id, a);
      expect(userTypes(a.send).filter((x) => x === "user_message")).toEqual([]);
      expect(bridge.getSession(id)!.pendingMessages.some((raw) => JSON.parse(raw).type === "user_message")).toBe(true);
    });
  }

  it("adapter swap: the old adapter never gets the held message, the new one gets it exactly once", () => {
    const id = "swap-1";
    const browser = socket({ kind: "browser", sessionId: id });
    bridge.handleBrowserOpen(browser, id);
    const oldA = codexAdapter();
    bridge.attachBackendAdapter(id, oldA.adapter as any, "codex");
    holding.add(id);
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "held" }));
    const newA = codexAdapter();
    bridge.attachBackendAdapter(id, newA.adapter as any, "codex"); // relaunch while still holding
    holding.delete(id);
    bridge.releaseHeldMessages(id);
    bridge.releaseHeldMessages(id);
    expect(userTypes(oldA.send).filter((x) => x === "user_message")).toEqual([]);
    expect(userTypes(newA.send).filter((x) => x === "user_message")).toEqual(["user_message"]);
  });

  it("a release that arrives before the new adapter is connected is delivered once it connects", () => {
    const id = "swap-2";
    const browser = socket({ kind: "browser", sessionId: id });
    bridge.handleBrowserOpen(browser, id);
    holding.add(id);
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "held" }));
    const newA = codexAdapter(false);
    bridge.attachBackendAdapter(id, newA.adapter as any, "codex");
    holding.delete(id);
    bridge.releaseHeldMessages(id); // not connected yet → stays queued
    expect(newA.send).not.toHaveBeenCalled();
    newA.state.connected = true;
    newA.meta({ cliSessionId: "thr-2", model: "gpt-x", cwd: "/test" }); // first frame of the new process
    expect(userTypes(newA.send).filter((x) => x === "user_message")).toEqual(["user_message"]);
  });

  it("Claude: handleCLIOpen does not flush held input to the old CLI; release delivers it once", () => {
    const id = "claude-1";
    const browser = socket({ kind: "browser", sessionId: id });
    bridge.handleBrowserOpen(browser, id);
    holding.add(id);
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "held-claude" }));
    const cli = socket({ kind: "cli", sessionId: id });
    bridge.handleCLIOpen(cli, id);
    const sentLines = () => cli.send.mock.calls.map(([raw]: any[]) => String(raw)).filter((l: string) => l.includes("held-claude"));
    expect(sentLines()).toEqual([]);
    holding.delete(id);
    bridge.releaseHeldMessages(id);
    bridge.releaseHeldMessages(id);
    expect(sentLines()).toHaveLength(1);
  });
});
