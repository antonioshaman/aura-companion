// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Control the sw-register signal directly so the hook can be tested without a
// real Service Worker: subscribeUpdateReady captures the listener, and we flip
// isUpdateReady + invoke the listener to simulate onNeedRefresh firing.
let updateReady = false;
let captured: ((ready: boolean) => void) | null = null;
vi.mock("./sw-register.js", () => ({
  isUpdateReady: () => updateReady,
  subscribeUpdateReady: (listener: (ready: boolean) => void) => {
    captured = listener;
    return () => {
      captured = null;
    };
  },
}));

import { useSwUpdate } from "./use-sw-update.js";

describe("useSwUpdate", () => {
  beforeEach(() => {
    updateReady = false;
    captured = null;
  });

  it("returns the initial update-ready state", () => {
    updateReady = true;
    const { result } = renderHook(() => useSwUpdate());
    expect(result.current).toBe(true);
  });

  it("updates when the subscription fires", () => {
    const { result } = renderHook(() => useSwUpdate());
    expect(result.current).toBe(false);
    act(() => {
      captured?.(true);
    });
    expect(result.current).toBe(true);
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useSwUpdate());
    expect(captured).not.toBeNull();
    unmount();
    expect(captured).toBeNull();
  });
});
