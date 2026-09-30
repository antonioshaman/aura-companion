import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OBSERVER_AUTOHEAL_BACKOFF_MS,
  OBSERVER_AUTOHEAL_MAX_ATTEMPTS,
  OBSERVER_AUTOHEAL_MAX_PER_HOUR,
  OBSERVER_AUTOHEAL_READY_WAIT_MS,
  ObserverAutoheal,
  observerAutohealBlockedReason,
  type AutohealGroupView,
} from "./council-observer-autoheal.js";

// P4/OBS-AUTOHEAL: after an idle period a Codex observer lost its backend
// adapter; the EC-13 failsafe polled, timed out and degraded the pair, and
// only a manual relaunch of the observer cured it. ObserverAutoheal performs
// that relaunch on its own under a hard budget. These tests pin the budget
// (attempts, backoff, hourly cap, one episode at a time), the "wait for the
// adapter to attach" step, and the refusals (user stop of either half,
// intentional kill, torn-down group). The module is provider-agnostic — the
// Claude and Codex observers differ only behind the injected callbacks.

const GROUP = "grp_heal";
const OBSERVER = "sess_obs";
const PRIMARY = "sess_pri";

afterEach(() => {
  vi.useRealTimers();
});

interface Harness {
  heal: ObserverAutoheal;
  relaunch: ReturnType<typeof vi.fn>;
  setReady: (v: boolean) => void;
  setBlocked: (reason: string | null) => void;
}

/**
 * `readyAfterRelaunch`: the adapter attaches after the Nth successful
 * relaunch (null = never). Mirrors the incident: before the relaunch the
 * adapter is gone, after it the adapter attaches.
 */
function makeHarness(opts: {
  readyAfterRelaunch?: number | null;
  relaunchResults?: Array<{ ok: boolean; error?: string }>;
} = {}): Harness {
  let ready = false;
  let blocked: string | null = null;
  let relaunches = 0;
  const results = [...(opts.relaunchResults ?? [])];
  const readyAfter = opts.readyAfterRelaunch === undefined ? 1 : opts.readyAfterRelaunch;
  const relaunch = vi.fn(async () => {
    const r = results.shift() ?? { ok: true };
    if (r.ok) {
      relaunches++;
      if (readyAfter !== null && relaunches >= readyAfter) ready = true;
    }
    return r;
  });
  const heal = new ObserverAutoheal({
    relaunchObserver: relaunch,
    isObserverReadyForWake: () => ready,
    blockedReason: () => blocked,
  });
  return {
    heal,
    relaunch,
    setReady: (v) => { ready = v; },
    setBlocked: (r) => { blocked = r; },
  };
}

describe("ObserverAutoheal", () => {
  it("relaunches the observer once and reports healed when the adapter attaches", async () => {
    // The incident path: adapter gone → one relaunch → adapter attached.
    const h = makeHarness({ readyAfterRelaunch: 1 });
    const result = await h.heal.heal(GROUP, OBSERVER, "adapter_wait_timed_out", "chk_1");
    expect(result).toEqual({ kind: "healed", attempts: 1 });
    expect(h.relaunch).toHaveBeenCalledTimes(1);
    expect(h.relaunch).toHaveBeenCalledWith(OBSERVER);
  });

  it("retries after the backoff and heals on the second attempt", async () => {
    // First relaunch fails outright; the second (after the backoff) works.
    vi.useFakeTimers();
    const h = makeHarness({ relaunchResults: [{ ok: false, error: "spawn failed" }, { ok: true }] });
    const p = h.heal.heal(GROUP, OBSERVER, "adapter_missing", "chk_1");
    await vi.advanceTimersByTimeAsync(OBSERVER_AUTOHEAL_BACKOFF_MS[1] - 1);
    // Backoff not elapsed yet — the second relaunch must not have run.
    expect(h.relaunch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(p).resolves.toEqual({ kind: "healed", attempts: 2 });
  });

  it("reports exhausted after the attempt budget when the adapter never attaches", async () => {
    // Each relaunch "succeeds" but the adapter never becomes ready: every
    // attempt waits the full ready window, then the budget is spent.
    vi.useFakeTimers();
    const h = makeHarness({ readyAfterRelaunch: null });
    const p = h.heal.heal(GROUP, OBSERVER, "adapter_wait_timed_out", "chk_1");
    await vi.advanceTimersByTimeAsync(
      OBSERVER_AUTOHEAL_MAX_ATTEMPTS * OBSERVER_AUTOHEAL_READY_WAIT_MS + OBSERVER_AUTOHEAL_BACKOFF_MS[1] + 1_000,
    );
    await expect(p).resolves.toEqual({
      kind: "exhausted",
      attempts: OBSERVER_AUTOHEAL_MAX_ATTEMPTS,
      lastError: "adapter_wait_timed_out",
    });
    expect(h.relaunch).toHaveBeenCalledTimes(OBSERVER_AUTOHEAL_MAX_ATTEMPTS);
  });

  it("never relaunches when blocked (user stop / intentional kill) and says why", async () => {
    const h = makeHarness();
    h.setBlocked("user_stopped");
    await expect(h.heal.heal(GROUP, OBSERVER, "adapter_missing", "chk_1")).resolves.toEqual({
      kind: "skipped",
      reason: "user_stopped",
    });
    expect(h.relaunch).not.toHaveBeenCalled();
  });

  it("stops between attempts when the user stops the pair during the backoff", async () => {
    // Attempt 1 fails; before attempt 2 the user kills the session → no
    // second relaunch, result is skipped (the caller then does not degrade).
    vi.useFakeTimers();
    const h = makeHarness({ relaunchResults: [{ ok: false }] });
    const p = h.heal.heal(GROUP, OBSERVER, "adapter_missing", "chk_1");
    await vi.advanceTimersByTimeAsync(10);
    h.setBlocked("user_stopped");
    await vi.advanceTimersByTimeAsync(OBSERVER_AUTOHEAL_BACKOFF_MS[1] + 10);
    await expect(p).resolves.toEqual({ kind: "skipped", reason: "user_stopped" });
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });

  it("skips the relaunch if the observer recovered by itself during the backoff", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ relaunchResults: [{ ok: false }] });
    const p = h.heal.heal(GROUP, OBSERVER, "adapter_missing", "chk_1");
    await vi.advanceTimersByTimeAsync(10);
    h.setReady(true);
    await vi.advanceTimersByTimeAsync(OBSERVER_AUTOHEAL_BACKOFF_MS[1] + 10);
    await expect(p).resolves.toEqual({ kind: "healed", attempts: 1 });
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });

  it("runs one episode per group at a time", async () => {
    // A second trigger (e.g. the failsafe tick) while an episode is running
    // must not start a parallel relaunch.
    vi.useFakeTimers();
    const h = makeHarness({ readyAfterRelaunch: null });
    const first = h.heal.heal(GROUP, OBSERVER, "adapter_wait_timed_out", "chk_1");
    expect(h.heal.isHealing(GROUP)).toBe(true);
    await expect(h.heal.heal(GROUP, OBSERVER, "adapter_missing", "chk_2")).resolves.toEqual({
      kind: "skipped",
      reason: "in_flight",
    });
    await vi.advanceTimersByTimeAsync(10 * OBSERVER_AUTOHEAL_READY_WAIT_MS);
    await first;
    expect(h.heal.isHealing(GROUP)).toBe(false);
    expect(h.relaunch).toHaveBeenCalledTimes(OBSERVER_AUTOHEAL_MAX_ATTEMPTS);
  });

  it("caps relaunches per group per rolling hour, and the cap resets after an hour", async () => {
    // A flapping observer: each episode heals, the adapter drops again. After
    // MAX_PER_HOUR relaunches in the hour the next episode is rate-limited
    // without relaunching; an hour later relaunching is allowed again.
    vi.useFakeTimers();
    const h = makeHarness({ readyAfterRelaunch: 1 });
    for (let i = 0; i < OBSERVER_AUTOHEAL_MAX_PER_HOUR; i++) {
      h.setReady(false);
      const p = h.heal.heal(GROUP, OBSERVER, "adapter_missing", `chk_${i}`);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(p).resolves.toMatchObject({ kind: "healed" });
    }
    h.setReady(false);
    await expect(h.heal.heal(GROUP, OBSERVER, "adapter_missing", "chk_x")).resolves.toEqual({
      kind: "skipped",
      reason: "rate_limited",
    });
    expect(h.relaunch).toHaveBeenCalledTimes(OBSERVER_AUTOHEAL_MAX_PER_HOUR);

    await vi.advanceTimersByTimeAsync(3_600_000);
    const later = h.heal.heal(GROUP, OBSERVER, "adapter_missing", "chk_y");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(later).resolves.toMatchObject({ kind: "healed" });
    expect(h.relaunch).toHaveBeenCalledTimes(OBSERVER_AUTOHEAL_MAX_PER_HOUR + 1);
  });

  it("forgetGroup drops the hourly history", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ readyAfterRelaunch: 1 });
    for (let i = 0; i < OBSERVER_AUTOHEAL_MAX_PER_HOUR; i++) {
      h.setReady(false);
      const p = h.heal.heal(GROUP, OBSERVER, "adapter_missing", `chk_${i}`);
      await vi.advanceTimersByTimeAsync(1_000);
      await p;
    }
    h.heal.forgetGroup(GROUP);
    h.setReady(false);
    const p = h.heal.heal(GROUP, OBSERVER, "adapter_missing", "chk_z");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toMatchObject({ kind: "healed" });
  });

  it("treats a throwing relaunch as a failed attempt, never an unhandled rejection", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.relaunch.mockImplementationOnce(async () => { throw new Error("boom"); });
    const p = h.heal.heal(GROUP, OBSERVER, "adapter_missing", "chk_1");
    await vi.advanceTimersByTimeAsync(OBSERVER_AUTOHEAL_BACKOFF_MS[1] + 1_000);
    // Second attempt uses the default ok relaunch → ready.
    await expect(p).resolves.toEqual({ kind: "healed", attempts: 2 });
  });
});

describe("observerAutohealBlockedReason", () => {
  const group = (status = "active"): AutohealGroupView => ({
    status,
    primary: { sessionId: PRIMARY },
    observer: { sessionId: OBSERVER },
  });
  const none = () => false;

  it("allows healing a live pair", () => {
    expect(observerAutohealBlockedReason(group(), OBSERVER, none, none)).toBeNull();
    expect(observerAutohealBlockedReason(group("reconnecting"), OBSERVER, none, none)).toBeNull();
  });

  it("refuses a torn-down, non-live or re-paired group", () => {
    expect(observerAutohealBlockedReason(undefined, OBSERVER, none, none)).toBe("group_gone");
    expect(observerAutohealBlockedReason(group("degraded"), OBSERVER, none, none)).toBe("group_not_live");
    expect(observerAutohealBlockedReason(group("archived"), OBSERVER, none, none)).toBe("group_not_live");
    expect(observerAutohealBlockedReason(group(), "other", none, none)).toBe("observer_changed");
  });

  it("refuses when the user stopped EITHER half (EC-2, P4/KILL-INTENTIONAL)", () => {
    // Relaunching the observer of a pair whose orchestrator the user stopped
    // would bring the whole pair back — so the orchestrator's stop counts too.
    expect(observerAutohealBlockedReason(group(), OBSERVER, (s) => s === OBSERVER, none)).toBe("user_stopped");
    expect(observerAutohealBlockedReason(group(), OBSERVER, (s) => s === PRIMARY, none)).toBe("user_stopped");
  });

  it("refuses while an intentional kill of the observer is in progress", () => {
    expect(observerAutohealBlockedReason(group(), OBSERVER, none, (s) => s === OBSERVER)).toBe("intentional_kill");
  });
});
