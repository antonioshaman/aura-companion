import { describe, it, expect } from "vitest";
import { SoloRelaunchLifecycle } from "./solo-relaunch-lifecycle.js";

// Fowler F5 — the extracted solo-session relaunch/keepalive lifecycle owner.
// These tests pin the 1:1 semantics the orchestrator relied on inline, so a
// future refactor toward a transition table can't silently change them.
describe("SoloRelaunchLifecycle", () => {
  it("relaunch-in-flight guard: begin/end toggles isRelaunching", () => {
    const l = new SoloRelaunchLifecycle();
    expect(l.isRelaunching("s1")).toBe(false);
    l.beginRelaunch("s1");
    expect(l.isRelaunching("s1")).toBe(true);
    l.endRelaunch("s1");
    expect(l.isRelaunching("s1")).toBe(false);
  });

  it("attempt counter defaults to 0 and round-trips set/reset (matches the old `get(id) ?? 0`)", () => {
    const l = new SoloRelaunchLifecycle();
    expect(l.relaunchAttempts("s1")).toBe(0); // never attempted → 0, not undefined
    l.setRelaunchAttempts("s1", 2);
    expect(l.relaunchAttempts("s1")).toBe(2);
    l.resetRelaunchAttempts("s1");
    expect(l.relaunchAttempts("s1")).toBe(0);
  });

  it("exhaustion-notified and intentional-kill guards are independent per session", () => {
    const l = new SoloRelaunchLifecycle();
    l.markExhausted("s1");
    l.markIntentionalKill("s2");
    expect(l.isExhausted("s1")).toBe(true);
    expect(l.isExhausted("s2")).toBe(false);
    expect(l.isIntentionalKill("s2")).toBe(true);
    expect(l.isIntentionalKill("s1")).toBe(false);
    l.clearExhausted("s1");
    l.clearIntentionalKill("s2");
    expect(l.isExhausted("s1")).toBe(false);
    expect(l.isIntentionalKill("s2")).toBe(false);
  });

  it("keepalive timers: get/set/clear + keepaliveSessionIds iterates live ids", () => {
    const l = new SoloRelaunchLifecycle();
    const t1 = setTimeout(() => {}, 10_000);
    const t2 = setTimeout(() => {}, 10_000);
    try {
      expect(l.getKeepaliveTimer("s1")).toBeUndefined();
      l.setKeepaliveTimer("s1", t1);
      l.setKeepaliveTimer("s2", t2);
      expect(l.getKeepaliveTimer("s1")).toBe(t1);
      expect([...l.keepaliveSessionIds()].sort()).toEqual(["s1", "s2"]);
      l.clearKeepaliveTimer("s1");
      expect(l.getKeepaliveTimer("s1")).toBeUndefined();
      expect([...l.keepaliveSessionIds()]).toEqual(["s2"]);
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
    }
  });
});
