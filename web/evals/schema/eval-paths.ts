/**
 * Eval path-safety helpers — the single source of truth for turning an
 * untrusted id/phase/provider into a filesystem path under the eval tree.
 *
 * Why this exists: `isBoundedToken` (council-types) accepts a 128-char
 * token that still permits `/`, `.`, and `..` — fine for an opaque id that
 * never touches the filesystem, but the eval sidecar writes
 * `.council/eval/<checkpoint_id>.json`, so the moment `checkpoint_id`
 * becomes a filename that validator is a path-traversal vector
 * (`checkpoint_id = "../../etc/cron.d/x"`). Every eval surface that maps an
 * id to a path MUST go through {@link isEvalSlug} (construction-site
 * validation) and, for on-disk resolution, {@link resolveWithinWorkspace}
 * (realpath + bounds, mirroring observer-grounding's createWorkspaceExistsCheck).
 *
 * Pure: depends only on node:path + node:fs. No `server/` imports — this
 * module sits inside the eval import firewall and is safe for portable
 * scorers to consume.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Max length for a slug that becomes a single path segment. */
export const EVAL_SLUG_MAX_LEN = 128;

/**
 * Strict single-segment slug: ASCII alphanumerics plus `.`, `_`, `-` only,
 * length-bounded, and `.`/`..`/leading-dot rejected so the result can never
 * be a relative-traversal token or a hidden dotfile. Unlike `isBoundedToken`
 * this rejects `/` outright — a slug is exactly one path segment.
 */
export function isEvalSlug(v: unknown, maxLen: number = EVAL_SLUG_MAX_LEN): v is string {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > maxLen) return false;
  if (v === "." || v === "..") return false;
  if (v.startsWith(".")) return false;
  return /^[A-Za-z0-9._-]+$/.test(v);
}

/**
 * Resolve `relPath` against `workspaceRoot`, realpath it (collapsing
 * symlinks), and return the resolved absolute path only if it EXISTS and
 * stays within the workspace. Returns `null` otherwise — a missing file, a
 * symlink that escapes the root, an absolute input, or a `..` segment all
 * map to `null`.
 *
 * EC-7: path resolution + bounds check are one inseparable unit here, so no
 * caller can resolve without bounding. Touches disk by design (`realpathSync`)
 * — call it at emit time to freeze the existence answer into the sidecar, not
 * inside a hermetic rerun.
 *
 * Throws on a non-absolute or NUL-poisoned `workspaceRoot`: that is a fixed
 * invariant of the caller's environment, not attacker-influenced input, so
 * failing fast catches misuse early (matches validateObserverFindings).
 */
export function resolveWithinWorkspace(workspaceRoot: string, relPath: string): string | null {
  if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot) || workspaceRoot.includes("\0")) {
    throw new Error("eval-paths: workspaceRoot must be absolute and NUL-free");
  }
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\0")) return null;
  if (isAbsolute(relPath)) return null;
  if (relPath.split(/[\\/]/).some((seg) => seg === "..")) return null;

  const rootResolved = (() => {
    try {
      return realpathSync(workspaceRoot);
    } catch {
      return resolve(workspaceRoot);
    }
  })();

  const target = resolve(rootResolved, relPath);
  let resolvedTarget: string;
  try {
    resolvedTarget = realpathSync(target);
  } catch {
    return null;
  }
  const rel = relative(rootResolved, resolvedTarget);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  if (rel.split(sep).some((s) => s === "..")) return null;
  return resolvedTarget;
}

/**
 * Existence predicate form of {@link resolveWithinWorkspace}: `true` iff the
 * workspace-relative path exists within bounds. This is the frozen
 * fs-facing input the grounding gate consumes — capture its value into the
 * sidecar at emit time so a later rerun is hermetic (recomputes grounding
 * from the frozen map, never re-stats the live disk).
 */
export function existsWithinWorkspace(workspaceRoot: string, relPath: string): boolean {
  return resolveWithinWorkspace(workspaceRoot, relPath) !== null;
}
