import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import { companionBus } from "./event-bus.js";
import { DEFAULT_LAG_TOLERANCE_MS } from "./silent-stdio-drift-detector.js";
import {
  DRIFT_DETECTOR_TICK_MS,
  KEEPALIVE_BASE_DELAY_MS,
  MAX_AUTO_RELAUNCHES,
  RECONNECT_GRACE_MS,
  RELAUNCH_COOLDOWN_MS,
  RELAUNCH_GRACE_MS,
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

function makeRecovery(sessions: Map<string, SdkSessionInfo>) {
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
  };
  const intentionalKills = new Set<string>();
  const onRelaunchSucceeded = vi.fn();
  const noteApiLimitReached = vi.fn();
  const recovery = new SessionRecovery({
    launcher: launcher as unknown as CliLauncher,
    wsBridge: wsBridge as unknown as WsBridge,
    intentionalKills,
    onRelaunchSucceeded,
    noteApiLimitReached,
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
