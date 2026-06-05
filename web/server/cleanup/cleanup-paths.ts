// AURA-LOCAL
// Path constants + EC-7 resolving wrapper for the cleanup subsystem.
// PLAN task T4 (sibling of sentinel-markers + cleanup-scheduler).
//
// Every cross-module producer↔consumer path/filename in the cleanup
// subsystem (eviction sentinels, orphan-reap markers, sweep-in-progress
// markers, archive sub-directories, recordings hold sentinel) lives here
// as an exported constant per EC-20 — never hardcoded at the call site.
// The accompanying static-grep canary in `cleanup-paths.test.ts` fails
// when a literal `"archived"` or `"archived-recordings"` reappears in
// another `cleanup/*.ts` file, so a future tier that needs the same
// subdir must import the constant.
//
// `resolveCleanupPath(root, rel)` is the EC-7 resolving wrapper that
// every fs touch in `sentinel-markers.ts`, `cleanup-scheduler.ts`, and
// the Phase E retention-sweeper / Phase H eviction-sweeper MUST route
// through. It (1) rejects traversal tokens / NUL bytes / absolute
// relPaths up-front, (2) `realpathSync`s the deepest existing ancestor
// of both root and target, (3) re-verifies `target.startsWith(root +
// sep)`. Sibling shape: `observer-write-policy.assertObserverWriteAllowed`
// — same idiom applied to the cleanup boundary.
//
// EC-7 floor: callers MUST NOT construct cleanup paths via raw `join` —
// the resolver inlines symlink-resolution + bounds-check at one site
// rather than relying on each call site to remember the discipline.

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Sub-directory under `~/.companion/sessions/` holding archived row JSON. */
export const ARCHIVED_SESSIONS_SUBDIR = "archived" as const;

/** Sub-directory under `~/.companion/recordings/` holding soft-archived recordings. */
export const ARCHIVED_RECORDINGS_SUBDIR = "archived-recordings" as const;

/**
 * Suffix appended to `<sessionId>.json` to mark an in-progress eviction.
 * Written via `writeEvictingMarker` BEFORE the rename, deleted AFTER fsync
 * — boot-time reconcile sees the marker and resumes idempotently.
 */
export const EVICTING_SENTINEL_SUFFIX = ".evicting" as const;

/**
 * Sub-directory under the session root holding orphan-reap intent markers.
 * Filename shape: `<pid>.json`. Written via `writeReapingMarker` BEFORE the
 * SIGTERM, deleted AFTER exit confirmed.
 */
export const REAPING_SENTINEL_SUBDIR = ".reaping" as const;

/**
 * Suffix appended to a tier identifier to mark an in-progress retention
 * sweep (Phase E). Written BEFORE the first unlink in a tier, deleted
 * AFTER the tier completes. Boot reconcile enumerates these so a crash
 * mid-sweep doesn't leave state lost between tiers.
 */
export const SWEEP_IN_PROGRESS_SUFFIX = ".sweep-in-progress" as const;

/**
 * Operator-facing sentinel under `~/.companion/recordings/`. When present,
 * retention sweep skips ALL recording deletes + logs `retention.skipped_hold`.
 * Documented in CLAUDE.md "Production deployment" as the incident-preservation
 * escape hatch per Phase E spec (Hunt R6).
 */
export const RECORDINGS_HOLD_SENTINEL = ".hold" as const;

/**
 * Resolve a relPath against the cleanup root, applying symlink resolution
 * + bounds check per EC-7. Throws on traversal, NUL byte, absolute
 * relPath, or any path that escapes `root` after symlink resolution.
 *
 * The realpath happens on the DEEPEST EXISTING ANCESTOR of the target,
 * so callers may resolve a not-yet-written sentinel path (typical for
 * first writes via `writeAtomicJson`). Sibling shape to
 * `observer-write-policy.realpathOfAncestor`.
 *
 * Returns the resolved absolute path. The atomic-write site then trusts
 * this path absolutely — no further validation needed at the writer.
 */
export function resolveCleanupPath(rootAbsolute: string, relPath: string): string {
  if (typeof rootAbsolute !== "string" || !isAbsolute(rootAbsolute) || rootAbsolute.includes("\0")) {
    throw new Error("resolveCleanupPath: invalid root (must be absolute, no NUL)");
  }
  if (typeof relPath !== "string" || relPath.includes("\0")) {
    throw new Error("resolveCleanupPath: invalid relPath (must be string, no NUL)");
  }
  if (relPath === "") {
    throw new Error("resolveCleanupPath: empty relPath");
  }
  if (isAbsolute(relPath)) {
    throw new Error("resolveCleanupPath: relPath must be relative");
  }
  const segments = relPath.split(sep).filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error("resolveCleanupPath: relPath has no usable segments");
  }
  if (segments.some((s) => s === "..")) {
    throw new Error("resolveCleanupPath: relPath contains parent traversal");
  }

  const target = resolve(rootAbsolute, relPath);
  const resolvedRoot = realpathOfAncestor(rootAbsolute);
  const resolvedTarget = realpathOfAncestor(target);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error("resolveCleanupPath: relPath escapes root after symlink resolution");
  }
  return resolvedTarget;
}

/**
 * Walk up from `absolutePath` until an existing ancestor is found, realpath
 * it, then rejoin the remaining segments. Bounded to 1024 iterations so a
 * pathologically deep path can't loop forever. Direct copy of the idiom in
 * `observer-write-policy.realpathOfAncestor` — kept inline to avoid a
 * security-sensitive cross-module dependency.
 */
function realpathOfAncestor(absolutePath: string): string {
  let current = absolutePath;
  const trailing: string[] = [];
  for (let depth = 0; depth < 1024; depth++) {
    try {
      const resolved = realpathSync(current);
      return trailing.length ? resolve(resolved, ...trailing.reverse()) : resolved;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolutePath;
      trailing.push(relative(parent, current));
      current = parent;
    }
  }
  return absolutePath;
}
