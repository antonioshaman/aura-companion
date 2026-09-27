#!/usr/bin/env bun
// Council PRO Economy — persistent skip-if-unchanged result cache (spec
// `council-pro-economy.md`, Story 2). Cache a seat's review findings keyed by a
// content-hash of its assigned file set. On a re-run whose hash is identical, the
// caller reuses the cached findings ("from cache") instead of re-dispatching the
// subagent — across sessions, under `<COMPANION_HOME>/council-cache/`.
//
// Invalidation (spec Story 2 negatives):
//   - a DIFFERENT file hash is simply a different key ⇒ miss ⇒ re-run;
//   - an entry older than the staleness bound, or produced by a different
//     schema/engine version, is INVALIDATED ⇒ miss ⇒ re-run.
// Reusing an unchanged-input result cannot drop a finding class — it re-surfaces
// the exact prior findings (P1s included); any input change re-runs. So the cache
// is guardrail-safe by construction (no P1 can be silently lost to a cache hit).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { COMPANION_HOME } from "../server/paths.js";
import { writeJsonAtomic } from "./atomic-json.js";
import type { FindingPriority } from "./run-stats.js";

// Bump when the on-disk shape changes → old entries invalidate on read.
export const RESULT_CACHE_SCHEMA_VERSION = 1;

// Default staleness bound: 14 days. Overridable per lookup and via env.
export const DEFAULT_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const FINDING_PRIORITIES: ReadonlySet<string> = new Set<FindingPriority>(["P1", "P2", "P3"]);
const MAX_STR = 512;
const MAX_SUMMARY = 4096;
const MAX_FINDINGS = 512;
const MAX_ENTRY_BYTES = 512 * 1024;

export interface CacheFinding {
  id: string;
  priority: FindingPriority;
  /** Human-readable finding summary re-surfaced on a cache hit. */
  summary: string;
}

export interface CachedSeatResult {
  schemaVersion: number;
  skill: string;
  /** Engine/catalog version; a mismatch on read invalidates the entry. */
  engineVersion: string;
  seatId: string;
  /** Content hash of the seat's assigned file set (see hashFileSet). */
  filesHash: string;
  /** Server wall-clock at write (Date.now) — never a model self-report. */
  ts: number;
  findings: CacheFinding[];
}

export interface FileEntry {
  path: string;
  content: string;
}

/**
 * Deterministic content hash of a seat's assigned file set. Order-independent
 * (paths are sorted first) so the same set hashes identically regardless of
 * listing order. Path + content are length-delimited so no concatenation
 * collision can forge a match.
 */
export function hashFileSet(files: FileEntry[]): string {
  const h = createHash("sha256");
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) {
    h.update(String(Buffer.byteLength(f.path, "utf8")));
    h.update(":");
    h.update(f.path);
    h.update(String(Buffer.byteLength(f.content, "utf8")));
    h.update(":");
    h.update(f.content);
  }
  return h.digest("hex");
}

/**
 * Convenience: hash files read from disk (paths relative to `root`). A missing or
 * unreadable file is folded in as a distinct sentinel so that deleting a
 * previously-present file CHANGES the hash (never silently skipped → never a false
 * cache hit on a since-deleted file).
 */
export function hashFilesOnDisk(root: string, relPaths: string[]): string {
  const entries: FileEntry[] = relPaths.map((p) => {
    try {
      return { path: p, content: readFileSync(join(root, p), "utf8") };
    } catch {
      return { path: p, content: "\u0000<unreadable-or-missing>" };
    }
  });
  return hashFileSet(entries);
}

export function resolveCacheDir(override?: string): string {
  return override ?? process.env.COMPANION_COUNCIL_CACHE_DIR ?? join(COMPANION_HOME, "council-cache");
}

function sanitize(seg: string): string {
  return seg.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128);
}

export function cacheFileName(skill: string, seatId: string, filesHash: string): string {
  return `${sanitize(skill)}__${sanitize(seatId)}__${sanitize(filesHash)}.json`;
}

function assertBoundedString(v: unknown, field: string, max = MAX_STR): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    throw new Error(`result-cache: ${field} must be a non-empty string <= ${max} chars`);
  }
  return v;
}

function assertFindings(raw: unknown): CacheFinding[] {
  if (!Array.isArray(raw) || raw.length > MAX_FINDINGS) {
    throw new Error(`result-cache: findings must be an array <= ${MAX_FINDINGS}`);
  }
  return raw.map((f, i) => {
    if (!f || typeof f !== "object") throw new Error(`result-cache: findings[${i}] must be an object`);
    const fo = f as Record<string, unknown>;
    const id = assertBoundedString(fo.id, `findings[${i}].id`);
    if (typeof fo.priority !== "string" || !FINDING_PRIORITIES.has(fo.priority)) {
      throw new Error(`result-cache: findings[${i}].priority must be one of ${[...FINDING_PRIORITIES].join("|")}`);
    }
    // summary may be empty (a bare finding), but bounded.
    if (typeof fo.summary !== "string" || fo.summary.length > MAX_SUMMARY) {
      throw new Error(`result-cache: findings[${i}].summary must be a string <= ${MAX_SUMMARY} chars`);
    }
    return { id, priority: fo.priority as FindingPriority, summary: fo.summary };
  });
}

export interface PutCacheInput {
  skill: string;
  engineVersion: string;
  seatId: string;
  filesHash: string;
  findings: CacheFinding[];
  ts?: number;
}

/** Build + validate + atomically write one cache entry. Returns the written record. */
export function putCachedResult(input: PutCacheInput, opts?: { dir?: string }): CachedSeatResult {
  const rec: CachedSeatResult = {
    schemaVersion: RESULT_CACHE_SCHEMA_VERSION,
    skill: assertBoundedString(input.skill, "skill"),
    engineVersion: assertBoundedString(input.engineVersion, "engineVersion"),
    seatId: assertBoundedString(input.seatId, "seatId"),
    filesHash: assertBoundedString(input.filesHash, "filesHash"),
    ts: input.ts ?? Date.now(),
    findings: assertFindings(input.findings),
  };
  if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts) || rec.ts < 0) {
    throw new Error("result-cache: ts must be a non-negative finite number");
  }
  const dir = resolveCacheDir(opts?.dir);
  writeJsonAtomic(join(dir, cacheFileName(rec.skill, rec.seatId, rec.filesHash)), rec, {
    maxBytes: MAX_ENTRY_BYTES,
    label: "result-cache",
  });
  return rec;
}

function validateEntry(o: Record<string, unknown>): CachedSeatResult {
  const schemaVersion = o.schemaVersion;
  if (typeof schemaVersion !== "number") throw new Error("result-cache: schemaVersion must be a number");
  return {
    schemaVersion,
    skill: assertBoundedString(o.skill, "skill"),
    engineVersion: assertBoundedString(o.engineVersion, "engineVersion"),
    seatId: assertBoundedString(o.seatId, "seatId"),
    filesHash: assertBoundedString(o.filesHash, "filesHash"),
    ts: (() => {
      if (typeof o.ts !== "number" || !Number.isFinite(o.ts) || o.ts < 0) throw new Error("result-cache: bad ts");
      return o.ts;
    })(),
    findings: assertFindings(o.findings),
  };
}

export type CacheLookup =
  | { hit: true; result: CachedSeatResult }
  | { hit: false; reason: "miss" | "stale" | "version" | "schema" | "malformed" };

export interface GetCacheOptions {
  dir?: string;
  /** Current engine/catalog version; a mismatch invalidates (reason "version"). */
  engineVersion: string;
  /** Staleness bound; older entries invalidate (reason "stale"). */
  maxAgeMs?: number;
  /** Injectable clock for deterministic tests. */
  nowMs?: number;
}

/**
 * Look up a cached seat result. Returns a hit only when the entry exists, parses,
 * matches the current schema + engine version, is within the staleness bound, and
 * carries the requested hash. Every other outcome is a typed miss so the caller
 * can log WHY it re-ran.
 */
export function getCachedResult(
  skill: string,
  seatId: string,
  filesHash: string,
  opts: GetCacheOptions,
): CacheLookup {
  const dir = resolveCacheDir(opts.dir);
  const abs = join(dir, cacheFileName(skill, seatId, filesHash));
  if (!existsSync(abs)) return { hit: false, reason: "miss" };
  let rec: CachedSeatResult;
  try {
    const doc = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    if (!doc || typeof doc !== "object") return { hit: false, reason: "malformed" };
    rec = validateEntry(doc as Record<string, unknown>);
  } catch {
    return { hit: false, reason: "malformed" };
  }
  if (rec.schemaVersion !== RESULT_CACHE_SCHEMA_VERSION) return { hit: false, reason: "schema" };
  if (rec.engineVersion !== opts.engineVersion) return { hit: false, reason: "version" };
  // Defensive: the filename is keyed by hash, but a tampered/renamed file could
  // carry a different hash — never serve it as a match.
  if (rec.filesHash !== filesHash) return { hit: false, reason: "miss" };
  const now = opts.nowMs ?? Date.now();
  const maxAge = opts.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;
  if (now - rec.ts > maxAge) return { hit: false, reason: "stale" };
  return { hit: true, result: rec };
}

// --------------------------------------------------------------------------
// CLI — used by the council skill: `hash` a seat's files, `get` to check the
// cache before dispatch, `put` after a fresh dispatch.
// --------------------------------------------------------------------------

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "hash") {
    // Paths (newline-separated) on stdin; --root defaults to cwd.
    const root = flag(rest, "--root") ?? process.cwd();
    const paths = readStdin()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (paths.length === 0) {
      console.error("result-cache hash: provide newline-separated paths on stdin");
      process.exit(2);
    }
    console.log(hashFilesOnDisk(root, paths));
  } else if (cmd === "get") {
    const skill = flag(rest, "--skill");
    const seat = flag(rest, "--seat");
    const hash = flag(rest, "--hash");
    const engine = flag(rest, "--engine");
    if (!skill || !seat || !hash || !engine) {
      console.error("result-cache get: --skill --seat --hash --engine required");
      process.exit(2);
    }
    const maxAgeMs = flag(rest, "--max-age-ms");
    const lookup = getCachedResult(skill, seat, hash, {
      dir: flag(rest, "--dir"),
      engineVersion: engine,
      maxAgeMs: maxAgeMs ? Number(maxAgeMs) : undefined,
    });
    console.log(JSON.stringify(lookup));
  } else if (cmd === "put") {
    const raw = flag(rest, "--json") ?? readStdin();
    if (!raw.trim()) {
      console.error("result-cache put: provide JSON via --json or stdin");
      process.exit(2);
    }
    try {
      const rec = putCachedResult(JSON.parse(raw) as PutCacheInput, { dir: flag(rest, "--dir") });
      console.log(JSON.stringify({ ok: true, seatId: rec.seatId, filesHash: rec.filesHash }));
    } catch (e) {
      console.error(`result-cache put: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    console.error("usage: result-cache.ts <hash|get|put> [flags]");
    process.exit(2);
  }
}
