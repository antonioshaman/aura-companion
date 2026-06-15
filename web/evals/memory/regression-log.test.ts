/**
 * Tests for the eval-memory regression log. The cases pin the contracts that
 * make this a durable, mineable record rather than a noisy append dump:
 *   - the record id is a STABLE hash of the drift signature, so re-recording the
 *     same drift collapses to one logical entry (idempotent, order-insensitive)
 *   - a genuinely different drift gets a different id
 *   - `recorded_at` is whatever the caller injected (server clock at boundary) —
 *     the module never reads the wall-clock itself
 *   - the parser dedupes last-write-wins by id, ignores blank lines, and counts
 *     malformed lines as skipped instead of throwing
 */

import { describe, it, expect } from "vitest";
import {
  EVAL_REGRESSION_VERSION,
  buildRegressionRecord,
  parseRegressionLog,
} from "./regression-log.js";

describe("buildRegressionRecord", () => {
  it("stamps the injected clock and the supplied counts", () => {
    const rec = buildRegressionRecord({
      fixturesScored: 5,
      diffs: ["a.jsonl: score drift"],
      nowMs: Date.UTC(2026, 5, 15, 12, 0, 0),
    });
    expect(rec.eval_regression_version).toBe(EVAL_REGRESSION_VERSION);
    expect(rec.recorded_at).toBe("2026-06-15T12:00:00.000Z");
    expect(rec.fixtures_scored).toBe(5);
    expect(rec.drifted_fixtures).toBe(1);
    expect(rec.git_sha).toBeUndefined();
  });

  it("derives the same id for the same drift regardless of diff ordering", () => {
    const a = buildRegressionRecord({
      fixturesScored: 3,
      diffs: ["x.jsonl: drift", "y.jsonl: drift"],
      nowMs: 1,
    });
    const b = buildRegressionRecord({
      fixturesScored: 3,
      diffs: ["y.jsonl: drift", "x.jsonl: drift"],
      nowMs: 999, // different clock must NOT change the id
    });
    expect(a.id).toBe(b.id);
  });

  it("derives a different id for a different drift", () => {
    const a = buildRegressionRecord({ fixturesScored: 1, diffs: ["x.jsonl: drift"], nowMs: 1 });
    const b = buildRegressionRecord({ fixturesScored: 1, diffs: ["z.jsonl: drift"], nowMs: 1 });
    expect(a.id).not.toBe(b.id);
  });

  it("includes git_sha only when provided", () => {
    const rec = buildRegressionRecord({
      fixturesScored: 1,
      diffs: ["x.jsonl: drift"],
      nowMs: 1,
      gitSha: "deadbeef",
    });
    expect(rec.git_sha).toBe("deadbeef");
  });
});

describe("parseRegressionLog", () => {
  it("dedupes by id last-write-wins, preserving first-seen order", () => {
    const first = buildRegressionRecord({ fixturesScored: 2, diffs: ["a: drift"], nowMs: 1 });
    const second = buildRegressionRecord({ fixturesScored: 9, diffs: ["a: drift"], nowMs: 2 });
    const other = buildRegressionRecord({ fixturesScored: 1, diffs: ["b: drift"], nowMs: 3 });
    // first and second share an id (same drift); second supersedes first.
    const log = [first, other, second].map((r) => JSON.stringify(r)).join("\n");
    const parsed = parseRegressionLog(log);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]!.id).toBe(first.id);
    expect(parsed.records[0]!.fixtures_scored).toBe(9); // superseded value
    expect(parsed.records[1]!.id).toBe(other.id);
  });

  it("ignores blank lines and counts malformed lines as skipped", () => {
    const good = JSON.stringify(
      buildRegressionRecord({ fixturesScored: 1, diffs: ["a: drift"], nowMs: 1 }),
    );
    const text = ["", good, "  ", "{not json", JSON.stringify({ wrong: "shape" })].join("\n");
    const parsed = parseRegressionLog(text);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.skipped).toBe(2);
  });
});
