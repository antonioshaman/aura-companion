import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Replay test for the reconnect / init-probe path (#200 regression, fixed in
// #335). It feeds the recorded prod frame sequence — probe → interrupt →
// CLI's interrupted probe turn → the human's next message — through the real
// WsBridge + ClaudeAdapter and asserts what reaches the CLI's stdin:
//   * the user's message goes out as its OWN `user` frame with exactly the
//     user's text (nothing prepended or merged),
//   * every probe frame written in the session carries a marker that does not
//     ask the model for silence (the CLI folds the next prompt into the probe
//     turn, so "do not respond" used to apply to the user's message),
// and that the delivery metrics flag the recorded failure reply
// ("No response requested.") but not a normal answer.
// Complements the marker-wording assertion in ws-bridge.test.ts
// ("sendInitializeKickoff") with the full recorded sequence.

// vitest runs under Node; ws-bridge uses Bun.hash for CLI frame dedup.
if (typeof globalThis.Bun === "undefined") {
  (globalThis as any).Bun = {
    hash(input: string | Uint8Array): number {
      const s = typeof input === "string" ? input : new TextDecoder().decode(input);
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      return h >>> 0;
    },
  };
}

const mockExecSync = vi.hoisted(() => vi.fn(() => { throw new Error("not a git repo"); }));
vi.mock("node:child_process", () => ({ execSync: mockExecSync }));
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({
    aiValidationEnabled: false,
    aiValidationAutoApprove: false,
    aiValidationAutoDeny: false,
    anthropicApiKey: "",
  }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WsBridge, AURA_INIT_PROBE_MARKER, AURA_INIT_PROBE_INTERRUPT_DELAY_MS } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { companionBus } from "./event-bus.js";
import { deliveryMetrics } from "./delivery-metrics.js";

interface Fixture {
  frames: { dtMs: number; dir: "out" | "in" | "browser"; raw: Record<string, unknown> }[];
  bugReply: Record<string, unknown>[];
  goodReply: Record<string, unknown>[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__/init-probe-reconnect/probe-interrupt-then-user.json"), "utf-8"),
);

/** Words that, in the probe marker, would tell the model to stay silent. */
const SILENCE_REQUEST = /do not respond|don't respond|no response|stay silent|do not reply|don't reply|не отвечай/i;

function mockSocket(data: Record<string, unknown>) {
  return { data, send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function parseSent(sock: { send: { mock: { calls: unknown[][] } } }): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const [arg] of sock.send.mock.calls) {
    for (const line of String(arg).split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* not JSON */ }
    }
  }
  return out;
}

let bridge: WsBridge;
let store: SessionStore;
let tempDir: string;

beforeEach(() => {
  vi.useFakeTimers();
  tempDir = mkdtempSync(join(tmpdir(), "probe-replay-"));
  store = new SessionStore(tempDir);
  bridge = new WsBridge();
  bridge.setStore(store);
  companionBus.clear();
  deliveryMetrics.reset({ stallThresholdMs: 60_000 });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  deliveryMetrics.reset();
  store.dispose();
  rmSync(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Replays the recorded reconnect. The `out` frames are what bun is expected
 * to write — they are produced by the bridge itself (handleCLIOpen kickoff),
 * not injected; `in` frames are fed as CLI stdout; `browser` frames are the
 * human typing. Returns the CLI socket for stdin assertions.
 */
function replayReconnect(sessionId: string) {
  const browser = mockSocket({ kind: "browser", sessionId });
  bridge.handleBrowserOpen(browser, sessionId);
  const cli = mockSocket({ kind: "cli", sessionId });
  bridge.handleCLIOpen(cli, sessionId); // kickoff → probe frame
  let clock = 0;
  for (const f of fixture.frames) {
    vi.advanceTimersByTime(f.dtMs - clock);
    clock = f.dtMs;
    if (f.dir === "in") bridge.handleCLIMessage(cli, JSON.stringify(f.raw) + "\n");
    else if (f.dir === "browser") bridge.handleBrowserMessage(browser, JSON.stringify(f.raw));
  }
  return { cli, browser };
}

describe("init-probe reconnect replay (recorded prod sequence)", () => {
  it("bun writes probe → interrupt → the user's message as its own prompt, in that order", () => {
    const { cli } = replayReconnect("s-replay");
    const stdin = parseSent(cli).filter((j) => j.type === "user" || (j.type === "control_request" && j.request?.subtype === "interrupt"));

    // Same shape as the recorded `out` frames.
    const expectedOut = fixture.frames.filter((f) => f.dir === "out").map((f) => f.raw.type);
    expect(stdin.slice(0, expectedOut.length).map((j) => j.type)).toEqual(expectedOut);
    expect(AURA_INIT_PROBE_INTERRUPT_DELAY_MS).toBeLessThanOrEqual(fixture.frames[1].dtMs);

    const probe = stdin[0];
    expect(probe.message.content).toBe(AURA_INIT_PROBE_MARKER);

    // The user's message: a separate frame, exactly the typed text, last.
    const userText = fixture.frames.find((f) => f.dir === "browser")!.raw.content;
    const userFrames = stdin.filter((j) => j.type === "user" && j.message.content !== AURA_INIT_PROBE_MARKER);
    expect(userFrames).toHaveLength(1);
    expect(userFrames[0].message.role).toBe("user");
    expect(userFrames[0].message.content).toBe(userText);
    expect(String(userFrames[0].message.content)).not.toContain("init probe");
    expect(stdin[stdin.length - 1]).toBe(userFrames[0]);
  });

  it("no probe frame written during the reconnect asks the model for silence", () => {
    const { cli } = replayReconnect("s-replay");
    const probes = parseSent(cli).filter(
      (j) => j.type === "user" && typeof j.message?.content === "string" && j.message.content.includes("init probe"),
    );
    expect(probes.length).toBeGreaterThan(0);
    for (const p of probes) {
      expect(p.message.content).not.toMatch(SILENCE_REQUEST);
      // Scoped to its own line and explicitly asks for a normal answer to
      // whatever follows — the property that survives the CLI's turn fold.
      expect(p.message.content).toMatch(/answer any user message that follows normally/i);
    }
  });

  it("delivery metrics: the recorded \"No response requested.\" reply to the user is flagged", () => {
    const { cli } = replayReconnect("s-bug");
    for (const f of fixture.bugReply) bridge.handleCLIMessage(cli, JSON.stringify(f) + "\n");
    const snap = deliveryMetrics.getSnapshot();
    expect(snap.sessions["s-bug"].noResponseRequestedReplies).toBe(1);
    expect(snap.global.noResponseRequestedReplies).toBe(1);
  });

  it("delivery metrics: a normal reply is not flagged and records time to first output", () => {
    const { cli } = replayReconnect("s-good");
    vi.advanceTimersByTime(1_500);
    for (const f of fixture.goodReply) bridge.handleCLIMessage(cli, JSON.stringify(f) + "\n");
    const snap = deliveryMetrics.getSnapshot();
    expect(snap.global.noResponseRequestedReplies).toBe(0);
    expect(snap.sessions["s-good"]).toMatchObject({ userMessages: 1, firstOutputs: 1, awaitingSince: null });
    // Clock started at the user's message, not at the probe.
    expect(snap.timeToFirstOutputMs.sum).toBe(1_500);
  });

  it("the probe turn's interrupted result does not count as an answer to the user", () => {
    // Race variant: the user's message arrives BEFORE the probe turn's
    // aborted result. That result must not close the user's turn — the
    // reply that follows is still the answer to the user.
    const sessionId = "s-race";
    const browser = mockSocket({ kind: "browser", sessionId });
    bridge.handleBrowserOpen(browser, sessionId);
    const cli = mockSocket({ kind: "cli", sessionId });
    bridge.handleCLIOpen(cli, sessionId);
    const inFrames = fixture.frames.filter((f) => f.dir === "in");
    const abortedResult = inFrames.find((f) => f.raw.type === "result")!;
    for (const f of inFrames) if (f !== abortedResult) bridge.handleCLIMessage(cli, JSON.stringify(f.raw) + "\n");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "ты тут?" }));
    bridge.handleCLIMessage(cli, JSON.stringify(abortedResult.raw) + "\n");
    for (const f of fixture.bugReply) bridge.handleCLIMessage(cli, JSON.stringify(f) + "\n");
    const s = deliveryMetrics.getSnapshot().sessions[sessionId];
    expect(s.noResponseRequestedReplies).toBe(1);
    expect(s.nudges).toBe(1);
  });
});

describe("codex solo session (no init probe)", () => {
  // Codex has no init probe: its app-server handshake is JSON-RPC
  // `initialize`, and sendInitializeKickoff returns early for any non-Claude
  // adapter. This pins that a solo Codex session delivers the user's message
  // to the adapter unchanged, never receives a probe/interrupt, and that the
  // delivery metrics work for Codex from the same normalized frames.
  it("delivers the user message as-is, sends no probe, and records delivery metrics", () => {
    const sessionId = "codex-solo";
    let emit: (msg: any) => void = () => {};
    const send = vi.fn((_msg: any) => true);
    const sendRawNDJSON = vi.fn();
    const adapter = {
      isConnected: () => true,
      send,
      sendRawNDJSON,
      disconnect: async () => {},
      onBrowserMessage: (cb: (msg: any) => void) => { emit = cb; },
      onSessionMeta: () => {},
      onDisconnect: () => {},
      onInitError: () => {},
    };
    const browser = mockSocket({ kind: "browser", sessionId });
    bridge.handleBrowserOpen(browser, sessionId);
    bridge.attachBackendAdapter(sessionId, adapter as any, "codex");
    bridge.sendInitializeKickoff(sessionId); // must be a no-op for Codex
    vi.advanceTimersByTime(1_000);

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "ты тут?" }));

    const sentUser = send.mock.calls.map(([m]) => m).filter((m) => m.type === "user_message");
    expect(sentUser).toHaveLength(1);
    expect(sentUser[0].content).toBe("ты тут?");
    expect(sendRawNDJSON).not.toHaveBeenCalled();
    for (const [m] of send.mock.calls) expect(JSON.stringify(m)).not.toContain("init probe");

    // Codex streams through the same normalized frames as Claude.
    vi.advanceTimersByTime(2_000);
    emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null });
    emit({ type: "assistant", message: { id: "c1", role: "assistant", content: [{ type: "text", text: "Да, здесь." }] }, parent_tool_use_id: null });
    const s = deliveryMetrics.getSnapshot().sessions[sessionId];
    expect(s).toMatchObject({ backend: "codex", userMessages: 1, firstOutputs: 1, nudges: 1, noResponseRequestedReplies: 0, awaitingSince: null });
    expect(deliveryMetrics.getSnapshot().timeToFirstOutputMs.sum).toBe(2_000);
  });
});

// ─── W3: the probe interrupt must never cancel a turn the CLI started itself ──
//
// Prod 40f03a1e, 2026-10-15 20:31 and 2026-10-16 07:02 (CLI 2.1.283): a
// `--resume`d CLI that owns a durable cron job dequeues the cron prompt on
// startup, BEFORE it reads the init probe from stdin. The old bridge sent
// `control_request{interrupt}` on a blind 200 ms timer, which landed on the
// cron turn: jsonl `[Request interrupted by user]` under the cron prompt,
// then the probe ran as a real turn ("No response requested."). The fixture is
// the recorded sequence (see __fixtures__/init-probe-reconnect/README.md).

interface CronFixture {
  frames: { dtMs: number; dir: "out" | "in"; raw: Record<string, any> }[];
}
const cronFixture: CronFixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__/init-probe-reconnect/cron-turn-on-resume.json"), "utf-8"),
);

function isInterrupt(j: Record<string, any>): boolean {
  return j.type === "control_request" && j.request?.subtype === "interrupt";
}

describe("init-probe reconnect replay — cron turn on resume (W3)", () => {
  it("never interrupts the cron turn the resumed CLI started first; drops the queued probe instead", () => {
    const sessionId = "s-cron";
    const browser = mockSocket({ kind: "browser", sessionId });
    bridge.handleBrowserOpen(browser, sessionId);
    const cli = mockSocket({ kind: "cli", sessionId });
    bridge.handleCLIOpen(cli, sessionId); // kickoff → probe frame
    const probe = parseSent(cli).find((j) => j.type === "user")!;
    expect(probe.message.content).toBe(AURA_INIT_PROBE_MARKER);
    // The probe is uuid-stamped so the CLI reports it in command_lifecycle.
    expect(typeof probe.uuid).toBe("string");

    // Replay the CLI's first stdout burst at its recorded offset (7.5 s: the
    // resumed CLI was still loading its transcript).
    const inFrames = cronFixture.frames.filter((f) => f.dir === "in");
    expect(inFrames[0].raw).toMatchObject({ type: "command_lifecycle", state: "started" });
    expect(inFrames[0].raw.command_uuid).not.toBe(probe.uuid);
    let clock = 0;
    for (const f of inFrames) {
      vi.advanceTimersByTime(f.dtMs - clock);
      clock = f.dtMs;
      bridge.handleCLIMessage(cli, JSON.stringify(f.raw) + "\n");
    }
    // The cron turn runs for a while (prod: tool calls over SSH).
    vi.advanceTimersByTime(60_000);

    const stdin = parseSent(cli);
    expect(stdin.filter(isInterrupt)).toHaveLength(0);
    const cancels = stdin.filter((j) => j.type === "control_request" && j.request?.subtype === "cancel_async_message");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].request.message_uuid).toBe(probe.uuid);
    // command_lifecycle is a known frame now — no "protocol drift" toast.
    const errors = parseSent(browser).filter((j) => j.type === "error");
    expect(errors.map((e) => e.message).join("\n")).not.toMatch(/protocol drift/i);
  });

  it("interrupts at once when the CLI reports the PROBE as the running turn (W1 reconnect, 15:03:38)", () => {
    // Same CLI (2.1.283), no cron: the probe is the first command it runs.
    const sessionId = "s-probe-first";
    const cli = mockSocket({ kind: "cli", sessionId });
    bridge.handleCLIOpen(cli, sessionId);
    const probe = parseSent(cli).find((j) => j.type === "user")!;
    const init = cronFixture.frames.find((f) => f.dir === "in" && f.raw.subtype === "init")!.raw;
    vi.advanceTimersByTime(1_000);
    expect(parseSent(cli).filter(isInterrupt)).toHaveLength(0);
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({ type: "command_lifecycle", command_uuid: probe.uuid, state: "started", uuid: "lc-1", session_id: init.session_id }) +
        "\n" + JSON.stringify(init) + "\n",
    );
    expect(parseSent(cli).filter(isInterrupt)).toHaveLength(1);
    // No extra interrupt from the legacy init path afterwards.
    vi.advanceTimersByTime(5_000);
    expect(parseSent(cli).filter(isInterrupt)).toHaveLength(1);
  });

  it("does not interrupt when a real prompt went to stdin before the probe started", () => {
    // The user types right after the reconnect; the CLI may fold that prompt
    // into the probe's turn — interrupting would cancel the user's message.
    const sessionId = "s-user-first";
    const browser = mockSocket({ kind: "browser", sessionId });
    bridge.handleBrowserOpen(browser, sessionId);
    const cli = mockSocket({ kind: "cli", sessionId });
    bridge.handleCLIOpen(cli, sessionId);
    const probe = parseSent(cli).find((j) => j.type === "user")!;
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "command_lifecycle", command_uuid: probe.uuid, state: "queued", uuid: "lc-q" }) + "\n");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "продолжай" }));
    // The CLI understands lifecycle → the still-queued probe is dropped.
    const cancels = parseSent(cli).filter((j) => j.request?.subtype === "cancel_async_message");
    expect(cancels.map((c) => c.request.message_uuid)).toEqual([probe.uuid]);
    // Even if the probe had already been dequeued, its start must not interrupt.
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "command_lifecycle", command_uuid: probe.uuid, state: "started", uuid: "lc-s" }) + "\n");
    vi.advanceTimersByTime(5_000);
    expect(parseSent(cli).filter(isInterrupt)).toHaveLength(0);
  });
});
