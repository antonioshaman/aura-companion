#!/usr/bin/env bun
// Knowledge-base lifecycle engine (spec `aura-meta-diet.md`, Story A2).
//
// The KB under `.agents/knowledge/*.jsonl` only had a *described* lifecycle: the
// skills told the agent to bump `usageCount`, but nothing enforced it and nothing
// ever archived a dead entry (baseline 2026-09-28: 137 entries, 2 ever surfaced).
// This module makes the lifecycle mechanical:
//
//   report  — total / used≥1 / helpful≥1 / promoted / stale / never-surfaced /
//             idle / confidence distribution. Corrupt lines are reported with
//             `file:line`, the rest is still processed, exit code is non-zero.
//   record  — called by `/prime` with the ids it surfaced. Counts ONE prime
//             session, bumps `usageCount` + `lastSurfacedSession` on those ids.
//   prune   — moves entries idle for ≥ N consecutive prime sessions (default 20)
//             into `.agents/knowledge/archive/<store>.jsonl` with a reason.
//             Never deletes.
//
// Session clock: `.agents/knowledge/usage-state.json` holds `primeSessions`, the
// number of recorded /prime runs. An entry's idle age is
// `primeSessions - (lastSurfacedSession ?? trackedSinceSession)`. `record` stamps
// `trackedSinceSession` on entries that have neither field (entries that pre-date
// tracking, or were just appended by /learn), so a brand-new entry is never
// instantly prunable. An entry with neither field has idle age 0.
//
// Rewrites preserve unparseable lines verbatim — a corrupt row is reported, never
// silently dropped by a lifecycle write.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeTextAtomic } from "./atomic-json.js";

export const DEFAULT_IDLE_THRESHOLD = 20;
export const USAGE_STATE_FILE = "usage-state.json";
export const ARCHIVE_DIR = "archive";

export type KbEntry = Record<string, unknown> & { id: string };

// `text` is the original line; it is written back verbatim unless `dirty`, so a
// lifecycle write only re-serializes the rows it actually touched.
type KbLine =
  | { kind: "entry"; entry: KbEntry; text: string; dirty?: boolean }
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

export interface UsageState {
  primeSessions: number;
}

export interface KbHealth {
  total: number;
  used: number; // usageCount >= 1
  helpful: number; // helpfulCount >= 1
  promoted: number;
  stale: number;
  neverSurfaced: number; // usageCount == 0
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

export function readUsageState(kbDir: string): UsageState {
  const p = join(kbDir, USAGE_STATE_FILE);
  if (!existsSync(p)) return { primeSessions: 0 };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as { primeSessions?: unknown };
  const n = parsed.primeSessions;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new Error(`${USAGE_STATE_FILE}: primeSessions must be a non-negative integer`);
  }
  return { primeSessions: n };
}

function num(entry: KbEntry, key: string): number {
  const v = entry[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function optNum(entry: KbEntry, key: string): number | undefined {
  const v = entry[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function isPromoted(entry: KbEntry): boolean {
  return entry.promoted === true;
}

// Field-driven staleness, verbatim from `/evolve` (mode: prune): flagged at least
// twice with no re-confirmation to balance it, or surfaced often and never
// confirmed helpful (too generic).
export function isStale(entry: KbEntry): boolean {
  const outdated = num(entry, "outdatedReports");
  const helpful = num(entry, "helpfulCount");
  const usage = num(entry, "usageCount");
  return (outdated >= 2 && outdated >= helpful) || (usage >= 10 && helpful === 0);
}

export function idleSessions(entry: KbEntry, primeSessions: number): number {
  const since = optNum(entry, "lastSurfacedSession") ?? optNum(entry, "trackedSinceSession");
  if (since === undefined) return 0;
  return Math.max(0, primeSessions - since);
}

export function isIdle(entry: KbEntry, primeSessions: number, threshold: number): boolean {
  return !isPromoted(entry) && idleSessions(entry, primeSessions) >= threshold;
}

export function computeHealth(
  load: KbLoad,
  state: UsageState,
  threshold = DEFAULT_IDLE_THRESHOLD,
): KbHealth {
  const entries = entriesOf(load);
  const confidence: Record<string, number> = {};
  let used = 0;
  let helpful = 0;
  let promoted = 0;
  let stale = 0;
  let neverSurfaced = 0;
  let idle = 0;
  for (const e of entries) {
    const usage = num(e, "usageCount");
    if (usage >= 1) used++;
    else neverSurfaced++;
    if (num(e, "helpfulCount") >= 1) helpful++;
    if (isPromoted(e)) promoted++;
    if (isStale(e)) stale++;
    if (isIdle(e, state.primeSessions, threshold)) idle++;
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
    primeSessions: state.primeSessions,
    idleThreshold: threshold,
    errors: load.errors,
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

function serializeStore(store: KbStore): string {
  const body = store.lines
    .map((l) => (l.kind === "entry" && l.dirty ? JSON.stringify(l.entry) : l.text))
    .join("\n");
  return body === "" ? "" : `${body}\n`;
}

function writeUsageState(kbDir: string, state: UsageState): void {
  writeTextAtomic(join(kbDir, USAGE_STATE_FILE), `${JSON.stringify({ primeSessions: state.primeSessions }, null, 2)}\n`);
}

export interface RecordResult {
  primeSessions: number;
  surfaced: string[];
  unknown: string[];
}

// One /prime session: bump the session clock, mark `ids` as surfaced now, and
// stamp `trackedSinceSession` on entries that are not yet tracked. Only stores
// that actually changed are rewritten.
export function recordPrime(kbDir: string, ids: string[], now = new Date()): RecordResult {
  const load = loadKb(kbDir);
  const state = readUsageState(kbDir);
  const session = state.primeSessions + 1;
  const wanted = new Set(ids);
  const surfaced: string[] = [];
  for (const store of load.stores) {
    let changed = false;
    for (const line of store.lines) {
      if (line.kind !== "entry") continue;
      const e = line.entry;
      if (wanted.has(e.id)) {
        e.usageCount = num(e, "usageCount") + 1;
        e.lastSurfacedSession = session;
        e.lastSurfacedAt = now.toISOString();
        surfaced.push(e.id);
        line.dirty = changed = true;
      } else if (optNum(e, "lastSurfacedSession") === undefined && optNum(e, "trackedSinceSession") === undefined) {
        e.trackedSinceSession = session;
        line.dirty = changed = true;
      }
    }
    if (changed) writeTextAtomic(join(kbDir, store.file), serializeStore(store));
  }
  writeUsageState(kbDir, { primeSessions: session });
  const found = new Set(surfaced);
  return { primeSessions: session, surfaced, unknown: [...wanted].filter((id) => !found.has(id)) };
}

export interface PruneResult {
  archived: { id: string; file: string; reason: string }[];
  dryRun: boolean;
}

// Move idle entries to `archive/<store>.jsonl`. Archive is written BEFORE the live
// store is rewritten, so a crash in between duplicates an entry (recoverable)
// rather than losing it.
export function pruneKb(
  kbDir: string,
  opts: { threshold?: number; dryRun?: boolean; now?: Date } = {},
): PruneResult {
  const threshold = opts.threshold ?? DEFAULT_IDLE_THRESHOLD;
  const now = opts.now ?? new Date();
  const load = loadKb(kbDir);
  const { primeSessions } = readUsageState(kbDir);
  const archived: PruneResult["archived"] = [];
  for (const store of load.stores) {
    const keep: KbLine[] = [];
    const moved: KbEntry[] = [];
    for (const line of store.lines) {
      if (line.kind === "entry" && isIdle(line.entry, primeSessions, threshold)) {
        const idle = idleSessions(line.entry, primeSessions);
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
    writeTextAtomic(join(kbDir, store.file), serializeStore({ file: store.file, lines: keep }));
  }
  return { archived, dryRun: opts.dryRun === true };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `usage: bun scripts/kb-health.ts [report|record|prune] [options]
  report [--json]                   health summary; exit 1 if any line is corrupt
  record <id>...                    /prime: count one session, mark ids surfaced
  prune [--dry-run]                 archive entries idle >= threshold sessions
  --kb-dir <path>                   default: <repo>/.agents/knowledge
  --threshold <n>                   idle threshold (default ${DEFAULT_IDLE_THRESHOLD})`;

export function runCli(argv: string[], io: { out: (s: string) => void; err: (s: string) => void }): number {
  let kbDir = resolve(import.meta.dirname, "..", "..", ".agents", "knowledge");
  let threshold = DEFAULT_IDLE_THRESHOLD;
  let json = false;
  let dryRun = false;
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
    const h = computeHealth(loadKb(kbDir), readUsageState(kbDir), threshold);
    io.out(json ? JSON.stringify(h, null, 2) : formatHealth(h));
    return h.errors.length > 0 ? 1 : 0;
  }
  if (cmd === "record") {
    const r = recordPrime(kbDir, positional);
    io.out(`recorded prime session ${r.primeSessions}: ${r.surfaced.length} entries surfaced`);
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
