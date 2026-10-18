import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import { companionBus } from "./event-bus.js";
import { IntentionalKills } from "./intentional-kills.js";
import { log } from "./logger.js";
import { DEFAULT_LAG_TOLERANCE_MS, resolveJsonlPath, SUBAGENT_LIVENESS_WINDOW_MS } from "./silent-stdio-drift-detector.js";
import type { SessionRecoveryDeps } from "./session-recovery.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BOOT_RESUME_STAGGER_MS,
  decideDriftAction,
  decideDriftKill,
  DRIFT_RECOVERY_RATE_MAX,
  DRIFT_RECOVERY_RATE_WINDOW_MS,
  pruneDriftRecoveries,
  waitChannelsShowPipeWrite,
  DRIFT_DETECTOR_TICK_MS,
  KEEPALIVE_BASE_DELAY_MS,
  MAX_AUTO_RELAUNCHES,
  RECONNECT_GRACE_MS,
  RELAUNCH_COOLDOWN_MS,
  RELAUNCH_GRACE_MS,
  RELAUNCH_SETTLE_MS,
  SessionRecovery,
} from "./session-recovery.js";

// P4/C1d: auto-relaunch, keepalive, silence/model-fallback recovery, the drift
// detector and the boot reconnection watchdog were extracted verbatim from
// session-orchestrator.ts. The orchestrator suite still pins their behaviour
// end-to-end (it drives them through the bus). These tests pin the NEW seam:
// the controller works with nothing but its DI deps, it reads the
// orchestrator-owned `intentionalKills` set LIVE (not a copy taken at
// construction), and the council/auto-proceed follow-ups reach the injected
// callbacks instead of being dropped.

function info(sessionId: string, overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return { sessionId, state: "exited", cwd: "/tmp", createdAt: 0, ...overrides } as SdkSessionInfo;
}

function makeRecovery(
  sessions: Map<string, SdkSessionInfo>,
  extraDeps: Pick<SessionRecoveryDeps, "readWaitChannels" | "subagentActivitySince"> = {},
) {
  const launcher = {
    getSession: vi.fn((id: string) => sessions.get(id)),
    listSessions: vi.fn(() => [...sessions.values()]),
    getStartingSessions: vi.fn(() => [...sessions.values()].filter((s) => s.state === "starting")),
    relaunch: vi.fn(async (_id: string): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
    kill: vi.fn(async () => true),
    setModel: vi.fn(),
  };
  const wsBridge = {
    isCliConnected: vi.fn(() => false),
    getSession: vi.fn(() => undefined),
    broadcastToSession: vi.fn(),
    recordModelFallback: vi.fn(),
    recordContextAdvisory: vi.fn(() => true),
    // #327: the drift tick asks how many user messages are queued for the
    // session before honouring a suppression. Default: none queued.
    getSessionPendingMessageCount: vi.fn(() => 0),
  };
  // P4/FIX-AUTOHEAL-1: the orchestrator's set carries relaunch-mark ownership.
  const intentionalKills = new IntentionalKills();
  const onRelaunchSucceeded = vi.fn();
  const noteApiLimitReached = vi.fn();
  const recovery = new SessionRecovery({
    launcher: launcher as unknown as CliLauncher,
    wsBridge: wsBridge as unknown as WsBridge,
    intentionalKills,
    onRelaunchSucceeded,
    noteApiLimitReached,
    ...extraDeps,
  });
  return { recovery, launcher, wsBridge, intentionalKills, onRelaunchSucceeded, noteApiLimitReached };
}

describe("SessionRecovery (P4/C1d DI seam)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    companionBus.clear();
  });

  it("reads the injected intentionalKills set live — a kill marked after construction blocks keepalive", () => {
    // Guards against the controller snapshotting the set at construction:
    // archive/delete/group-degrade in the orchestrator add to it later.
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, intentionalKills } = makeRecovery(sessions);
    intentionalKills.add("s1");
    recovery.scheduleProactiveRelaunch("s1");
    expect([...recovery.keepaliveSessionIds()]).toEqual([]);

    intentionalKills.delete("s1");
    recovery.scheduleProactiveRelaunch("s1");
    expect([...recovery.keepaliveSessionIds()]).toEqual(["s1"]);
    // Sweep-orphans clears through the same teardown.
    recovery.cancelKeepaliveTimer("s1");
    expect([...recovery.keepaliveSessionIds()]).toEqual([]);
  });

  it("keepalive fires the auto-relaunch after the backoff and hands success to onRelaunchSucceeded", async () => {
    // The got-050 spawn-checkpoint re-arm lives in the orchestrator; the
    // controller must call it on every successful automatic relaunch.
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, launcher, intentionalKills, onRelaunchSucceeded } = makeRecovery(sessions);
    let markedDuringRelaunch = false;
    launcher.relaunch.mockImplementation(async () => {
      markedDuringRelaunch = intentionalKills.has("s1");
      return { ok: true };
    });

    recovery.scheduleProactiveRelaunch("s1");
    await vi.advanceTimersByTimeAsync(KEEPALIVE_BASE_DELAY_MS + RELAUNCH_GRACE_MS);

    expect(launcher.relaunch).toHaveBeenCalledWith("s1");
    expect(onRelaunchSucceeded).toHaveBeenCalledWith("s1");
    // CR-12: intentional mark set during the relaunch, cleared in finally.
    expect(markedDuringRelaunch).toBe(true);
    expect(intentionalKills.has("s1")).toBe(false);
  });

  it("a user-stopped session is not auto-relaunched until the mark is cleared (P4/KILL-INTENTIONAL)", async () => {
    // Unlike an idle-kill, a user stop must survive a returning browser and
    // the transport-drop `session:relaunch-needed`; clearing the mark (explicit
    // relaunch / new user message) makes the same path relaunch again.
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, launcher } = makeRecovery(sessions);
    recovery.markStoppedByUser("s1");
    await recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    expect(launcher.relaunch).not.toHaveBeenCalled();

    expect(recovery.clearStoppedByUser("s1")).toBe(true);
    expect(recovery.clearStoppedByUser("s1")).toBe(false);
    const p = recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    await p;
    expect(launcher.relaunch).toHaveBeenCalledWith("s1");

    // Delete drops the mark with the rest of the bookkeeping.
    recovery.markStoppedByUser("s1");
    recovery.forgetSession("s1");
    expect(recovery.isStoppedByUser("s1")).toBe(false);
  });

  it("exhausts the budget, emits session:relaunch-failed once, and clearAutoRelaunchCount restores it", async () => {
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, launcher, onRelaunchSucceeded } = makeRecovery(sessions);
    launcher.relaunch.mockResolvedValue({ ok: false });
    const failed: Array<{ sessionId: string; reason: string }> = [];
    companionBus.on("session:relaunch-failed", (p) => {
      failed.push(p);
    });

    for (let i = 0; i < MAX_AUTO_RELAUNCHES; i++) {
      const p = recovery.handleAutoRelaunch("s1");
      await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
      await p;
      await vi.advanceTimersByTimeAsync(RELAUNCH_COOLDOWN_MS);
    }
    expect(launcher.relaunch).toHaveBeenCalledTimes(MAX_AUTO_RELAUNCHES);
    expect(recovery.isRelaunchExhausted("s1")).toBe(false);

    const last = recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    await last;
    expect(recovery.isRelaunchExhausted("s1")).toBe(true);
    expect(failed).toEqual([{ sessionId: "s1", reason: "budget_exhausted" }]);
    expect(onRelaunchSucceeded).not.toHaveBeenCalled();

    recovery.clearAutoRelaunchCount("s1");
    expect(recovery.isRelaunchExhausted("s1")).toBe(false);
  });

  it("rate-limit fallback pauses auto-proceed via the injected callback and does not kill", async () => {
    const sessions = new Map([["s1", info("s1", { state: "running", model: "claude-opus-4-8" })]]);
    const { recovery, launcher, noteApiLimitReached } = makeRecovery(sessions);
    await recovery.handleModelFallback("s1", "claude-opus-4-8", "claude-sonnet-4-6", "rate_limit");
    expect(noteApiLimitReached).toHaveBeenCalledWith("s1");
    expect(launcher.kill).not.toHaveBeenCalled();
    expect(launcher.setModel).not.toHaveBeenCalled();
  });

  it("unknown-model chain fallback records a persistent from→to notice (Task A.2), not just a toast", async () => {
    // The user must see WHICH model they were moved off and onto, and why,
    // in a notice that survives a reload — recorded on the bridge state.
    const sessions = new Map([["s1", info("s1", { state: "running", model: "claude-opus-4-8" })]]);
    const { recovery, launcher, wsBridge } = makeRecovery(sessions);
    await recovery.handleModelFallback("s1", "<synthetic>", "<resolve-at-orchestrator>", "unknown_model");
    expect(launcher.setModel).toHaveBeenCalledWith("s1", "claude-opus-4-7");
    expect(wsBridge.recordModelFallback).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ from: "claude-opus-4-8", to: "claude-opus-4-7", reason: "unavailable" }),
    );
  });

  it("silence rotation records a persistent 'unresponsive' fallback notice (Task A.2)", async () => {
    const sessions = new Map([["s1", info("s1", { state: "running", model: "claude-opus-4-8" })]]);
    const { recovery, wsBridge } = makeRecovery(sessions);
    await recovery.handleBackendSilent("s1", 300_000, "silent_stdio_watchdog");
    await recovery.handleBackendSilent("s1", 300_000, "silent_stdio_watchdog");
    expect(wsBridge.recordModelFallback).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ from: "claude-opus-4-8", to: "claude-opus-4-7", reason: "unresponsive" }),
    );
  });

  it("silence strikes accumulate per session and reset on noteTurnSucceeded", async () => {
    const sessions = new Map([["s1", info("s1", { state: "running", model: "claude-opus-4-8" })]]);
    const { recovery, launcher } = makeRecovery(sessions);
    await recovery.handleBackendSilent("s1", 300_000, "silent_stdio_watchdog");
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(recovery.silenceRecurrenceCounts.get("s1")?.count).toBe(1);
    recovery.noteTurnSucceeded("s1");
    expect(recovery.silenceRecurrenceCounts.has("s1")).toBe(false);
  });

  it("boot watchdog relaunches sessions still starting after the grace, re-arming only on success", async () => {
    const sessions = new Map([
      ["ok", info("ok", { state: "starting" })],
      ["bad", info("bad", { state: "starting" })],
      ["arch", info("arch", { state: "starting", archived: true })],
    ]);
    const { recovery, launcher, onRelaunchSucceeded } = makeRecovery(sessions);
    launcher.relaunch.mockImplementation(async (id: string) => ({ ok: id === "ok" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    recovery.startReconnectionWatchdog();
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS);

    expect(launcher.relaunch.mock.calls.map((c) => c[0])).toEqual(["ok", "bad"]);
    expect(onRelaunchSucceeded.mock.calls).toEqual([["ok"]]);
  });

  it("forgetSession drops relaunch bookkeeping; drift detector start/stop are idempotent", async () => {
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, launcher } = makeRecovery(sessions);
    recovery.relaunchExhaustedNotified.add("s1");
    recovery.forgetSession("s1");
    expect(recovery.isRelaunchExhausted("s1")).toBe(false);

    recovery.startDriftDetector();
    recovery.startDriftDetector();
    expect(vi.getTimerCount()).toBe(1);
    recovery.stopDriftDetector();
    recovery.stopDriftDetector();
    expect(vi.getTimerCount()).toBe(0);
    expect(launcher.kill).not.toHaveBeenCalled();
  });

  it("drift detector ticks every 15s so silent-stdio drift heals within ~105s", async () => {
    // P4/DRIFT-15S: the tick was 60s (auto-heal window ≈ 60 + 90 = 150s).
    // Pin both the interval actually passed to setInterval (a tick fires at
    // 15s, not before) and the resulting worst-case window: tick + the
    // detector's lag tolerance must stay ≤ 105s, well under the 300s
    // adapter watchdog.
    expect(DRIFT_DETECTOR_TICK_MS).toBe(15_000);
    expect(DRIFT_DETECTOR_TICK_MS + DEFAULT_LAG_TOLERANCE_MS).toBeLessThanOrEqual(105_000);

    const { recovery } = makeRecovery(new Map());
    const tick = vi.spyOn(recovery, "driftDetectorTick").mockImplementation(() => {});
    recovery.startDriftDetector();

    await vi.advanceTimersByTimeAsync(DRIFT_DETECTOR_TICK_MS - 1);
    expect(tick).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DRIFT_DETECTOR_TICK_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    recovery.stopDriftDetector();
  });
});

// P4/FIX-AUTOHEAL-1 item 1: every relaunch path goes through one per-session
// single-flight gate. Before it, after a server restart the boot watchdog
// (RECONNECT_GRACE_MS) and the observer catch-up poll → auto-heal (30 s) fired
// together and each called launcher.relaunch → two CLIs `--resume`d on one
// cliSessionId, one orphaned. Same race with handleAutoRelaunch while a fresh
// Codex CLI is still `starting` (~16 s init).
describe("SessionRecovery.relaunchOnce — single-flight (P4/FIX-AUTOHEAL-1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    companionBus.clear();
  });

  /** launcher.relaunch that stays pending until the test resolves it. */
  function deferredRelaunch(launcher: ReturnType<typeof makeRecovery>["launcher"]) {
    const pending: Array<(r: { ok: boolean; error?: string }) => void> = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    launcher.relaunch.mockImplementation(
      () =>
        new Promise((resolve) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          pending.push((r) => {
            concurrent--;
            resolve(r);
          });
        }),
    );
    return { pending, maxConcurrent: () => maxConcurrent };
  }

  it("parallel auto-heal + boot-watchdog calls spawn ONE process and share its result", async () => {
    const sessions = new Map([["s1", info("s1", { state: "starting" })]]);
    const { recovery, launcher, onRelaunchSucceeded } = makeRecovery(sessions);
    const d = deferredRelaunch(launcher);

    const heal = recovery.relaunchOnce("s1", "autoheal", {});
    const boot = recovery.relaunchOnce("s1", "boot_watchdog");
    expect(recovery.isRelaunchInFlight("s1")).toBe(true);
    d.pending[0]({ ok: true });
    await expect(heal).resolves.toEqual({ ok: true });
    await expect(boot).resolves.toEqual({ ok: true });

    expect(launcher.relaunch).toHaveBeenCalledTimes(1);
    // The got-050 follow-up runs once per real relaunch, not once per caller.
    expect(onRelaunchSucceeded).toHaveBeenCalledTimes(1);
    expect(recovery.isRelaunchInFlight("s1")).toBe(false);
  });

  it("the boot watchdog joins an auto-heal relaunch already in flight", async () => {
    const sessions = new Map([["s1", info("s1", { state: "starting" })]]);
    const { recovery, launcher } = makeRecovery(sessions);
    const d = deferredRelaunch(launcher);

    recovery.startReconnectionWatchdog();
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS - 1_000);
    const heal = recovery.relaunchOnce("s1", "autoheal", {});
    await vi.advanceTimersByTimeAsync(2_000);
    d.pending[0]({ ok: true });
    await heal;
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);
  });

  it("handleAutoRelaunch neither relaunches again nor spends budget while another relaunch runs or settles", async () => {
    const sessions = new Map([["s1", info("s1", { state: "starting" })]]);
    const { recovery, launcher } = makeRecovery(sessions);
    const d = deferredRelaunch(launcher);

    const heal = recovery.relaunchOnce("s1", "autoheal", {});
    const auto = recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    await auto;
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);

    d.pending[0]({ ok: true });
    await heal;
    // The fresh CLI is still `starting` with no adapter (Codex init) — the
    // deaf check would have relaunched it; the settle window prevents that.
    await vi.advanceTimersByTimeAsync(10_000);
    const auto2 = recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    await auto2;
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);

    // Budget untouched: MAX_AUTO_RELAUNCHES real attempts are still available.
    sessions.set("s1", info("s1", { state: "exited" }));
    launcher.relaunch.mockResolvedValue({ ok: false });
    for (let i = 0; i < MAX_AUTO_RELAUNCHES; i++) {
      const p = recovery.handleAutoRelaunch("s1");
      await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS + RELAUNCH_COOLDOWN_MS);
      await p;
    }
    expect(launcher.relaunch).toHaveBeenCalledTimes(1 + MAX_AUTO_RELAUNCHES);
    expect(recovery.isRelaunchExhausted("s1")).toBe(false);
  });

  it("automatic sources skip inside the settle window; a manual relaunch always runs; a crashed CLI is not 'settling'", async () => {
    const sessions = new Map([["s1", info("s1", { state: "starting" })]]);
    const { recovery, launcher } = makeRecovery(sessions);

    await recovery.relaunchOnce("s1", "manual", {});
    await expect(recovery.relaunchOnce("s1", "autoheal", {})).resolves.toEqual({
      ok: true,
      skipped: "recently_relaunched",
    });
    await recovery.relaunchOnce("s1", "boot_watchdog");
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);

    await recovery.relaunchOnce("s1", "manual", {});
    expect(launcher.relaunch).toHaveBeenCalledTimes(2);

    // The fresh CLI died (exited) — that is a crash, not a spawn in progress.
    sessions.set("s1", info("s1", { state: "exited" }));
    expect(recovery.isRelaunchSettling("s1")).toBe(false);
    await recovery.relaunchOnce("s1", "autoheal", {});
    expect(launcher.relaunch).toHaveBeenCalledTimes(3);

    // Past the window an automatic relaunch runs again.
    sessions.set("s1", info("s1", { state: "starting" }));
    await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_MS);
    await recovery.relaunchOnce("s1", "boot_watchdog");
    expect(launcher.relaunch).toHaveBeenCalledTimes(4);
  });

  it("a manual relaunch with a different model waits for the running one instead of overlapping it", async () => {
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, launcher } = makeRecovery(sessions);
    const d = deferredRelaunch(launcher);

    const first = recovery.relaunchOnce("s1", "autoheal", {});
    const manual = recovery.relaunchOnce("s1", "manual", { model: "claude-sonnet-5" });
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);
    d.pending[0]({ ok: true });
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.relaunch).toHaveBeenCalledTimes(2);
    expect(launcher.relaunch).toHaveBeenLastCalledWith("s1", { model: "claude-sonnet-5" });
    d.pending[1]({ ok: true });
    await manual;
    expect(d.maxConcurrent()).toBe(1);
  });

  // Item 3 (EC-2): archive marks the session intentional while the relaunch
  // is awaiting the spawn. The relaunch's cleanup must not wipe that mark,
  // and the process it just spawned for an archived session must be killed.
  it("archive during an in-flight relaunch keeps the archive's intentional mark and kills the new process", async () => {
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, launcher, intentionalKills, onRelaunchSucceeded } = makeRecovery(sessions);
    const d = deferredRelaunch(launcher);

    const run = recovery.relaunchOnce("s1", "autoheal", {});
    expect(intentionalKills.has("s1")).toBe(true);
    // Archive path: mark intentional, set archived.
    intentionalKills.add("s1");
    sessions.set("s1", info("s1", { archived: true }));
    d.pending[0]({ ok: true });

    await expect(run).resolves.toMatchObject({ ok: false });
    expect(intentionalKills.has("s1")).toBe(true);
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(onRelaunchSucceeded).not.toHaveBeenCalled();
  });

  it("releases its own intentional mark on failure and on throw (keepalive must not be locked out)", async () => {
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, launcher, intentionalKills } = makeRecovery(sessions);
    launcher.relaunch.mockResolvedValueOnce({ ok: false, error: "boom" });
    await recovery.relaunchOnce("s1", "manual", {});
    expect(intentionalKills.has("s1")).toBe(false);
    launcher.relaunch.mockRejectedValueOnce(new Error("spawn threw"));
    await expect(recovery.relaunchOnce("s1", "manual", {})).rejects.toThrow("spawn threw");
    expect(intentionalKills.has("s1")).toBe(false);
    expect(recovery.isRelaunchInFlight("s1")).toBe(false);
  });

  // P4/FIX-AUTOHEAL-2 (a): Settings → "apply credentials" relaunches WITHOUT
  // a model change. The in-flight automatic relaunch already built its spawn
  // env from the OLD settings, so joining it would silently drop the new
  // credentials. A manual call must wait and then spawn on its own.
  it("a manual relaunch without a model change waits for an in-flight automatic one and runs its own", async () => {
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, launcher, onRelaunchSucceeded } = makeRecovery(sessions);
    const d = deferredRelaunch(launcher);

    const heal = recovery.relaunchOnce("s1", "autoheal", {});
    const manual = recovery.relaunchOnce("s1", "manual", {});
    await vi.advanceTimersByTimeAsync(0);
    // Not overlapping: the manual spawn has not started yet.
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);
    d.pending[0]({ ok: true });
    await heal;
    await vi.advanceTimersByTimeAsync(0);
    // Its own spawn — not the shared result of the automatic one.
    expect(launcher.relaunch).toHaveBeenCalledTimes(2);
    d.pending[1]({ ok: true });
    await expect(manual).resolves.toEqual({ ok: true });
    expect(d.maxConcurrent()).toBe(1);
    expect(onRelaunchSucceeded).toHaveBeenCalledTimes(2);
  });

  // A double-clicked relaunch button: the second manual call is serialized
  // behind the first (never two spawns at once; automatic callers still join).
  it("two manual relaunches back to back run one after the other, never together", async () => {
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, launcher } = makeRecovery(sessions);
    const d = deferredRelaunch(launcher);

    const first = recovery.relaunchOnce("s1", "manual", {});
    const second = recovery.relaunchOnce("s1", "manual", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);
    d.pending[0]({ ok: true });
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.relaunch).toHaveBeenCalledTimes(2);
    d.pending[1]({ ok: true });
    await second;
    expect(d.maxConcurrent()).toBe(1);
  });

  // P4/FIX-AUTOHEAL-2 (c): a CLI that hangs in `starting` (never attaches,
  // never exits). The automatic trigger inside the settle window is skipped;
  // without a re-check nothing would ever try again for an orchestrator.
  it("an automatic trigger skipped inside the settle window re-checks when the window closes and recovers a hung CLI", async () => {
    const sessions = new Map([["s1", info("s1", { state: "starting" })]]);
    const { recovery, launcher } = makeRecovery(sessions);

    await recovery.relaunchOnce("s1", "manual", {});
    await expect(recovery.relaunchOnce("s1", "boot_watchdog")).resolves.toMatchObject({
      skipped: "recently_relaunched",
    });
    // A second skip does not arm a second timer (one recovery, not two).
    await recovery.relaunchOnce("s1", "autoheal", {});
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_MS - 1_000);
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);
    // Window over → handleAutoRelaunch (with its grace period) relaunches.
    await vi.advanceTimersByTimeAsync(1_000 + RELAUNCH_GRACE_MS);
    expect(launcher.relaunch).toHaveBeenCalledTimes(2);
  });

  it("handleAutoRelaunch skipped while settling also re-checks after the window", async () => {
    const sessions = new Map([["s1", info("s1", { state: "starting" })]]);
    const { recovery, launcher } = makeRecovery(sessions);

    await recovery.relaunchOnce("s1", "manual", {});
    const auto = recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    await auto;
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_MS + RELAUNCH_GRACE_MS);
    expect(launcher.relaunch).toHaveBeenCalledTimes(2);
  });

  it("the settle re-check leaves a CLI alone that attached, was stopped by the user, or was archived", async () => {
    // Attached: adapter present on the bridge session → nothing to recover.
    {
      const sessions = new Map([["s1", info("s1", { state: "starting" })]]);
      const { recovery, launcher, wsBridge } = makeRecovery(sessions);
      await recovery.relaunchOnce("s1", "manual", {});
      await recovery.relaunchOnce("s1", "boot_watchdog");
      wsBridge.getSession.mockReturnValue({ backendAdapter: {} } as never);
      await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_MS + RELAUNCH_GRACE_MS);
      expect(launcher.relaunch).toHaveBeenCalledTimes(1);
    }
    // Stopped by the user in the meantime (P4/KILL-INTENTIONAL).
    {
      const sessions = new Map([["s1", info("s1", { state: "starting" })]]);
      const { recovery, launcher } = makeRecovery(sessions);
      await recovery.relaunchOnce("s1", "manual", {});
      await recovery.relaunchOnce("s1", "boot_watchdog");
      recovery.markStoppedByUser("s1");
      await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_MS + RELAUNCH_GRACE_MS);
      expect(launcher.relaunch).toHaveBeenCalledTimes(1);
    }
    // Archived in the meantime.
    {
      const sessions = new Map([["s1", info("s1", { state: "starting" })]]);
      const { recovery, launcher } = makeRecovery(sessions);
      await recovery.relaunchOnce("s1", "manual", {});
      await recovery.relaunchOnce("s1", "boot_watchdog");
      sessions.set("s1", info("s1", { state: "starting", archived: true }));
      await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_MS + RELAUNCH_GRACE_MS);
      expect(launcher.relaunch).toHaveBeenCalledTimes(1);
    }
    // Deleted: forgetSession drops the timer.
    {
      const sessions = new Map([["s1", info("s1", { state: "starting" })]]);
      const { recovery, launcher } = makeRecovery(sessions);
      await recovery.relaunchOnce("s1", "manual", {});
      await recovery.relaunchOnce("s1", "boot_watchdog");
      recovery.forgetSession("s1");
      await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_MS + RELAUNCH_GRACE_MS);
      expect(launcher.relaunch).toHaveBeenCalledTimes(1);
    }
  });

  it("does not release a mark that existed before the relaunch (e.g. an idle-kill)", async () => {
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, intentionalKills } = makeRecovery(sessions);
    intentionalKills.add("s1");
    await recovery.relaunchOnce("s1", "manual", {});
    expect(intentionalKills.has("s1")).toBe(true);
  });
});

describe("SessionRecovery.handleAutoRelaunch — deaf backend (P4/FIX-RECONNECT-RELAUNCH)", () => {
  // Prod 2026-09-29 19:03 → 2026-09-30 06:55: a Codex observer's app-server
  // WS to the bridge dropped. The bridge nulled the adapter and emitted
  // `session:relaunch-needed`, but the process lived on and the launcher kept
  // state `connected`, so handleAutoRelaunch returned silently — six returning
  // browsers logged "requesting relaunch", none relaunched, until a manual
  // POST /relaunch. These tests pin: launcher `connected` without an attached
  // adapter relaunches; with an adapter it is still left alone, but loudly.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    companionBus.clear();
  });

  it("relaunches a session the launcher calls `connected` whose adapter is gone (live PID)", async () => {
    // process.pid is alive, so the old PID-liveness shortcut would also have
    // held it back if it were not gated on the adapter.
    const sessions = new Map([["obs", info("obs", { state: "connected", pid: process.pid, sessionGroupRole: "observer" })]]);
    const { recovery, launcher, wsBridge } = makeRecovery(sessions);
    wsBridge.getSession.mockReturnValue({ backendAdapter: null } as never);

    const p = recovery.handleAutoRelaunch("obs");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    await p;

    expect(launcher.relaunch).toHaveBeenCalledWith("obs");
  });

  it("the same for `running`", async () => {
    const sessions = new Map([["s1", info("s1", { state: "running", pid: process.pid })]]);
    const { recovery, launcher, wsBridge } = makeRecovery(sessions);
    wsBridge.getSession.mockReturnValue({ backendAdapter: null } as never);

    const p = recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    await p;

    expect(launcher.relaunch).toHaveBeenCalledWith("s1");
  });

  it("leaves a `connected` session with an attached adapter alone and logs why (EC-9)", async () => {
    // E.g. Claude over the legacy WS transport mid-reconnect: the adapter
    // object stays attached; that path is owned by the disconnect debounce.
    const sessions = new Map([["s1", info("s1", { state: "connected", pid: process.pid, sessionGroupRole: "orchestrator" })]]);
    const { recovery, launcher, wsBridge } = makeRecovery(sessions);
    wsBridge.getSession.mockReturnValue({ backendAdapter: {} } as never);
    const infoSpy = vi.spyOn(log, "info");

    const p = recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    await p;

    expect(launcher.relaunch).not.toHaveBeenCalled();
    const skip = infoSpy.mock.calls.find((c) => (c[2] as { event?: string } | undefined)?.event === "session.relaunch.skipped_alive");
    expect(skip?.[2]).toMatchObject({ sessionId: "s1", role: "orchestrator", reason: "launcher_state", state: "connected" });
    // relaunchingSet released — the next request is evaluated afresh.
    wsBridge.getSession.mockReturnValue({ backendAdapter: null } as never);
    const p2 = recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    await p2;
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);
  });

  it("logs cli_connected when the backend reconnected during the grace", async () => {
    const sessions = new Map([["s1", info("s1", { state: "connected" })]]);
    const { recovery, launcher, wsBridge } = makeRecovery(sessions);
    wsBridge.isCliConnected.mockReturnValue(true);
    const infoSpy = vi.spyOn(log, "info");

    const p = recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS);
    await p;

    expect(launcher.relaunch).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.some((c) => (c[2] as { reason?: string } | undefined)?.reason === "cli_connected")).toBe(true);
  });
});

// P7/FIX-DRIFT-FALSE-KILLS: the tick wires the undelivered-output evidence
// into the kill decision. A real jsonl under a temp HOME, a ClaudeAdapter
// whose last-frame clock is pinned, fake timers for `now`.
describe("SessionRecovery.driftDetectorTick — undelivered-output gate (P7/FIX-DRIFT-FALSE-KILLS)", () => {
  const NOW = Date.parse("2026-10-01T13:10:52.000Z");
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "drift-tick-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.useRealTimers();
    companionBus.clear();
  });

  function setup(records: Array<{ type: string; atMs: number; message?: object }>, bunLastFrameMs: number, pid?: number) {
    const sessions = new Map([["s1", info("s1", { state: "running", cwd: "/root/proj", cliSessionId: "cli-1", pid })]]);
    const ctx = makeRecovery(sessions);
    const adapter = Object.create(ClaudeAdapter.prototype) as ClaudeAdapter;
    adapter.getLastCliFrameReceivedMs = () => bunLastFrameMs;
    ctx.wsBridge.getSession.mockReturnValue({ backendAdapter: adapter } as never);
    const path = resolveJsonlPath(join(home, ".claude"), "/root/proj", "cli-1")!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, records.map((r) => JSON.stringify({ type: r.type, timestamp: new Date(r.atMs).toISOString(), ...(r.message ? { message: r.message } : {}) })).join("\n") + "\n");
    const mtime = Math.max(...records.map((r) => r.atMs)) / 1000;
    utimesSync(path, mtime, mtime);
    return { ...ctx, path };
  }
  /** Append main-chain records to the session jsonl and bump its mtime (the CLI kept working). */
  function append(path: string, records: Array<{ type: string; atMs: number; message?: object }>) {
    appendFileSync(path, records.map((r) => JSON.stringify({ type: r.type, timestamp: new Date(r.atMs).toISOString(), ...(r.message ? { message: r.message } : {}) })).join("\n") + "\n");
    const mtime = Math.max(...records.map((r) => r.atMs)) / 1000;
    utimesSync(path, mtime, mtime);
  }
  const TOOL_USE = (id: string) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] });
  const TOOL_RESULT = (id: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] });

  it("idle session that just got a prompt: no kill, one suppressed log per stall", () => {
    // Prod shape (2026-10-01T13:10:52): last frame 421 s ago, prompt queued 3 s ago.
    const { recovery, launcher } = setup(
      [
        { type: "queue-operation", atMs: NOW - 3_000 },
        { type: "user", atMs: NOW - 3_000 },
      ],
      NOW - 424_000,
    );
    const info_ = vi.spyOn(log, "info");
    recovery.driftDetectorTick();
    recovery.driftDetectorTick();
    expect(launcher.kill).not.toHaveBeenCalled();
    const suppressed = info_.mock.calls.filter((c) => (c[2] as { event?: string })?.event === "silent_stdio_drift.suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0][2]).toMatchObject({ sessionId: "s1", reason: "no_undelivered_output" });
  });

  it("open main-thread tool call at detection: withholds the kill (once-logged) until the tool_result lands, then relaunches", () => {
    // Owner incident 2026-10-18 (af80e149, 04:14:36): bun's last frame 04:14:08,
    // the CLI wrote thinking/text/tool_use to its jsonl and was executing a
    // Bash call when the kill fired — the command died with exit 137 and the
    // resumed CLI had to redo it. Now the kill waits for that one call.
    const { recovery, launcher, wsBridge, path } = setup(
      [
        { type: "user", atMs: NOW - 100_000 },
        { type: "assistant", atMs: NOW - 60_000, message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
        { type: "assistant", atMs: NOW - 50_000, message: TOOL_USE("t1") },
      ],
      NOW - 110_000,
    );
    const info_ = vi.spyOn(log, "info");
    recovery.driftDetectorTick();
    recovery.driftDetectorTick();
    expect(launcher.kill).not.toHaveBeenCalled();
    const withheld = info_.mock.calls.filter((c) => (c[2] as { event?: string })?.event === "silent_stdio_drift.withheld_open_tool_call");
    expect(withheld).toHaveLength(1);
    expect(withheld[0][2]).toMatchObject({ sessionId: "s1", undeliveredAssistantRecords: 2, toolCallStartedAtMs: NOW - 50_000 });
    // The user learns why nothing moves — once per stall.
    const notices = wsBridge.broadcastToSession.mock.calls.filter((c) => /waiting for it to finish/.test((c[1] as { message?: string }).message ?? ""));
    expect(notices).toHaveLength(1);

    // The tool finished: its result is in the jsonl → the next tick recovers.
    append(path, [{ type: "user", atMs: NOW - 1_000, message: TOOL_RESULT("t1") }]);
    recovery.driftDetectorTick();
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });

  it("the deferral covers exactly one call: a NEW tool call under the same stall means the deferred one completed → relaunch", () => {
    // Without this, a CLI that keeps calling tools (dead stdout, working
    // model) would push the kill out indefinitely, one call at a time.
    const { recovery, launcher, path } = setup(
      [
        { type: "user", atMs: NOW - 100_000 },
        { type: "assistant", atMs: NOW - 50_000, message: TOOL_USE("t1") },
      ],
      NOW - 110_000,
    );
    recovery.driftDetectorTick();
    expect(launcher.kill).not.toHaveBeenCalled();
    append(path, [
      { type: "user", atMs: NOW - 2_000, message: TOOL_RESULT("t1") },
      { type: "assistant", atMs: NOW - 1_000, message: TOOL_USE("t2") },
    ]);
    recovery.driftDetectorTick();
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });

  it("parallel tool calls: one result landing does NOT release the deferral while siblings run (prod 2026-10-18 18:16:04)", () => {
    const parallel = { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Bash", input: {} },
      { type: "tool_use", id: "t2", name: "Bash", input: {} },
    ] };
    const { recovery, launcher, path } = setup(
      [
        { type: "user", atMs: NOW - 100_000 },
        { type: "assistant", atMs: NOW - 50_000, message: parallel },
      ],
      NOW - 110_000,
    );
    recovery.driftDetectorTick();
    expect(launcher.kill).not.toHaveBeenCalled();
    append(path, [{ type: "user", atMs: NOW - 2_000, message: TOOL_RESULT("t1") }]);
    recovery.driftDetectorTick();
    expect(launcher.kill).not.toHaveBeenCalled(); // t2 still running
    append(path, [{ type: "user", atMs: NOW - 1_000, message: TOOL_RESULT("t2") }]);
    recovery.driftDetectorTick();
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });

  it("an open call older than the ceiling does not defer (a tool that hung cannot wedge recovery)", () => {
    // 16 min into a Bash call (10 min timeout + margin) the call is presumed
    // dead; the stall is recovered like any other.
    const { recovery, launcher } = setup(
      [
        { type: "user", atMs: NOW - 20 * 60_000 },
        { type: "assistant", atMs: NOW - 16 * 60_000, message: TOOL_USE("t1") },
      ],
      NOW - 17 * 60_000,
    );
    recovery.driftDetectorTick();
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });

  it("model output stuck in the jsonl past the min age: kills for relaunch", () => {
    const { recovery, launcher } = setup(
      [
        { type: "user", atMs: NOW - 100_000 },
        { type: "assistant", atMs: NOW - 60_000 },
        { type: "user", atMs: NOW - 2_000 },
      ],
      NOW - 110_000,
    );
    const warn = vi.spyOn(log, "warn");
    recovery.driftDetectorTick();
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    const detected = warn.mock.calls.find((c) => (c[2] as { event?: string })?.event === "silent_stdio_drift.detected");
    expect(detected?.[2]).toMatchObject({ sessionId: "s1", undeliveredAssistantRecords: 1 });
    // No pid known → no wait-channel probe, field present and null.
    expect((detected?.[2] as { cliWaitChannels?: unknown }).cliWaitChannels).toBeNull();
  });

  it.skipIf(process.platform !== "linux")(
    "detected log carries the CLI's kernel wait channels (P7/SERVER-STDOUT-STALL)",
    () => {
      // The field tells the next investigation which side stopped: a CLI
      // thread parked in `pipe_write` = bun stopped draining stdout. Our own
      // pid stands in for the CLI so the real /proc path is exercised.
      const { recovery } = setup(
        [
          { type: "user", atMs: NOW - 100_000 },
          { type: "assistant", atMs: NOW - 60_000 },
          { type: "user", atMs: NOW - 2_000 }, // jsonl still being written
        ],
        NOW - 110_000,
        process.pid,
      );
      // The spy may carry calls from the previous test's tick; start clean.
      const warn = vi.spyOn(log, "warn");
      warn.mockClear();
      recovery.driftDetectorTick();
      const detected = warn.mock.calls.find((c) => (c[2] as { event?: string })?.event === "silent_stdio_drift.detected");
      expect((detected?.[2] as { cliWaitChannels?: unknown }).cliWaitChannels).toMatch(/^[\w.]+×\d+(, [\w.]+×\d+)*$/);
    },
  );
});

// Context-overflow handoff: the drift tick piggybacks a jsonl stat and fires
// the size advisory. From 5 MB the advisory is STRUCTURED (recorded on the
// session state + `advisory` payload on the legacy error frame) so the browser
// can offer a one-click "Continue in a new session"; 1.5/3 MB stay /compact.
describe("SessionRecovery.contextAdvisoryTick — context-size advisory", () => {
  // Council plan 2026-10-17: the advisory is its OWN tick pass (not a passenger
  // on the drift gate). Claude is measured by transcript bytes, Codex by the
  // persisted context-window percent; each milestone fires once per session,
  // the handoff tier is recorded on the state BEFORE it is marked as fired,
  // and the seed survives a restart only for the same signal.
  const NOW = Date.parse("2026-10-17T10:00:00.000Z");
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "ctx-advisory-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.useRealTimers();
    companionBus.clear();
  });

  type Persisted = { signal?: "transcript_bytes" | "codex_compactions"; milestone?: number; milestoneBytes?: number };

  /** A Claude session whose jsonl is `sizeBytes` big (sparse file). `state` picks connected vs exited. */
  function setup(
    sizeBytes: number,
    persisted?: Persisted,
    opts: { state?: "running" | "exited"; withAdapter?: boolean; archived?: boolean } = {},
  ) {
    const state = opts.state ?? "running";
    const sessions = new Map([["s1", info("s1", { state, cwd: "/root/proj", cliSessionId: "cli-1", archived: opts.archived ?? false })]]);
    const ctx = makeRecovery(sessions);
    let adapter: ClaudeAdapter | null = null;
    if (opts.withAdapter ?? state === "running") {
      adapter = Object.create(ClaudeAdapter.prototype) as ClaudeAdapter;
      adapter.getLastCliFrameReceivedMs = () => NOW;
    }
    ctx.wsBridge.getSession.mockReturnValue({
      backendAdapter: adapter,
      state: persisted ? { context_advisory: persisted } : {},
    } as never);
    const path = resolveJsonlPath(join(home, ".claude"), "/root/proj", "cli-1")!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "user", timestamp: new Date(NOW).toISOString() }) + "\n");
    truncateSync(path, sizeBytes);
    utimesSync(path, NOW / 1000, NOW / 1000);
    return ctx;
  }

  /** A Codex session whose persisted state reports `compactions` main-thread compactions. */
  function setupCodex(compactions: number | undefined, persisted?: Persisted) {
    const sessions = new Map([["c1", info("c1", { state: "running", cwd: "/root/proj", backendType: "codex" })]]);
    const ctx = makeRecovery(sessions);
    ctx.wsBridge.getSession.mockReturnValue({
      backendAdapter: null,
      state: { ...(compactions === undefined ? {} : { codex_compactions: compactions }), ...(persisted ? { context_advisory: persisted } : {}) },
    } as never);
    return ctx;
  }

  function advisoryFrames(wsBridge: ReturnType<typeof makeRecovery>["wsBridge"]) {
    return wsBridge.broadcastToSession.mock.calls
      .map((c: unknown[]) => c[1] as { type: string; advisory?: { action: string; milestoneBytes?: number; milestone?: number } })
      .filter((f) => f.type === "error" && f.advisory);
  }

  it("10 MB: records the handoff advisory (bytes signal) and sends the structured error frame", () => {
    const { recovery, wsBridge } = setup(10_500_000);
    recovery.contextAdvisoryTick();
    expect(wsBridge.recordContextAdvisory).toHaveBeenCalledWith("s1", expect.objectContaining({
      signal: "transcript_bytes",
      milestone: 10_000_000,
      milestoneBytes: 10_000_000,
      action: "continue_in_new",
    }));
    const frames = advisoryFrames(wsBridge);
    expect(frames).toHaveLength(1);
    // Legacy text stays for old browsers; the payload drives the new banner.
    expect(frames[0]).toMatchObject({
      message: expect.stringMatching(/10 MB/),
      advisory: { kind: "context_advisory", milestoneBytes: 10_000_000, milestone: 10_000_000, action: "continue_in_new" },
    });
    // Fires once per milestone.
    recovery.contextAdvisoryTick();
    expect(advisoryFrames(wsBridge)).toHaveLength(1);
  });

  it("3 MB: plain /compact advisory, nothing recorded on the state", () => {
    const { recovery, wsBridge } = setup(3_200_000);
    recovery.contextAdvisoryTick();
    expect(wsBridge.recordContextAdvisory).not.toHaveBeenCalled();
    expect(advisoryFrames(wsBridge)[0]?.advisory).toMatchObject({ action: "compact", milestoneBytes: 3_000_000 });
  });

  it("after a server restart, an already-recorded tier does not re-fire (legacy record without `signal` counts as bytes)", () => {
    // The in-memory map is empty after restart; the persisted record seeds it,
    // so a dismissed banner is not resurrected with a fresh timestamp.
    const { recovery, wsBridge } = setup(10_500_000, { milestoneBytes: 10_000_000 });
    recovery.contextAdvisoryTick();
    expect(wsBridge.recordContextAdvisory).not.toHaveBeenCalled();
    expect(advisoryFrames(wsBridge)).toHaveLength(0);
  });

  // AC2 — the gap #381 shipped with: an exited / idle-killed Claude session
  // at >= 5 MB never saw the banner because the advisory rode the drift pass
  // (connected + live ClaudeAdapter only). The handoff works from persisted
  // history alone, so the offer must reach dead sessions too.
  it("AC2: an exited Claude session with no live adapter still gets the 5 MB handoff advisory", () => {
    const { recovery, wsBridge } = setup(5_500_000, undefined, { state: "exited", withAdapter: false });
    recovery.contextAdvisoryTick();
    expect(wsBridge.recordContextAdvisory).toHaveBeenCalledTimes(1);
    expect(wsBridge.recordContextAdvisory).toHaveBeenCalledWith("s1", expect.objectContaining({
      signal: "transcript_bytes",
      milestone: 5_000_000,
      action: "continue_in_new",
    }));
    // The drift pass itself still ignores an exited session (no kill, no advisory from there).
    recovery.driftDetectorTick();
    expect(wsBridge.recordContextAdvisory).toHaveBeenCalledTimes(1);
  });

  it("the drift pass no longer fires advisories (moved to its own pass)", () => {
    const { recovery, wsBridge } = setup(10_500_000);
    recovery.driftDetectorTick();
    expect(wsBridge.recordContextAdvisory).not.toHaveBeenCalled();
    expect(advisoryFrames(wsBridge)).toHaveLength(0);
  });

  // Commit-before-mark: recordContextAdvisory returns false when the bridge
  // has no session (restored launcher row, mid-restart race). The tier must
  // NOT be marked as fired — the next tick retries instead of silently never
  // showing the banner for the rest of the process lifetime.
  it("a handoff tier that could not be recorded is retried on the next tick (no legacy frame either)", () => {
    const { recovery, wsBridge } = setup(10_500_000);
    wsBridge.recordContextAdvisory.mockReturnValueOnce(false);
    recovery.contextAdvisoryTick();
    expect(wsBridge.recordContextAdvisory).toHaveBeenCalledTimes(1);
    expect(advisoryFrames(wsBridge)).toHaveLength(0);
    recovery.contextAdvisoryTick();
    expect(wsBridge.recordContextAdvisory).toHaveBeenCalledTimes(2);
    expect(advisoryFrames(wsBridge)).toHaveLength(1);
    // Now it is marked: a third tick is quiet.
    recovery.contextAdvisoryTick();
    expect(wsBridge.recordContextAdvisory).toHaveBeenCalledTimes(2);
  });

  // AC1 — Codex. Measured by the adapter's count of main-thread compactions
  // (`thread/compacted`); bytes never apply (rollouts on disk are ~30 KB) and
  // the window percent is cyclic, so it cannot drive a fire-once latch. No
  // legacy error frame: its browser handler is bytes-shaped; session_update
  // is the path.
  it("AC1: a Codex session compacted twice records a codex_compactions handoff advisory once, without milestoneBytes or a legacy frame", () => {
    const { recovery, wsBridge } = setupCodex(2);
    recovery.contextAdvisoryTick();
    expect(wsBridge.recordContextAdvisory).toHaveBeenCalledTimes(1);
    const [, record] = wsBridge.recordContextAdvisory.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(record).toMatchObject({ signal: "codex_compactions", milestone: 2, action: "continue_in_new" });
    expect(record).not.toHaveProperty("milestoneBytes");
    expect(record.message).toMatch(/twice/);
    expect(advisoryFrames(wsBridge)).toHaveLength(0);
    recovery.contextAdvisoryTick();
    expect(wsBridge.recordContextAdvisory).toHaveBeenCalledTimes(1);
  });

  it("a Codex session compacted once (or never reporting) never fires; the 5th compaction is a fresh rung", () => {
    const a = setupCodex(1);
    a.recovery.contextAdvisoryTick();
    expect(a.wsBridge.recordContextAdvisory).not.toHaveBeenCalled();
    const b = setupCodex(undefined);
    b.recovery.contextAdvisoryTick();
    expect(b.wsBridge.recordContextAdvisory).not.toHaveBeenCalled();
    // Already advised at 2 (persisted), now at 5 → the next rung fires once.
    const c = setupCodex(5, { signal: "codex_compactions", milestone: 2 });
    c.recovery.contextAdvisoryTick();
    expect(c.wsBridge.recordContextAdvisory).toHaveBeenCalledTimes(1);
    expect(c.wsBridge.recordContextAdvisory).toHaveBeenCalledWith("c1", expect.objectContaining({ milestone: 5 }));
  });

  it("Codex seed survives a restart only for the same signal: a compactions record seeds, a bytes record does not", () => {
    const seeded = setupCodex(2, { signal: "codex_compactions", milestone: 2 });
    seeded.recovery.contextAdvisoryTick();
    expect(seeded.wsBridge.recordContextAdvisory).not.toHaveBeenCalled();
    // A stale bytes record on a Codex session (impossible today, defensive)
    // is on another axis and must not suppress the compactions ladder.
    const other = setupCodex(2, { signal: "transcript_bytes", milestone: 10_000_000, milestoneBytes: 10_000_000 });
    other.recovery.contextAdvisoryTick();
    expect(other.wsBridge.recordContextAdvisory).toHaveBeenCalledTimes(1);
  });

  // The pass has exactly one gate — `archived` — so it needs exactly one test
  // (review 2026-10-17, beck #2): delete the gate and this goes red.
  it("an archived session is skipped even at 10 MB", () => {
    const { recovery, wsBridge } = setup(10_500_000, undefined, { archived: true });
    recovery.contextAdvisoryTick();
    expect(wsBridge.recordContextAdvisory).not.toHaveBeenCalled();
    expect(advisoryFrames(wsBridge)).toHaveLength(0);
  });

  // The `/compact` tiers are not persisted; after a restart they would re-fire
  // into every exited session (a line nobody can act on). Only a live CLI gets
  // them — but the tier is still marked so it is not retried every tick
  // (review 2026-10-17, ritchie A-1).
  it("the /compact tier is not sent to an exited session, and is marked so it does not retry", () => {
    const { recovery, wsBridge } = setup(3_200_000, undefined, { state: "exited", withAdapter: false });
    recovery.contextAdvisoryTick();
    recovery.contextAdvisoryTick();
    expect(advisoryFrames(wsBridge)).toHaveLength(0);
    expect(wsBridge.recordContextAdvisory).not.toHaveBeenCalled();
    // A live session at the same size does get the line (unchanged behaviour).
    const live = setup(3_200_000);
    live.recovery.contextAdvisoryTick();
    expect(advisoryFrames(live.wsBridge)).toHaveLength(1);
  });

  it("a transcript path outside the projects root is never stat'ed: a traversal-shaped cliSessionId resolves to null", () => {
    expect(resolveJsonlPath(join(home, ".claude"), "/root/proj", "../../etc/passwd")).toBeNull();
    expect(resolveJsonlPath(join(home, ".claude"), "/root/proj", "cli-1/..")).toBeNull();
  });
});

// ── PLAN Tasks 2-4 + review 2026-10-14-2248 #3/#4/#5 ─────────────────────────
// The kill decision is two pure stages (`decideDriftAction` → `decideDriftKill`)
// so every policy row is testable without a SessionRecovery; the tick-level
// tests below pin the wiring on a real jsonl + real subagent sibling tree.

describe("decideDriftAction — per-reason suppression override (PLAN Task 3)", () => {
  const ok = { pendingMessages: 0, intentionallyKilled: false, relaunchExhausted: false };

  it("healthy verdict → skip; drifted → recovery candidate", () => {
    expect(decideDriftAction({ drifted: false, suppressedReason: null }, ok)).toEqual({ kind: "skip" });
    expect(decideDriftAction({ drifted: true, suppressedReason: null }, ok)).toEqual({
      kind: "candidate",
      trigger: "drift",
      pendingMessages: 0,
    });
  });

  it("no_undelivered_output: suppressed when nothing is queued, overridden by queued messages (#327 kept)", () => {
    const v = { drifted: false, suppressedReason: "no_undelivered_output" as const };
    expect(decideDriftAction(v, ok)).toEqual({ kind: "suppress", reason: "no_undelivered_output", pendingMessages: 0 });
    expect(decideDriftAction(v, { ...ok, pendingMessages: 2 })).toEqual({
      kind: "candidate",
      trigger: "pending_override",
      pendingMessages: 2,
    });
  });

  it("live_subagent_activity is NOT overridable by queued messages — a queued prompt is not evidence of death", () => {
    // Before Task 3 the override was keyed to the other reason by accident;
    // this pins it as policy: the queued prompt waits for the fan-out.
    const v = { drifted: false, suppressedReason: "live_subagent_activity" as const };
    expect(decideDriftAction(v, { ...ok, pendingMessages: 5 })).toEqual({
      kind: "suppress",
      reason: "live_subagent_activity",
      pendingMessages: 5,
    });
  });

  it("intentional-kill / exhausted guards skip a candidate but never turn a suppression into a kill", () => {
    const drifted = { drifted: true, suppressedReason: null };
    expect(decideDriftAction(drifted, { ...ok, intentionallyKilled: true })).toEqual({ kind: "skip" });
    expect(decideDriftAction(drifted, { ...ok, relaunchExhausted: true })).toEqual({ kind: "skip" });
    const overridden = { drifted: false, suppressedReason: "no_undelivered_output" as const };
    expect(decideDriftAction(overridden, { ...ok, pendingMessages: 1, intentionallyKilled: true })).toEqual({ kind: "skip" });
  });
});

describe("decideDriftKill — wait-channel guard (PLAN Task 2) + rate guard (PLAN Task 4b)", () => {
  const INCIDENT = "futex_wait_queue×9, ep_poll×1"; // 2026-10-14 signature: busy, NOT pipe-dead
  const STALLED = "pipe_write×1, futex_wait_queue×8";

  it("incident signature (no pipe_write) with live subagents → withhold the kill", () => {
    expect(decideDriftKill({ waitChannels: INCIDENT, subagentActive: true, recentRecoveries: 0 })).toEqual({
      kind: "withhold_live",
    });
  });

  it("pipe_write proves bun stopped draining stdout → recover even with live subagents", () => {
    expect(decideDriftKill({ waitChannels: STALLED, subagentActive: true, recentRecoveries: 0 })).toEqual({
      kind: "recover",
      pipeWrite: true,
    });
  });

  it("no pipe_write and an idle subagent tree → recover (the CLI itself stopped writing stdout)", () => {
    expect(decideDriftKill({ waitChannels: INCIDENT, subagentActive: false, recentRecoveries: 0 })).toEqual({
      kind: "recover",
      pipeWrite: false,
    });
  });

  it("unknown wait channels (no pid / no /proc) fall back to the subagent evidence alone", () => {
    expect(decideDriftKill({ waitChannels: null, subagentActive: true, recentRecoveries: 0 }).kind).toBe("withhold_live");
    expect(decideDriftKill({ waitChannels: null, subagentActive: false, recentRecoveries: 0 }).kind).toBe("recover");
  });

  it("past DRIFT_RECOVERY_RATE_MAX recent recoveries → rate_limited instead of another relaunch", () => {
    expect(
      decideDriftKill({ waitChannels: STALLED, subagentActive: false, recentRecoveries: DRIFT_RECOVERY_RATE_MAX - 1 }).kind,
    ).toBe("recover");
    expect(decideDriftKill({ waitChannels: STALLED, subagentActive: false, recentRecoveries: DRIFT_RECOVERY_RATE_MAX })).toEqual({
      kind: "rate_limited",
      recentRecoveries: DRIFT_RECOVERY_RATE_MAX,
    });
  });

  it("main thread inside its tool call → withhold_open_tool_call, even with pipe_write (owner incident 2026-10-18)", () => {
    // The tool runs and writes the jsonl whatever stdout does; killing now
    // loses its result. A live subagent tree still wins the ordering (both
    // withhold). Rate limiting only applies to an actual recovery.
    expect(decideDriftKill({ waitChannels: STALLED, subagentActive: false, recentRecoveries: 0, mainToolCallOpen: true })).toEqual({
      kind: "withhold_open_tool_call",
    });
    expect(
      decideDriftKill({ waitChannels: INCIDENT, subagentActive: false, recentRecoveries: DRIFT_RECOVERY_RATE_MAX, mainToolCallOpen: true }),
    ).toEqual({ kind: "withhold_open_tool_call" });
    expect(decideDriftKill({ waitChannels: INCIDENT, subagentActive: true, recentRecoveries: 0, mainToolCallOpen: true })).toEqual({
      kind: "withhold_live",
    });
    // Omitted (older call sites) behaves as "not open".
    expect(decideDriftKill({ waitChannels: INCIDENT, subagentActive: false, recentRecoveries: 0 }).kind).toBe("recover");
  });

  it("waitChannelsShowPipeWrite matches the summarizeWaitChannels format exactly", () => {
    expect(waitChannelsShowPipeWrite("pipe_write×1, ep_poll×2")).toBe(true);
    expect(waitChannelsShowPipeWrite("ep_poll×2, pipe_write×1")).toBe(true);
    expect(waitChannelsShowPipeWrite("xpipe_write×1")).toBe(false);
    expect(waitChannelsShowPipeWrite("ep_poll×2")).toBe(false);
    expect(waitChannelsShowPipeWrite(null)).toBe(false);
  });

  it("pruneDriftRecoveries keeps only recoveries inside the rate window", () => {
    const now = 10 * DRIFT_RECOVERY_RATE_WINDOW_MS;
    expect(pruneDriftRecoveries([now - DRIFT_RECOVERY_RATE_WINDOW_MS, now - DRIFT_RECOVERY_RATE_WINDOW_MS + 1, now - 5], now)).toEqual([
      now - DRIFT_RECOVERY_RATE_WINDOW_MS + 1,
      now - 5,
    ]);
  });
});

// Tick wiring on a real jsonl + a real `<cliSid>/subagents/` tree under a temp
// HOME (review B-1: deleting the sessionDir derivation or the liveness dep
// must turn these red).
describe("SessionRecovery.driftDetectorTick — liveness, guards and EC-52 recovery (PLAN Tasks 2-4)", () => {
  const NOW = Date.parse("2026-10-14T12:00:00.000Z");
  const BUN_LAST = NOW - 110_000;
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "drift-tick-live-"));
    process.env.HOME = home;
    // Earlier describes spy on `log` without restoring; start from clean spies
    // so each test only sees its own log calls.
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    companionBus.clear();
  });

  /**
   * One Claude session with undelivered model output in its jsonl (an
   * assistant record 60 s old that bun never received — bun's last frame is
   * 110 s old). `subagentWriteAgoMs` = age of the newest subagent file, or
   * null for no subagent tree. Wait channels are injected (AP-1 seam).
   */
  function setup(opts: {
    subagentWriteAgoMs: number | null;
    waitChannels?: string | null;
    undelivered?: boolean;
    cliVersion?: string;
    pid?: number;
  }) {
    const sessions = new Map([
      ["s1", info("s1", { state: "running", cwd: "/root/proj", cliSessionId: "cli-1", pid: opts.pid ?? 4242 })],
    ]);
    const readWaitChannels = vi.fn(() => (opts.waitChannels === undefined ? "futex_wait_queue×9, ep_poll×1" : opts.waitChannels));
    const ctx = makeRecovery(sessions, { readWaitChannels });
    const adapter = Object.create(ClaudeAdapter.prototype) as ClaudeAdapter;
    adapter.getLastCliFrameReceivedMs = () => BUN_LAST;
    ctx.wsBridge.getSession.mockReturnValue({
      backendAdapter: adapter,
      state: { claude_code_version: opts.cliVersion ?? "2.1.283" },
    } as never);
    const path = resolveJsonlPath(join(home, ".claude"), "/root/proj", "cli-1")!;
    mkdirSync(dirname(path), { recursive: true });
    const records =
      opts.undelivered === false
        ? [{ type: "user", atMs: NOW - 2_000 }]
        : [
            { type: "user", atMs: NOW - 100_000 },
            { type: "assistant", atMs: NOW - 60_000 },
            { type: "user", atMs: NOW - 2_000 },
          ];
    writeFileSync(path, records.map((r) => JSON.stringify({ type: r.type, timestamp: new Date(r.atMs).toISOString() })).join("\n") + "\n");
    utimesSync(path, (NOW - 2_000) / 1000, (NOW - 2_000) / 1000);
    if (opts.subagentWriteAgoMs !== null) {
      const sessionDir = path.slice(0, -".jsonl".length);
      mkdirSync(join(sessionDir, "subagents"), { recursive: true });
      const agent = join(sessionDir, "subagents", "agent-a1.jsonl");
      writeFileSync(agent, "{}\n");
      const t = (NOW - opts.subagentWriteAgoMs) / 1000;
      utimesSync(agent, t, t);
    }
    return { ...ctx, readWaitChannels };
  }

  const events = (spy: { mock: { calls: unknown[][] } }, event: string): unknown[][] =>
    spy.mock.calls.filter((c) => (c[2] as { event?: string } | undefined)?.event === event);

  it("live subagent tree → no kill; the suppressed log names the real reason and the undelivered count (review #4)", () => {
    const { recovery, launcher } = setup({ subagentWriteAgoMs: 5_000 });
    const infoSpy = vi.spyOn(log, "info");
    recovery.driftDetectorTick();
    recovery.driftDetectorTick();
    expect(launcher.kill).not.toHaveBeenCalled();
    const suppressed = events(infoSpy, "silent_stdio_drift.suppressed");
    expect(suppressed).toHaveLength(1); // once per stall + reason, not every tick
    expect(suppressed[0][1]).toMatch(/alive mid subagent fan-out/);
    expect(suppressed[0][2]).toMatchObject({ reason: "live_subagent_activity", undeliveredAssistantRecords: 1 });
  });

  it("subagent tree quiet for longer than the liveness window → recovers (review #1 at the tick)", () => {
    // Written after bun's last frame? No — but even a write after it that is
    // older than the window must not suppress; here the tree went quiet
    // SUBAGENT_LIVENESS_WINDOW_MS + 10 s ago.
    const { recovery, launcher } = setup({ subagentWriteAgoMs: SUBAGENT_LIVENESS_WINDOW_MS + 10_000 });
    recovery.driftDetectorTick();
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });

  it("queued user messages do not override live_subagent_activity (PLAN Task 3)", () => {
    const { recovery, launcher, wsBridge } = setup({ subagentWriteAgoMs: 5_000 });
    wsBridge.getSessionPendingMessageCount.mockReturnValue(2);
    const infoSpy = vi.spyOn(log, "info");
    recovery.driftDetectorTick();
    expect(launcher.kill).not.toHaveBeenCalled();
    expect(events(infoSpy, "silent_stdio_drift.suppressed")[0][2]).toMatchObject({ pendingMessages: 2 });
  });

  it("pending-message override with a live subagent tree and no pipe_write → withheld (PLAN Task 2 guards the override path)", () => {
    // no_undelivered_output + queued message used to kill unconditionally,
    // even mid fan-out. The kill-time guard now asks the process layer.
    const { recovery, launcher, wsBridge } = setup({ subagentWriteAgoMs: 5_000, undelivered: false });
    wsBridge.getSessionPendingMessageCount.mockReturnValue(1);
    const infoSpy = vi.spyOn(log, "info");
    recovery.driftDetectorTick();
    expect(launcher.kill).not.toHaveBeenCalled();
    expect(events(infoSpy, "silent_stdio_drift.withheld_live")[0][2]).toMatchObject({
      trigger: "pending_override",
      subagentActive: true,
      cliWaitChannels: "futex_wait_queue×9, ep_poll×1",
    });
  });

  it("pending-message override with pipe_write → recovers despite subagent activity (PLAN Task 2)", () => {
    const { recovery, launcher, wsBridge } = setup({
      subagentWriteAgoMs: 5_000,
      undelivered: false,
      waitChannels: "pipe_write×1, futex_wait_queue×8",
    });
    wsBridge.getSessionPendingMessageCount.mockReturnValue(1);
    recovery.driftDetectorTick();
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });

  it("recovery marks the session intentional BEFORE the kill, relaunches with --resume, clears the mark after (EC-2/EC-52, PLAN Task 4a)", async () => {
    // Without the mark, the kill's `session:exited` arms the council reconnect
    // cycle (sibling flickers reconnecting/degraded) and schedules a keepalive
    // relaunch racing ours.
    const { recovery, launcher, intentionalKills, onRelaunchSucceeded } = setup({ subagentWriteAgoMs: null });
    const order: string[] = [];
    launcher.kill.mockImplementation(async () => {
      order.push(`kill:marked=${intentionalKills.has("s1")}`);
      return true;
    });
    launcher.relaunch.mockImplementation(async () => {
      order.push(`relaunch:marked=${intentionalKills.has("s1")}`);
      return { ok: true };
    });
    recovery.driftDetectorTick();
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["kill:marked=true", "relaunch:marked=true"]);
    expect(onRelaunchSucceeded).toHaveBeenCalledWith("s1");
    expect(intentionalKills.has("s1")).toBe(false);
    // The keepalive path saw nothing to do (no duplicate relaunch armed).
    expect([...recovery.keepaliveSessionIds()]).toEqual([]);
  });

  it("a failed drift relaunch clears the mark and falls back to the keepalive path (EC-52 finally)", async () => {
    const { recovery, launcher, intentionalKills } = setup({ subagentWriteAgoMs: null });
    launcher.relaunch.mockResolvedValue({ ok: false, error: "spawn failed" });
    launcher.getSession.mockImplementation(() => info("s1", { state: "exited", cwd: "/root/proj", cliSessionId: "cli-1" }));
    const warn = vi.spyOn(log, "warn");
    // listSessions still reports the running record for the tick itself.
    launcher.listSessions.mockReturnValue([info("s1", { state: "running", cwd: "/root/proj", cliSessionId: "cli-1", pid: 4242 })]);
    recovery.driftDetectorTick();
    await vi.advanceTimersByTimeAsync(1);
    expect(intentionalKills.has("s1")).toBe(false);
    expect(events(warn, "silent_stdio_drift.relaunch_failed")).toHaveLength(1);
    expect([...recovery.keepaliveSessionIds()]).toEqual(["s1"]);
  });

  it("a kill that throws still releases the mark (EC-52 finally)", async () => {
    const { recovery, launcher, intentionalKills } = setup({ subagentWriteAgoMs: null });
    launcher.kill.mockRejectedValue(new Error("boom"));
    recovery.driftDetectorTick();
    await vi.advanceTimersByTimeAsync(1);
    expect(intentionalKills.has("s1")).toBe(false);
    expect(launcher.relaunch).not.toHaveBeenCalled();
  });

  it("a durable mark set during the recovery (archive / group teardown) survives it", async () => {
    const { recovery, launcher, intentionalKills } = setup({ subagentWriteAgoMs: null });
    launcher.kill.mockImplementation(async () => {
      intentionalKills.add("s1"); // archive claimed it mid-flight
      return true;
    });
    recovery.driftDetectorTick();
    await vi.advanceTimersByTimeAsync(1);
    expect(intentionalKills.has("s1")).toBe(true);
  });

  it("rate guard: after DRIFT_RECOVERY_RATE_MAX recoveries in the window the tick stops relaunching and warns once (PLAN Task 4b)", async () => {
    const { recovery, launcher, wsBridge } = setup({ subagentWriteAgoMs: null });
    const warn = vi.spyOn(log, "warn");
    for (let i = 0; i < DRIFT_RECOVERY_RATE_MAX; i++) {
      recovery.driftDetectorTick();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(launcher.kill).toHaveBeenCalledTimes(DRIFT_RECOVERY_RATE_MAX);
    recovery.driftDetectorTick();
    recovery.driftDetectorTick();
    await vi.advanceTimersByTimeAsync(1);
    expect(launcher.kill).toHaveBeenCalledTimes(DRIFT_RECOVERY_RATE_MAX);
    expect(events(warn, "silent_stdio_drift.rate_limited")).toHaveLength(1);
    const pausedToasts = wsBridge.broadcastToSession.mock.calls.filter((c) =>
      String((c[1] as { message?: string }).message).includes("automatic recovery paused"),
    );
    expect(pausedToasts).toHaveLength(1);
  });

  it("does not start a second recovery while one is in flight", async () => {
    const { recovery, launcher } = setup({ subagentWriteAgoMs: null });
    let release!: () => void;
    launcher.kill.mockImplementation(() => new Promise<boolean>((r) => { release = () => r(true); }));
    recovery.driftDetectorTick();
    recovery.driftDetectorTick();
    expect(launcher.kill).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1);
  });

  it("logs the unverified-layout canary once when the CLI version differs from the verified one (PLAN Task 5)", () => {
    const { recovery } = setup({ subagentWriteAgoMs: 5_000, undelivered: false, cliVersion: "2.2.0" });
    // Candidate path is where the canary runs — force it via a queued message.
    const { wsBridge } = { wsBridge: (recovery as unknown as { wsBridge: { getSessionPendingMessageCount: ReturnType<typeof vi.fn> } }).wsBridge };
    wsBridge.getSessionPendingMessageCount.mockReturnValue(1);
    const warn = vi.spyOn(log, "warn");
    recovery.driftDetectorTick();
    recovery.driftDetectorTick();
    const canary = events(warn, "silent_stdio_drift.cli_layout_unverified");
    expect(canary).toHaveLength(1);
    expect(canary[0][2]).toMatchObject({ cliVersion: "2.2.0", verifiedCliVersion: "2.1.283" });
  });

  it("logs again when the suppression reason switches mid-stall (dedup keyed on reason, review #4)", () => {
    const { recovery, wsBridge } = setup({ subagentWriteAgoMs: 5_000 });
    const infoSpy = vi.spyOn(log, "info");
    recovery.driftDetectorTick(); // live_subagent_activity
    // The model output gets delivered-equivalent: rewrite jsonl with no assistant record.
    const path = resolveJsonlPath(join(home, ".claude"), "/root/proj", "cli-1")!;
    writeFileSync(path, JSON.stringify({ type: "user", timestamp: new Date(NOW - 2_000).toISOString() }) + "\n");
    utimesSync(path, (NOW - 2_000) / 1000, (NOW - 2_000) / 1000);
    wsBridge.getSessionPendingMessageCount.mockReturnValue(0);
    recovery.driftDetectorTick(); // no_undelivered_output
    const reasons = events(infoSpy, "silent_stdio_drift.suppressed").map((c) => (c[2] as { reason: string }).reason);
    expect(reasons).toEqual(["live_subagent_activity", "no_undelivered_output"]);
  });
});

// W2 (prod 2026-10-15 17:15 / 2026-10-16 06:13): after a server restart the
// sessions that were alive came back `exited` and were relaunched only when a
// browser opened them (07:02, ~50 min later; om_event_bot 2 h later) — a
// Rapesha CLI cron missed its 06:30 run. `scheduleBootResume` relaunches them
// at boot with no browser, staggered, through the same guarded auto-relaunch
// path a returning browser uses.
describe("SessionRecovery.scheduleBootResume (W2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(log, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    companionBus.clear();
  });

  it("resumes every candidate with NO browser, one CLI at a time, staggered", async () => {
    // Both halves of a council pair (claude orchestrator + codex observer) and
    // a solo cron session. No browser ever connects in this test.
    const sessions = new Map([
      ["orch", info("orch", { sessionGroupRole: "orchestrator", cliSessionId: "c1" } as Partial<SdkSessionInfo>)],
      ["obs", info("obs", { sessionGroupRole: "observer", backendType: "codex", cliSessionId: "t1" } as Partial<SdkSessionInfo>)],
      ["cron", info("cron", { cliSessionId: "c2" })],
    ]);
    const { recovery, launcher, onRelaunchSucceeded } = makeRecovery(sessions);
    launcher.relaunch.mockImplementation(async (id: string) => {
      sessions.get(id)!.state = "starting";
      return { ok: true };
    });

    recovery.scheduleBootResume(["orch", "obs", "cron"]);
    // Pending timers are visible to sweep-orphans / cancellable like keepalive.
    expect([...recovery.keepaliveSessionIds()].sort()).toEqual(["cron", "obs", "orch"]);

    await vi.advanceTimersByTimeAsync(BOOT_RESUME_STAGGER_MS + RELAUNCH_GRACE_MS);
    expect(launcher.relaunch.mock.calls.map((c) => c[0])).toEqual(["orch"]);
    await vi.advanceTimersByTimeAsync(BOOT_RESUME_STAGGER_MS);
    expect(launcher.relaunch.mock.calls.map((c) => c[0])).toEqual(["orch", "obs"]);
    await vi.advanceTimersByTimeAsync(BOOT_RESUME_STAGGER_MS);
    expect(launcher.relaunch.mock.calls.map((c) => c[0])).toEqual(["orch", "obs", "cron"]);
    expect(onRelaunchSucceeded.mock.calls.map((c) => c[0])).toEqual(["orch", "obs", "cron"]);
    expect([...recovery.keepaliveSessionIds()]).toEqual([]);
  });

  it("a browser connecting concurrently does not cause a double relaunch", async () => {
    const sessions = new Map([["s1", info("s1", { cliSessionId: "c1" })]]);
    const { recovery, launcher } = makeRecovery(sessions);
    launcher.relaunch.mockImplementation(async (id: string) => {
      sessions.get(id)!.state = "starting";
      return { ok: true };
    });

    recovery.scheduleBootResume(["s1"]);
    // Browser opens the session before the boot timer fires.
    const browser = recovery.handleAutoRelaunch("s1");
    await vi.advanceTimersByTimeAsync(BOOT_RESUME_STAGGER_MS + RELAUNCH_GRACE_MS + RELAUNCH_COOLDOWN_MS);
    await browser;
    expect(launcher.relaunch).toHaveBeenCalledTimes(1);

    // And the other order: boot timer first, browser arrives during its grace.
    sessions.set("s2", info("s2", { cliSessionId: "c2" }));
    recovery.scheduleBootResume(["s2"]);
    await vi.advanceTimersByTimeAsync(BOOT_RESUME_STAGGER_MS + 1);
    const late = recovery.handleAutoRelaunch("s2");
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS + RELAUNCH_COOLDOWN_MS);
    await late;
    expect(launcher.relaunch.mock.calls.filter((c) => c[0] === "s2")).toHaveLength(1);
  });

  it("respects archived, user-stopped, intentional kills, cancellation and already-alive sessions", async () => {
    const sessions = new Map([
      ["archived", info("archived", { archived: true })],
      ["stopped", info("stopped")],
      ["killed", info("killed")],
      ["cancelled", info("cancelled")],
      ["alive", info("alive", { state: "connected" })],
      ["gone-from-store", info("gone-from-store")],
    ]);
    const { recovery, launcher, intentionalKills } = makeRecovery(sessions);
    recovery.markStoppedByUser("stopped");
    intentionalKills.add("killed");
    sessions.delete("gone-from-store");

    recovery.scheduleBootResume(["archived", "stopped", "killed", "cancelled", "alive", "gone-from-store"]);
    // Archive / delete / user kill of the session cancels its pending timer.
    recovery.cancelKeepaliveTimer("cancelled");
    await vi.advanceTimersByTimeAsync(10 * BOOT_RESUME_STAGGER_MS + RELAUNCH_GRACE_MS + RELAUNCH_COOLDOWN_MS);

    expect(launcher.relaunch).not.toHaveBeenCalled();
  });

  it("a user stop or archive DURING the auto-relaunch grace pause wins — the session stays down", async () => {
    // Q1 of the #362 review: the boot timer passes its guards, then
    // handleAutoRelaunch waits RELAUNCH_GRACE_MS. A user kill (stoppedByUser)
    // or an archive inside that pause must still prevent the spawn.
    const sessions = new Map([
      ["stopped-mid-grace", info("stopped-mid-grace", { cliSessionId: "c1" })],
      ["archived-mid-grace", info("archived-mid-grace", { cliSessionId: "c2" })],
    ]);
    const { recovery, launcher } = makeRecovery(sessions);
    recovery.scheduleBootResume(["stopped-mid-grace", "archived-mid-grace"]);
    await vi.advanceTimersByTimeAsync(2 * BOOT_RESUME_STAGGER_MS + 1);
    recovery.markStoppedByUser("stopped-mid-grace");
    sessions.get("archived-mid-grace")!.archived = true;
    await vi.advanceTimersByTimeAsync(RELAUNCH_GRACE_MS + RELAUNCH_COOLDOWN_MS);
    expect(launcher.relaunch).not.toHaveBeenCalled();
  });

  it("a session whose crash budget is spent is not relaunched again", async () => {
    const sessions = new Map([["s1", info("s1")]]);
    const { recovery, launcher } = makeRecovery(sessions);
    recovery.relaunchExhaustedNotified.add("s1");
    recovery.scheduleBootResume(["s1"]);
    await vi.advanceTimersByTimeAsync(BOOT_RESUME_STAGGER_MS + RELAUNCH_GRACE_MS);
    expect(launcher.relaunch).not.toHaveBeenCalled();
  });

  it("an empty candidate list schedules nothing", () => {
    const { recovery } = makeRecovery(new Map());
    recovery.scheduleBootResume([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
