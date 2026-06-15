/**
 * Council Eval Harness replay runner (M1 surface).
 *
 *   bun run eval:replay --recording <path-to-recording.jsonl>
 *   bun run eval:replay --all [--dir <recordings-dir>]
 *   bun run eval:replay --ci [--update-baseline]
 *
 * Single-recording mode loads one session recording and prints a cost/latency
 * scorecard. `--all` scans every *.jsonl in the recordings directory
 * (~/.companion/recordings by default, override via --dir or
 * COMPANION_RECORDINGS_DIR) and prints a per-session table plus aggregate
 * totals — the cheap, zero-LLM-cost way to see spend across all sessions that
 * already exist on disk.
 *
 * `--ci` is the CI-gate verb: it scores ONLY the checked-in synthetic fixtures
 * under `web/evals/__fixtures__/` (never ~/.companion/recordings), in sorted
 * order, and diffs the result against the committed `ci-baseline.json`. It
 * makes zero network calls, reads no secrets, uses no wall-clock/random (the
 * scores derive purely from recorded frame timestamps), and its EXIT CODE is
 * load-bearing — 0 when the corpus matches the baseline, 1 on a regression
 * (any score drift), 2 on an IO/usage error. This leaves Phase 3 free to wrap
 * it in a GHA step with no new secret plumbing. `--update-baseline` rewrites
 * the baseline from the current scores (run deliberately when a scorer change
 * is intended).
 *
 * The single-recording / `--all` modes are deliberately NOT wired into the
 * vitest glob (they read real recordings off disk); the `--ci` fixture gate is
 * the only mode the automated suite exercises.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRecording } from "./recording/read-recording.js";
import { scoreCostLatency, type CostLatencyScore, type Metric } from "./scorers/cost-latency.js";

interface ParsedArgs {
  recording?: string;
  all: boolean;
  ci: boolean;
  updateBaseline: boolean;
  dir?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, all: false, ci: false, updateBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--all") out.all = true;
    else if (a === "--ci") out.ci = true;
    else if (a === "--update-baseline") out.updateBaseline = true;
    else if (a === "--recording" || a === "-r") out.recording = argv[++i];
    else if (a.startsWith("--recording=")) out.recording = a.slice("--recording=".length);
    else if (a === "--dir") out.dir = argv[++i];
    else if (a.startsWith("--dir=")) out.dir = a.slice("--dir=".length);
  }
  return out;
}

export function resolveRecordingsDir(envDir?: string): string {
  if (envDir && envDir.length > 0) return envDir;
  return join(homedir(), ".companion", "recordings");
}

function fmt(m: Metric): string {
  return m.kind === "value" ? String(m.value) : `— (${m.why})`;
}

function fmtCost(m: Metric): string {
  return m.kind === "value" ? `$${m.value.toFixed(4)}` : `— (${m.why})`;
}

function fmtMs(m: Metric): string {
  return m.kind === "value" ? `${(m.value / 1000).toFixed(1)}s` : `— (${m.why})`;
}

export function renderScorecard(score: CostLatencyScore, recordingPath: string): string {
  const L: string[] = [];
  L.push("── Council Eval · cost/latency scorecard ──");
  L.push(`recording : ${recordingPath}`);
  L.push(`backend   : ${score.backend}${score.recognized ? "" : "  ⚠ UNRECOGNIZED"}`);
  L.push("tokens");
  L.push(`  input               : ${fmt(score.tokens.input)}`);
  L.push(`  output              : ${fmt(score.tokens.output)}`);
  L.push(`  cached input        : ${fmt(score.tokens.cached_input)}`);
  L.push(`  cache creation      : ${fmt(score.tokens.cache_creation_input)}`);
  L.push(`  reasoning output    : ${fmt(score.tokens.reasoning_output)}`);
  L.push(`  total               : ${fmt(score.tokens.total)}`);
  L.push(`cost      : ${fmtCost(score.cost_usd)}`);
  L.push(`latency   : wall ${fmtMs(score.latency.wall_clock_ms)} · api ${fmtMs(score.latency.api_ms)}`);
  L.push(`frames    : result=${score.frames.result} tokenUsage=${score.frames.token_usage_updated} unhandled=${score.frames.unhandled}`);
  return L.join("\n");
}

export interface AggregateRow {
  /** Recording filename (basename), for display. */
  file: string;
  /** header.session_id, or "(no header)" when absent. */
  sessionId: string;
  backend: string;
  recognized: boolean;
  cost_usd: Metric;
  total_tokens: Metric;
  wall_clock_ms: Metric;
  /** Set when the file could not be read/parsed at all. */
  error?: string;
}

export interface AggregateResult {
  rows: AggregateRow[];
  totals: {
    /** Files scanned (including ones that errored). */
    files: number;
    recognized: number;
    /** Files that contributed a dollar cost (Claude only today). */
    cost_files: number;
    cost_usd: number;
    /** Summed token totals across files that reported any. */
    tokens: number;
    token_files: number;
  };
}

/**
 * Score a list of recording paths into per-file rows + summed totals. A file
 * that cannot be read or parsed becomes an `error` row rather than aborting
 * the whole scan — one corrupt recording must not blind the aggregate.
 * `unavailable` metrics never contribute to the sums (the absent-vs-zero
 * contract: a missing cost is not a $0 cost).
 */
export function aggregateRecordings(paths: string[]): AggregateResult {
  const rows: AggregateRow[] = [];
  const totals = {
    files: 0,
    recognized: 0,
    cost_files: 0,
    cost_usd: 0,
    tokens: 0,
    token_files: 0,
  };
  for (const path of paths) {
    totals.files++;
    const file = basename(path);
    let score: CostLatencyScore;
    let sessionId = "(no header)";
    try {
      const rec = loadRecording(path);
      if (rec.header?.session_id) sessionId = rec.header.session_id;
      score = scoreCostLatency(rec);
    } catch (e) {
      rows.push({
        file,
        sessionId,
        backend: "(unreadable)",
        recognized: false,
        cost_usd: { kind: "unavailable", why: "load failed" },
        total_tokens: { kind: "unavailable", why: "load failed" },
        wall_clock_ms: { kind: "unavailable", why: "load failed" },
        error: (e as Error).message,
      });
      continue;
    }
    if (score.recognized) totals.recognized++;
    if (score.cost_usd.kind === "value") {
      totals.cost_usd += score.cost_usd.value;
      totals.cost_files++;
    }
    if (score.tokens.total.kind === "value") {
      totals.tokens += score.tokens.total.value;
      totals.token_files++;
    }
    rows.push({
      file,
      sessionId,
      backend: score.backend,
      recognized: score.recognized,
      cost_usd: score.cost_usd,
      total_tokens: score.tokens.total,
      wall_clock_ms: score.latency.wall_clock_ms,
    });
  }
  return { rows, totals };
}

export function renderAggregate(agg: AggregateResult, dir: string): string {
  const L: string[] = [];
  L.push("── Council Eval · cross-session cost/latency aggregate ──");
  L.push(`dir       : ${dir}`);
  L.push(`recordings: ${agg.totals.files}`);
  L.push("");
  for (const r of agg.rows) {
    const tag = r.error ? " ⚠ unreadable" : r.recognized ? "" : " ⚠ unrecognized";
    L.push(`${r.backend.padEnd(8)} ${fmtCost(r.cost_usd).padStart(12)}  ${fmt(r.total_tokens).padStart(12)} tok  ${fmtMs(r.wall_clock_ms).padStart(8)}  ${r.sessionId}${tag}`);
  }
  L.push("");
  L.push(`TOTAL cost    : $${agg.totals.cost_usd.toFixed(4)} (over ${agg.totals.cost_files}/${agg.totals.files} recordings reporting cost)`);
  L.push(`TOTAL tokens  : ${agg.totals.tokens} (over ${agg.totals.token_files}/${agg.totals.files} recordings reporting usage)`);
  L.push(`recognized    : ${agg.totals.recognized}/${agg.totals.files}`);
  return L.join("\n");
}

/**
 * The committed fixture corpus and its expected-score baseline. Resolved
 * relative to THIS module so the gate is location-stable regardless of cwd —
 * it never consults ~/.companion/recordings or any path outside the repo.
 */
export const CI_FIXTURES_DIR = fileURLToPath(new URL("./__fixtures__", import.meta.url));
export const CI_BASELINE_PATH = fileURLToPath(new URL("./ci-baseline.json", import.meta.url));

/** A score reduced to the comparable, serialization-stable subset the CI gate
 *  diffs. `unavailable` is kept distinct from a numeric 0 (absent-vs-zero). */
export interface FixtureScore {
  file: string;
  backend: string;
  recognized: boolean;
  total_tokens: number | "unavailable";
  cost_usd: number | "unavailable";
  wall_clock_ms: number | "unavailable";
  api_ms: number | "unavailable";
  frames: { result: number; token_usage_updated: number; unhandled: number };
}

const metricBase = (m: Metric): number | "unavailable" =>
  m.kind === "value" ? m.value : "unavailable";

/**
 * Score every `*.jsonl` fixture under `fixturesDir` in sorted (byte-stable)
 * order. Pure + deterministic: the cost/latency scores derive only from
 * recorded frame contents and timestamps — no wall-clock, no randomness — so
 * the same fixtures always yield the same corpus score.
 */
export function scoreFixtureCorpus(fixturesDir: string): FixtureScore[] {
  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  return files.map((f) => {
    const s = scoreCostLatency(loadRecording(join(fixturesDir, f)));
    return {
      file: f,
      backend: s.backend,
      recognized: s.recognized,
      total_tokens: metricBase(s.tokens.total),
      cost_usd: metricBase(s.cost_usd),
      wall_clock_ms: metricBase(s.latency.wall_clock_ms),
      api_ms: metricBase(s.latency.api_ms),
      frames: s.frames,
    };
  });
}

/** Field-level per-fixture diff between the freshly-scored corpus and the
 *  committed baseline. Empty array ⇔ no regression. */
export function diffAgainstBaseline(
  current: FixtureScore[],
  baseline: FixtureScore[],
): string[] {
  const diffs: string[] = [];
  const cur = new Map(current.map((s) => [s.file, s]));
  const base = new Map(baseline.map((s) => [s.file, s]));
  const files = [...new Set([...cur.keys(), ...base.keys()])].sort();
  for (const file of files) {
    const c = cur.get(file);
    const b = base.get(file);
    if (c && !b) {
      diffs.push(`${file}: present in corpus but absent from baseline (run --update-baseline)`);
      continue;
    }
    if (!c && b) {
      diffs.push(`${file}: in baseline but missing from corpus`);
      continue;
    }
    if (!c || !b) continue;
    const cs = JSON.stringify(c);
    const bs = JSON.stringify(b);
    if (cs !== bs) {
      diffs.push(`${file}: score drift\n      baseline=${bs}\n      current =${cs}`);
    }
  }
  return diffs;
}

function runCi(args: ParsedArgs): number {
  let scores: FixtureScore[];
  try {
    scores = scoreFixtureCorpus(CI_FIXTURES_DIR);
  } catch (e) {
    process.stderr.write(`eval:replay --ci: cannot score fixtures in ${CI_FIXTURES_DIR}: ${(e as Error).message}\n`);
    return 2;
  }
  if (scores.length === 0) {
    process.stderr.write(`eval:replay --ci: no *.jsonl fixtures under ${CI_FIXTURES_DIR}\n`);
    return 2;
  }
  if (args.updateBaseline) {
    writeFileSync(CI_BASELINE_PATH, JSON.stringify(scores, null, 2) + "\n");
    process.stdout.write(`eval:replay --ci: baseline updated — ${scores.length} fixtures → ${basename(CI_BASELINE_PATH)}\n`);
    return 0;
  }
  let baseline: FixtureScore[];
  try {
    baseline = JSON.parse(readFileSync(CI_BASELINE_PATH, "utf8")) as FixtureScore[];
  } catch (e) {
    process.stderr.write(
      `eval:replay --ci: cannot read baseline ${CI_BASELINE_PATH}: ${(e as Error).message}\n` +
        `  seed it with: bun run eval:replay --ci --update-baseline\n`,
    );
    return 2;
  }
  const diffs = diffAgainstBaseline(scores, baseline);
  if (diffs.length === 0) {
    process.stdout.write(
      `eval:replay --ci: OK — ${scores.length} fixtures match baseline (zero LLM calls)\n`,
    );
    return 0;
  }
  process.stderr.write(
    `eval:replay --ci: REGRESSION — ${diffs.length} fixture(s) drifted from baseline:\n`,
  );
  for (const d of diffs) process.stderr.write(`  • ${d}\n`);
  process.stderr.write(
    `  If this drift is intended, re-baseline with: bun run eval:replay --ci --update-baseline\n`,
  );
  return 1;
}

const USAGE =
  "usage: bun run eval:replay --recording <path-to-recording.jsonl>\n" +
  "       bun run eval:replay --all [--dir <recordings-dir>]\n" +
  "       bun run eval:replay --ci [--update-baseline]";

function runAll(args: ParsedArgs): number {
  const dir = resolveRecordingsDir(args.dir ?? process.env.COMPANION_RECORDINGS_DIR);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .map((f) => join(dir, f));
  } catch (e) {
    process.stderr.write(`eval:replay: cannot read recordings dir ${dir}: ${(e as Error).message}\n`);
    return 2;
  }
  if (files.length === 0) {
    process.stderr.write(`eval:replay: no *.jsonl recordings in ${dir}\n`);
    return 2;
  }
  const agg = aggregateRecordings(files);
  process.stdout.write(renderAggregate(agg, dir) + "\n");
  return 0;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (args.ci) return runCi(args);
  if (args.all) return runAll(args);
  if (!args.recording) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  let score: CostLatencyScore;
  try {
    const rec = loadRecording(args.recording);
    score = scoreCostLatency(rec);
  } catch (e) {
    process.stderr.write(`eval:replay: cannot read recording: ${(e as Error).message}\n`);
    return 2;
  }
  process.stdout.write(renderScorecard(score, args.recording) + "\n");
  return 0;
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.main) {
  process.exit(main());
}
