// Shared filesystem-access primitives for the RC-2 universal stack fingerprinter
// (PLAN Task 3). Extracted from `detect-stack.ts`'s hardened marker-read boundary
// so the new fingerprinter and (eventually, PLAN Task 9) the collapsed detector
// share ONE EC-7 resolving wrapper instead of two divergent copies.
//
// EC-7 (conventions.md): every workspace-file access goes through `resolveMarker`,
// which realpath-anchors the workspace root once, rejects symlink leaves, and
// bounds-checks the resolved path. No caller may `readFileSync`/`readdirSync`
// outside these helpers — that is how the symlink-escape / out-of-bounds guard
// stays a single choke point (hunt #1, ritchie B-1).
//
// Two deliberate fixes over detect-stack.ts's private copies (folded in here
// because the widened tree scan re-opens gaps the closed 5-marker set avoided):
//   - ritchie B-4: `readdirSync` output is sorted lexicographically BEFORE the
//     MAX_CANDIDATE_SUBDIRS cap, so which subdirs a wide monorepo scans is
//     deterministic (not filesystem-encounter-order dependent).
//   - ritchie B-9: the traversal reject tests for a `..` path SEGMENT, not the
//     `.includes("..")` substring, so a legitimately-named subdir like `foo..bar`
//     is not silently dropped.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

export type MarkerReason =
  | "json_parse"
  | "yaml_parse"
  | "size_exceeded"
  | "out_of_bounds"
  | "symlink"
  | "read_error";

export type ResolveResult =
  | { ok: true; absolute: string }
  | { ok: false; reason: MarkerReason };

export type ReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: MarkerReason };

// ritchie B-9: reject a `..` path SEGMENT, not the substring — `foo..bar` is a
// legal directory name and must not false-reject under the widened scan.
function hasTraversalSegment(relPath: string): boolean {
  return relPath.split(/[/\\]/).some((seg) => seg === "..");
}

/**
 * The single EC-7 resolving wrapper. `relativeMarker` is workspace-relative;
 * an absolute path or a `..` segment is refused as `out_of_bounds`. A symlink
 * leaf is refused as `symlink`. A resolved path escaping the root is refused as
 * `out_of_bounds`. A non-existent path is `ok` (the caller distinguishes
 * presence via `existsSync` after) — matching detect-stack.ts semantics.
 */
export function resolveMarker(
  rootResolved: string,
  relativeMarker: string,
): ResolveResult {
  if (relativeMarker.startsWith("/") || hasTraversalSegment(relativeMarker)) {
    return { ok: false, reason: "out_of_bounds" };
  }
  const candidate = join(rootResolved, relativeMarker);
  if (!existsSync(candidate)) {
    return { ok: true, absolute: candidate };
  }
  let lst;
  try {
    lst = lstatSync(candidate);
  } catch {
    return { ok: false, reason: "read_error" };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, reason: "symlink" };
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { ok: false, reason: "read_error" };
  }
  if (real !== candidate && !real.startsWith(rootResolved + sep)) {
    return { ok: false, reason: "out_of_bounds" };
  }
  return { ok: true, absolute: candidate };
}

/** Size-capped, BOM-stripped, utf8 read. Cap enforced before the read. */
export function readText(absolute: string, cap: number): ReadResult {
  try {
    const st = statSync(absolute);
    if (!st.isFile()) {
      return { ok: false, reason: "read_error" };
    }
    if (st.size > cap) {
      return { ok: false, reason: "size_exceeded" };
    }
  } catch {
    return { ok: false, reason: "read_error" };
  }
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch {
    return { ok: false, reason: "read_error" };
  }
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  return { ok: true, text: raw };
}

export function isDirectory(absolute: string): boolean {
  try {
    const st = lstatSync(absolute);
    if (st.isSymbolicLink()) return false;
    return st.isDirectory();
  } catch {
    return false;
  }
}

export interface EnumerationResult {
  /** Accepted depth-1 subdir names, lexicographically sorted (ritchie B-4). */
  prefixes: string[];
  /** Synthetic failures (readdir throw, per-entry lstat throw) — surfaced, never silent. */
  failures: { name: string; reason: MarkerReason }[];
  /** True when the cap was hit before all eligible entries were visited. */
  truncated: boolean;
}

export const MAX_CANDIDATE_SUBDIRS = 64;

// Dirs excluded from the depth-1 scan (false-positive / budget-blowing).
export const SKIP_SUBDIRS = new Set<string>([
  "node_modules", ".git", ".husky", ".venv", "venv", ".env", "env",
  "dist", "build", "out", "target", ".next", ".turbo", ".cache",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".vscode", ".idea", ".council", ".agents", ".learnings",
]);

/**
 * Enumerate depth-1 subdirs as scan prefixes. Sorts entries BEFORE the cap
 * (ritchie B-4) so a truncated wide-monorepo scan is deterministic. Hidden dirs
 * and SKIP_SUBDIRS members excluded; symlinks silently excluded (EC-7); per-entry
 * lstat failures surfaced on `failures` (no silent skip). Inlines the EC-36(b)
 * discipline: name comes from readdir Dirent (no separators), lstat not stat,
 * realpath omitted (depth-1 non-symlink leaves are by construction in-root).
 */
export function enumerateCandidatePrefixes(rootResolved: string): EnumerationResult {
  const prefixes: string[] = [];
  const failures: { name: string; reason: MarkerReason }[] = [];
  let entries;
  try {
    entries = readdirSync(rootResolved, { withFileTypes: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[fingerprint] readdirSync failed on workspace root: ${message}`);
    failures.push({ name: "<workspace>/ (directory scan)", reason: "read_error" });
    return { prefixes, failures, truncated: false };
  }
  // ritchie B-4: deterministic order before the cap.
  const names = entries.map((e) => e.name).sort();
  let scanned = 0;
  let truncated = false;
  for (const name of names) {
    if (scanned >= MAX_CANDIDATE_SUBDIRS) {
      truncated = true;
      break;
    }
    if (name.startsWith(".")) continue;
    if (SKIP_SUBDIRS.has(name)) continue;
    const candidate = join(rootResolved, name);
    let lst;
    try {
      lst = lstatSync(candidate);
    } catch {
      failures.push({ name: `<workspace>/${name} (lstat)`, reason: "read_error" });
      continue;
    }
    if (lst.isSymbolicLink()) continue; // EC-7 silent symlink reject.
    if (!lst.isDirectory()) continue;
    prefixes.push(name);
    scanned += 1;
  }
  return { prefixes, failures, truncated };
}

/** Resolve a directory root once (realpath). Returns null if it cannot resolve. */
export function resolveRoot(workspaceRoot: string): string | null {
  try {
    return realpathSync(resolve(workspaceRoot));
  } catch {
    return null;
  }
}
