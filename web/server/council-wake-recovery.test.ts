import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObserverWakeRecovery } from "./council-wake-recovery.js";
import { ObserverAutoheal, type ObserverAutohealResult } from "./council-observer-autoheal.js";

/**
 * W14 (b): a pair degraded by an unanswered wake must heal itself. Prod
 * 2026-10-16 grp_879b81b6 stayed degraded from 12:06 until a manual relaunch
 * at 12:14 — no auto-heal attempt was ever logged. ObserverWakeRecovery runs
 * the bounded observer auto-heal for it, never kills a wake turn that is still
 * streaming, and drains the re-queued checkpoint once the pair is active.
 */
const GROUP = "grp_879b81b6";
const OBS = "17fbf63f";
const CP = "council-review-158-pr366-drift-reply-delivery";

function harness(opts: { status?: string; inFlight?: boolean; result?: ObserverAutohealResult } = {}) {
  let status = opts.status ?? "degraded";
  let inFlight = opts.inFlight ?? false;
  let resolveHeal: (r: ObserverAutohealResult) => void = () => {};
  const heal = vi.fn(() => new Promise<ObserverAutohealResult>((r) => { resolveHeal = r; }));
  const drain = vi.fn();
  const rec = new ObserverWakeRecovery({
    autoheal: { heal },
    getGroupStatus: () => status,
    isObserverTurnInFlight: () => inFlight,
    drainPendingObserverWake: drain,
  });
  return {
    rec, heal, drain,
    setStatus: (s: string) => { status = s; },
    setInFlight: (v: boolean) => { inFlight = v; },
    finishHeal: async (r: ObserverAutohealResult) => { resolveHeal(r); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
  };
}

describe("ObserverWakeRecovery (W14)", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("auto-heals a degraded pair with the wake_produced_no_review trigger and drains once active", async () => {
    const h = harness();
    h.rec.onWakeUnanswered(GROUP, OBS, CP);
    expect(h.heal).toHaveBeenCalledWith(GROUP, OBS, "wake_produced_no_review", CP);
    expect(h.rec.isRecovering(GROUP)).toBe(true);
    // The relaunch handshake flipped the pair back to active.
    h.setStatus("active");
    await h.finishHeal({ kind: "healed", attempts: 1 });
    expect(h.drain).toHaveBeenCalledWith(GROUP);
    expect(h.rec.isRecovering(GROUP)).toBe(false);
  });

  it("runs one episode per group", () => {
    const h = harness();
    h.rec.onWakeUnanswered(GROUP, OBS, CP);
    h.rec.onWakeUnanswered(GROUP, OBS, CP);
    expect(h.heal).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the pair is not degraded (no-op degrade transition)", () => {
    const h = harness({ status: "reconnecting" });
    h.rec.onWakeUnanswered(GROUP, OBS, CP);
    expect(h.heal).not.toHaveBeenCalled();
  });

  // A slow-but-alive observer whose turn outlived the review deadline must not
  // be killed mid-review: wait for the turn to end (observer:turn-done, at the
  // latest the 6-min completion watchdog), then relaunch.
  it("defers the relaunch until a still-running wake turn ends", () => {
    const h = harness({ inFlight: true });
    h.rec.onWakeUnanswered(GROUP, OBS, CP);
    expect(h.heal).not.toHaveBeenCalled();
    expect(h.rec.isRecovering(GROUP)).toBe(true);
    h.setInFlight(false);
    h.rec.onObserverTurnDone(GROUP);
    expect(h.heal).toHaveBeenCalledWith(GROUP, OBS, "wake_produced_no_review", CP);
  });

  it("drops a deferred recovery if the pair recovered some other way meanwhile", () => {
    const h = harness({ inFlight: true });
    h.rec.onWakeUnanswered(GROUP, OBS, CP);
    h.setStatus("active"); // manual relaunch
    h.rec.onObserverTurnDone(GROUP);
    expect(h.heal).not.toHaveBeenCalled();
    expect(h.rec.isRecovering(GROUP)).toBe(false);
  });

  it("leaves the queued checkpoint for a manual relaunch when auto-heal is exhausted", async () => {
    const h = harness();
    h.rec.onWakeUnanswered(GROUP, OBS, CP);
    await h.finishHeal({ kind: "exhausted", attempts: 2, lastError: "adapter_wait_timed_out" });
    expect(h.drain).not.toHaveBeenCalled();
    expect(h.rec.isRecovering(GROUP)).toBe(false);
  });
});

// W14 fix-pass: end-to-end with the REAL ObserverAutoheal — a failed first
// relaunch while the deaf adapter looks ready must still lead to a working
// relaunch and the re-queued checkpoint being redelivered.
describe("ObserverWakeRecovery + ObserverAutoheal (W14 fix-pass)", () => {
  afterEach(() => vi.useRealTimers());

  it("redelivers the checkpoint after a failed first relaunch followed by a successful one", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let status = "degraded";
    const results = [{ ok: false, error: "spawn failed" }, { ok: true }];
    const relaunch = vi.fn(async () => {
      const r = results.shift()!;
      if (r.ok) status = "active"; // the relaunch handshake flips the pair back
      return r;
    });
    const autoheal = new ObserverAutoheal({
      relaunchObserver: relaunch,
      isObserverReadyForWake: () => true, // deaf adapter still "ready"
      blockedReason: () => null,
    });
    const drain = vi.fn();
    const rec = new ObserverWakeRecovery({
      autoheal,
      getGroupStatus: () => status,
      isObserverTurnInFlight: () => false,
      drainPendingObserverWake: drain,
    });
    rec.onWakeUnanswered(GROUP, OBS, CP);
    await vi.runAllTimersAsync();
    expect(relaunch).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenCalledWith(GROUP);
    expect(rec.isRecovering(GROUP)).toBe(false);
  });
});
