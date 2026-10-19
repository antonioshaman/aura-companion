#!/usr/bin/env bun
// Council economy dispatch policy (spec `specs/aura-meta-diet.md`, Story B4:
// "a median of ≤ 3 experts per review, no paying for theatre").
//
// Why this exists: `composeCouncil` seats every advisor whose declared STACK
// signals overlap the REPOSITORY fingerprint. On this repo (bun + hono + react +
// websocket + ndjson + stdio-subprocess …) nearly every stack specialist scores
// > 0 on every change, so the historical panels ran 7–12 seats regardless of
// what the diff touched (see the B4 report). This module is the economy layer on
// top of the same scorer:
//
//   1. RELEVANCE GATE — a seat must match at least one domain the CHANGE touches.
//      A stack-signal match alone (the repo "looks like" the advisor's stack) no
//      longer earns a seat.
//   2. SEAT BUDGET — sized from the diff (`seatBudget`), filled by rank.
//   3. FAIL-CLOSED LENSES — every cross-stack lens whose domain the change
//      touches (engine `isGuaranteed`: hunt / fowler / willison / beck) is seated
//      even when that overruns the budget. The budget can only ever trim
//      specialists; it can never drop security / refactoring / LLM / test.
//
// Pure and deterministic like the rest of the engine: no Date, no randomness,
// ordering via `cmpCodePoint` only. The history analysis half (`applyPolicy…`,
// `renderDispatchReport`) is the evidence the budget was chosen against; its
// dataset is the archived review-output (the run-stats store was empty at B4).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  cmpCodePoint,
  dedupRedundant,
  isGuaranteed,
  scoreAdvisors,
  type RankedCandidate,
} from "./advisor-scorer.js";
import type { AdvisorProfile } from "./capability-catalog.js";
import { readRunStats } from "./run-stats.js";

// ─── Policy ──────────────────────────────────────────────────────────────────

/** Default seat budget for any change that is not provably small. */
export const ECONOMY_SEAT_BUDGET = 3;
/** Budget for a provably small change (both limits below, line count known). */
export const SMALL_DIFF_SEAT_BUDGET = 2;
export const SMALL_DIFF_MAX_FILES = 3;
export const SMALL_DIFF_MAX_LINES = 150;

export interface DiffSize {
  diffFiles: number;
  /** Added + deleted lines; null when unknown. */
  diffLines: number | null;
}

/**
 * Seats available to rank-fill. An unknown line count never qualifies as
 * "small" — missing data resolves to the larger budget (fail-closed toward
 * more review, never less).
 */
export function seatBudget(diff: DiffSize): number {
  const small =
    diff.diffLines !== null &&
    diff.diffFiles <= SMALL_DIFF_MAX_FILES &&
    diff.diffLines <= SMALL_DIFF_MAX_LINES;
  return small ? SMALL_DIFF_SEAT_BUDGET : ECONOMY_SEAT_BUDGET;
}

export type DropReason = "no-domain-match" | "over-budget";

export interface EconomyComposition {
  /** Seated advisors, in overall rank order (score desc, id asc). */
  seated: RankedCandidate[];
  /** Every ranked candidate NOT seated, with why — never a silent drop. */
  dropped: { advisorId: string; reason: DropReason }[];
  budget: number;
  /** True when fail-closed lenses alone exceeded the budget (all still seated). */
  overBudget: boolean;
}

/**
 * Economy seat selection over an already scored + deduped candidate list.
 * Guaranteed lenses first (all of them), then domain-relevant candidates by rank
 * until the budget is reached.
 */
export function selectEconomySeats(ranked: RankedCandidate[], budget: number): EconomyComposition {
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error(`dispatch-policy: budget must be a positive integer, got ${budget}`);
  }
  const seated: RankedCandidate[] = ranked.filter(isGuaranteed);
  const overBudget = seated.length > budget;
  const dropped: EconomyComposition["dropped"] = [];
  for (const c of ranked) {
    if (isGuaranteed(c)) continue;
    if (c.matchedDomains.length === 0) {
      dropped.push({ advisorId: c.advisorId, reason: "no-domain-match" });
    } else if (seated.length < budget) {
      seated.push(c);
    } else {
      dropped.push({ advisorId: c.advisorId, reason: "over-budget" });
    }
  }
  seated.sort((a, b) => b.score - a.score || cmpCodePoint(a.advisorId, b.advisorId));
  return { seated, dropped, budget, overBudget };
}

/** Score → dedup → economy selection in one deterministic pass. */
export function composeEconomyCouncil(
  fingerprintSignals: string[],
  changedDomains: string[],
  profiles: AdvisorProfile[],
  diff: DiffSize,
): EconomyComposition {
  const ranked = dedupRedundant(scoreAdvisors({ signals: fingerprintSignals }, changedDomains, profiles));
  return selectEconomySeats(ranked, seatBudget(diff));
}

// ─── History dataset ─────────────────────────────────────────────────────────

export type FindingPriority = "P1" | "P2" | "P3";

export interface HistoryFinding {
  priority: FindingPriority;
  /** Catalog ids credited in the FINAL-REVIEW attribution row. */
  creditedSeats: string[];
}

export interface HistoryReview extends DiffSize {
  reviewId: string;
  sizeSource: string;
  /** Historical seat names (expert output files actually written). */
  panel: string[];
  /** The same seats mapped to today's catalog ids. */
  panelCatalogIds: string[];
  changedDomains: string[];
  /** null when FINAL-REVIEW is absent or has no attribution rows. */
  finalFindings: HistoryFinding[] | null;
}

export interface DispatchHistory {
  fingerprintSignals: string[];
  reviews: HistoryReview[];
}

const PRIORITIES: ReadonlySet<string> = new Set(["P1", "P2", "P3"]);

function assertStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0)) {
    throw new Error(`dispatch-history: ${field} must be an array of non-empty strings`);
  }
  return v as string[];
}

function assertCount(v: unknown, field: string, nullable: boolean): number | null {
  if (nullable && v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error(`dispatch-history: ${field} must be a non-negative integer${nullable ? " or null" : ""}`);
  }
  return v;
}

/** Validate the dataset. Fail-loud: a malformed row would silently skew the median. */
export function parseDispatchHistory(raw: unknown): DispatchHistory {
  if (!raw || typeof raw !== "object") throw new Error("dispatch-history: expected an object");
  const o = raw as Record<string, unknown>;
  const fingerprintSignals = assertStringArray(o.fingerprintSignals, "fingerprintSignals");
  if (!Array.isArray(o.reviews) || o.reviews.length === 0) {
    throw new Error("dispatch-history: reviews must be a non-empty array");
  }
  const seen = new Set<string>();
  const reviews = o.reviews.map((r, i): HistoryReview => {
    if (!r || typeof r !== "object") throw new Error(`dispatch-history: reviews[${i}] must be an object`);
    const x = r as Record<string, unknown>;
    if (typeof x.reviewId !== "string" || x.reviewId.length === 0) {
      throw new Error(`dispatch-history: reviews[${i}].reviewId must be a non-empty string`);
    }
    if (seen.has(x.reviewId)) throw new Error(`dispatch-history: duplicate reviewId ${x.reviewId}`);
    seen.add(x.reviewId);
    const at = `reviews[${i}]`;
    const panel = assertStringArray(x.panel, `${at}.panel`);
    if (panel.length === 0) throw new Error(`dispatch-history: ${at}.panel must be non-empty`);
    let finalFindings: HistoryFinding[] | null = null;
    if (x.finalFindings !== null) {
      if (!Array.isArray(x.finalFindings)) throw new Error(`dispatch-history: ${at}.finalFindings must be an array or null`);
      finalFindings = x.finalFindings.map((f, j) => {
        const fo = (f ?? {}) as Record<string, unknown>;
        if (typeof fo.priority !== "string" || !PRIORITIES.has(fo.priority)) {
          throw new Error(`dispatch-history: ${at}.finalFindings[${j}].priority must be P1|P2|P3`);
        }
        const creditedSeats = assertStringArray(fo.creditedSeats, `${at}.finalFindings[${j}].creditedSeats`);
        if (creditedSeats.length === 0) {
          throw new Error(`dispatch-history: ${at}.finalFindings[${j}].creditedSeats must be non-empty`);
        }
        return { priority: fo.priority as FindingPriority, creditedSeats };
      });
    }
    if (typeof x.sizeSource !== "string" || x.sizeSource.length === 0) {
      throw new Error(`dispatch-history: ${at}.sizeSource must be a non-empty string`);
    }
    return {
      reviewId: x.reviewId,
      diffFiles: assertCount(x.diffFiles, `${at}.diffFiles`, false) as number,
      diffLines: assertCount(x.diffLines, `${at}.diffLines`, true),
      sizeSource: x.sizeSource,
      panel,
      panelCatalogIds: assertStringArray(x.panelCatalogIds, `${at}.panelCatalogIds`),
      changedDomains: assertStringArray(x.changedDomains, `${at}.changedDomains`),
      finalFindings,
    };
  });
  return { fingerprintSignals, reviews };
}

// ─── Analysis ────────────────────────────────────────────────────────────────

export type SizeBucket = "S" | "M" | "L";

/**
 * Diff-size bucket for the report. S: ≤ 5 files and a known ≤ 600 lines.
 * L: > 20 files or > 2000 lines. Everything else (including unknown lines on a
 * small file count) is M.
 */
export function sizeBucket(d: DiffSize): SizeBucket {
  if (d.diffFiles > 20 || (d.diffLines !== null && d.diffLines > 2000)) return "L";
  if (d.diffFiles <= 5 && d.diffLines !== null && d.diffLines <= 600) return "S";
  return "M";
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface Coverage {
  total: number;
  covered: number;
}

export interface ReviewOutcome {
  reviewId: string;
  bucket: SizeBucket;
  diffFiles: number;
  diffLines: number | null;
  historicalSeats: number;
  economySeats: string[];
  budget: number;
  overBudget: boolean;
  /** Cross-stack lenses whose domain the change touched but which were NOT seated. Must be empty. */
  guaranteedMissed: string[];
  /** FINAL findings credited to at least one economy seat (null when no attribution data). */
  findings: Coverage | null;
  p1: Coverage | null;
  /** Credited seats of every P1 NOT covered by an economy seat (one entry per seat per lost P1). */
  lostP1Seats: string[];
}

function coverage(findings: HistoryFinding[], seated: Set<string>, onlyP1: boolean): Coverage {
  const pool = onlyP1 ? findings.filter((f) => f.priority === "P1") : findings;
  return { total: pool.length, covered: pool.filter((f) => f.creditedSeats.some((s) => seated.has(s))).length };
}

/** Replay the economy policy over every archived review. */
export function applyPolicyToHistory(history: DispatchHistory, profiles: AdvisorProfile[]): ReviewOutcome[] {
  const crossStack = profiles.filter((p) => p.signals.includes("any"));
  return history.reviews.map((r) => {
    const comp = composeEconomyCouncil(history.fingerprintSignals, r.changedDomains, profiles, r);
    const ids = comp.seated.map((c) => c.advisorId);
    const seated = new Set(ids);
    const changed = new Set(r.changedDomains);
    const guaranteedMissed = crossStack
      .filter((p) => p.domains.some((d) => changed.has(d)) && !seated.has(p.id))
      .map((p) => p.id)
      .sort(cmpCodePoint);
    return {
      reviewId: r.reviewId,
      bucket: sizeBucket(r),
      diffFiles: r.diffFiles,
      diffLines: r.diffLines,
      historicalSeats: r.panel.length,
      economySeats: ids,
      budget: comp.budget,
      overBudget: comp.overBudget,
      guaranteedMissed,
      findings: r.finalFindings ? coverage(r.finalFindings, seated, false) : null,
      p1: r.finalFindings ? coverage(r.finalFindings, seated, true) : null,
      lostP1Seats: (r.finalFindings ?? [])
        .filter((f) => f.priority === "P1" && !f.creditedSeats.some((s) => seated.has(s)))
        .flatMap((f) => f.creditedSeats)
        .sort(cmpCodePoint),
    };
  });
}

function distribution(xs: number[]): string {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
}

function sumCoverage(cs: (Coverage | null)[]): Coverage {
  return cs.reduce<Coverage>(
    (acc, c) => (c ? { total: acc.total + c.total, covered: acc.covered + c.covered } : acc),
    { total: 0, covered: 0 },
  );
}

function pct(c: Coverage): string {
  return c.total === 0 ? "—" : `${c.covered}/${c.total} (${Math.round((100 * c.covered) / c.total)}%)`;
}

const BUCKET_LABEL: Record<SizeBucket, string> = {
  S: "S (≤5 files, ≤600 lines)",
  M: "M",
  L: "L (>20 files or >2000 lines)",
};

/** Deterministic markdown for the history half of the B4 report. */
export function renderDispatchReport(outcomes: ReviewOutcome[]): string {
  const lines: string[] = [];
  const hist = outcomes.map((o) => o.historicalSeats);
  const econ = outcomes.map((o) => o.economySeats.length);
  lines.push("| Panel | Reviews | Median seats | Distribution (seats×reviews) |");
  lines.push("|---|---|---|---|");
  lines.push(`| Historical (dispatched) | ${outcomes.length} | ${median(hist)} | ${distribution(hist)} |`);
  lines.push(`| Economy policy (replayed) | ${outcomes.length} | ${median(econ)} | ${distribution(econ)} |`);
  lines.push("");
  lines.push("| Diff size | Reviews | Historical median | Economy median | FINAL findings kept | P1 kept |");
  lines.push("|---|---|---|---|---|---|");
  for (const b of ["S", "M", "L"] as const) {
    const g = outcomes.filter((o) => o.bucket === b);
    if (g.length === 0) {
      lines.push(`| ${BUCKET_LABEL[b]} | 0 | — | — | — | — |`);
      continue;
    }
    lines.push(
      `| ${BUCKET_LABEL[b]} | ${g.length} | ${median(g.map((o) => o.historicalSeats))} | ` +
        `${median(g.map((o) => o.economySeats.length))} | ${pct(sumCoverage(g.map((o) => o.findings)))} | ` +
        `${pct(sumCoverage(g.map((o) => o.p1)))} |`,
    );
  }
  lines.push(
    `| **All** | ${outcomes.length} | ${median(hist)} | ${median(econ)} | ` +
      `${pct(sumCoverage(outcomes.map((o) => o.findings)))} | ${pct(sumCoverage(outcomes.map((o) => o.p1)))} |`,
  );
  const lost = new Map<string, number>();
  for (const id of outcomes.flatMap((o) => o.lostP1Seats)) lost.set(id, (lost.get(id) ?? 0) + 1);
  const lostRows = [...lost.entries()].sort((a, b) => b[1] - a[1] || cmpCodePoint(a[0], b[0]));
  lines.push("");
  lines.push("| Seat credited on a P1 the economy panel would not have seated | P1 findings |");
  lines.push("|---|---|");
  for (const [id, n] of lostRows) lines.push(`| ${id} | ${n} |`);
  if (lostRows.length === 0) lines.push("| none | 0 |");
  lines.push("");
  lines.push("| Review | Files | Lines | Historical | Economy seats | Budget | Findings kept | P1 kept | Guaranteed missed |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const o of outcomes) {
    lines.push(
      `| ${o.reviewId} | ${o.diffFiles} | ${o.diffLines ?? "?"} | ${o.historicalSeats} | ` +
        `${o.economySeats.join(", ")} | ${o.budget}${o.overBudget ? " (over)" : ""} | ` +
        `${o.findings ? pct(o.findings) : "n/a"} | ${o.p1 ? pct(o.p1) : "n/a"} | ` +
        `${o.guaranteedMissed.length === 0 ? "none" : o.guaranteedMissed.join(", ")} |`,
    );
  }
  return lines.join("\n") + "\n";
}

// ─── Fixtures + CLI ──────────────────────────────────────────────────────────

const FIXTURES = join(dirname(new URL(import.meta.url).pathname), "__fixtures__");
export const DEFAULT_HISTORY_PATH = join(FIXTURES, "council-dispatch", "history.json");
export const DEFAULT_PROFILES_PATH = join(FIXTURES, "council-catalog", "profiles.json");

export function loadHistory(path: string = DEFAULT_HISTORY_PATH): DispatchHistory {
  return parseDispatchHistory(JSON.parse(readFileSync(path, "utf8")));
}

export function loadProfiles(path: string = DEFAULT_PROFILES_PATH): AdvisorProfile[] {
  const doc = JSON.parse(readFileSync(path, "utf8")) as { profiles?: AdvisorProfile[] };
  if (!Array.isArray(doc.profiles) || doc.profiles.length === 0) {
    throw new Error(`dispatch-policy: no profiles in ${path}`);
  }
  return doc.profiles;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd !== "report") {
    console.error("usage: dispatch-policy.ts report [--history <json>] [--profiles <json>] [--stats-dir <dir>]");
    process.exit(2);
  }
  const outcomes = applyPolicyToHistory(
    loadHistory(flag(rest, "--history")),
    loadProfiles(flag(rest, "--profiles")),
  );
  process.stdout.write(renderDispatchReport(outcomes));
  // Live run-stats are environment-dependent, so they are printed after (never
  // inside) the deterministic history block.
  const { runs, malformed, skippedSchema } = readRunStats({ dir: flag(rest, "--stats-dir") });
  const seats = runs.map((r) => r.seats.length);
  process.stdout.write(
    `\nrun-stats: ${runs.length} run(s), median seats ${median(seats) ?? "—"}` +
      ` (${distribution(seats) || "no data"}), malformed ${malformed}, stale-schema ${skippedSchema}\n`,
  );
}
