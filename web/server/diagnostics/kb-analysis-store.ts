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
  MEMORY_SIGNALS,
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
/** Sentinel for an archive decision in progress (written before the KB move, cleared after the ledger line). */
export const ARCHIVE_PENDING_FILE = "archive-pending.json";
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

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const optionalString = (v: unknown) => v === undefined || typeof v === "string";

/** Total boundary validation: no consumer may assume nested disk JSON is typed. */
function isReport(v: unknown): v is KbAnalysisReport {
  if (!object(v)) return false;
  const entry = (e: unknown): boolean => object(e) &&
    ["id", "file", "type", "fact", "recommendation", "confidence"].every((k) => typeof e[k] === "string") &&
    strings(e.tags) && Array.isArray(e.affectedFiles) && e.affectedFiles.every((a) => object(a) && typeof a.path === "string" && typeof a.exists === "boolean") &&
    Array.isArray(e.provenance) && e.provenance.every((p) => object(p) && ["source", "reference", "date"].every((k) => typeof p[k] === "string")) &&
    (e.createdAt === null || typeof e.createdAt === "string") &&
    ["usage", "helpfulCount", "outdatedReports"].every((k) => finite(e[k])) && typeof e.promoted === "boolean";
  const signal = (s: unknown): boolean => object(s) && (KB_SIGNALS as readonly unknown[]).includes(s.signal) &&
    typeof s.criterion === "string" && optionalString(s.partnerId) && (s.similarity === undefined || finite(s.similarity));
  const memory = (m: unknown): boolean => m === null || (object(m) && finite(m.fileCount) && typeof m.truncated === "boolean" &&
    Array.isArray(m.findings) && m.findings.every((f) => object(f) &&
      ["findingId", "file", "name", "description"].every((k) => typeof f[k] === "string") &&
      Array.isArray(f.signals) && f.signals.every((s) => object(s) && (MEMORY_SIGNALS as readonly unknown[]).includes(s.signal) &&
        typeof s.criterion === "string" && optionalString(s.partnerFile))));
  return v.schemaVersion === KB_REPORT_SCHEMA_VERSION && typeof v.runId === "string" && finite(v.generatedAt) &&
    ["entries", "sessions", "age", "manual"].includes(v.trigger as string) && finite(v.kbEntryCount) && finite(v.kbParseErrors) &&
    Array.isArray(v.findings) && v.findings.every((f) => object(f) && typeof f.entryId === "string" &&
      Array.isArray(f.signals) && f.signals.every(signal) && [null, "archive", "merge"].includes(f.suggested as null | string) && entry(f.entry)) &&
    Array.isArray(v.mergeTasks) && v.mergeTasks.every((t) => object(t) && typeof t.entryId === "string" && typeof t.mergeInto === "string" && finite(t.decidedAt)) &&
    memory(v.memory);
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
export function consumeStaleInflightMarker(
  root: string,
  bootTimeMs: number,
  isOtherProcessAlive: (pid: number) => boolean = defaultIsOtherProcessAlive,
): InflightMarker | null {
  const p = resolveInside(root, INFLIGHT_FILE);
  if (!existsSync(p)) return null;
  let m: InflightMarker | null = null;
  try {
    m = JSON.parse(readFileSync(p, "utf8")) as InflightMarker;
  } catch {
    /* corrupt marker: treat as stale */
  }
  if (m && typeof m.bootTimeMs === "number" && m.bootTimeMs >= bootTimeMs) return null;
  // Review A-1: an older marker whose writer is still alive is another
  // server's LIVE run (e.g. a dev server on the same checkout) — not a crash.
  if (m && typeof m.pid === "number" && m.pid > 0 && isOtherProcessAlive(m.pid)) return null;
  unlinkSync(p);
  return m ?? { runId: "unknown", pid: 0, bootTimeMs: 0, startedAt: 0 };
}

function defaultIsOtherProcessAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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

// ─── archive-pending.json (sentinel-before-act, EC-8) ───────────────────────

export interface ArchivePending {
  v: 1;
  runId: string;
  ts: number;
  ids: string[];
}

/**
 * The ONLY proof that an archive was interrupted. Written before the KB move,
 * cleared after the decision line is appended. Boot reconcile finishes
 * exactly these ids and nothing else — an entry the owner restored by hand
 * (with or without the archive copy) is never re-archived.
 */
export function writeArchivePending(root: string, p: ArchivePending): void {
  writeAtomicJson(resolveInside(root, ARCHIVE_PENDING_FILE), p, { maxBytes: 256 * 1024 });
}

export function readArchivePending(root: string): ArchivePending | null {
  const path = resolveInside(root, ARCHIVE_PENDING_FILE);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as ArchivePending;
    return v && v.v === 1 && Array.isArray(v.ids) && typeof v.runId === "string" && typeof v.ts === "number" ? v : null;
  } catch {
    return null;
  }
}

export function clearArchivePending(root: string): void {
  const path = resolveInside(root, ARCHIVE_PENDING_FILE);
  if (existsSync(path)) unlinkSync(path);
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
  const created = !existsSync(path);
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) {
    // First decision ever: make the new directory entry durable too.
    const dirFd = openSync(root, "r");
    try {
      fsyncSync(dirFd);
    } catch {
      /* best effort: not every filesystem fsyncs directories */
    } finally {
      closeSync(dirFd);
    }
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
