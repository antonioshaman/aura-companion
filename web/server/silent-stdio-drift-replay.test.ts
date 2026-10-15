import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { companionBus } from "./event-bus.js";
import { IntentionalKills } from "./intentional-kills.js";
import { log } from "./logger.js";
import { SessionRecovery } from "./session-recovery.js";
import {
  checkDrift,
  countAssistantRecordsBetween,
  countUndeliveredAssistantRecords,
  defaultSubagentActivitySince,
  resolveCliSessionPaths,
  SUBAGENT_ACTIVITY_SUBDIRS,
  SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION,
} from "./silent-stdio-drift-detector.js";

// PLAN Task 5 (EC-6): replay regression fixtures for the drift kill decision,
// plus a CLI-version canary for the on-disk layout the liveness gate rests on.
//
// Fixture: `fixtures/drift/cli-2.1.283/` — record shapes copied from a real
// CLI 2.1.283 session (same keys, content replaced by placeholders):
//   projects/-root-proj/<cliSid>.jsonl                 main chain, all isSidechain:false
//   projects/-root-proj/<cliSid>/subagents/agent-*.jsonl  Task subagent, isSidechain:true
//   projects/-root-proj/<cliSid>/tool-results/*         spilled tool output
//   recording.jsonl                                    recorder v3: what bun RECEIVED (dir=in, ch=cli)
//
// The incident shape (prod 2026-10-14): bun's last CLI frame is the Task
// tool_use (T-290 s); the CLI then wrote two more main-chain assistant records
// to its jsonl (T-120 s, T-60 s) that never reached stdout, while the subagent
// kept working in the sibling tree. The negative and positive scenarios replay
// the SAME bytes and differ only in liveness evidence (subagent mtimes + the
// CLI's kernel wait channels) — which is exactly what the kill decision must
// discriminate on.

const FIXTURE = join(import.meta.dirname, "fixtures", "drift", `cli-${SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION}`);
const CWD = "/root/proj";
const CLI_SID = "7c1e0f2a-5b3d-4e8f-9a6c-1d2e3f4a5b6c";
/** The fixture's reference "now" (2026-10-14T12:00:00Z); record timestamps are relative to it. */
const NOW = Date.parse("2026-10-14T12:00:00.000Z");

const fixturePaths = resolveCliSessionPaths(join(FIXTURE), CWD, CLI_SID)!;

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * bun's freshness clock as the recording proves it: the timestamp of the last
 * frame bun RECEIVED from the CLI (dir=in on the cli channel). A recorded
 * `out` frame is intent, not delivery, and lifecycle events carry no payload.
 */
function lastCliFrameReceivedMs(recordingPath: string): number {
  let last = 0;
  for (const e of readJsonl(recordingPath)) {
    if (e._header) continue;
    if (e.dir === "in" && e.ch === "cli" && !e.event && typeof e.ts === "number") last = Math.max(last, e.ts);
  }
  return last;
}

describe("drift fixture — CLI layout canary (PLAN Task 5)", () => {
  // These pin the layout the liveness gate depends on. When a CLI bump changes
  // it, refresh the fixture from a real session of the new version and bump
  // SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION in the same change — the tests force
  // both to move together.

  it("every main-chain record is from the verified CLI version and none is a sidechain", () => {
    const main = readJsonl(fixturePaths.jsonlPath);
    expect(main.length).toBeGreaterThan(0);
    for (const r of main) {
      expect(r.version).toBe(SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION);
      expect(r.isSidechain).toBe(false);
      expect(typeof r.parentToolUseID).not.toBe("string");
    }
  });

  it("the init frame bun received reports the verified CLI version", () => {
    const init = readJsonl(join(FIXTURE, "recording.jsonl"))
      .filter((e) => e.dir === "in" && e.ch === "cli")
      .map((e) => JSON.parse(e.raw as string) as Record<string, unknown>)
      .find((f) => f.type === "system" && f.subtype === "init");
    expect(init?.claude_code_version).toBe(SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION);
    expect(init?.session_id).toBe(CLI_SID);
  });

  it("subagent output lives in the sibling tree as flat regular files, flagged isSidechain:true", () => {
    // resolveCliSessionPaths derives the sibling dir; it must hold exactly the
    // subdirs the gate scans, each a flat set of regular files.
    expect(readdirSync(fixturePaths.sessionDir).sort()).toEqual([...SUBAGENT_ACTIVITY_SUBDIRS].sort());
    for (const sub of SUBAGENT_ACTIVITY_SUBDIRS) {
      for (const name of readdirSync(join(fixturePaths.sessionDir, sub))) {
        expect(lstatSync(join(fixturePaths.sessionDir, sub, name)).isFile()).toBe(true);
      }
    }
    const agents = readdirSync(join(fixturePaths.sessionDir, "subagents")).filter((n) => n.endsWith(".jsonl"));
    expect(agents).toEqual(["agent-afixture01.jsonl"]);
    for (const r of readJsonl(join(fixturePaths.sessionDir, "subagents", agents[0]))) {
      expect(r.isSidechain).toBe(true);
      expect(r.agentId).toBe("afixture01");
      expect(r.version).toBe(SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION);
    }
  });

  it("id/role/content extraction: the delivered assistant message id is the one bun received; the stuck ones are not", () => {
    // message.id (msg_…) is the stdout↔jsonl join key (dahl, PLAN watchpoints).
    const assistants = readJsonl(fixturePaths.jsonlPath).filter((r) => r.type === "assistant");
    const msgs = assistants.map((r) => r.message as { id: string; role: string; content: Array<{ type: string }> });
    for (const m of msgs) {
      expect(m.id).toMatch(/^msg_/);
      expect(m.role).toBe("assistant");
      expect(Array.isArray(m.content) && m.content.length > 0).toBe(true);
    }
    const received = readJsonl(join(FIXTURE, "recording.jsonl"))
      .filter((e) => e.dir === "in" && e.ch === "cli")
      .map((e) => JSON.parse(e.raw as string) as { type?: string; message?: { id?: string } })
      .filter((f) => f.type === "assistant")
      .map((f) => f.message?.id);
    expect(received).toEqual(["msg_fixture_0001"]);
    expect(msgs.map((m) => m.id).filter((id) => !received.includes(id))).toEqual(["msg_fixture_0002", "msg_fixture_0003"]);
  });

  it("the undelivered counter sees the two stuck main-chain records and ignores the subagent file", () => {
    const bunLast = lastCliFrameReceivedMs(join(FIXTURE, "recording.jsonl"));
    expect(bunLast).toBe(NOW - 290_000);
    expect(countAssistantRecordsBetween(readFileSync(fixturePaths.jsonlPath, "utf8"), bunLast, NOW - 10_000)).toBe(2);
    const agentFile = join(fixturePaths.sessionDir, "subagents", "agent-afixture01.jsonl");
    expect(countAssistantRecordsBetween(readFileSync(agentFile, "utf8"), bunLast, NOW)).toBe(0);
  });
});

describe("drift replay — council turn vs genuine stdout death (PLAN Task 5, EC-6)", () => {
  let home: string;
  let prevHome: string | undefined;
  let paths: { jsonlPath: string; sessionDir: string };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.restoreAllMocks();
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "drift-replay-"));
    process.env.HOME = home;
    // Replay the exact bytes (no parse → re-serialize round trip).
    mkdirSync(join(home, ".claude"), { recursive: true });
    cpSync(join(FIXTURE, "projects"), join(home, ".claude", "projects"), { recursive: true });
    paths = resolveCliSessionPaths(join(home, ".claude"), CWD, CLI_SID)!;
    expect(readFileSync(paths.jsonlPath).equals(readFileSync(fixturePaths.jsonlPath))).toBe(true);
    // The CLI just wrote the queued prompt to its jsonl.
    setMtime(paths.jsonlPath, NOW - 5_000);
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.useRealTimers();
    companionBus.clear();
  });

  function setMtime(path: string, atMs: number) {
    utimesSync(path, atMs / 1000, atMs / 1000);
  }

  /** Age every file of the sibling tree to `atMs` (the subagents' last write). */
  function setSubagentTreeMtime(atMs: number) {
    for (const sub of SUBAGENT_ACTIVITY_SUBDIRS) {
      for (const name of readdirSync(join(paths.sessionDir, sub))) setMtime(join(paths.sessionDir, sub, name), atMs);
    }
  }

  function makeTick(waitChannels: string) {
    const bunLastFrameMs = lastCliFrameReceivedMs(join(FIXTURE, "recording.jsonl"));
    const session = { sessionId: "s1", state: "running", cwd: CWD, cliSessionId: CLI_SID, pid: 4242, createdAt: 0 } as SdkSessionInfo;
    const launcher = {
      getSession: vi.fn(() => session),
      listSessions: vi.fn(() => [session]),
      getStartingSessions: vi.fn(() => []),
      relaunch: vi.fn(async () => ({ ok: true })),
      kill: vi.fn(async () => true),
      setModel: vi.fn(),
    };
    const adapter = Object.create(ClaudeAdapter.prototype) as ClaudeAdapter;
    adapter.getLastCliFrameReceivedMs = () => bunLastFrameMs;
    const wsBridge = {
      isCliConnected: vi.fn(() => true),
      getSession: vi.fn(() => ({ backendAdapter: adapter, state: { claude_code_version: SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION } })),
      broadcastToSession: vi.fn(),
      // A queued prompt is present in both scenarios — it must not decide.
      getSessionPendingMessageCount: vi.fn(() => 1),
    };
    const recovery = new SessionRecovery({
      launcher: launcher as unknown as CliLauncher,
      wsBridge: wsBridge as unknown as WsBridge,
      intentionalKills: new IntentionalKills(),
      onRelaunchSucceeded: vi.fn(),
      noteApiLimitReached: vi.fn(),
      readWaitChannels: () => waitChannels,
    });
    return { recovery, launcher, bunLastFrameMs };
  }

  it("NEGATIVE — council turn with a live subagent tree and no pipe_write: drifted=false, live_subagent_activity, no kill", async () => {
    setSubagentTreeMtime(NOW - 10_000); // subagent wrote 10 s ago
    const { recovery, launcher, bunLastFrameMs } = makeTick("futex_wait_queue×9, ep_poll×2");

    const verdict = checkDrift(
      { sessionId: "s1", bunLastFrameMs, jsonlPath: paths.jsonlPath, sessionDir: paths.sessionDir },
      { undeliveredOutput: countUndeliveredAssistantRecords, subagentActivitySince: defaultSubagentActivitySince },
    );
    expect(verdict).toMatchObject({ drifted: false, suppressedReason: "live_subagent_activity", undeliveredAssistantRecords: 2 });

    const info = vi.spyOn(log, "info");
    recovery.driftDetectorTick();
    await vi.advanceTimersByTimeAsync(1);
    expect(launcher.kill).not.toHaveBeenCalled();
    expect(launcher.relaunch).not.toHaveBeenCalled();
    const suppressed = info.mock.calls.find((c) => (c[2] as { event?: string })?.event === "silent_stdio_drift.suppressed");
    expect(suppressed?.[2]).toMatchObject({ reason: "live_subagent_activity", undeliveredAssistantRecords: 2, pendingMessages: 1 });
  });

  it("POSITIVE — genuine stdout death (tree idle, pipe_write): drifted=true and the kill → --resume relaunch fires", async () => {
    setSubagentTreeMtime(NOW - 400_000); // fan-out finished before bun's last frame
    const { recovery, launcher, bunLastFrameMs } = makeTick("pipe_write×1, futex_wait_queue×8");

    const verdict = checkDrift(
      { sessionId: "s1", bunLastFrameMs, jsonlPath: paths.jsonlPath, sessionDir: paths.sessionDir },
      { undeliveredOutput: countUndeliveredAssistantRecords, subagentActivitySince: defaultSubagentActivitySince },
    );
    expect(verdict).toMatchObject({ drifted: true, suppressedReason: null, undeliveredAssistantRecords: 2 });

    recovery.driftDetectorTick();
    await vi.advanceTimersByTimeAsync(1);
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(launcher.relaunch).toHaveBeenCalledWith("s1");
    expect(launcher.kill.mock.invocationCallOrder[0]).toBeLessThan(launcher.relaunch.mock.invocationCallOrder[0]);
  });

  it("WEDGE — the subagent finished after stdout died but went quiet past the window: still recovers (review #1)", async () => {
    // The subagent tree last wrote 6 min ago — older than the 5 min liveness
    // window, but AFTER bun's (frozen) last frame. Measured "since bun's last
    // frame" this stale write suppressed forever; measured against now it does not.
    setSubagentTreeMtime(NOW - 360_000 + 1);
    const { recovery, launcher, bunLastFrameMs } = makeTick("futex_wait_queue×9, ep_poll×2");
    // bun's clock froze before the fan-out finished (T-490 s).
    const frozen = bunLastFrameMs - 200_000; // T-490 s
    (recovery as unknown as { wsBridge: { getSession: ReturnType<typeof vi.fn> } }).wsBridge.getSession.mockImplementation(() => {
      const a = Object.create(ClaudeAdapter.prototype) as ClaudeAdapter;
      a.getLastCliFrameReceivedMs = () => frozen;
      return { backendAdapter: a, state: { claude_code_version: SUBAGENT_LAYOUT_VERIFIED_CLI_VERSION } };
    });
    expect(NOW - 360_000 + 1).toBeGreaterThan(frozen);
    recovery.driftDetectorTick();
    await vi.advanceTimersByTimeAsync(1);
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });
});
