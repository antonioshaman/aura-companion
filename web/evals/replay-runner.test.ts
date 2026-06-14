/**
 * Tests for the replay runner's cross-session aggregate. The contract that
 * matters: per-file rows preserve the absent-vs-zero distinction, the summed
 * totals NEVER fold an `unavailable` metric in as a real 0 (so Codex's missing
 * cost can't deflate the average), and an unreadable file becomes an error row
 * instead of aborting the whole scan.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { aggregateRecordings } from "./replay-runner.js";

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
