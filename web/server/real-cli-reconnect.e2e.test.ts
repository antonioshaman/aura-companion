import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

// REAL-CLI reconnect scenario (opt-in). Skipped unless AURA_REAL_CLI_E2E=1 AND
// a `claude` binary is found, so CI and the default `bun run test` stay green
// and spend no API usage.
//
//   AURA_REAL_CLI_E2E=1 bunx vitest run server/real-cli-reconnect.e2e.test.ts
//   optional: AURA_REAL_CLI_BIN=/path/to/claude  AURA_REAL_CLI_MODEL=haiku
//
// What it proves end to end, against the real Claude Code CLI:
//   1. a session started through the server's WsBridge (the component that
//      owns the init-probe kickoff) answers a first prompt;
//   2. after the CLI process dies and a new one is attached with `--resume`
//      (the reconnect path: bridge sends the init probe + interrupt), the
//      NEXT user message gets a real assistant reply — not
//      "No response requested." (the #200 → #335 regression), and the delivery
//      metrics agree.
//
//   3. same after a second reconnect where the user's message reaches stdin
//      right behind the probe (before its interrupt) — the prod fold shape.
//
// Limit (measured 2026-10-12, CLI 2.1.283): in a short synthetic session the
// OLD "do not respond" marker did not reproduce the failure on haiku or opus;
// prod hit it on long transcripts with many accumulated probe lines. So this
// is an end-to-end liveness check of the reconnect path, while the
// deterministic regression guard for the marker/frame sequence is
// init-probe-reconnect.replay.test.ts.
//
// It runs the bridge in-process and spawns the CLI with the launcher's stdio
// argv (see CliLauncher's stream-json args) instead of booting a whole second
// server: a full server boot runs the orphan reaper and the cleanup sweeps
// against the host's shared ~/.companion, which is not acceptable on a box
// that also runs prod. The bridge → adapter → stdin/stdout path is the same.
//
// Codex is out of scope here: Codex has no init probe (its app-server
// handshake is JSON-RPC `initialize`, never a user frame); the Codex solo path
// is covered by "codex solo session" in init-probe-reconnect.replay.test.ts.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

function resolveClaudeBin(): string | null {
  if (process.env.AURA_REAL_CLI_BIN) return process.env.AURA_REAL_CLI_BIN;
  try {
    return execFileSync("which", ["claude"], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

const CLAUDE_BIN = process.env.AURA_REAL_CLI_E2E === "1" ? resolveClaudeBin() : null;
const ENABLED = CLAUDE_BIN !== null;
const MODEL = process.env.AURA_REAL_CLI_MODEL || "haiku";
const TURN_TIMEOUT_MS = 120_000;

// The bridge only needs settings for AI validation; keep it off.
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({
    aiValidationEnabled: false,
    aiValidationAutoApprove: false,
    aiValidationAutoDeny: false,
    anthropicApiKey: "",
  }),
  DEFAULT_ANTHROPIC_MODEL: "claude-haiku-4-5",
}));

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

describe.skipIf(!ENABLED)("real Claude CLI: reply after reconnect is not swallowed", () => {
  const sessionId = "e2e-reconnect-0001";
  let cwd: string;
  let storeDir: string;
  let bridge: import("./ws-bridge.js").WsBridge;
  let store: import("./session-store.js").SessionStore;
  let deliveryMetrics: typeof import("./delivery-metrics.js").deliveryMetrics;
  let NO_RESPONSE: string;
  const children: ChildProcess[] = [];
  let cliSessionIdSeen: string | undefined;
  /** Every frame written to a CLI's stdin, tagged with that CLI's pid. */
  const stdinLog: { pid: number | undefined; data: string }[] = [];
  // Every frame the bridge broadcast to the (mock) browser.
  const browserFrames: Record<string, any>[] = [];
  const browser = {
    data: { kind: "browser", sessionId },
    send: (raw: string) => {
      for (const line of String(raw).split("\n")) {
        if (!line.trim()) continue;
        try { browserFrames.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    },
    close: () => {},
    readyState: 1,
  } as any;

  /** Spawn the CLI with the launcher's stdio argv and attach it to the bridge. */
  async function attachCli(resumeCliSessionId?: string) {
    const { StdioCliTransport, pumpStdoutLines } = await import("./cli-transport.js");
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", MODEL,
      "--permission-mode", "default",
      // Text-only turns: no tool can make the test wait on a permission.
      "--disallowedTools", "Bash", "--disallowedTools", "Edit", "--disallowedTools", "Write",
      ...(resumeCliSessionId ? ["--resume", resumeCliSessionId] : []),
    ];
    const child = spawn(CLAUDE_BIN!, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    children.push(child);
    child.stderr!.on("data", () => {});
    const transport = new StdioCliTransport(
      {
        write: (d: string) => {
          stdinLog.push({ pid: child.pid, data: d });
          return child.stdin!.write(d);
        },
        end: () => child.stdin!.end(),
      },
      sessionId,
    );
    const adapter = bridge.handleCLIStdioOpen(sessionId, transport, { resume: !!resumeCliSessionId });
    void pumpStdoutLines(
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      (chunk) => {
        // Note the CLI's own session id (needed for `--resume`) from the
        // raw `system.init`, then hand the chunk to the adapter unchanged.
        for (const line of chunk.split("\n")) {
          if (!line.includes('"subtype":"init"')) continue;
          try {
            const j = JSON.parse(line);
            if (j.type === "system" && j.subtype === "init" && typeof j.session_id === "string") cliSessionIdSeen = j.session_id;
          } catch { /* partial line */ }
        }
        adapter.handleRawMessage(chunk);
      },
    );
    child.on("exit", () => {
      transport.markClosed();
      adapter.handleTransportClose();
    });
    return child;
  }

  async function waitFor<T>(probe: () => T | undefined | null | false, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = probe();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Send a browser user_message; resolve with the assistant text of that turn. */
  async function ask(text: string): Promise<string> {
    const start = browserFrames.length;
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: text }));
    // Wait for a result that follows at least one assistant frame of this turn
    // (the probe's interrupted result carries no assistant output).
    await waitFor(() => {
      const turn = browserFrames.slice(start);
      const firstAssistant = turn.findIndex((f) => f.type === "assistant");
      return firstAssistant >= 0 && turn.slice(firstAssistant).some((f) => f.type === "result");
    }, TURN_TIMEOUT_MS, `reply to ${JSON.stringify(text)}`);
    return browserFrames
      .slice(start)
      .filter((f) => f.type === "assistant")
      .flatMap((f) => (Array.isArray(f.message?.content) ? f.message.content : []))
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
  }

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "aura-real-cli-"));
    storeDir = mkdtempSync(join(tmpdir(), "aura-real-cli-store-"));
    const { WsBridge } = await import("./ws-bridge.js");
    const { SessionStore } = await import("./session-store.js");
    ({ deliveryMetrics, NO_RESPONSE_REQUESTED_TEXT: NO_RESPONSE } = await import("./delivery-metrics.js"));
    deliveryMetrics.reset();
    store = new SessionStore(storeDir);
    bridge = new WsBridge();
    bridge.setStore(store);
    bridge.getOrCreateSession(sessionId, "claude");
    bridge.handleBrowserOpen(browser, sessionId);
  });

  afterAll(() => {
    // Only the children this test spawned, by their own handle.
    for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
    store?.dispose();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("answers after a reconnect with the init probe in the transcript", async () => {
    // ── 1. fresh session: kickoff probe → system.init → first prompt ──────
    const first = await attachCli();
    await waitFor(() => browserFrames.some((f) => f.type === "session_init"), 60_000, "first system.init");
    const reply1 = await ask("Remember the code word PINEAPPLE. Reply with exactly: OK");
    expect(reply1.length).toBeGreaterThan(0);
    expect(reply1).not.toBe(NO_RESPONSE);

    const cliSessionId = await waitFor(() => cliSessionIdSeen, 10_000, "CLI session id");

    // ── 2. reconnect: the CLI dies, a new one resumes the transcript ──────
    first.kill("SIGTERM");
    await waitFor(() => first.exitCode !== null || first.signalCode !== null, 15_000, "first CLI exit");
    const initsBefore = browserFrames.filter((f) => f.type === "session_init").length;
    const second = await attachCli(cliSessionId); // bridge sends init probe + interrupt here
    await waitFor(
      () => browserFrames.filter((f) => f.type === "session_init").length > initsBefore,
      90_000,
      "system.init after resume",
    );
    // Let the probe's interrupted turn settle, as in the recorded prod case
    // (user typed 8.5 s after the reconnect).
    await new Promise((r) => setTimeout(r, 3_000));

    // The reconnect really went through the probe path.
    const { AURA_INIT_PROBE_MARKER } = await import("./ws-bridge.js");
    const secondStdin = stdinLog.filter((e) => e.pid === second.pid).map((e) => e.data);
    expect(secondStdin.some((d) => d.includes(AURA_INIT_PROBE_MARKER))).toBe(true);
    expect(secondStdin.some((d) => d.includes('"subtype":"interrupt"'))).toBe(true);

    // ── 3. the next user message must get a real answer ───────────────────
    const reply2 = await ask("What was the code word I asked you to remember? Answer with just the word.");
    expect(reply2).not.toBe(NO_RESPONSE);
    expect(reply2).not.toMatch(/^no response requested\.?$/i);
    expect(reply2.toUpperCase()).toContain("PINEAPPLE");

    // ── 4. race: the user types while the probe turn is still open ────────
    // The prod failure shape: the message reaches stdin right behind the
    // probe, before its interrupt lands, so the CLI folds both into one turn.
    second.kill("SIGTERM");
    await waitFor(() => second.exitCode !== null || second.signalCode !== null, 15_000, "second CLI exit");
    await attachCli(cliSessionId);
    const reply3 = await ask("Say the code word again, just the word.");
    expect(reply3).not.toMatch(/^no response requested\.?$/i);
    expect(reply3.toUpperCase()).toContain("PINEAPPLE");

    const s = deliveryMetrics.getSnapshot().sessions[sessionId];
    expect(s.noResponseRequestedReplies).toBe(0);
    expect(s.firstOutputs).toBe(3);
    expect(s.awaitingSince).toBeNull();
  }, 300_000);

});
