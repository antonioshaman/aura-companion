// Tests for the KB-analyzer settings (diagnostics spec §3.2).
//
// What is validated:
//   - defaults are 10 entries / 25 sessions / 14 days (owner answers 2026-10-19);
//   - the disk normaliser falls back per field: a zero, negative, fractional,
//     string or NaN value never survives a load (a 0 threshold would make the
//     analyzer due every hour);
//   - the route parser is strict (EC-5): any bad field is a 400 naming that
//     field, never a silent default;
//   - the settings manager persists the object and the memory-report flag, and
//     the flag defaults to OFF.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_KB_ANALYSIS_SETTINGS,
  normalizeKbAnalysisSettings,
  parseKbAnalysisSettings,
} from "./kb-analysis-settings.js";
import { _resetForTest, getSettings, updateSettings } from "../settings-manager.js";

describe("kb-analysis settings", () => {
  it("defaults to 10 entries / 25 sessions / 14 days", () => {
    expect(DEFAULT_KB_ANALYSIS_SETTINGS).toEqual({ newEntriesThreshold: 10, sessionsThreshold: 25, maxAgeDays: 14 });
    expect(normalizeKbAnalysisSettings(undefined)).toEqual(DEFAULT_KB_ANALYSIS_SETTINGS);
  });

  it.each([0, -1, 2.5, "10", Number.NaN, 100000])("normalize drops an out-of-bounds value (%s) to the default", (bad) => {
    const out = normalizeKbAnalysisSettings({ newEntriesThreshold: bad, sessionsThreshold: 7, maxAgeDays: 3 });
    expect(out).toEqual({ newEntriesThreshold: 10, sessionsThreshold: 7, maxAgeDays: 3 });
  });

  it("parse accepts a complete in-bounds object", () => {
    expect(parseKbAnalysisSettings({ newEntriesThreshold: 1, sessionsThreshold: 10000, maxAgeDays: 365 })).toEqual({
      ok: true,
      value: { newEntriesThreshold: 1, sessionsThreshold: 10000, maxAgeDays: 365 },
    });
  });

  it("parse rejects a bad or missing field with an error naming it", () => {
    const r = parseKbAnalysisSettings({ newEntriesThreshold: 10, sessionsThreshold: 0, maxAgeDays: 14 });
    expect(r).toEqual({ ok: false, error: "kbAnalysis.sessionsThreshold must be an integer between 1 and 10000" });
    expect(parseKbAnalysisSettings({ newEntriesThreshold: 10 }).ok).toBe(false);
    expect(parseKbAnalysisSettings([1, 2, 3]).ok).toBe(false);
  });
});

describe("settings manager — kbAnalysis + diagnosticsMemoryReport", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-settings-"));
    _resetForTest(join(dir, "settings.json"));
  });
  afterEach(() => {
    _resetForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults the memory report to off and persists both keys", () => {
    expect(getSettings().diagnosticsMemoryReport).toBe(false);
    expect(getSettings().kbAnalysis).toEqual(DEFAULT_KB_ANALYSIS_SETTINGS);
    updateSettings({
      kbAnalysis: { newEntriesThreshold: 5, sessionsThreshold: 50, maxAgeDays: 7 },
      diagnosticsMemoryReport: true,
    });
    const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(onDisk.kbAnalysis).toEqual({ newEntriesThreshold: 5, sessionsThreshold: 50, maxAgeDays: 7 });
    expect(onDisk.diagnosticsMemoryReport).toBe(true);
  });
});
