#!/usr/bin/env bun
// Council PRO Economy — persistent run-stats store (spec `council-pro-economy.md`,
// Story 1: "Sbor statistiki progonov — the self-learning foundation").
//
// Records ONE row per council run carrying the tuple the adaptive levers learn
// from: (complexity, seat, model tier, diff size, did each finding survive
// verification). This increment ONLY records — it changes no dispatch behaviour,
// so it is guardrail-safe by construction (it can neither drop a finding nor
// tier-down a lens). Stories 1 (adaptive tiering) & 3 (data-derived depth
// thresholds) READ this dataset; per the spec Assumptions this collection
// increment must land FIRST so those levers have something to learn from.
//
// Persistence model: ONE atomically-written file per run under
// `<COMPANION_HOME>/council-stats/` (override `COMPANION_COUNCIL_STATS_DIR`).
// One-file-per-run (mirrors the eval sidecar) rather than a shared append log:
// on this multi-agent box several council runs can complete concurrently, and a
// tmp+rename per run is interleave-free where a concurrent `appendFileSync` past
// PIPE_BUF is not (ritchie — filesystem persistence discipline).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { COMPANION_HOME } from "../server/paths.js";
import { writeJsonAtomic } from "./atomic-json.js";
import {
  assertComplexity,
  type Complexity,
  type ComplexitySignal,
  computeComplexity,
} from "./complexity.js";

// Bump when the on-disk record shape changes. A record whose schemaVersion does
// not match is INVALIDATED by the reader (never silently coerced) — the same
// fail-closed contract Story 2's cache uses for "produced by a different
// council/engine version" (spec Story 2 negative).
export const RUN_STATS_SCHEMA_VERSION = 1;

export type FindingPriority = "P1" | "P2" | "P3";
const FINDING_PRIORITIES: ReadonlySet<string> = new Set<FindingPriority>(["P1", "P2", "P3"]);

// The two economy tiers. `top` is the pre-optimization default every seat runs
// on today (Story 1 records the baseline); Story 2 introduces `cheap` for narrow
// lenses. The fail-closed security/LLM lenses are ALWAYS `top` (spec Boundary 🚫)
// — recorded here via `SeatStat.guaranteed` so a later analysis can prove it.
export type ModelTier = "cheap" | "top";
const MODEL_TIERS: ReadonlySet<string> = new Set<ModelTier>(["cheap", "top"]);

export interface FindingStat {
  /** Stable finding id assigned by the council pipeline. */
  id: string;
  priority: FindingPriority;
  /** Did the finding survive adversarial verification (true) or get discarded. */
  survived: boolean;
}

export interface SeatStat {
  /** Advisor/lens id (e.g. `hunt`, `willison`). */
  seatId: string;
  /**
   * True when this seat is a fail-closed cross-stack lens (engine `isGuaranteed`
   * — security/refactor/llm/test). Persisted so the guardrail can later assert
   * "no guaranteed seat was ever tiered below top".
   */
  guaranteed: boolean;
  tier: ModelTier;
  /** Concrete model id dispatched for this seat (e.g. `claude-haiku-4-5-...`). */
  model: string;
  findings: FindingStat[];
}

export interface CouncilRunStats {
  schemaVersion: number;
  /** Unique per run. */
  runId: string;
  /** Server wall-clock at record time (Date.now) — never a model self-report. */
  ts: number;
  /** Which pipeline produced the run (e.g. `council-review-aura`). */
  skill: string;
  /** Engine/catalog version for cross-version invalidation; null when unknown. */
  engineVersion: string | null;
  complexity: Complexity;
  seats: SeatStat[];
}

export interface RunStatsInput {
  skill: string;
  engineVersion?: string | null;
  /** Raw complexity vector; the provisional band is computed here. */
  complexity: ComplexitySignal;
  seats: SeatStat[];
  /** Optional overrides (idempotency / deterministic tests). */
  runId?: string;
  ts?: number;
}

// Bounds — reject unbounded blobs before they reach disk (mirrors the codebase's
// isBounded* validator family; a runaway record would bloat the learning store).
const MAX_STR = 512;
const MAX_SEATS = 64;
const MAX_FINDINGS_PER_SEAT = 512;
// One record is small; cap generously. Prevents a pathological payload from
// filling the store.
const MAX_RECORD_BYTES = 256 * 1024;

function assertBoundedString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_STR) {
    throw new Error(`run-stats: ${field} must be a non-empty string ≤ ${MAX_STR} chars`);
  }
  return v;
}

function assertSeat(raw: unknown, i: number): SeatStat {
  if (!raw || typeof raw !== "object") {
    throw new Error(`run-stats: seats[${i}] must be an object`);
  }
  const s = raw as Record<string, unknown>;
  const seatId = assertBoundedString(s.seatId, `seats[${i}].seatId`);
  if (typeof s.guaranteed !== "boolean") {
    throw new Error(`run-stats: seats[${i}].guaranteed must be a boolean`);
  }
  if (typeof s.tier !== "string" || !MODEL_TIERS.has(s.tier)) {
    throw new Error(`run-stats: seats[${i}].tier must be one of ${[...MODEL_TIERS].join("|")}`);
  }
  const model = assertBoundedString(s.model, `seats[${i}].model`);
  if (!Array.isArray(s.findings) || s.findings.length > MAX_FINDINGS_PER_SEAT) {
    throw new Error(`run-stats: seats[${i}].findings must be an array ≤ ${MAX_FINDINGS_PER_SEAT}`);
  }
  const findings: FindingStat[] = s.findings.map((f, j) => {
    if (!f || typeof f !== "object") {
      throw new Error(`run-stats: seats[${i}].findings[${j}] must be an object`);
    }
    const fo = f as Record<string, unknown>;
    const id = assertBoundedString(fo.id, `seats[${i}].findings[${j}].id`);
    if (typeof fo.priority !== "string" || !FINDING_PRIORITIES.has(fo.priority)) {
      throw new Error(
        `run-stats: seats[${i}].findings[${j}].priority must be one of ${[...FINDING_PRIORITIES].join("|")}`,
      );
    }
    if (typeof fo.survived !== "boolean") {
      throw new Error(`run-stats: seats[${i}].findings[${j}].survived must be a boolean`);
    }
    return { id, priority: fo.priority as FindingPriority, survived: fo.survived };
  });
  return { seatId, guaranteed: s.guaranteed, tier: s.tier as ModelTier, model, findings };
}

/**
 * Build + validate a full record from caller input. Fills schemaVersion, runId
 * (uuid) and ts (server clock) when not overridden, and computes the provisional
 * complexity band. Throws on any invalid field (fail-loud).
 */
export function buildRunStats(input: RunStatsInput): CouncilRunStats {
  const skill = assertBoundedString(input.skill, "skill");
  if (!Array.isArray(input.seats) || input.seats.length === 0 || input.seats.length > MAX_SEATS) {
    throw new Error(`run-stats: seats must be a non-empty array ≤ ${MAX_SEATS}`);
  }
  const seats = input.seats.map((s, i) => assertSeat(s, i));
  const complexity = computeComplexity(input.complexity);
  const engineVersion =
    input.engineVersion == null ? null : assertBoundedString(input.engineVersion, "engineVersion");
  const runId = input.runId != null ? assertBoundedString(input.runId, "runId") : randomUUID();
  const ts = input.ts != null ? input.ts : Date.now();
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) {
    throw new Error("run-stats: ts must be a non-negative finite number");
  }
  return { schemaVersion: RUN_STATS_SCHEMA_VERSION, runId, ts, skill, engineVersion, complexity, seats };
}

/** Resolve the stats directory. Override precedence: arg → env → COMPANION_HOME. */
export function resolveStatsDir(override?: string): string {
  return (
    override ??
    process.env.COMPANION_COUNCIL_STATS_DIR ??
    join(COMPANION_HOME, "council-stats")
  );
}

// Filesystem-safe filename: `<ts>-<runId>.json`. runId is a uuid or a
// caller-supplied bounded string; sanitize to defend against path traversal in a
// caller-supplied runId (hunt — never trust an id straight into a path).
function statsFileName(rec: CouncilRunStats): string {
  const safeRunId = rec.runId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return `${rec.ts}-${safeRunId}.json`;
}

/**
 * Record one council run. Returns the written record (with generated ids). The
 * write is atomic (tmp+rename); a partial/corrupt file is never observable by a
 * concurrent reader.
 */
export function recordRunStats(input: RunStatsInput, opts?: { dir?: string }): CouncilRunStats {
  const rec = buildRunStats(input);
  const dir = resolveStatsDir(opts?.dir);
  writeJsonAtomic(join(dir, statsFileName(rec)), rec, { maxBytes: MAX_RECORD_BYTES, label: "run-stats" });
  return rec;
}

/**
 * Validate a FULL on-disk record, preserving every persisted field exactly as
 * written — critically the `complexity.band`/`bandSource` (a historical label
 * that must NOT be recomputed from today's seed weights) and `runId`/`ts`/
 * `schemaVersion`. Throws on any invalid field. Distinct from `buildRunStats`,
 * which is the WRITE path and (re)computes the band for a fresh record.
 */
function validateOnDiskRecord(o: Record<string, unknown>): CouncilRunStats {
  const skill = assertBoundedString(o.skill, "skill");
  if (!Array.isArray(o.seats) || o.seats.length === 0 || o.seats.length > MAX_SEATS) {
    throw new Error(`run-stats: seats must be a non-empty array ≤ ${MAX_SEATS}`);
  }
  const seats = o.seats.map((s, i) => assertSeat(s, i));
  const complexity = assertComplexity(o.complexity); // preserves band/bandSource
  const engineVersion = o.engineVersion == null ? null : assertBoundedString(o.engineVersion, "engineVersion");
  const runId = assertBoundedString(o.runId, "runId");
  const ts = o.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) {
    throw new Error("run-stats: ts must be a non-negative finite number");
  }
  const schemaVersion = o.schemaVersion;
  if (typeof schemaVersion !== "number") {
    throw new Error("run-stats: schemaVersion must be a number");
  }
  return { schemaVersion, runId, ts, skill, engineVersion, complexity, seats };
}

export type ParseRunStatsResult =
  | { ok: true; record: CouncilRunStats }
  | { ok: false; reason: "malformed" | "stale-schema" };

/**
 * Parse + validate one on-disk record. The `schemaVersion` is checked BEFORE the
 * current-shape validators so a genuinely different schema (renamed/removed
 * field — the real reason to bump the version) is reported as `stale-schema`, not
 * misclassified as `malformed` disk corruption. Pass `includeStaleSchema` to
 * still attempt validation of a differently-versioned record (works for
 * additive/compatible changes; migration tooling).
 */
export function parseRunStats(
  text: string,
  opts?: { includeStaleSchema?: boolean },
): ParseRunStatsResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!doc || typeof doc !== "object") return { ok: false, reason: "malformed" };
  const o = doc as Record<string, unknown>;
  if (typeof o.schemaVersion !== "number") return { ok: false, reason: "malformed" };
  if (o.schemaVersion !== RUN_STATS_SCHEMA_VERSION && !opts?.includeStaleSchema) {
    return { ok: false, reason: "stale-schema" };
  }
  try {
    return { ok: true, record: validateOnDiskRecord(o) };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export interface ReadRunStatsResult {
  runs: CouncilRunStats[];
  /** Files that failed JSON parse or validation. */
  malformed: number;
  /** Valid-but-wrong-schema records, invalidated (excluded from `runs`). */
  skippedSchema: number;
}

/**
 * Load every recorded run from the stats dir. Wrong-schema records are
 * invalidated (excluded) unless `includeStaleSchema` is set — matching the
 * cross-version invalidation contract the cache will share.
 */
export function readRunStats(opts?: { dir?: string; includeStaleSchema?: boolean }): ReadRunStatsResult {
  const dir = resolveStatsDir(opts?.dir);
  const out: ReadRunStatsResult = { runs: [], malformed: 0, skippedSchema: 0 };
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return out;
  }
  for (const name of entries) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      out.malformed += 1;
      continue;
    }
    const parsed = parseRunStats(text, { includeStaleSchema: opts?.includeStaleSchema });
    if (parsed.ok) {
      out.runs.push(parsed.record);
    } else if (parsed.reason === "stale-schema") {
      out.skippedSchema += 1;
    } else {
      out.malformed += 1;
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// CLI — invoked by the council pipeline to append a run, or by an operator to
// inspect the dataset. Library functions above carry the logic; this is a thin
// shell (advisor-engine convention: modules are libraries, the CLI is a shim).
// --------------------------------------------------------------------------

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function cliRecord(argv: string[]): void {
  const jsonFlagIdx = argv.indexOf("--json");
  const raw = jsonFlagIdx >= 0 ? argv[jsonFlagIdx + 1] ?? "" : readStdin();
  if (!raw.trim()) {
    console.error("run-stats record: provide a JSON payload via --json '<json>' or stdin");
    process.exit(2);
  }
  let input: RunStatsInput;
  try {
    input = JSON.parse(raw) as RunStatsInput;
  } catch (e) {
    console.error(`run-stats record: invalid JSON: ${(e as Error).message}`);
    process.exit(2);
    return;
  }
  const dirFlagIdx = argv.indexOf("--dir");
  const dir = dirFlagIdx >= 0 ? argv[dirFlagIdx + 1] : undefined;
  try {
    const rec = recordRunStats(input, dir ? { dir } : undefined);
    console.log(JSON.stringify({ ok: true, runId: rec.runId, path: join(resolveStatsDir(dir), statsFileName(rec)) }));
  } catch (e) {
    console.error(`run-stats record: ${(e as Error).message}`);
    process.exit(1);
  }
}

function cliSummary(argv: string[]): void {
  const dirFlagIdx = argv.indexOf("--dir");
  const dir = dirFlagIdx >= 0 ? argv[dirFlagIdx + 1] : undefined;
  const { runs, malformed, skippedSchema } = readRunStats(dir ? { dir } : undefined);
  const byBand: Record<string, number> = { low: 0, medium: 0, high: 0 };
  const byTier: Record<string, number> = { cheap: 0, top: 0 };
  let findings = 0;
  let survived = 0;
  for (const r of runs) {
    byBand[r.complexity.band] = (byBand[r.complexity.band] ?? 0) + 1;
    for (const s of r.seats) {
      byTier[s.tier] = (byTier[s.tier] ?? 0) + 1;
      for (const f of s.findings) {
        findings += 1;
        if (f.survived) survived += 1;
      }
    }
  }
  console.log(
    JSON.stringify(
      { dir: resolveStatsDir(dir), runs: runs.length, malformed, skippedSchema, byBand, byTier, findings, survived },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "record") cliRecord(rest);
  else if (cmd === "summary") cliSummary(rest);
  else {
    console.error("usage: run-stats.ts <record|summary> [--dir <path>] [--json <payload>]");
    process.exit(2);
  }
}
