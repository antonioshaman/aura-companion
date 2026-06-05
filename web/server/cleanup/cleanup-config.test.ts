import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { loadCleanupConfig } from "./cleanup-config.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// All tests pass an explicit `env` to keep them hermetic — the loader
// defaults to process.env but accepts an injected map.
//
// We spy on the structured logger so we can assert on emit shape per
// EC-22 (typed-channel emit paths need behavioural-assertion tests).

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const loggerModule = await import("../logger.js");
  infoSpy = vi.spyOn(loggerModule.log, "info").mockImplementation(() => undefined);
  warnSpy = vi.spyOn(loggerModule.log, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadCleanupConfig — defaults", () => {
  // The default profile is what production sees on a vanilla install.
  // Codifying it here turns "I assumed the default" into a typecheck-able
  // contract — a future env-rename or default-flip goes red here first.
  it("uses documented defaults when env is empty", () => {
    const cfg = loadCleanupConfig({});

    expect(cfg.evictionGrace).toEqual({ enabled: true, ms: 24 * HOUR_MS });
    expect(cfg.archiveTtl).toEqual({ enabled: true, ms: 30 * DAY_MS });
    expect(cfg.recordingsSoftTtl).toEqual({ enabled: true, ms: 14 * DAY_MS });
    expect(cfg.recordingsHardTtl).toEqual({ enabled: true, ms: 60 * DAY_MS });
    expect(cfg.logsTtl).toEqual({ enabled: true, ms: 7 * DAY_MS });
    expect(cfg.memoryPressureWarn).toEqual({ enabled: true, us: 10_000_000 });
  });

  // The structured log line is operator-facing API — log analyzers will
  // grep `event=cleanup.config.resolved` so we pin both the event name
  // and the per-knob `source` discriminator.
  it("emits cleanup.config.resolved info per knob with source=default", () => {
    loadCleanupConfig({});
    expect(infoSpy).toHaveBeenCalledTimes(6);
    for (const call of infoSpy.mock.calls) {
      const data = call[2] as Record<string, unknown>;
      expect(data.event).toBe("cleanup.config.resolved");
      expect(data.source).toBe("default");
    }
  });
});

describe("loadCleanupConfig — env override", () => {
  // Hours-unit knob: prove the multiplication landed at ms scale.
  it("parses AURA_EVICTION_GRACE_HOURS as hours → ms", () => {
    const cfg = loadCleanupConfig({ AURA_EVICTION_GRACE_HOURS: "2" });
    expect(cfg.evictionGrace).toEqual({ enabled: true, ms: 2 * HOUR_MS });
  });

  // Days-unit knob: same shape check for the days→ms multiplier.
  it("parses AURA_ARCHIVE_TTL_DAYS as days → ms", () => {
    const cfg = loadCleanupConfig({ AURA_ARCHIVE_TTL_DAYS: "5" });
    expect(cfg.archiveTtl).toEqual({ enabled: true, ms: 5 * DAY_MS });
  });

  // Microseconds-unit knob: stays in us, doesn't get multiplied.
  it("parses AURA_MEMORY_PRESSURE_WARN_THRESHOLD_US in microseconds (no unit conversion)", () => {
    const cfg = loadCleanupConfig({ AURA_MEMORY_PRESSURE_WARN_THRESHOLD_US: "5000000" });
    expect(cfg.memoryPressureWarn).toEqual({ enabled: true, us: 5_000_000 });
  });
});

describe("loadCleanupConfig — 0 = disabled sentinel", () => {
  // The whole reason for the discriminated union — `0` resolves to
  // `{enabled: false}` once, not "still 0" that downstream re-interprets.
  it("treats 0 as disabled for duration knobs", () => {
    const cfg = loadCleanupConfig({
      AURA_EVICTION_GRACE_HOURS: "0",
      AURA_ARCHIVE_TTL_DAYS: "0",
      AURA_RECORDINGS_SOFT_TTL_DAYS: "0",
      AURA_RECORDINGS_HARD_TTL_DAYS: "0",
      AURA_LOGS_TTL_DAYS: "0",
    });
    expect(cfg.evictionGrace).toEqual({ enabled: false });
    expect(cfg.archiveTtl).toEqual({ enabled: false });
    expect(cfg.recordingsSoftTtl).toEqual({ enabled: false });
    expect(cfg.recordingsHardTtl).toEqual({ enabled: false });
    expect(cfg.logsTtl).toEqual({ enabled: false });
  });

  it("treats 0 as disabled for the memory-pressure threshold", () => {
    const cfg = loadCleanupConfig({ AURA_MEMORY_PRESSURE_WARN_THRESHOLD_US: "0" });
    expect(cfg.memoryPressureWarn).toEqual({ enabled: false });
  });
});

describe("loadCleanupConfig — invalid input", () => {
  // Negative, fractional, alphabetic — every shape that's NOT a
  // non-negative integer string falls back to default + WARN. Boot does
  // not abort: a typo'd env var should not take prod down, but the
  // operator MUST see the line in logs.
  const invalidInputs: ReadonlyArray<[string, string]> = [
    ["negative",   "-5"],
    ["fractional", "1.5"],
    ["leading ws", " 3"],
    ["alphabetic", "foo"],
    ["empty-ish",  "  "],
  ];

  for (const [label, raw] of invalidInputs) {
    it(`falls back to default on ${label} input (${JSON.stringify(raw)})`, () => {
      const cfg = loadCleanupConfig({ AURA_ARCHIVE_TTL_DAYS: raw });
      expect(cfg.archiveTtl).toEqual({ enabled: true, ms: 30 * DAY_MS });
    });
  }

  // Pin the warn-line shape so an alert that watches
  // `event=cleanup.config.resolved AND reason=invalid_input` keeps
  // firing across refactors.
  it("emits a WARN naming the offending env value with reason=invalid_input", () => {
    loadCleanupConfig({ AURA_LOGS_TTL_DAYS: "-1" });
    const warnCalls = warnSpy.mock.calls.filter((c: unknown[]) => {
      const data = c[2] as Record<string, unknown>;
      return data.knob === "logsTtl";
    });
    expect(warnCalls).toHaveLength(1);
    const data = warnCalls[0][2] as Record<string, unknown>;
    expect(data.event).toBe("cleanup.config.resolved");
    expect(data.source).toBe("default");
    expect(data.rawEnvValue).toBe("-1");
    expect(data.reason).toBe("invalid_input");
  });
});

describe("loadCleanupConfig — narrowing ergonomics", () => {
  // The whole point of the discriminated union: a consumer should be
  // able to `if (!cfg.x.enabled) return` and have TS narrow inside.
  // This test fails at typecheck (not at runtime) if the union shape
  // regresses — which is the contract we want pinned.
  it("narrows cfg.archiveTtl.ms after enabled-check", () => {
    const cfg = loadCleanupConfig({});
    const ttl = cfg.archiveTtl;
    if (!ttl.enabled) {
      throw new Error("expected enabled for default");
    }
    // TS should know `ms` exists here — runtime assertion confirms shape.
    expect(typeof ttl.ms).toBe("number");
  });
});
