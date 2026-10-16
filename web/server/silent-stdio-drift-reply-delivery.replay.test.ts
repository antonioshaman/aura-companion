import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// W1 replay (prod 40f03a1e, 2026-10-15 15:02–15:03, CLI 2.1.283).
//
// The silent-stdio drift detector killed a CLI whose stdout went silent and
// relaunched it with `--resume` — but the answer the CLI had ALREADY written
// to its own jsonl (thinking + `git push` tool_use + tool_result + thinking +
// text, end_turn at 15:03:34) never reached the browser: bun had received
// nothing after `system.init`, and a resumed CLI does not re-emit past turns
// on stdout. The user saw a hang and had to type "продолжай".
//
// This test replays the recorded frames bun received (fixture `recording`)
// through the REAL WsBridge + ClaudeAdapter, writes the CLI's real jsonl
// lines (fixture `jsonl`) into a temp HOME, runs one drift-detector tick at
// the recorded detection time, and asserts that the stalled reply reaches the
// browser and the session history — exactly once, before the relaunch.

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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { SessionRecovery } from "./session-recovery.js";
import { IntentionalKills } from "./intentional-kills.js";
import { companionBus } from "./event-bus.js";
import { deliveryMetrics } from "./delivery-metrics.js";
import { resolveCliSessionPaths, readUndeliveredAssistantRecords } from "./silent-stdio-drift-detector.js";

interface Fixture {
  detectedAtMs: number;
  jsonlMtimeMs: number;
  waitChannels: string;
  recording: { ts: number; dir: "in" | "out"; ch: "cli" | "browser"; raw?: Record<string, any>; event?: string }[];
  jsonl: Record<string, any>[];
}
const fx: Fixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__/silent-stdio-drift/stalled-reply-never-delivered.json"), "utf-8"),
);
const SESSION_ID = "40f03a1e-replay";
const CWD = "/workspace/project";
const CLI_SID = "cli-drift-reply-0001";

/** The assistant records of the stalled turn (after the user's "да"). */
const userPromptAt = Date.parse(fx.jsonl.find((r) => r.type === "user" && r.message?.content === "да")!.timestamp);
const stalledReply = fx.jsonl.filter((r) => r.type === "assistant" && Date.parse(r.timestamp) > userPromptAt);
/** The previous turn's answer — bun DID deliver it (14:45). */
const deliveredBefore = fx.jsonl.filter((r) => r.type === "assistant" && Date.parse(r.timestamp) < userPromptAt);

function mockSocket(data: Record<string, unknown>) {
  return { data, send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}
function sentFrames(sock: { send: { mock: { calls: unknown[][] } } }): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const [arg] of sock.send.mock.calls) {
    for (const line of String(arg).split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* not JSON */ }
    }
  }
  return out;
}

let home: string;
let prevHome: string | undefined;
let storeDir: string;
let store: SessionStore;
let bridge: WsBridge;

beforeEach(() => {
  vi.useFakeTimers();
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "drift-reply-home-"));
  process.env.HOME = home;
  storeDir = mkdtempSync(join(tmpdir(), "drift-reply-store-"));
  store = new SessionStore(storeDir);
  bridge = new WsBridge();
  bridge.setStore(store);
  companionBus.clear();
  deliveryMetrics.reset({ stallThresholdMs: 60_000 });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env.HOME = prevHome;
  deliveryMetrics.reset();
  store.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
  companionBus.clear();
});

/**
 * Bring the bridge to the state bun was in at 15:03:37: the previous answer
 * delivered earlier (as live stdout frames), then the recorded spawn replayed
 * frame by frame at its recorded wall-clock times. Writes the CLI's jsonl.
 */
function replayToDetection() {
  const browser = mockSocket({ kind: "browser", sessionId: SESSION_ID });
  bridge.handleBrowserOpen(browser, SESSION_ID);
  const cli = mockSocket({ kind: "cli", sessionId: SESSION_ID });

  const start = fx.recording[0].ts;
  vi.setSystemTime(start - 60_000);
  bridge.handleCLIOpen(cli, SESSION_ID);
  // The previous turn's answer reached bun as stdout frames (same message
  // object as its jsonl record — the CLI writes them byte-identical).
  for (const r of deliveredBefore) {
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "assistant", message: r.message, parent_tool_use_id: null, session_id: CLI_SID, uuid: r.uuid }) + "\n");
  }
  for (const f of fx.recording) {
    vi.setSystemTime(f.ts);
    if (f.ch === "browser" && f.raw) bridge.handleBrowserMessage(browser, JSON.stringify(f.raw));
    else if (f.dir === "in" && f.raw) bridge.handleCLIMessage(cli, JSON.stringify(f.raw) + "\n");
  }

  const paths = resolveCliSessionPaths(join(home, ".claude"), CWD, CLI_SID)!;
  mkdirSync(dirname(paths.jsonlPath), { recursive: true });
  writeFileSync(paths.jsonlPath, fx.jsonl.map((r) => JSON.stringify(r)).join("\n") + "\n");
  utimesSync(paths.jsonlPath, fx.jsonlMtimeMs / 1000, fx.jsonlMtimeMs / 1000);
  vi.setSystemTime(fx.detectedAtMs);
  return { browser, cli, paths };
}

function makeRecovery() {
  const info = {
    sessionId: SESSION_ID, state: "connected", cwd: CWD, cliSessionId: CLI_SID, pid: 4242, createdAt: 0, backendType: "claude",
  } as SdkSessionInfo;
  const order: string[] = [];
  const launcher = {
    getSession: vi.fn(() => info),
    listSessions: vi.fn(() => [info]),
    getStartingSessions: vi.fn(() => []),
    kill: vi.fn(async () => { order.push("kill"); return true; }),
    relaunch: vi.fn(async () => { order.push("relaunch"); return { ok: true }; }),
    setModel: vi.fn(),
  };
  const recovery = new SessionRecovery({
    launcher: launcher as unknown as CliLauncher,
    wsBridge: bridge,
    intentionalKills: new IntentionalKills(),
    onRelaunchSucceeded: vi.fn(),
    noteApiLimitReached: vi.fn(),
    readWaitChannels: () => fx.waitChannels,
    subagentActivitySince: () => false,
    subagentOpenToolCallSince: () => false,
  });
  return { recovery, launcher, order };
}

function assistantFramesTo(browser: any, ids: Set<string>) {
  return sentFrames(browser).filter((j) => j.type === "assistant" && ids.has(j.message?.id));
}

describe("drift recovery delivers the reply the CLI wrote only to its jsonl (W1, 40f03a1e)", () => {
  it("fixture sanity: bun's last CLI frame is system.init; the whole reply is in the jsonl after it", () => {
    const lastIn = fx.recording.filter((f) => f.dir === "in" && f.ch === "cli" && f.raw).at(-1)!;
    expect(lastIn.raw).toMatchObject({ type: "system", subtype: "init" });
    expect(stalledReply.map((r) => r.message.content[0].type)).toEqual(["thinking", "tool_use", "thinking", "text"]);
    expect(stalledReply.at(-1)!.message.stop_reason).toBe("end_turn");
    for (const r of stalledReply) expect(Date.parse(r.timestamp)).toBeGreaterThan(lastIn.ts);
  });

  it("the drift tick kills, delivers every stalled record to the browser + history, then relaunches", async () => {
    const { browser } = replayToDetection();
    const { recovery, launcher, order } = makeRecovery();
    const replyIds = new Set(stalledReply.map((r) => r.message.id as string));
    expect(assistantFramesTo(browser, replyIds)).toHaveLength(0); // the bug's starting point

    browser.send.mockClear();
    recovery.driftDetectorTick();
    await vi.advanceTimersByTimeAsync(1);

    expect(launcher.kill).toHaveBeenCalledWith(SESSION_ID);
    expect(order).toEqual(["kill", "relaunch"]);

    // Browser: the four records, in jsonl order, with the CLI's exact content.
    const got = assistantFramesTo(browser, replyIds);
    expect(got.map((j) => j.message.content)).toEqual(stalledReply.map((r) => r.message.content));
    expect(got.every((j) => j.parent_tool_use_id === null)).toBe(true);
    expect(got.at(-1)!.message.content[0].text).toBe(stalledReply.at(-1)!.message.content[0].text);

    // History (what a reconnecting browser / page reload gets): same, once.
    const history = bridge.getSession(SESSION_ID)!.messageHistory.filter(
      (m) => m.type === "assistant" && replyIds.has((m as any).message.id),
    );
    expect(history.map((m: any) => m.message.content)).toEqual(stalledReply.map((r) => r.message.content));

    // The previously delivered answer is NOT re-sent.
    const prevIds = new Set(deliveredBefore.map((r) => r.message.id as string));
    expect(assistantFramesTo(browser, prevIds)).toHaveLength(0);
  });

  it("exactly once: records bun already got are skipped, and a second recovery delivers nothing new", async () => {
    const { browser, cli, paths } = replayToDetection();
    // Variant: the first stalled block (thinking) DID reach bun, at the moment
    // the CLI wrote it, before stdout froze.
    vi.setSystemTime(Date.parse(stalledReply[0].timestamp));
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "assistant", message: stalledReply[0].message, parent_tool_use_id: null, session_id: CLI_SID, uuid: stalledReply[0].uuid }) + "\n");
    vi.setSystemTime(fx.detectedAtMs);
    const replyIds = new Set(stalledReply.map((r) => r.message.id as string));
    browser.send.mockClear();

    const { recovery } = makeRecovery();
    recovery.driftDetectorTick();
    await vi.advanceTimersByTimeAsync(1);
    expect(assistantFramesTo(browser, replyIds).map((j) => j.message.content)).toEqual(
      stalledReply.slice(1).map((r) => r.message.content),
    );

    const again = bridge.deliverRecoveredAssistantRecords(SESSION_ID, readUndeliveredAssistantRecords(paths.jsonlPath, 0));
    expect(again.delivered).toBe(0);
    const history = bridge.getSession(SESSION_ID)!.messageHistory.filter(
      (m) => m.type === "assistant" && replyIds.has((m as any).message.id),
    );
    expect(history).toHaveLength(stalledReply.length);
  });
});
