/**
 * @vitest-environment jsdom
 *
 * Tests for the Service Worker registration module.
 *
 * Validates that:
 * - registerSW is called with the correct callbacks
 * - A periodic update interval is set up (every 60 minutes)
 * - Missing registration (undefined) is handled gracefully
 * - The offline-ready callback logs a message
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

// Mock the virtual:pwa-register module before importing sw-register
const mockRegisterSW: ReturnType<typeof vi.fn<AnyFn>> = vi.fn(() => vi.fn());
vi.mock("virtual:pwa-register", () => ({
  registerSW: mockRegisterSW,
}));

describe("sw-register", () => {
  beforeEach(() => {
    vi.resetModules();
    mockRegisterSW.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls registerSW with onRegisteredSW, onOfflineReady, and onNeedRefresh callbacks", async () => {
    await import("./sw-register.js");

    expect(mockRegisterSW).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = mockRegisterSW.mock.calls[0]![0] as any;
    expect(config).toHaveProperty("onRegisteredSW");
    expect(config).toHaveProperty("onOfflineReady");
    expect(config).toHaveProperty("onNeedRefresh");
    expect(typeof config.onRegisteredSW).toBe("function");
    expect(typeof config.onOfflineReady).toBe("function");
    expect(typeof config.onNeedRefresh).toBe("function");
  });

  // Prompt-mode signal: onNeedRefresh flips the update-ready flag and notifies
  // subscribers so the React toaster can render. applyUpdate() then activates
  // the waiting SW via the updateSW callback returned by registerSW.
  it("notifies subscribers on onNeedRefresh and applies via updateSW", async () => {
    const updateSWFn = vi.fn();
    mockRegisterSW.mockReturnValueOnce(updateSWFn);

    const mod = await import("./sw-register.js");
    expect(mod.isUpdateReady()).toBe(false);

    const listener = vi.fn();
    const unsubscribe = mod.subscribeUpdateReady(listener);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = mockRegisterSW.mock.calls[0]![0] as any;
    config.onNeedRefresh();

    expect(mod.isUpdateReady()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);

    mod.applyUpdate();
    expect(updateSWFn).toHaveBeenCalledWith(true);

    unsubscribe();
  });

  it("sets up periodic update check every 60 minutes", async () => {
    await import("./sw-register.js");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = mockRegisterSW.mock.calls[0]![0] as any;
    const mockRegistration = { update: vi.fn() };

    // Simulate the SW being registered
    config.onRegisteredSW("/sw.js", mockRegistration);

    // No update calls yet
    expect(mockRegistration.update).not.toHaveBeenCalled();

    // Advance 60 minutes
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(mockRegistration.update).toHaveBeenCalledOnce();

    // Advance another 60 minutes
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(mockRegistration.update).toHaveBeenCalledTimes(2);
  });

  it("handles missing registration gracefully", async () => {
    await import("./sw-register.js");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = mockRegisterSW.mock.calls[0]![0] as any;
    // Calling with undefined registration should not throw
    expect(() => config.onRegisteredSW("/sw.js", undefined)).not.toThrow();
  });

  it("logs offline-ready message", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await import("./sw-register.js");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = mockRegisterSW.mock.calls[0]![0] as any;
    config.onOfflineReady();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Offline-ready"),
    );
    consoleSpy.mockRestore();
  });
});
