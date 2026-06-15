/**
 * Eval-memory regression log — the durable record of when the L1 replay CI gate
 * caught a fixture drifting from its committed baseline.
 *
 * The CI gate (`eval:replay --ci`) is deliberately pure: its load-bearing exit
 * code derives only from recorded frame contents — no wall-clock, no random, no
 * writes. So this writer is OPT-IN (the gate appends a record only when invoked
 * with `--record-regressions`), and the timestamp is taken at the call boundary
 * and injected — this module never reads the clock itself. That keeps the default
 * gate deterministic while still giving a local/explicit run a place to leave a
 * breadcrumb the post-hoc Evaluator can mine.
 *
 * Append-only JSONL, last-write-wins by record `id` (mirrors `parseLabelLog`).
 * The `id` is derived from the drift signature, so re-recording an identical
 * regression is idempotent rather than duplicative.
 *
 * Firewall-clean: format-only, no `server/` imports.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const EVAL_REGRESSION_VERSION = 1 as const;

/** One CI-gate regression event: a baseline drift caught at a point in time. */
export interface RegressionRecord {
  eval_regression_version: typeof EVAL_REGRESSION_VERSION;
  /** Stable hash of the drift signature — identical drift → identical id. */
  id: string;
  /** Server-clock ISO timestamp, injected at the call boundary (never read here). */
  recorded_at: string;
  /** Total fixtures scored in the run that detected the drift. */
  fixtures_scored: number;
  /** Number of fixtures that drifted from baseline. */
  drifted_fixtures: number;
  /** Human-readable drift lines, exactly as `diffAgainstBaseline` produced them. */
  diffs: string[];
  /** Best-effort repo HEAD at record time; omitted when unavailable. */
  git_sha?: string;
}

/** Canonical default home for the regression log (resolved off this module). */
export const DEFAULT_REGRESSION_LOG = fileURLToPath(
  new URL("./regressions.jsonl", import.meta.url),
);

export interface BuildRegressionOptions {
  fixturesScored: number;
  diffs: string[];
  /** Server clock in ms, supplied by the caller (boundary-injected). */
  nowMs: number;
  gitSha?: string;
}

/**
 * Build a record from a non-empty drift list. The id hashes the sorted diff
 * lines so the same regression always collapses to one logical entry on read.
 */
export function buildRegressionRecord(opts: BuildRegressionOptions): RegressionRecord {
  const signature = [...opts.diffs].sort().join("\n");
  const id = "reg_" + createHash("sha256").update(signature).digest("hex").slice(0, 12);
  const rec: RegressionRecord = {
    eval_regression_version: EVAL_REGRESSION_VERSION,
    id,
    recorded_at: new Date(opts.nowMs).toISOString(),
    fixtures_scored: opts.fixturesScored,
    drifted_fixtures: opts.diffs.length,
    diffs: opts.diffs,
  };
  if (opts.gitSha) rec.git_sha = opts.gitSha;
  return rec;
}

/** Append one record as a JSON line, creating the parent dir on first write. */
export function appendRegressionRecord(path: string, record: RegressionRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

export interface RegressionLogParse {
  records: RegressionRecord[];
  /** Lines that were non-empty but could not be parsed into a record. */
  skipped: number;
}

function isRegressionRecord(v: unknown): v is RegressionRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.eval_regression_version === EVAL_REGRESSION_VERSION &&
    typeof r.id === "string" &&
    typeof r.recorded_at === "string" &&
    typeof r.fixtures_scored === "number" &&
    typeof r.drifted_fixtures === "number" &&
    Array.isArray(r.diffs)
  );
}

/**
 * Parse the append-only log, deduping by `id` last-write-wins (a later line for
 * the same id supersedes earlier ones), preserving first-seen order. Blank lines
 * are ignored; malformed lines are counted in `skipped`, never thrown.
 */
export function parseRegressionLog(text: string): RegressionLogParse {
  const byId = new Map<string, RegressionRecord>();
  const order: string[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }
    if (!isRegressionRecord(parsed)) {
      skipped++;
      continue;
    }
    if (!byId.has(parsed.id)) order.push(parsed.id);
    byId.set(parsed.id, parsed);
  }
  return { records: order.map((id) => byId.get(id)!), skipped };
}

/** Convenience reader: parse a log file path, returning an empty result if absent. */
export function readRegressionLog(path: string): RegressionLogParse {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { records: [], skipped: 0 };
  }
  return parseRegressionLog(text);
}
