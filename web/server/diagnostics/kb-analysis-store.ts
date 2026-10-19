/**
 * On-disk state of the KB analyzer under `<COMPANION_HOME>/diagnostics/kb-analysis/`
 * (spec §3.4; plan Task 10; ritchie B1–B5, B9, B10; hunt 10, 11).
 *
 *   <UTC ts>-<runId>.json   reports — atomic, versioned, newest 20 kept (derived data)
 *   state.json              accumulation + run state — atomic, versioned
 *   decisions.jsonl         owner decisions — append-only, the audit trail; never rotated
 *   .inflight.json          marker of a running analysis — informational for the NEXT boot only
 *
 * Every path is built from a server-generated name and resolved inside the
 * reports root (EC-7). Retention matches only the strict report pattern, so it
 * can never touch decisions.jsonl, state.json, the marker, temp files or a
 * symlink planted in the directory.
 */

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { writeAtomicJson } from "../atomic-write.js";
import {
  DECISION_LINE_VERSION,
  KB_REPORT_SCHEMA_VERSION,
  KB_SIGNALS,
  type AnalysisTrigger,
  type CardSource,
  type DecisionLine,
  type KbAnalysisReport,
} from "./diagnostics-types.js";
import type { FoldedDecision } from "./kb-analyzer.js";
import { resolveInside } from "./roots.js";

export const REPORT_NAME_RE = /^(\d{8}T\d{6}Z)-([a-f0-9]{8,32})\.json$/;
export const REPORTS_KEPT = 20;
export const REPORT_MAX_BYTES = 8 * 1024 * 1024;
export const STATE_FILE = "state.json";
export const DECISIONS_FILE = "decisions.jsonl";
export const INFLIGHT_FILE = ".inflight.json";
const TMP_RE = /^\.[0-9a-f]{16}\.tmp$/;
export const STATE_SCHEMA_VERSION = 1;

export function reportFileName(generatedAt: number, runId: string): string {
  const ts = new Date(generatedAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = `${ts}-${runId}.json`;
  if (!REPORT_NAME_RE.test(name)) throw new Error(`invalid report name ${name}`);
  return name;
}

// ─── reports ────────────────────────────────────────────────────────────────

/** Report file names, oldest first. Regular files matching the strict pattern only. */
export function listReports(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => REPORT_NAME_RE.test(n))
    .filter((n) => {
      // A planted symlink with a report-shaped name is skipped, never followed.
      try {
        return lstatSync(resolveInside(root, n), { throwIfNoEntry: false })?.isFile() === true;
      } catch {
        return false;
      }
    })
    .sort();
}

export function writeReport(root: string, report: KbAnalysisReport): string {
  const name = reportFileName(report.generatedAt, report.runId);
  writeAtomicJson(resolveInside(root, name), report, { maxBytes: REPORT_MAX_BYTES });
  return name;
}

/** Delete all but the newest `keep` reports. Runs only after a new report landed. */
export function pruneReports(root: string, keep = REPORTS_KEPT): string[] {
  const names = listReports(root);
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  for (const n of doomed) unlinkSync(resolveInside(root, n));
  return doomed;
}

function isReport(v: unknown): v is KbAnalysisReport {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.schemaVersion === KB_REPORT_SCHEMA_VERSION &&
    typeof r.runId === "string" &&
    typeof r.generatedAt === "number" &&
    Array.isArray(r.findings) &&
    r.findings.every(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as { entryId?: unknown }).entryId === "string" &&
        Array.isArray((f as { signals?: unknown }).signals) &&
        (f as { signals: { signal?: unknown }[] }).signals.every((s) => (KB_SIGNALS as readonly unknown[]).includes(s.signal)),
    ) &&
    Array.isArray(r.mergeTasks)
  );
}

/** The newest report, validated. null = no report yet; unavailable = present but unusable. */
export function readLatestReport(root: string): CardSource<KbAnalysisReport> | null {
  const names = listReports(root);
  const newest = names[names.length - 1];
  if (!newest) return null;
  const path = resolveInside(root, newest);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { status: "unavailable", reason: "report-unreadable", since: statSync(path).mtimeMs };
  }
  const v = (parsed as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof v === "number" && v > KB_REPORT_SCHEMA_VERSION) {
    return { status: "unavailable", reason: "report-schema-newer", since: statSync(path).mtimeMs };
  }
  if (!isReport(parsed)) return { status: "unavailable", reason: "report-invalid", since: statSync(path).mtimeMs };
  return { status: "available", data: parsed, fetchedAt: parsed.generatedAt };
}

// ─── state.json ─────────────────────────────────────────────────────────────

export interface KbAnalysisState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  lastRun: { runId: string; at: number; trigger: AnalysisTrigger } | null;
  lastAttempt: { at: number; outcome: "ok" | "failed" | "aborted"; reason?: string } | null;
  /** Distinct sessions that finished (≥ 1 turn) since lastRun. */
  finishedSessionIds: string[];
  lastNotDueLogAt: number | null;
  /** A run died with the server; automatic triggering waits for one manual success. */
  autoTriggerSuppressed: boolean;
}

export const MAX_TRACKED_SESSIONS = 10_000;

export function emptyState(): KbAnalysisState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    lastRun: null,
    lastAttempt: null,
    finishedSessionIds: [],
    lastNotDueLogAt: null,
    autoTriggerSuppressed: false,
  };
}

/** Missing or unreadable → empty state (logged by the caller); a newer schema → null (do not overwrite it). */
export function readState(root: string): KbAnalysisState | null {
  const path = resolveInside(root, STATE_FILE);
  if (!existsSync(path)) return emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyState();
  }
  const r = (raw ?? {}) as Partial<KbAnalysisState> & { schemaVersion?: unknown };
  if (typeof r.schemaVersion === "number" && r.schemaVersion > STATE_SCHEMA_VERSION) return null;
  const s = emptyState();
  if (r.lastRun && typeof r.lastRun.runId === "string" && typeof r.lastRun.at === "number") s.lastRun = r.lastRun;
  if (r.lastAttempt && typeof r.lastAttempt.at === "number") s.lastAttempt = r.lastAttempt;
  if (Array.isArray(r.finishedSessionIds)) {
    s.finishedSessionIds = r.finishedSessionIds.filter((x): x is string => typeof x === "string").slice(-MAX_TRACKED_SESSIONS);
  }
  if (typeof r.lastNotDueLogAt === "number") s.lastNotDueLogAt = r.lastNotDueLogAt;
  s.autoTriggerSuppressed = r.autoTriggerSuppressed === true;
  return s;
}

export function writeState(root: string, state: KbAnalysisState): void {
  writeAtomicJson(resolveInside(root, STATE_FILE), state, { maxBytes: 2 * 1024 * 1024 });
}

// ─── in-flight marker ───────────────────────────────────────────────────────

export interface InflightMarker {
  runId: string;
  pid: number;
  bootTimeMs: number;
  startedAt: number;
}

export function writeInflightMarker(root: string, marker: InflightMarker): void {
  writeAtomicJson(resolveInside(root, INFLIGHT_FILE), marker, { maxBytes: 4096 });
}

export function clearInflightMarker(root: string): void {
  const p = resolveInside(root, INFLIGHT_FILE);
  if (existsSync(p)) unlinkSync(p);
}

/**
 * Boot reconcile: a marker left by an EARLIER boot means that run died with
 * the server. Consumes the marker and returns it; a marker from this boot is
 * left alone (it belongs to a live run).
 */
export function consumeStaleInflightMarker(root: string, bootTimeMs: number): InflightMarker | null {
  const p = resolveInside(root, INFLIGHT_FILE);
  if (!existsSync(p)) return null;
  let m: InflightMarker | null = null;
  try {
    m = JSON.parse(readFileSync(p, "utf8")) as InflightMarker;
  } catch {
    /* corrupt marker: treat as stale */
  }
  if (m && typeof m.bootTimeMs === "number" && m.bootTimeMs >= bootTimeMs) return null;
  unlinkSync(p);
  return m ?? { runId: "unknown", pid: 0, bootTimeMs: 0, startedAt: 0 };
}

/** Boot reconcile: remove `.<hex>.tmp` leftovers older than this boot (atomic-write orphans). */
export function sweepStaleTmp(root: string, bootTimeMs: number): string[] {
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const n of readdirSync(root)) {
    if (!TMP_RE.test(n)) continue;
    const p = resolveInside(root, n);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (st?.isFile() && st.mtimeMs < bootTimeMs) {
      unlinkSync(p);
      removed.push(n);
    }
  }
  return removed;
}

// ─── decisions.jsonl ────────────────────────────────────────────────────────

/** Last byte of the file, or null if empty/missing. */
function lastByte(path: string): number | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size === 0) return null;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0];
  } finally {
    closeSync(fd);
  }
}

/**
 * Append owner decisions: one newline-terminated JSON line each, in ONE
 * write on an O_APPEND fd, then fsync — these are human decisions, the one
 * thing in this feature whose loss loses human work. A torn last line (crash
 * mid-write) is fenced off with a newline first, so it stays torn on its own.
 */
export function appendDecisions(root: string, lines: DecisionLine[]): void {
  if (lines.length === 0) return;
  const path = resolveInside(root, DECISIONS_FILE);
  const fence = (() => {
    const b = lastByte(path);
    return b !== null && b !== 0x0a ? "\n" : "";
  })();
  const text = fence + lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isDecisionLine(v: unknown): v is DecisionLine {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    d.v === DECISION_LINE_VERSION &&
    typeof d.ts === "number" &&
    typeof d.runId === "string" &&
    typeof d.entryId === "string" &&
    (d.decision === "keep" || d.decision === "archive" || d.decision === "merge" || d.decision === "seen") &&
    (d.mergeInto === undefined || typeof d.mergeInto === "string")
  );
}

/** Read every valid line; bad lines are counted, never fatal. */
export function readDecisions(root: string): { lines: DecisionLine[]; badLines: number } {
  const path = resolveInside(root, DECISIONS_FILE);
  if (!existsSync(path)) return { lines: [], badLines: 0 };
  const lines: DecisionLine[] = [];
  let badLines = 0;
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (text.trim() === "") continue;
    try {
      const v = JSON.parse(text);
      if (isDecisionLine(v)) lines.push(v);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { lines, badLines };
}

/** Last decision per entry id (file order = decision order). */
export function foldDecisions(lines: DecisionLine[]): Map<string, FoldedDecision> {
  const out = new Map<string, FoldedDecision>();
  for (const l of lines) {
    out.set(l.entryId, { decision: l.decision, ts: l.ts, ...(l.mergeInto ? { mergeInto: l.mergeInto } : {}) });
  }
  return out;
}
