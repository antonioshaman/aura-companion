/** @vitest-environment jsdom
 * Behavioral registration/update contract, including the first-install tab
 * reproduced with two real Vite builds. No Workbox isUpdate heuristic mocked.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

let serviceWorker: EventTarget & { controller: object | null; register: ReturnType<typeof vi.fn> };
let reg: EventTarget & { waiting: { postMessage: ReturnType<typeof vi.fn> } | null; installing: (EventTarget & { state: string }) | null; update: ReturnType<typeof vi.fn> };
let reload: ReturnType<typeof vi.fn>;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  reg = Object.assign(new EventTarget(), { waiting: null, installing: null, update: vi.fn().mockResolvedValue(undefined) });
  serviceWorker = Object.assign(new EventTarget(), { controller: null, register: vi.fn().mockResolvedValue(reg) });
  reload = vi.fn();
  vi.stubGlobal("navigator", { serviceWorker });
  vi.stubGlobal("window", { location: { reload } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("sw-register", () => {
  it("registers the worker and observes installation and controller changes", async () => {
    await import("./sw-register.js"); await flush();
    expect(serviceWorker.register).toHaveBeenCalledExactlyOnceWith("/sw.js");
    expect(reload).not.toHaveBeenCalled();
  });
  it("announces an update but waits for the user before reloading", async () => {
    reg.waiting = { postMessage: vi.fn() };
    const mod = await import("./sw-register.js"); await flush();
    const listener = vi.fn(); const unsubscribe = mod.subscribeUpdateReady(listener);
    const worker = Object.assign(new EventTarget(), { state: "installing" });
    reg.installing = worker;
    serviceWorker.controller = {};
    reg.dispatchEvent(new Event("updatefound"));
    worker.state = "installed"; worker.dispatchEvent(new Event("statechange"));
    expect(mod.isUpdateReady()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
    expect(reg.waiting.postMessage).not.toHaveBeenCalled();
    // Activation in ANOTHER tab does not grant a reload in this one.
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
    mod.applyUpdate();
    expect(reg.waiting.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "SKIP_WAITING" });
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledOnce();
    unsubscribe(); worker.dispatchEvent(new Event("statechange"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("sets up periodic update check every 60 minutes, tolerating a failed check", async () => {
    await import("./sw-register.js"); await flush();
    expect(reg.update).not.toHaveBeenCalled();
    reg.update.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(reg.update).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(reg.update).toHaveBeenCalledTimes(2);
  });
  it("handles missing service worker support gracefully", async () => {
    vi.stubGlobal("navigator", {});
    const mod = await import("./sw-register.js");
    mod.applyUpdate();
    expect(mod.isUpdateReady()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
  it("logs offline-ready for the first install without requesting reload", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const worker = Object.assign(new EventTarget(), { state: "installing" });
    reg.installing = worker;
    await import("./sw-register.js"); await flush();
    worker.dispatchEvent(new Event("statechange"));
    expect(log).not.toHaveBeenCalled();
    worker.state = "installed"; worker.dispatchEvent(new Event("statechange"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Offline-ready"));
    expect(reload).not.toHaveBeenCalled();
  });
  it("reloads a first-install tab on explicit update even though it originally had no controller", async () => {
    const mod = await import("./sw-register.js"); await flush();
    serviceWorker.controller = {};
    const worker = Object.assign(new EventTarget(), { state: "installing" });
    reg.installing = worker; reg.dispatchEvent(new Event("updatefound"));
    reg.waiting = { postMessage: vi.fn() };
    worker.state = "installed"; worker.dispatchEvent(new Event("statechange"));
    mod.applyUpdate();
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledOnce();
  });
  it("lets the owner reload after another tab already activated the announced update", async () => {
    reg.waiting = { postMessage: vi.fn() };
    const mod = await import("./sw-register.js"); await flush();
    reg.waiting = null;
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
    mod.applyUpdate(); mod.applyUpdate();
    expect(reload).toHaveBeenCalledOnce();
  });
  it("reports registration failure without an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    serviceWorker.register.mockRejectedValueOnce(new Error("unavailable"));
    const mod = await import("./sw-register.js"); await flush();
    expect(warn).toHaveBeenCalledWith("[SW] Registration failed", expect.any(Error));
    expect(mod.isUpdateReady()).toBe(false);
  });
});
