#!/usr/bin/env bun
// Knowledge-base lifecycle engine (spec `aura-meta-diet.md`, Story A2).
//
// The KB under `.agents/knowledge/*.jsonl` only had a *described* lifecycle: the
// skills told the agent to bump `usageCount`, but nothing enforced it and nothing
// ever archived a dead entry (baseline 2026-09-28: 137 entries, 2 ever surfaced).
// This module makes the lifecycle mechanical:
//
//   report  — total / used≥1 / helpful≥1 / promoted / stale / never-surfaced /
//             idle / confidence distribution. Corrupt lines (stores or usage
//             log) are reported with `file:line`, the rest is still processed,
//             exit code is non-zero.
//   record  — called by `/prime` with the ids it surfaced. Appends ONE line to
//             the usage log; never touches the stores.
//   prune   — moves entries idle for ≥ N consecutive prime sessions (default 20)
//             into `.agents/knowledge/archive/<store>.jsonl` with a reason.
//             Never deletes. This is the only command that rewrites a store —
//             archiving is a deliberate content change.
//
// Telemetry is kept apart from content (FIX-A2-1). The stores are tracked in git
// and live in checkouts where Council pairs run; writing counters into them made
// every /prime dirty the prod checkout (blocking `git pull --ff-only` on deploy)
// and lost updates when two /prime runs raced a read-modify-write. So usage goes
// to `.agents/knowledge/usage.log` (gitignored): NDJSON, one line per /prime,
// written with a single O_APPEND write — concurrent writers each get their own
// line, nothing is read back first. The log order IS the session clock: line k
// (1-based, valid lines only) is prime session k.
//
// Derived per entry:
//   usage     = the entry's `usageCount` field (a frozen pre-log baseline, no
//               longer written by tooling) + the number of log lines naming it.
//   idle age  = log sessions after the later of the entry's last surfacing and
//               its `createdAt`. A row just appended by /learn therefore starts at
//               0 without any stamp in the store; a row with no parseable
//               `createdAt` and no surfacing has idle age 0 (never auto-pruned).
//
// Rewrites preserve unparseable lines verbatim — a corrupt row is reported, never
// silently dropped by a lifecycle write.

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { writeTextAtomic } from "./atomic-json.js";

export const DEFAULT_IDLE_THRESHOLD = 20;
// Not `.jsonl`: `loadKb` treats every `*.jsonl` in the KB dir as a content store.
export const USAGE_LOG_FILE = "usage.log";
export const ARCHIVE_DIR = "archive";

export type KbEntry = Record<string, unknown> & { id: string };

// `text` is the original line; it is written back verbatim, so a lifecycle
// write never reformats rows it does not move.
type KbLine =
  | { kind: "entry"; entry: KbEntry; text: string }
  | { kind: "raw"; text: string };

export interface KbStore {
  file: string; // basename, e.g. "gotchas.jsonl"
  lines: KbLine[];
}

export interface KbParseError {
  file: string;
  line: number; // 1-based
  message: string;
}

export interface KbLoad {
  stores: KbStore[];
  errors: KbParseError[];
}

// One recorded /prime run. `session` is an opaque run id (for tracing); the
// session *number* is the line's position in the log.
export interface UsageRecord {
  session: string;
  at: string; // ISO
  ids: string[];
}

export interface UsageLog {
  records: UsageRecord[];
  errors: KbParseError[];
}

// Aggregated view of the log that the lifecycle rules consume.
export interface UsageIndex {
  primeSessions: number;
  counts: Map<string, number>;
  lastSession: Map<string, number>; // 1-based session number of last surfacing
  sessionTimes: number[]; // epoch ms of session k at index k-1
}

export interface KbHealth {
  total: number;
  used: number; // usage >= 1
  helpful: number; // helpfulCount >= 1
  promoted: number;
  stale: number;
  neverSurfaced: number; // usage == 0
  idle: number; // prune candidates at the configured threshold
  usedRatio: number;
  confidence: Record<string, number>;
  primeSessions: number;
  idleThreshold: number;
  errors: KbParseError[];
}

export function loadKb(kbDir: string): KbLoad {
  const stores: KbStore[] = [];
  const errors: KbParseError[] = [];
  const files = readdirSync(kbDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (const file of files) {
    const content = readFileSync(join(kbDir, file), "utf8");
    const rawLines = content.split("\n");
    if (rawLines[rawLines.length - 1] === "") rawLines.pop();
    const lines: KbLine[] = rawLines.map((text, i) => {
      if (text.trim() === "") return { kind: "raw", text };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        errors.push({ file, line: i + 1, message: `invalid JSON: ${(err as Error).message}` });
        return { kind: "raw", text };
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        typeof (parsed as { id?: unknown }).id !== "string"
      ) {
        errors.push({ file, line: i + 1, message: "not a KB entry object with a string id" });
        return { kind: "raw", text };
      }
      return { kind: "entry", entry: parsed as KbEntry, text };
    });
    stores.push({ file, lines });
  }
  return { stores, errors };
}

export function entriesOf(load: KbLoad): KbEntry[] {
  return load.stores.flatMap((s) =>
    s.lines.flatMap((l) => (l.kind === "entry" ? [l.entry] : [])),
  );
}

function isUsageRecord(v: unknown): v is UsageRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.session === "string" &&
    typeof r.at === "string" &&
    Number.isFinite(Date.parse(r.at)) &&
    Array.isArray(r.ids) &&
    r.ids.every((id) => typeof id === "string")
  );
}

// Fail closed per line: a malformed line is reported and does NOT count as a
// session (it could not have come from `record`), the rest is still used.
export function readUsageLog(kbDir: string): UsageLog {
  const p = join(kbDir, USAGE_LOG_FILE);
  if (!existsSync(p)) return { records: [], errors: [] };
  const records: UsageRecord[] = [];
  const errors: KbParseError[] = [];
  readFileSync(p, "utf8")
    .split("\n")
    .forEach((text, i) => {
      if (text.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        errors.push({ file: USAGE_LOG_FILE, line: i + 1, message: `invalid JSON: ${(err as Error).message}` });
        return;
      }
      if (!isUsageRecord(parsed)) {
        errors.push({ file: USAGE_LOG_FILE, line: i + 1, message: "not a usage record {session, at, ids[]}" });
        return;
      }
      records.push(parsed);
    });
  return { records, errors };
}

export function indexUsage(log: UsageLog): UsageIndex {
  const counts = new Map<string, number>();
  const lastSession = new Map<string, number>();
  const sessionTimes: number[] = [];
  log.records.forEach((r, i) => {
    sessionTimes.push(Date.parse(r.at));
    for (const id of new Set(r.ids)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      lastSession.set(id, i + 1);
    }
  });
  return { primeSessions: log.records.length, counts, lastSession, sessionTimes };
}

function num(entry: KbEntry, key: string): number {
  const v = entry[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function usageOf(entry: KbEntry, usage: UsageIndex): number {
  return num(entry, "usageCount") + (usage.counts.get(entry.id) ?? 0);
}

export function isPromoted(entry: KbEntry): boolean {
  return entry.promoted === true;
}

// Field-driven staleness, verbatim from `/evolve` (mode: prune): flagged at least
// twice with no re-confirmation to balance it, or surfaced often and never
// confirmed helpful (too generic).
export function isStale(entry: KbEntry, usage: UsageIndex): boolean {
  const outdated = num(entry, "outdatedReports");
  const helpful = num(entry, "helpfulCount");
  return (outdated >= 2 && outdated >= helpful) || (usageOf(entry, usage) >= 10 && helpful === 0);
}

export function idleSessions(entry: KbEntry, usage: UsageIndex): number {
  const last = usage.lastSession.get(entry.id);
  // Sessions after the last surfacing, but none that happened before the entry
  // existed: count only sessions recorded at/after `createdAt`.
  const created = typeof entry.createdAt === "string" ? Date.parse(entry.createdAt) : NaN;
  if (last === undefined && !Number.isFinite(created)) return 0;
  let idle = 0;
  for (let k = (last ?? 0) + 1; k <= usage.primeSessions; k++) {
    if (!Number.isFinite(created) || usage.sessionTimes[k - 1] >= created) idle++;
  }
  return idle;
}

export function isIdle(entry: KbEntry, usage: UsageIndex, threshold: number): boolean {
  return !isPromoted(entry) && idleSessions(entry, usage) >= threshold;
}

export function computeHealth(
  load: KbLoad,
  log: UsageLog,
  threshold = DEFAULT_IDLE_THRESHOLD,
): KbHealth {
  const usage = indexUsage(log);
  const entries = entriesOf(load);
  const confidence: Record<string, number> = {};
  let used = 0;
  let helpful = 0;
  let promoted = 0;
  let stale = 0;
  let neverSurfaced = 0;
  let idle = 0;
  for (const e of entries) {
    if (usageOf(e, usage) >= 1) used++;
    else neverSurfaced++;
    if (num(e, "helpfulCount") >= 1) helpful++;
    if (isPromoted(e)) promoted++;
    if (isStale(e, usage)) stale++;
    if (isIdle(e, usage, threshold)) idle++;
    const c = typeof e.confidence === "string" ? e.confidence : "(missing)";
    confidence[c] = (confidence[c] ?? 0) + 1;
  }
  return {
    total: entries.length,
    used,
    helpful,
    promoted,
    stale,
    neverSurfaced,
    idle,
    usedRatio: entries.length === 0 ? 0 : used / entries.length,
    confidence,
    primeSessions: usage.primeSessions,
    idleThreshold: threshold,
    errors: [...load.errors, ...log.errors],
  };
}

export function formatHealth(h: KbHealth): string {
  const pct = (n: number) => (h.total === 0 ? "0%" : `${Math.round((n / h.total) * 100)}%`);
  const conf = Object.entries(h.confidence)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const out = [
    "KB health",
    `  total           ${h.total}`,
    `  used>=1         ${h.used} (${pct(h.used)})`,
    `  helpful>=1      ${h.helpful} (${pct(h.helpful)})`,
    `  promoted        ${h.promoted}`,
    `  stale           ${h.stale}`,
    `  never-surfaced  ${h.neverSurfaced} (${pct(h.neverSurfaced)})`,
    `  idle>=${h.idleThreshold}        ${h.idle} (prune candidates; prime sessions recorded: ${h.primeSessions})`,
    `  confidence      ${conf || "(none)"}`,
  ];
  if (h.errors.length > 0) {
    out.push(`  corrupt lines   ${h.errors.length}`);
    for (const e of h.errors) out.push(`    ${e.file}:${e.line}: ${e.message}`);
  }
  return out.join("\n");
}

function serializeLines(lines: KbLine[]): string {
  const body = lines.map((l) => l.text).join("\n");
  return body === "" ? "" : `${body}\n`;
}

export interface RecordResult {
  session: string;
  surfaced: string[];
  unknown: string[];
}

// One /prime session: append a single log line with the surfaced ids that exist
// in the KB. The stores are only read (to reject unknown ids), never written.
// One `appendFileSync` = one write(2) on an O_APPEND fd, so concurrent /prime
// runs cannot overwrite each other's line.
export function recordPrime(
  kbDir: string,
  ids: string[],
  opts: { now?: Date; session?: string } = {},
): RecordResult {
  const known = new Set(entriesOf(loadKb(kbDir)).map((e) => e.id));
  const unique = [...new Set(ids)];
  const surfaced = unique.filter((id) => known.has(id));
  const record: UsageRecord = {
    session: opts.session ?? randomUUID(),
    at: (opts.now ?? new Date()).toISOString(),
    ids: surfaced,
  };
  appendFileSync(join(kbDir, USAGE_LOG_FILE), `${JSON.stringify(record)}\n`, { flag: "a" });
  return { session: record.session, surfaced, unknown: unique.filter((id) => !known.has(id)) };
}

export interface PruneResult {
  archived: { id: string; file: string; reason: string }[];
  dryRun: boolean;
}

// Move idle entries to `archive/<store>.jsonl`. Archive is written BEFORE the live
// store is rewritten, so a crash in between duplicates an entry (recoverable)
// rather than losing it. The archived row is the content row plus
// `archivedAt`/`archiveReason`; usage stays in the log.
export function pruneKb(
  kbDir: string,
  opts: { threshold?: number; dryRun?: boolean; now?: Date } = {},
): PruneResult {
  const threshold = opts.threshold ?? DEFAULT_IDLE_THRESHOLD;
  const now = opts.now ?? new Date();
  const load = loadKb(kbDir);
  const usage = indexUsage(readUsageLog(kbDir));
  const archived: PruneResult["archived"] = [];
  for (const store of load.stores) {
    const keep: KbLine[] = [];
    const moved: KbEntry[] = [];
    for (const line of store.lines) {
      if (line.kind === "entry" && isIdle(line.entry, usage, threshold)) {
        const idle = idleSessions(line.entry, usage);
        const reason = `idle: not surfaced by /prime in ${idle} consecutive sessions (threshold ${threshold})`;
        moved.push({ ...line.entry, archivedAt: now.toISOString(), archiveReason: reason });
        archived.push({ id: line.entry.id, file: store.file, reason });
      } else {
        keep.push(line);
      }
    }
    if (moved.length === 0 || opts.dryRun) continue;
    const archivePath = join(kbDir, ARCHIVE_DIR, store.file);
    const prior = existsSync(archivePath) ? readFileSync(archivePath, "utf8") : "";
    const sep = prior === "" || prior.endsWith("\n") ? "" : "\n";
    writeTextAtomic(archivePath, `${prior}${sep}${moved.map((e) => JSON.stringify(e)).join("\n")}\n`);
    writeTextAtomic(join(kbDir, store.file), serializeLines(keep));
  }
  return { archived, dryRun: opts.dryRun === true };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `usage: bun scripts/kb-health.ts [report|record|prune] [options]
  report [--json]                   health summary; exit 1 if any line is corrupt
  record [--session <id>] <id>...   /prime: append one usage-log line (stores untouched)
  prune [--dry-run]                 archive entries idle >= threshold sessions
  --kb-dir <path>                   default: <repo>/.agents/knowledge
  --threshold <n>                   idle threshold (default ${DEFAULT_IDLE_THRESHOLD})`;

export function runCli(argv: string[], io: { out: (s: string) => void; err: (s: string) => void }): number {
  let kbDir = resolve(import.meta.dirname, "..", "..", ".agents", "knowledge");
  let threshold = DEFAULT_IDLE_THRESHOLD;
  let json = false;
  let dryRun = false;
  let session: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kb-dir") kbDir = resolve(argv[++i] ?? "");
    else if (a === "--threshold") {
      threshold = Number(argv[++i]);
      if (!Number.isInteger(threshold) || threshold < 1) {
        io.err("--threshold must be a positive integer");
        return 2;
      }
    } else if (a === "--json") json = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--session") {
      session = argv[++i];
      if (!session) {
        io.err("--session needs a non-empty id");
        return 2;
      }
    }
    else if (a === "--help" || a === "-h") {
      io.out(USAGE);
      return 0;
    } else if (a.startsWith("--")) {
      io.err(`unknown option ${a}\n${USAGE}`);
      return 2;
    } else positional.push(a);
  }
  const cmd = positional.shift() ?? "report";
  if (!existsSync(kbDir)) {
    io.err(`KB dir not found: ${kbDir}`);
    return 2;
  }

  if (cmd === "report") {
    const h = computeHealth(loadKb(kbDir), readUsageLog(kbDir), threshold);
    io.out(json ? JSON.stringify(h, null, 2) : formatHealth(h));
    return h.errors.length > 0 ? 1 : 0;
  }
  if (cmd === "record") {
    const r = recordPrime(kbDir, positional, { session });
    io.out(`recorded prime session ${r.session}: ${r.surfaced.length} entries surfaced`);
    if (r.unknown.length > 0) {
      io.err(`unknown KB ids (not recorded): ${r.unknown.join(", ")}`);
      return 1;
    }
    return 0;
  }
  if (cmd === "prune") {
    const r = pruneKb(kbDir, { threshold, dryRun });
    const verb = r.dryRun ? "would archive" : "archived";
    io.out(`${verb} ${r.archived.length} entries${r.archived.length ? ":" : ""}`);
    for (const a of r.archived) io.out(`  ${a.file} ${a.id} — ${a.reason}`);
    return 0;
  }
  io.err(`unknown command ${cmd}\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  process.exit(
    runCli(process.argv.slice(2), {
      out: (s) => console.log(s),
      err: (s) => console.error(s),
    }),
  );
}
