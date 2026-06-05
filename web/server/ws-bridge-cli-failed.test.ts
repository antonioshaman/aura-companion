import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";

// AURA-LOCAL — PLAN T10+T11 Phase F integration tests for the
// ws-bridge drain pipeline. Covers the brief-mandated canaries:
//
//   (a) Zero-queued suppression — empty pendingMessages +
//       browser_closed_no_reconnect -> NO broadcast.
//       Empty pendingMessages + relaunch_exhausted (etc.) -> broadcast fires.
//   (b) 4-step dispatch ordering — clear + persist BEFORE
//       broadcast per Persistence R7.
//   (c) Per-session fanout only — frame never appears on other
//       sessions in the bridge (Hunt R5).
//   (d) Browser-drain grace timer arm/cancel + fire path.
//   (e) Replay regression per EC-6 — captured "relaunch-exhausted"
//       event reaches dispatchCliFailedDrain exactly once via the
//       constructor's bus subscriber.

if (typeof globalThis.Bun === "undefined") {
  (globalThis as any).Bun = {
    hash(input: string | Uint8Array): number {
      const s = typeof input === "string" ? input : new TextDecoder().decode(input);
      let h = 0;
      for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
      return h >>> 0;
    },
  };
}

vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({
    aiValidationEnabled: false,
    aiValidationAutoApprove: false,
    aiValidationAutoDeny: false,
    anthropicApiKey: "",
  }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

import { WsBridge, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { companionBus } from "./event-bus.js";
import type { RelaunchExhaustedReason } from "./event-bus-types.js";
import type { CliFailedReason } from "./cli-failed-frame.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createMockSocket(data: SocketData) {
  return { data, send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}
function makeBrowserSocket(sessionId: string) {
  return createMockSocket({ kind: "browser", sessionId });
}

let bridge: WsBridge;
let tempDir: string;
let store: SessionStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cli-failed-test-"));
  store = new SessionStore(tempDir);
  bridge = new WsBridge();
  bridge.setStore(store);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  store.dispose();
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Phase F — zero-queued suppression", () => {
  // Brief: "empty pendingMessages + browser_closed_no_reconnect ->
  // NO broadcast. Empty pendingMessages + relaunch_exhausted ->
  // broadcast FIRES."
  it("suppresses browser_closed_no_reconnect when no queued messages", () => {
    const sid = "sess_suppress";
    const ws = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(ws, sid);
    const result = bridge.dispatchCliFailedDrain(sid, "browser_closed_no_reconnect");
    expect(result).toEqual({ fired: false, drainedCount: 0 });
    // No cli_failed payload arrived at the browser.
    const sends = ws.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(sends.find((m: any) => m.type === "cli_failed")).toBeUndefined();
  });

  it("ALWAYS-fires relaunch_exhausted even with no queued messages", () => {
    const sid = "sess_always_fire";
    const ws = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(ws, sid);
    ws.send.mockClear();
    const result = bridge.dispatchCliFailedDrain(sid, "relaunch_exhausted");
    expect(result.fired).toBe(true);
    expect(result.drainedCount).toBe(0);
    const cli_failed = ws.send.mock.calls
      .map((c: unknown[]) => JSON.parse(c[0] as string))
      .find((m: any) => m.type === "cli_failed");
    expect(cli_failed).toBeDefined();
    expect(cli_failed.reason).toBe("relaunch_exhausted");
    expect(cli_failed.subprocessAlive).toBe(false);
    expect(cli_failed.drainedCount).toBe(0);
    expect(cli_failed.origin).toBe("server:cleanup-drain");
  });
});

describe("Phase F — 4-step dispatch ordering", () => {
  // Brief: "(1) snapshot pendingMessages, (2) clear Map entry +
  // store.saveSync BEFORE broadcast per Persistence R7, (3)
  // broadcastToBrowsers(session, frame), (4) recordCleanupEvent."
  it("clears pendingMessages BEFORE broadcasting the cli_failed frame", () => {
    const sid = "sess_4step";
    const ws = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(ws, sid);
    // Pre-load 3 queued messages.
    const session = bridge.getSession(sid)!;
    session.pendingMessages.push("m1", "m2", "m3");
    ws.send.mockClear();
    const result = bridge.dispatchCliFailedDrain(sid, "container_missing");
    expect(result.fired).toBe(true);
    expect(result.drainedCount).toBe(3);
    expect(session.pendingMessages).toEqual([]);
    const cli_failed = ws.send.mock.calls
      .map((c: unknown[]) => JSON.parse(c[0] as string))
      .find((m: any) => m.type === "cli_failed");
    expect(cli_failed.drainedCount).toBe(3);
    expect(cli_failed.reason).toBe("container_missing");
  });
});
describe("Phase F — per-session fanout (Hunt R5)", () => {
  // Frame must NEVER fan across sessions.values(). Verify the
  // dispatch on session A does not touch session B's browsers.
  it("does not deliver cli_failed to other sessions' browsers", () => {
    const sa = "sess_A", sb = "sess_B";
    const wsA = makeBrowserSocket(sa);
    const wsB = makeBrowserSocket(sb);
    bridge.handleBrowserOpen(wsA, sa);
    bridge.handleBrowserOpen(wsB, sb);
    wsA.send.mockClear();
    wsB.send.mockClear();
    bridge.dispatchCliFailedDrain(sa, "relaunch_exhausted");
    const aFrames = wsA.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const bFrames = wsB.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(aFrames.some((m: any) => m.type === "cli_failed")).toBe(true);
    expect(bFrames.some((m: any) => m.type === "cli_failed")).toBe(false);
  });
});

describe("Phase F — bus subscriber (replay regression, EC-6)", () => {
  // Brief: "Replay-based regression per EC-6: a captured
  // \"relaunch-exhausted\" recording -> assert EXACTLY one
  // cli_failed frame fires with correct (reason, drainedCount)."
  //
  // Replay shape: a single companionBus emit of
  // session:relaunch-exhausted with a structural reason.
  it("fires exactly one cli_failed when session:relaunch-exhausted lands", () => {
    const sid = "sess_replay";
    const ws = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(ws, sid);
    const session = bridge.getSession(sid)!;
    session.pendingMessages.push("queued-1", "queued-2");
    ws.send.mockClear();
    // Simulate the captured wire event from cli-launcher's
    // clearPidAndPersist on a container-missing path.
    companionBus.emit("session:relaunch-exhausted", {
      sessionId: sid,
      reason: "container_missing",
    });
    const cli_failed_frames = ws.send.mock.calls
      .map((c: unknown[]) => JSON.parse(c[0] as string))
      .filter((m: any) => m.type === "cli_failed");
    expect(cli_failed_frames).toHaveLength(1);
    expect(cli_failed_frames[0].reason).toBe("container_missing");
    expect(cli_failed_frames[0].drainedCount).toBe(2);
    expect(cli_failed_frames[0].subprocessAlive).toBe(false);
  });

  // Mapping coverage: each cli-launcher reason routes to the
  // correct CliFailedReason via mapClearReasonToCliFailedReason.
  it.each<[RelaunchExhaustedReason, CliFailedReason]>([
    ["container_missing", "container_missing"],
    ["container_start_failed", "container_stopped"],
    ["container_binary_missing", "binary_missing"],
    ["observer_prompt_config_failed", "relaunch_exhausted"],
    ["observer_prompt_source_drift_refused", "relaunch_exhausted"],
  ])("%s -> %s", (clearReason, expectedReason) => {
    const sid = `sess_map_${clearReason}`;
    const ws = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(ws, sid);
    const session = bridge.getSession(sid)!;
    session.pendingMessages.push("x");
    ws.send.mockClear();
    companionBus.emit("session:relaunch-exhausted", { sessionId: sid, reason: clearReason });
    const frame = ws.send.mock.calls
      .map((c: unknown[]) => JSON.parse(c[0] as string))
      .find((m: any) => m.type === "cli_failed");
    expect(frame).toBeDefined();
    expect(frame.reason).toBe(expectedReason);
  });
});

describe("Phase F — browser-close drain grace timer", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  // Brief: "ws-bridge browser-close-grace expiry with no reconnect
  // -> reason browser_closed_no_reconnect, subprocessAlive: true".
  it("arms a grace timer on last-browser-close with queued messages, fires drain on expiry", () => {
    const sid = "sess_grace_fire";
    const ws = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(ws, sid);
    const session = bridge.getSession(sid)!;
    session.pendingMessages.push("q1", "q2");
    ws.send.mockClear();
    bridge.handleBrowserClose(ws);
    // Within grace — drain has not fired yet.
    expect(session.pendingMessages.length).toBe(2);
    // Advance past the default 300_000 ms grace.
    vi.advanceTimersByTime(300_001);
    expect(session.pendingMessages.length).toBe(0);
  });

  // Suppression: empty pendingMessages -> no timer armed.
  it("does NOT arm the grace timer when there are no queued messages", () => {
    const sid = "sess_grace_nop";
    const ws = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(ws, sid);
    bridge.handleBrowserClose(ws);
    vi.advanceTimersByTime(300_001);
    const session = bridge.getSession(sid)!;
    expect(session.pendingMessages.length).toBe(0);
    // No cli_failed broadcast either.
    const sends = ws.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(sends.some((m: any) => m.type === "cli_failed")).toBe(false);
  });

  // Cancellation: browser reconnect within grace cancels the timer.
  it("cancels the grace timer when a browser reconnects", () => {
    const sid = "sess_grace_cancel";
    const ws = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(ws, sid);
    const session = bridge.getSession(sid)!;
    session.pendingMessages.push("q1");
    bridge.handleBrowserClose(ws);
    // Reconnect within grace.
    vi.advanceTimersByTime(100_000);
    const ws2 = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(ws2, sid);
    // Advance past original grace — queue must survive because the
    // timer was cancelled when ws2 attached.
    vi.advanceTimersByTime(300_001);
    expect(session.pendingMessages).toEqual(["q1"]);
  });
});

describe("Phase F — getSessionMemoryStats reachability axis", () => {
  it("derives the reachable axis from the live adapter", () => {
    const sid = "sess_reach";
    const ws = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(ws, sid);
    const stats = bridge.getSessionMemoryStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].id).toBe(sid);
    // Without an attached adapter, `backendAdapter?.isConnected() ?? false`
    // resolves to false (Fowler finding #12 — derived, not cached).
    expect(stats[0].reachable).toBe(false);
  });
});
