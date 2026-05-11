import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Allow-list predicate for write attempts by the observer half of a Council
 * Mode pair. The observer must NEVER write outside these locations:
 *
 *   - `<workspace>/.council/observer/**`
 *   - `<workspace>/.council/reviews/<phase>-observer.md` (pinned shape, not "contains observer")
 *
 * The predicate operates on the workspace-relative path *after* the caller
 * has resolved symlinks. {@link assertObserverWriteAllowed} is the integrated
 * entry point that does resolution + predicate together — prefer it.
 *
 * Returns `false` for absolute-vs-relative mismatches, NUL bytes, parent
 * traversal, or any path outside the allow-list — never throws.
 */
export function isObserverWriteAllowed(targetAbsolutePath: string, workspaceRootAbsolute: string): boolean {
  if (!isAbsolute(targetAbsolutePath) || !isAbsolute(workspaceRootAbsolute)) return false;
  if (targetAbsolutePath.includes("\0") || workspaceRootAbsolute.includes("\0")) return false;

  const rel = relative(workspaceRootAbsolute, targetAbsolutePath);
  if (rel === "" || rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;

  const segments = rel.split(sep);
  if (segments.some((s) => s === "..")) return false;

  if (segments[0] === ".council") {
    return segments[1] === "observer" || segments[1] === "reviews";
  }

  // specs/*observer*.md branch removed — the previous substring match was
  // too loose (any filename containing "observer" passed). Specs are
  // human-owned; observer writes belong under .council/.

  return false;
}

/**
 * Phase-name pattern used to pin review filenames. Mirrors the validator
 * in council-types.ts so a review file is genuinely shaped `<phase>-observer.md`
 * rather than "any filename containing 'observer'".
 */
const REVIEW_FILENAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}-observer\.md$/;

/**
 * Stricter pre-check for review filename. Used by callers that write
 * directly into `.council/reviews/`. Independent from {@link isObserverWriteAllowed}
 * (which is a directory check) — both apply together at the write site.
 */
export function isObserverReviewFilenameAllowed(filename: string): boolean {
  return REVIEW_FILENAME_PATTERN.test(filename);
}

/**
 * Integrated entry-point: resolve symlinks on the target's nearest existing
 * ancestor, normalise the resulting absolute path, then apply the predicate.
 *
 * This is the API write-call sites should use. The pure {@link isObserverWriteAllowed}
 * remains exported for unit testing the predicate without filesystem access.
 *
 * Throws on any disallowed write — callers must wrap if they want a boolean,
 * but throwing is the safer default (a forgotten guard is now a noisy failure
 * rather than a silent file escape).
 */
export function assertObserverWriteAllowed(rawTargetPath: string, workspaceRootAbsolute: string): string {
  if (typeof rawTargetPath !== "string" || rawTargetPath.includes("\0")) {
    throw new Error("observer-write-policy: invalid target path");
  }
  if (!isAbsolute(workspaceRootAbsolute) || workspaceRootAbsolute.includes("\0")) {
    throw new Error("observer-write-policy: invalid workspace root");
  }
  // Resolve relative paths against the workspace root, then normalise.
  const absoluteTarget = isAbsolute(rawTargetPath)
    ? resolve(rawTargetPath)
    : resolve(workspaceRootAbsolute, rawTargetPath);

  // Realpath the deepest existing ancestor — a symlink anywhere in the chain
  // is collapsed before the predicate runs.
  const resolvedTarget = realpathOfAncestor(absoluteTarget);
  const resolvedRoot = realpathOfAncestor(workspaceRootAbsolute);

  if (!isObserverWriteAllowed(resolvedTarget, resolvedRoot)) {
    throw new Error(`observer-write-policy: write to ${rawTargetPath} not allowed`);
  }
  return resolvedTarget;
}

/**
 * Walk up from the given absolute path until we find an existing ancestor,
 * realpath it, then rejoin the remaining segments. This handles the case
 * where the target file does not exist yet (typical for first write) but
 * the parent directory does and may be a symlink.
 */
function realpathOfAncestor(absolutePath: string): string {
  let current = absolutePath;
  const trailing: string[] = [];
  // Bounded loop — pathologically deep paths cannot infinite-loop here.
  for (let depth = 0; depth < 1024; depth++) {
    try {
      const resolved = realpathSync(current);
      return trailing.length ? resolve(resolved, ...trailing.reverse()) : resolved;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Reached the root without finding any existing ancestor.
        return absolutePath;
      }
      trailing.push(relativeChild(parent, current));
      current = parent;
    }
  }
  return absolutePath;
}

function relativeChild(parent: string, child: string): string {
  // `relative` here gives the single trailing segment, e.g. "foo" for /a/b -> /a/b/foo.
  return relative(parent, child);
}
