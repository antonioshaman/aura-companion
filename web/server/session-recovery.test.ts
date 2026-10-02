import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import { companionBus } from "./event-bus.js";
import { IntentionalKills } from "./intentional-kills.js";
import { log } from "./logger.js";
import { DEFAULT_LAG_TOLERANCE_MS, resolveJsonlPath } from "./silent-stdio-drift-detector.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
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

  function setup(records: Array<{ type: string; atMs: number }>, bunLastFrameMs: number, pid?: number) {
    const sessions = new Map([["s1", info("s1", { state: "running", cwd: "/root/proj", cliSessionId: "cli-1", pid })]]);
    const ctx = makeRecovery(sessions);
    const adapter = Object.create(ClaudeAdapter.prototype) as ClaudeAdapter;
    adapter.getLastCliFrameReceivedMs = () => bunLastFrameMs;
    ctx.wsBridge.getSession.mockReturnValue({ backendAdapter: adapter } as never);
    const path = resolveJsonlPath(join(home, ".claude"), "/root/proj", "cli-1")!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, records.map((r) => JSON.stringify({ type: r.type, timestamp: new Date(r.atMs).toISOString() })).join("\n") + "\n");
    const mtime = Math.max(...records.map((r) => r.atMs)) / 1000;
    utimesSync(path, mtime, mtime);
    return ctx;
  }

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
