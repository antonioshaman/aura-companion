/**
 * Tests for the replay runner's cross-session aggregate. The contract that
 * matters: per-file rows preserve the absent-vs-zero distinction, the summed
 * totals NEVER fold an `unavailable` metric in as a real 0 (so Codex's missing
 * cost can't deflate the average), and an unreadable file becomes an error row
 * instead of aborting the whole scan.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aggregateRecordings,
  scoreFixtureCorpus,
  diffAgainstBaseline,
  CI_FIXTURES_DIR,
  CI_BASELINE_PATH,
  type FixtureScore,
} from "./replay-runner.js";

const FX = join(__dirname, "__fixtures__");

describe("aggregateRecordings", () => {
  it("sums only available costs/tokens and counts contributors", () => {
    const agg = aggregateRecordings([
      join(FX, "claude-basic.jsonl"),
      join(FX, "codex-basic.jsonl"),
    ]);

    expect(agg.totals.files).toBe(2);
    expect(agg.totals.recognized).toBe(2);
    // Only Claude reports a dollar cost; Codex cost is `unavailable`.
    expect(agg.totals.cost_files).toBe(1);
    expect(agg.totals.cost_usd).toBeCloseTo(0.75, 10);
    // Both backends report a token total → summed (claude 222 + codex 250).
    expect(agg.totals.token_files).toBe(2);
    expect(agg.totals.tokens).toBe(222 + 250);
  });

  it("preserves per-row backend + absent-vs-zero metrics", () => {
    const agg = aggregateRecordings([
      join(FX, "claude-basic.jsonl"),
      join(FX, "codex-basic.jsonl"),
    ]);
    const claude = agg.rows.find((r) => r.backend === "claude")!;
    const codex = agg.rows.find((r) => r.backend === "codex")!;

    expect(claude.cost_usd.kind).toBe("value");
    expect(codex.cost_usd.kind).toBe("unavailable");
    expect(codex.total_tokens.kind).toBe("value");
  });

  it("turns an unreadable file into an error row without aborting the scan", () => {
    const agg = aggregateRecordings([
      join(FX, "does-not-exist.jsonl"),
      join(FX, "claude-basic.jsonl"),
    ]);

    expect(agg.totals.files).toBe(2);
    expect(agg.rows[0]!.error).toBeTruthy();
    expect(agg.rows[0]!.backend).toBe("(unreadable)");
    // The good file still scored.
    expect(agg.rows[1]!.backend).toBe("claude");
    expect(agg.totals.cost_files).toBe(1);
  });

  it("counts an unrecognized backend but excludes it from token/cost sums", () => {
    const agg = aggregateRecordings([join(FX, "unknown-backend.jsonl")]);
    expect(agg.totals.files).toBe(1);
    expect(agg.totals.recognized).toBe(0);
    expect(agg.totals.cost_files).toBe(0);
    expect(agg.totals.token_files).toBe(0);
  });
});

/**
 * The CI gate (`eval:replay --ci`) is the load-bearing verb Phase 3 wraps in a
 * GHA step. These pin its determinism + regression sensitivity:
 *   - scoring the committed fixture corpus is sorted + deterministic (same
 *     bytes in, same scores out — no wall-clock/random)
 *   - the freshly-scored corpus EQUALS the committed baseline (so a drift
 *     between a scorer change and the baseline is caught here, not in prod)
 *   - a regression (any score drift, or a missing/extra fixture) produces a
 *     non-empty diff — which is what makes the runner's exit code non-zero
 */
describe("eval:replay --ci fixture gate", () => {
  it("scores the corpus deterministically and in sorted order", () => {
    const a = scoreFixtureCorpus(CI_FIXTURES_DIR);
    const b = scoreFixtureCorpus(CI_FIXTURES_DIR);
    // Byte-stable across runs: no wall-clock, no randomness in the score path.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Sorted by filename so the baseline diff is order-stable.
    const files = a.map((s) => s.file);
    expect(files).toEqual([...files].sort());
    expect(a.length).toBeGreaterThan(0);
  });

  it("the committed baseline matches the current corpus (zero drift)", () => {
    const current = scoreFixtureCorpus(CI_FIXTURES_DIR);
    const baseline = JSON.parse(readFileSync(CI_BASELINE_PATH, "utf8")) as FixtureScore[];
    expect(diffAgainstBaseline(current, baseline)).toEqual([]);
  });

  it("preserves absent-vs-zero in the baseline (codex cost is unavailable, not 0)", () => {
    const baseline = JSON.parse(readFileSync(CI_BASELINE_PATH, "utf8")) as FixtureScore[];
    const codex = baseline.find((s) => s.file === "codex-basic.jsonl")!;
    expect(codex.cost_usd).toBe("unavailable");
    expect(codex.total_tokens).not.toBe("unavailable");
  });

  it("flags a numeric score regression as a diff (drives non-zero exit)", () => {
    const current = scoreFixtureCorpus(CI_FIXTURES_DIR);
    // Simulate a scorer regression: one fixture's tokens collapse to 0.
    const regressed = current.map((s) =>
      s.file === "claude-basic.jsonl" ? { ...s, total_tokens: 0 } : s,
    );
    const diffs = diffAgainstBaseline(regressed, current);
    expect(diffs.length).toBe(1);
    expect(diffs[0]).toContain("claude-basic.jsonl");
    expect(diffs[0]).toContain("score drift");
  });

  it("flags an added or removed fixture against the baseline", () => {
    const current = scoreFixtureCorpus(CI_FIXTURES_DIR);
    const dropped = current.slice(1); // baseline has one the corpus lost
    const removed = diffAgainstBaseline(dropped, current);
    expect(removed.some((d) => d.includes("missing from corpus"))).toBe(true);

    const extra = diffAgainstBaseline(current, dropped); // corpus has a new one
    expect(extra.some((d) => d.includes("absent from baseline"))).toBe(true);
  });
});
