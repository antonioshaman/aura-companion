import { describe, it, expect, vi } from "vitest";
import { SilentStdioWatchdog } from "./silent-stdio-watchdog.js";

/**
 * The watchdog is behavioural (arm → deadline → fire OR arm → frame →
 * slide → …). We stub clock + timers so tests are deterministic and
 * fast; no real setTimeout involvement.
 */
function harness(timeoutMs = 1000) {
  let now = 1_000_000;
  const clock = () => now;
  // Poor-man's virtual timer: keep a small queue of pending fires
  // keyed by an id. `setTimer` pushes; the test advances time and
  // calls `runDue()` to fire whichever handlers whose deadline
  // has arrived.
  interface Pending { id: number; fn: () => void; dueAt: number; }
  const pending: Pending[] = [];
  let nextId = 1;
  const setTimer = (fn: () => void, ms: number) => {
    const id = nextId++;
    pending.push({ id, fn, dueAt: now + ms });
    return id;
  };
  const clearTimer = (h: unknown) => {
    const idx = pending.findIndex((p) => p.id === h);
    if (idx >= 0) pending.splice(idx, 1);
  };
  const advance = (ms: number) => {
    now += ms;
    // Fire in due-order; a handler may schedule a new timer (arm/reset),
    // so re-check after each fire.
    for (;;) {
      const due = pending
        .filter((p) => p.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!due) break;
      // Remove from queue BEFORE firing so the handler can enqueue new work.
      const idx = pending.findIndex((p) => p.id === due.id);
      pending.splice(idx, 1);
      due.fn();
    }
  };
  const onSilent = vi.fn<(info: { sinceMs: number; reason: string }) => void>();
  const dog = new SilentStdioWatchdog({
    timeoutMs,
    onSilent,
    clock,
    setTimer,
    clearTimer,
  });
  return { dog, advance, onSilent, pendingCount: () => pending.length };
}

describe("SilentStdioWatchdog", () => {
  it("fires onSilent when no frame arrives before the deadline", () => {
    const { dog, advance, onSilent } = harness(1000);
    dog.arm("user_message_sent");
    expect(onSilent).not.toHaveBeenCalled();
    advance(999);
    expect(onSilent).not.toHaveBeenCalled();
    advance(2); // now past 1000ms since arm
    expect(onSilent).toHaveBeenCalledTimes(1);
    expect(onSilent).toHaveBeenCalledWith({
      sinceMs: expect.any(Number),
      reason: "user_message_sent",
    });
    // sinceMs should be roughly the elapsed real (virtual) time
    const call = onSilent.mock.calls[0][0];
    expect(call.sinceMs).toBeGreaterThanOrEqual(1000);
  });

  it("slides the deadline forward on every frame — long healthy turn does not fire", () => {
    const { dog, advance, onSilent } = harness(1000);
    dog.arm("user_message_sent");
    // Simulate a 10-second turn with tool_progress frames every 500ms.
    for (let i = 0; i < 20; i++) {
      advance(500);
      dog.onFrame();
    }
    expect(onSilent).not.toHaveBeenCalled();
    // Now go silent for the full window.
    advance(1001);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it("disarm cancels the pending fire", () => {
    const { dog, advance, onSilent, pendingCount } = harness(1000);
    dog.arm("user_message_sent");
    expect(dog.isArmed()).toBe(true);
    dog.disarm();
    expect(dog.isArmed()).toBe(false);
    expect(pendingCount()).toBe(0);
    advance(5000);
    expect(onSilent).not.toHaveBeenCalled();
  });

  it("onFrame with no arm is a no-op (no crash, no fire)", () => {
    const { dog, advance, onSilent } = harness(1000);
    dog.onFrame();
    dog.onFrame();
    advance(5000);
    expect(onSilent).not.toHaveBeenCalled();
    expect(dog.isArmed()).toBe(false);
  });

  it("re-arm inside the onSilent callback works — deadline resets cleanly", () => {
    const { dog, advance, onSilent } = harness(1000);
    onSilent.mockImplementationOnce(() => {
      // Simulate the orchestrator re-arming immediately (would happen
      // in production if the same session gets another user message
      // right after backend-silent).
      dog.arm("second_arm");
    });
    dog.arm("first_arm");
    advance(1001);
    expect(onSilent).toHaveBeenCalledTimes(1);
    // Second window: no frame → fire again
    advance(1001);
    expect(onSilent).toHaveBeenCalledTimes(2);
    expect(onSilent.mock.calls[1][0].reason).toBe("second_arm");
  });

  it("does NOT fire if a frame arrives inside the deadline window", () => {
    const { dog, advance, onSilent } = harness(1000);
    dog.arm("user_message_sent");
    advance(999);
    dog.onFrame(); // extends deadline
    advance(999);
    expect(onSilent).not.toHaveBeenCalled();
    // Now stop responding
    advance(1002);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it("arm-then-arm restarts the deadline (does not stack)", () => {
    const { dog, advance, onSilent, pendingCount } = harness(1000);
    dog.arm("first");
    advance(500);
    dog.arm("second"); // resets the clock
    expect(pendingCount()).toBe(1);
    advance(600);
    expect(onSilent).not.toHaveBeenCalled(); // 600ms < 1000ms from second arm
    advance(500);
    expect(onSilent).toHaveBeenCalledTimes(1);
    expect(onSilent.mock.calls[0][0].reason).toBe("second");
  });
});
