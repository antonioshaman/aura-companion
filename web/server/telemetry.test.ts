import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _resetForTest, updateSettings } from "./settings-manager.js";
import {
  DEFAULT_STATS_URL,
  getStatsBaseUrl,
  isTelemetryEnabled,
  startTelemetryHeartbeat,
  startPresencePing,
} from "./telemetry.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "telemetry-test-"));
  _resetForTest(join(tempDir, "settings.json"));
  delete process.env.COMPANION_TELEMETRY;
  delete process.env.COMPANION_STATS_URL;
  delete process.env.COMPANION_HOME;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.COMPANION_TELEMETRY;
  delete process.env.COMPANION_STATS_URL;
  delete process.env.COMPANION_HOME;
});

describe("getStatsBaseUrl", () => {
  it("defaults to the bundled aggregator URL", () => {
    expect(getStatsBaseUrl()).toBe(DEFAULT_STATS_URL);
  });

  it("honours COMPANION_STATS_URL override and strips trailing slash", () => {
    process.env.COMPANION_STATS_URL = "https://my.worker.dev/";
    expect(getStatsBaseUrl()).toBe("https://my.worker.dev");
  });
});

describe("isTelemetryEnabled", () => {
  it("is off by default", () => {
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("follows the opt-in setting when no env override", () => {
    updateSettings({ telemetryEnabled: true });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("env override forces off even when the setting is on", () => {
    updateSettings({ telemetryEnabled: true });
    process.env.COMPANION_TELEMETRY = "0";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("env override forces on even when the setting is off", () => {
    process.env.COMPANION_TELEMETRY = "1";
    expect(isTelemetryEnabled()).toBe(true);
  });
});

describe("startTelemetryHeartbeat", () => {
  it("is a no-op (no fetch) when telemetry is disabled", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const stop = startTelemetryHeartbeat("1.8.0");
    expect(fetchSpy).not.toHaveBeenCalled();
    stop();
  });

  it("sends an immediate heartbeat when enabled", () => {
    process.env.COMPANION_TELEMETRY = "1";
    process.env.COMPANION_HOME = tempDir;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const stop = startTelemetryHeartbeat("1.8.0");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/telemetry/heartbeat");
    expect((init as RequestInit).method).toBe("POST");
    stop();
  });
});

describe("startPresencePing", () => {
  it("is a no-op (no fetch) when telemetry is disabled", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const stop = startPresencePing(() => 5);
    expect(fetchSpy).not.toHaveBeenCalled();
    stop();
  });

  it("does NOT ping when enabled but no browser is connected", () => {
    process.env.COMPANION_TELEMETRY = "1";
    process.env.COMPANION_HOME = tempDir;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    // Zero connected browsers → install is up but nobody is looking.
    const stop = startPresencePing(() => 0);
    expect(fetchSpy).not.toHaveBeenCalled();
    stop();
  });

  it("pings the presence endpoint when enabled and a browser is connected", () => {
    process.env.COMPANION_TELEMETRY = "1";
    process.env.COMPANION_HOME = tempDir;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const stop = startPresencePing(() => 1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/telemetry/presence");
    expect((init as RequestInit).method).toBe("POST");
    stop();
  });
});
