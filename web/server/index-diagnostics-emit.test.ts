import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// EC-19 / feedback_trust_diff_not_prose: the diagnostic snapshot key
// names are operator-facing API. Log analysers, dashboards, and
// alert rules grep on these literal strings. A rename or typo at the
// emit site would silently green-stamp through typecheck (the emit
// shape is `Record<string, unknown>` at the boundary) and bury the
// alert until the next on-call rotation noticed the missing line.
//
// This canary pins each key as a LITERAL substring in the index.ts
// source. EC-19 prefers function-anchored regex extraction for
// production assertions, but the bootstrap module is a top-level
// `setInterval` lambda — we anchor on the literal field names of the
// log payload instead.
//
// PLAN T6 (Phase C): pins five cleanup-counter projection fields +
// three sweep-status fields + the memory-pressure WARN event-name +
// payload keys that the brief documented.

const indexSrc = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "index.ts"), "utf8");
})();

describe("index.ts diagnostic-emit — EC-19 literal-string canary", () => {
  // The five cleanup-counter projection field names. Each MUST appear
  // literally at the emit site so log-line consumers see the
  // documented key. The plan brief enumerates these explicitly.
  const COUNTER_KEYS = [
    "evictedLastHour",
    "orphanReapedLastHour",
    "drainedPendingLastHour",
    "recordingsSoftArchivedLastHour",
    "recordingsHardDeletedLastHour",
  ] as const;

  it.each(COUNTER_KEYS)("emits cleanup counter key '%s' literally in the diagnostic snapshot", (key) => {
    // Match the key as either a bare identifier shorthand
    // (`evictedLastHour,`) or a quoted property (`"evictedLastHour":`).
    // EC-19 — anchored on the field name, not its expected value, so
    // a cosmetic edit of the value doesn't weaken the canary.
    const pattern = new RegExp(`\\b${key}\\b`);
    expect(indexSrc).toMatch(pattern);
  });

  // The three sweep-status fields surfaced from Phase C's cleanup-
  // scheduler accessors. Same canary contract as the counters.
  const SWEEP_STATUS_KEYS = [
    "lastSweepCompletedAt",
    "lastSweepDurationMs",
    "sweepInFlight",
  ] as const;

  it.each(SWEEP_STATUS_KEYS)("emits sweep-status key '%s' literally in the diagnostic snapshot", (key) => {
    const pattern = new RegExp(`\\b${key}\\b`);
    expect(indexSrc).toMatch(pattern);
  });

  // The memory-pressure WARN event name + structured payload keys.
  // `cli.cleanup.memory_pressure` is the dotted event identifier that
  // operators alert on; the payload keys are the structured-log
  // fields the on-call runbook references.
  it("emits the cli.cleanup.memory_pressure event name literally", () => {
    expect(indexSrc).toMatch(/\bcli\.cleanup\.memory_pressure\b/);
  });

  it.each(["fullAvg300Us", "thresholdUs", "sessions", "unevictedArchivedCount"])(
    "emits memory-pressure WARN payload key '%s' literally",
    (key) => {
      const pattern = new RegExp(`\\b${key}\\b`);
      expect(indexSrc).toMatch(pattern);
    },
  );
});
