/**
 * ClaudeAdapter → `session:usage-limit` (auto-resume detection).
 *
 * Replays REAL limit frames captured from prod recordings
 * (fixtures/usage-limit/*.ndjson: rate_limit_event rejected → synthetic
 * assistant "You've hit your session limit · resets …" → is_error result
 * 429) through the adapter's NDJSON ingest and asserts the bus event carries
 * the STRUCTURED reset time from the rejected rate_limit_event. Also guards
 * the negative cases: a successful result, or an unrelated error, must not
 * emit (a false positive would inject an unwanted "continue" prompt).
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({ aiValidationEnabled: false, aiValidationAutoApprove: false, aiValidationAutoDeny: false, anthropicApiKey: "" }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

import { ClaudeAdapter } from "./claude-adapter.js";
import { companionBus } from "./event-bus.js";

function fixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", "usage-limit", name), "utf-8");
}

function mockSocket(sessionId: string) {
  return { data: { kind: "cli" as const, sessionId }, send: vi.fn(), close: vi.fn(), readyState: 1, getBufferedAmount: vi.fn(() => 0) } as any;
}

describe("ClaudeAdapter usage-limit detection", () => {
  let adapter: ClaudeAdapter;
  let events: Array<Record<string, unknown>>;
  let off: () => void;

  beforeEach(() => {
    events = [];
    off = companionBus.on("session:usage-limit", (e) => {
      events.push(e as unknown as Record<string, unknown>);
    });
    adapter = new ClaudeAdapter("sess-limit");
    adapter.attachWebSocket(mockSocket("sess-limit"));
    // The frames were captured at 2026-10-14T23:37:48Z; pin "now" there so
    // the structured reset (01:40Z next day) is in the future.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1792021068884);
  });

  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  it("real five-hour session-limit frames → one event with the rate_limit_event resetsAt", () => {
    adapter.handleRawMessage(fixture("claude-session-limit-2026-10-14.ndjson"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: "sess-limit",
      backend: "claude",
      resetAt: 1792028400 * 1000,
      resetSource: "rate_limit_event",
      limitType: "five_hour",
    });
  });

  it("real 'out of usage credits' frames (no time in text) → structured weekly reset", () => {
    vi.setSystemTime(1791959859885);
    adapter.handleRawMessage(fixture("claude-out-of-usage-credits-2026-10-14.ndjson"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ resetAt: 1791979200 * 1000, resetSource: "rate_limit_event", limitType: "seven_day_overage_included" });
  });

  it("result text alone (no rate_limit_event) still emits, parsed from the text", () => {
    const lines = fixture("claude-session-limit-2026-10-14.ndjson").trim().split("\n");
    adapter.handleRawMessage(`${lines[2]}\n`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ resetAt: 1792028400 * 1000, resetSource: "text" });
  });

  it("a successful result does not emit and clears a remembered rejection", () => {
    const lines = fixture("claude-session-limit-2026-10-14.ndjson").trim().split("\n");
    adapter.handleRawMessage(`${lines[0]}\n`);
    adapter.handleRawMessage(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done", session_id: "x" })}\n`);
    expect(events).toHaveLength(0);
    // A later 429 without limit text must not reuse the stale rejection.
    adapter.handleRawMessage(`${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 429 overloaded", api_error_status: 429, session_id: "x" })}\n`);
    expect(events).toHaveLength(0);
  });

  // Review WARN1: the REAL adapter path passes no defaultTimeZone — a
  // zoneless "resets 3pm" resolves in the server zone and is flagged.
  it("zoneless 'resets 3pm' through the real adapter path → server-zone time, source text_no_zone", () => {
    vi.setSystemTime(new Date(2026, 9, 16, 10, 0));
    adapter.handleRawMessage(`${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets 3pm", api_error_status: 429, session_id: "x" })}\n`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ resetAt: new Date(2026, 9, 16, 15, 0).getTime(), resetSource: "text_no_zone" });
  });

  it("zoneless time 5 min ahead through the real adapter path → safe fallback", () => {
    vi.setSystemTime(new Date(2026, 9, 16, 10, 0));
    adapter.handleRawMessage(`${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets 10:05am", api_error_status: 429, session_id: "x" })}\n`);
    expect(events[0]).toMatchObject({ resetSource: "fallback" });
  });

  it("an unrelated error result does not emit", () => {
    adapter.handleRawMessage(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Tool crashed", session_id: "x" })}\n`);
    expect(events).toHaveLength(0);
  });
});
