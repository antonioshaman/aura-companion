/**
 * Replay regression for turn-failure classification (LLM auth phase 1,
 * tasks 10/15; S3-AC1…AC3, S3-AC5; EC-6).
 *
 * Real frames from `~/.companion/recordings/` (fixtures/turn-failure,
 * fixtures/usage-limit) are fed as RAW lines — never re-serialised — through
 * the real ClaudeAdapter NDJSON ingest and the real Codex StdioTransport, and
 * the browser-bound `error` frame must carry the right `turnFailure`.
 * Incidents with no capture on the box (Claude 401, network mid-turn,
 * "version X required", Codex id-less auth) use the exact wire shapes the
 * installed CLIs emit; see fixtures/turn-failure/README.md.
 *
 * Negative space: auth/limit phrases inside assistant text, Bash tool output
 * or a successful result must NOT produce a card (prompt-injection guard).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { CodexAdapter, StdioTransport } from "./codex-adapter.js";
import type { BrowserIncomingMessage } from "./session-types.js";
import type { TurnFailure } from "./auth-status/auth-types.js";
import { log } from "./logger.js";

function fixture(dir: string, name: string): string {
  return readFileSync(join(__dirname, "fixtures", dir, name), "utf-8");
}

function mockSocket(sessionId: string) {
  return { data: { kind: "cli" as const, sessionId }, send: vi.fn(), close: vi.fn(), readyState: 1, getBufferedAmount: vi.fn(() => 0) } as any;
}

type ErrorFrame = Extract<BrowserIncomingMessage, { type: "error" }>;

function failures(messages: BrowserIncomingMessage[]): TurnFailure[] {
  return messages.filter((m): m is ErrorFrame => m.type === "error").flatMap((m) => (m.turnFailure ? [m.turnFailure] : []));
}

describe("Claude replay → turnFailure", () => {
  let adapter: ClaudeAdapter;
  let messages: BrowserIncomingMessage[];

  beforeEach(() => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    adapter = new ClaudeAdapter("sess-replay");
    adapter.attachWebSocket(mockSocket("sess-replay"));
    messages = [];
    adapter.onBrowserMessage((m) => messages.push(m));
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("real 403 'organization has disabled subscription access' → auth_rejected, sent before the result", () => {
    vi.setSystemTime(Date.UTC(2026, 10, 13, 19, 41));
    adapter.handleRawMessage(fixture("turn-failure", "claude-403-org-disabled-2026-11-13.ndjson"));
    expect(failures(messages)).toEqual([
      expect.objectContaining({ kind: "auth_rejected", provider: "claude", providerMessage: expect.stringContaining("disabled Claude subscription access") }),
    ]);
    // Ordering contract for task 12: the typed failure precedes the result frame.
    const errIdx = messages.findIndex((m) => m.type === "error");
    const resIdx = messages.findIndex((m) => m.type === "result");
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(errIdx).toBeLessThan(resIdx);
  });

  it("real five-hour session limit (2026-11-14) → limit_window five_hour with the structured reset", () => {
    vi.setSystemTime(Date.UTC(2026, 10, 14, 7, 0));
    adapter.handleRawMessage(fixture("turn-failure", "claude-session-limit-2026-11-14.ndjson"));
    expect(failures(messages)).toEqual([
      expect.objectContaining({ kind: "limit_window", window: "five_hour", resetAt: 1794657600 * 1000 }),
    ]);
  });

  it("real 'out of usage credits' (seven_day_overage_included) → extra_usage_exhausted, model named as likely cause", () => {
    vi.setSystemTime(1791959859885);
    adapter.handleRawMessage(fixture("usage-limit", "claude-out-of-usage-credits-2026-10-14.ndjson"));
    expect(failures(messages)).toEqual([
      expect.objectContaining({ kind: "extra_usage_exhausted", window: "extra_usage", likelyCause: "model_outside_plan", resetAt: 1791979200 * 1000 }),
    ]);
  });

  it("401 (CLI wire shape) → auth_rejected", () => {
    adapter.handleRawMessage([
      JSON.stringify({ type: "assistant", message: { id: "m1", type: "message", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Invalid API key · Please run /login" }], stop_reason: "stop_sequence", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, parent_tool_use_id: null, error: "authentication_failed", uuid: "u1", session_id: "c1" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 401, terminal_reason: "api_error", result: "Invalid API key · Please run /login", duration_ms: 10, uuid: "u2", session_id: "c1" }),
    ].join("\n"));
    expect(failures(messages).map((f) => f.kind)).toEqual(["auth_rejected"]);
  });

  it("network mid-turn: api_retry without status then a status-less error result → network, not auth", () => {
    adapter.handleRawMessage([
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: "unknown", uuid: "r1", session_id: "c1" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "API Error: Connection error.", duration_ms: 10, uuid: "u3", session_id: "c1" }),
    ].join("\n"));
    expect(failures(messages).map((f) => f.kind)).toEqual(["network"]);
  });

  it("'version X or newer is required' → cli_outdated", () => {
    adapter.handleRawMessage(JSON.stringify({
      type: "result", subtype: "success", is_error: true, api_error_status: 400, terminal_reason: "api_error",
      result: "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"claude-code 2.1.278 does not support this model; version 2.1.280 or newer is required\"}}",
      duration_ms: 10, uuid: "u4", session_id: "c1",
    }));
    expect(failures(messages)).toEqual([expect.objectContaining({ kind: "cli_outdated", requiredVersion: "2.1.280" })]);
  });

  it("negative: auth/limit phrases in assistant text, Bash output and a successful result → no card", () => {
    adapter.handleRawMessage([
      JSON.stringify({ type: "assistant", message: { id: "m2", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "API Error: 401 unauthorized. You've hit your session limit · resets 1pm (UTC). You're out of extra usage." }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, parent_tool_use_id: null, uuid: "u5", session_id: "c1" }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "HTTP/1.1 401 Unauthorized\nversion 9.9.9 or newer is required\nConnection error." }] }, parent_tool_use_id: null, session_id: "c1", uuid: "u6" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: "Done: the 401 unauthorized / session limit text was only quoted.", duration_ms: 10, uuid: "u7", session_id: "c1" }),
    ].join("\n"));
    expect(failures(messages)).toEqual([]);
  });
});

describe("Codex replay → turnFailure", () => {
  function createStreams() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdin = new WritableStream<Uint8Array>({ write() {} });
    const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    return { stdin, stdout, pushRaw: (line: string) => controller.enqueue(new TextEncoder().encode(`${line}\n`)) };
  }

  let messages: BrowserIncomingMessage[];
  let streams: ReturnType<typeof createStreams>;

  function start(credentialGeneration?: () => "renewed" | "same" | "incomparable") {
    streams = createStreams();
    const transport = new StdioTransport(streams.stdin, streams.stdout, "sess-codex-replay");
    const adapter = new CodexAdapter(transport, "sess-codex-replay", { model: "gpt-6.1-sol", cwd: "/tmp", credentialGeneration });
    messages = [];
    adapter.onBrowserMessage((m) => messages.push(m));
  }

  const flush = () => new Promise((r) => setTimeout(r, 30));

  beforeEach(() => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    vi.spyOn(log, "error").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("real usageLimitExceeded (2026-10-30) → limit_window", async () => {
    start();
    for (const line of fixture("turn-failure", "codex-usage-limit-2026-10-30.ndjson").trim().split("\n")) streams.pushRaw(line);
    await flush();
    expect(failures(messages)).toEqual([expect.objectContaining({ kind: "limit_window", provider: "codex" })]);
  });

  it("v2 error notification codexErrorInfo 'unauthorized' (observed 2026-06-12 shape) → auth_rejected", async () => {
    start(() => "same");
    streams.pushRaw(JSON.stringify({ method: "error", params: { error: { message: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.", codexErrorInfo: "unauthorized", additionalDetails: null }, willRetry: false, threadId: "t", turnId: "u" } }));
    await flush();
    expect(failures(messages)).toEqual([expect.objectContaining({ kind: "auth_rejected", credentialsCompared: true })]);
  });

  it("id-less JSON-RPC auth error (formerly 'protocol drift') → auth_rejected", async () => {
    start();
    streams.pushRaw(JSON.stringify({ jsonrpc: "2.0", error: { code: 401, message: "Unauthorized: token expired" } }));
    await flush();
    expect(failures(messages)).toEqual([expect.objectContaining({ kind: "auth_rejected", credentialsCompared: false })]);
    expect(messages.some((m) => m.type === "error" && m.message.includes("protocol drift"))).toBe(false);
  });

  it("stale Codex copy: unauthorized while the primary sign-in was renewed → stale_session_credentials", async () => {
    start(() => "renewed");
    streams.pushRaw(JSON.stringify({ method: "error", params: { error: { message: "refresh token was already used", codexErrorInfo: "unauthorized" }, willRetry: false, threadId: "t", turnId: "u" } }));
    await flush();
    expect(failures(messages).map((f) => f.kind)).toEqual(["stale_session_credentials"]);
  });

  it("network: responseStreamDisconnected without an HTTP status → network", async () => {
    start();
    streams.pushRaw(JSON.stringify({ method: "error", params: { error: { message: "stream disconnected before completion", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }, willRetry: false, threadId: "t", turnId: "u" } }));
    await flush();
    expect(failures(messages).map((f) => f.kind)).toEqual(["network"]);
  });

  it("real account/rateLimits/updated → onProviderCheck (Codex status evidence, task 11)", async () => {
    streams = createStreams();
    const checks: number[] = [];
    const transport = new StdioTransport(streams.stdin, streams.stdout, "sess-codex-evidence");
    new CodexAdapter(transport, "sess-codex-evidence", { model: "gpt-6.1-sol", cwd: "/tmp", onProviderCheck: (at) => checks.push(at) });
    const [rateLimitsLine] = fixture("turn-failure", "codex-usage-limit-2026-10-30.ndjson").trim().split("\n");
    streams.pushRaw(rateLimitsLine);
    await flush();
    expect(checks).toHaveLength(1);
  });

  it("negative: auth phrases inside a command's output → no card", async () => {
    start();
    streams.pushRaw(JSON.stringify({ method: "item/completed", params: { threadId: "t", turnId: "u", item: { type: "commandExecution", id: "exec-1", command: "/bin/bash -lc 'curl -i api'", cwd: "/tmp", status: "completed", aggregatedOutput: "HTTP/1.1 401 Unauthorized\nYou've hit your usage limit", exitCode: 0 } } }));
    streams.pushRaw(JSON.stringify({ method: "item/completed", params: { threadId: "t", turnId: "u", item: { type: "agentMessage", id: "msg-1", text: "The API answered 401 unauthorized; please sign in again." } } }));
    await flush();
    expect(failures(messages)).toEqual([]);
  });
});
