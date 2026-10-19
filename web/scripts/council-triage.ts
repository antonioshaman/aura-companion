#!/usr/bin/env bun
// Council complexity gate — solo / economy / full (handoff 2026-10-18 §1).
//
// Before a council skill builds a roster it asks: does this change need a council
// at all? The answer is a RECOMMENDATION with risk triggers, never an automatic
// threshold: the run-stats dataset is 4 files deep, so any numeric cutoff would
// be invented (spec `aura-meta-diet.md` Boundary 🚫 — the same reason
// `complexity.ts` keeps its bands provisional). What makes the recommendation
// safe to act on is the risk table: a change that touches auth, persistence,
// the CLI protocol, council machinery or deploy makes the council MANDATORY
// (never `solo`), whatever its size. Everything else is sized with the same
// small-diff limits the dispatch policy already uses for the seat budget.
//
// Every decision (recommended vs actually chosen, with a reason) is appended to
// `<council-stats>/triage.jsonl` — a sibling of the run-stats records, not a
// field on them: a solo run has no seats, and run-stats rejects an empty seat
// list by design. `report` reads that log so the gate can be calibrated from
// real choices later instead of from guesses now.
//
// Pure core (`triage`, `matchRiskTriggers`) + thin I/O (`changedFiles` via git,
// the jsonl log, the CLI). Deterministic like the rest of the engine: no Date
// in the core, code-point ordering only.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SMALL_DIFF_MAX_FILES, SMALL_DIFF_MAX_LINES } from "./dispatch-policy.js";
import { resolveStatsDir } from "./run-stats.js";

// ─── Policy ──────────────────────────────────────────────────────────────────

export type CouncilMode = "solo" | "economy" | "full";
export const COUNCIL_MODES: ReadonlySet<string> = new Set<CouncilMode>(["solo", "economy", "full"]);

export type RiskCategory = "auth" | "persistence" | "protocol" | "council" | "deploy";

export interface RiskTrigger {
  category: RiskCategory;
  /** Tested against the workspace-relative POSIX path. */
  pattern: RegExp;
  why: string;
}

/**
 * The closed risk table. A path matching any row makes the council mandatory.
 * Test files never trigger (they change no behaviour) but still count toward
 * the diff size. Rows are deliberately broad on the "code that can lose data or
 * lock the user out" side — a false positive costs one economy council, a false
 * negative costs an unreviewed auth/persistence change.
 */
export const RISK_TRIGGERS: readonly RiskTrigger[] = [
  {
    category: "auth",
    pattern: /(^|\/)[^/]*(auth|token|credential|oauth|secret|permission)[^/]*\.(ts|tsx|js|mjs|json)$/i,
    why: "authentication / credentials / permission code",
  },
  {
    category: "persistence",
    pattern: /(^|\/)[^/]*(store|persist|atomic|recorder|cache|paths|marker-fs|run-stats)[^/]*\.(ts|tsx|js|mjs)$/i,
    why: "on-disk formats and persistence paths",
  },
  {
    category: "protocol",
    pattern:
      /^web\/server\/(ws-bridge|claude-adapter|codex-adapter|cli-transport|cli-launcher|session-orchestrator|session-recovery|session-types|silent-stdio-drift-detector)\.ts$|protocol/i,
    why: "CLI stream-json / WebSocket bridge and session lifecycle",
  },
  {
    category: "council",
    pattern: /council|group-state-machine|(^|\/)observer[^/]*\.(ts|tsx|md)$|(^|\/)\.council\//i,
    why: "council mode pipeline, skills or prompts",
  },
  {
    category: "deploy",
    pattern: /^(deploy\/|\.github\/workflows\/|Dockerfile|docker-compose)|\.(sh|service|timer)$|systemd/i,
    why: "deploy / CI / service units",
  },
];

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__fixtures__\//;

export interface TriggerMatch {
  category: RiskCategory;
  path: string;
}

/** Risk-table matches for a set of paths, in input order; test files never match. */
export function matchRiskTriggers(files: readonly string[]): TriggerMatch[] {
  const out: TriggerMatch[] = [];
  for (const raw of files) {
    const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (TEST_FILE.test(path)) continue;
    for (const t of RISK_TRIGGERS) {
      if (t.pattern.test(path)) {
        out.push({ category: t.category, path });
        break; // one category per file: the first (most specific) row wins
      }
    }
  }
  return out;
}

export interface TriageInput {
  /** Workspace-relative changed files (tracked + untracked). */
  files: readonly string[];
  /** Added + deleted lines; null when unknown (binary / no git). */
  diffLines: number | null;
  /** The developer asked for a full council / release / security audit. */
  explicitFull?: boolean;
}

export interface TriageResult {
  recommendation: CouncilMode;
  /** True when a risk trigger matched: the council may be trimmed, never skipped. */
  mandatoryCouncil: boolean;
  triggers: TriggerMatch[];
  /** Distinct triggered categories, code-point sorted. */
  categories: RiskCategory[];
  diff: { files: number; lines: number | null };
  /** Provably small by the dispatch policy's limits (unknown lines are never small). */
  small: boolean;
  rationale: string[];
}

/**
 * The gate. Rules, in order:
 *   1. explicit full request → `full`;
 *   2. ≥ 2 risk categories → `full` (the change crosses trust boundaries);
 *   3. any risk trigger → `economy` (mandatory, trimmed roster);
 *   4. provably small (≤ 3 files, ≤ 150 lines, lines known) → `solo`;
 *   5. otherwise `economy`.
 * Unknown line counts fail closed toward review (rule 4 needs a known count),
 * exactly like `seatBudget`.
 */
export function triage(input: TriageInput): TriageResult {
  const files = [...input.files];
  const triggers = matchRiskTriggers(files);
  const categories = [...new Set(triggers.map((t) => t.category))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mandatoryCouncil = categories.length > 0;
  const lines = input.diffLines;
  if (lines !== null && (!Number.isInteger(lines) || lines < 0)) {
    throw new Error(`council-triage: diffLines must be a non-negative integer or null, got ${JSON.stringify(lines)}`);
  }
  const small = lines !== null && files.length <= SMALL_DIFF_MAX_FILES && lines <= SMALL_DIFF_MAX_LINES;
  const rationale: string[] = [];
  const size = `${files.length} file(s) / ${lines === null ? "unknown" : lines} line(s)`;
  let recommendation: CouncilMode;
  if (input.explicitFull) {
    recommendation = "full";
    rationale.push("full council requested explicitly (release / security audit)");
  } else if (categories.length >= 2) {
    recommendation = "full";
    rationale.push(`crosses ${categories.length} risk areas: ${categories.join(", ")}`);
  } else if (mandatoryCouncil) {
    recommendation = "economy";
    rationale.push(`touches a risk area (${categories[0]}): council mandatory, economy roster`);
  } else if (small) {
    recommendation = "solo";
    rationale.push(`small change (${size}, limits ${SMALL_DIFF_MAX_FILES} files / ${SMALL_DIFF_MAX_LINES} lines) with no risk paths`);
  } else {
    recommendation = "economy";
    rationale.push(
      lines === null
        ? `line count unknown — never solo without a known size (${size})`
        : `not provably small (${size}) — economy roster`,
    );
  }
  for (const t of triggers) rationale.push(`risk ${t.category}: ${t.path}`);
  return {
    recommendation,
    mandatoryCouncil,
    triggers,
    categories,
    diff: { files: files.length, lines },
    small,
    rationale,
  };
}

/** One line for the Chair to echo, then the rationale bullets. */
export function renderTriage(r: TriageResult): string {
  const head = `Triage: ${r.recommendation}${r.mandatoryCouncil ? " (council mandatory)" : ""} — ${r.diff.files} file(s) / ${
    r.diff.lines === null ? "unknown" : r.diff.lines
  } line(s)${r.categories.length ? `, risk: ${r.categories.join(", ")}` : ", no risk paths"}`;
  return [head, ...r.rationale.map((l) => `- ${l}`)].join("\n");
}

// ─── Changed files via git ───────────────────────────────────────────────────

export interface ChangedFiles {
  files: string[];
  /** Added + deleted lines over tracked changes; untracked files add their line count. */
  diffLines: number | null;
  base: string;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * Tracked changes vs `base` (committed-but-unmerged AND working-tree edits, via
 * `git diff --numstat <base>`) plus untracked non-ignored files. Binary files
 * count as files with 0 lines. `base` defaults to `origin/main` when it
 * resolves, else `HEAD` (= working-tree changes only).
 */
export function changedFiles(root: string, base?: string): ChangedFiles {
  let resolvedBase = base;
  if (!resolvedBase) {
    try {
      git(root, ["rev-parse", "--verify", "--quiet", "origin/main"]);
      resolvedBase = "origin/main";
    } catch {
      resolvedBase = "HEAD";
    }
  }
  const files: string[] = [];
  let lines = 0;
  const numstat = git(root, ["diff", "--numstat", resolvedBase, "--"]);
  for (const row of numstat.split("\n")) {
    if (!row.trim()) continue;
    const [added, deleted, ...rest] = row.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    files.push(path);
    if (added !== "-" && deleted !== "-") lines += Number(added) + Number(deleted);
  }
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  for (const path of untracked.split("\n")) {
    if (!path.trim()) continue;
    files.push(path);
    try {
      lines += readFileSync(join(root, path), "utf8").split("\n").length;
    } catch {
      // unreadable (binary / vanished) — counts as a file, adds no lines
    }
  }
  return { files, diffLines: lines, base: resolvedBase };
}

// ─── Decision log ────────────────────────────────────────────────────────────

export const TRIAGE_LOG_FILENAME = "triage.jsonl";
const MAX_REASON = 512;
const MAX_SKILL = 128;

export interface TriageDecision {
  ts: number;
  skill: string;
  recommendation: CouncilMode;
  /** What the Chair actually ran. */
  decision: CouncilMode;
  reason: string;
  diff: { files: number; lines: number | null };
  categories: RiskCategory[];
  mandatoryCouncil: boolean;
}

function assertMode(v: unknown, field: string): CouncilMode {
  if (typeof v !== "string" || !COUNCIL_MODES.has(v)) {
    throw new Error(`council-triage: ${field} must be one of ${[...COUNCIL_MODES].join("|")}, got ${JSON.stringify(v)}`);
  }
  return v as CouncilMode;
}

export function assertTriageDecision(raw: unknown): TriageDecision {
  if (!raw || typeof raw !== "object") throw new Error("council-triage: decision must be an object");
  const o = raw as Record<string, unknown>;
  const ts = o.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) throw new Error("council-triage: ts must be a non-negative number");
  if (typeof o.skill !== "string" || o.skill.length === 0 || o.skill.length > MAX_SKILL) {
    throw new Error(`council-triage: skill must be a non-empty string ≤ ${MAX_SKILL}`);
  }
  if (typeof o.reason !== "string" || o.reason.length > MAX_REASON) {
    throw new Error(`council-triage: reason must be a string ≤ ${MAX_REASON}`);
  }
  const diff = o.diff as Record<string, unknown> | undefined;
  if (!diff || typeof diff.files !== "number" || !Number.isInteger(diff.files) || diff.files < 0) {
    throw new Error("council-triage: diff.files must be a non-negative integer");
  }
  if (!(diff.lines === null || (typeof diff.lines === "number" && Number.isInteger(diff.lines) && diff.lines >= 0))) {
    throw new Error("council-triage: diff.lines must be a non-negative integer or null");
  }
  if (!Array.isArray(o.categories) || !o.categories.every((c) => typeof c === "string")) {
    throw new Error("council-triage: categories must be an array of strings");
  }
  if (typeof o.mandatoryCouncil !== "boolean") throw new Error("council-triage: mandatoryCouncil must be a boolean");
  return {
    ts,
    skill: o.skill,
    recommendation: assertMode(o.recommendation, "recommendation"),
    decision: assertMode(o.decision, "decision"),
    reason: o.reason,
    diff: { files: diff.files, lines: diff.lines as number | null },
    categories: o.categories as RiskCategory[],
    mandatoryCouncil: o.mandatoryCouncil,
  };
}

/** Append one decision (validated) to `<stats-dir>/triage.jsonl`. */
export function recordTriageDecision(decision: TriageDecision, opts?: { dir?: string }): void {
  const rec = assertTriageDecision(decision);
  const dir = resolveStatsDir(opts?.dir);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, TRIAGE_LOG_FILENAME), JSON.stringify(rec) + "\n");
}

/** Every valid decision in the log, file order; malformed lines are skipped and counted. */
export function readTriageDecisions(opts?: { dir?: string }): { decisions: TriageDecision[]; skipped: number } {
  const path = join(resolveStatsDir(opts?.dir), TRIAGE_LOG_FILENAME);
  if (!existsSync(path)) return { decisions: [], skipped: 0 };
  const decisions: TriageDecision[] = [];
  let skipped = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      decisions.push(assertTriageDecision(JSON.parse(line)));
    } catch {
      skipped++;
    }
  }
  return { decisions, skipped };
}

export interface TriageReport {
  total: number;
  skipped: number;
  byRecommendation: Record<CouncilMode, number>;
  byDecision: Record<CouncilMode, number>;
  /** Decisions equal to the recommendation. */
  agreed: number;
  /** Recommended solo, Chair ran a council anyway — the gate was too eager. */
  overruledToCouncil: number;
  /** Recommended a council, Chair went solo — the gate was too cautious (or a risk path was ignored). */
  overruledToSolo: number;
}

export function summarizeTriage(decisions: readonly TriageDecision[], skipped = 0): TriageReport {
  const zero = (): Record<CouncilMode, number> => ({ solo: 0, economy: 0, full: 0 });
  const r: TriageReport = {
    total: decisions.length,
    skipped,
    byRecommendation: zero(),
    byDecision: zero(),
    agreed: 0,
    overruledToCouncil: 0,
    overruledToSolo: 0,
  };
  for (const d of decisions) {
    r.byRecommendation[d.recommendation]++;
    r.byDecision[d.decision]++;
    if (d.recommendation === d.decision) r.agreed++;
    else if (d.recommendation === "solo") r.overruledToCouncil++;
    else if (d.decision === "solo") r.overruledToSolo++;
  }
  return r;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === "recommend") {
      const root = flag(rest, "--root") ?? process.cwd();
      const changed = changedFiles(root, flag(rest, "--base"));
      const result = triage({ files: changed.files, diffLines: changed.diffLines, explicitFull: rest.includes("--full") });
      if (rest.includes("--json")) {
        console.log(JSON.stringify({ ...result, base: changed.base, files: changed.files }, null, 2));
      } else {
        console.log(renderTriage(result));
        console.log(`(diff vs ${changed.base})`);
      }
    } else if (cmd === "record") {
      const categories = (flag(rest, "--categories") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as RiskCategory[];
      const linesFlag = flag(rest, "--lines");
      recordTriageDecision(
        {
          ts: Date.now(),
          skill: flag(rest, "--skill") ?? "",
          recommendation: flag(rest, "--recommendation") as CouncilMode,
          decision: flag(rest, "--decision") as CouncilMode,
          reason: flag(rest, "--reason") ?? "",
          diff: { files: Number(flag(rest, "--files") ?? 0), lines: linesFlag === undefined ? null : Number(linesFlag) },
          categories,
          mandatoryCouncil: rest.includes("--mandatory") || categories.length > 0,
        },
        { dir: flag(rest, "--dir") },
      );
      console.log(`recorded → ${join(resolveStatsDir(flag(rest, "--dir")), TRIAGE_LOG_FILENAME)}`);
    } else if (cmd === "report") {
      const { decisions, skipped } = readTriageDecisions({ dir: flag(rest, "--dir") });
      console.log(JSON.stringify(summarizeTriage(decisions, skipped), null, 2));
    } else {
      console.error(
        "usage: council-triage.ts recommend [--root <ws>] [--base <ref>] [--full] [--json]\n" +
          "       council-triage.ts record --skill <s> --recommendation <m> --decision <m> --reason <text> [--files N] [--lines N] [--categories a,b] [--mandatory] [--dir <stats-dir>]\n" +
          "       council-triage.ts report [--dir <stats-dir>]",
      );
      process.exit(2);
    }
  } catch (err) {
    console.error(`council-triage: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
