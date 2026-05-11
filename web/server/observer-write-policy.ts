import { isAbsolute, relative, sep } from "node:path";

/**
 * Allow-list predicate for write attempts by the observer half of a Council
 * Mode pair. The observer must NEVER write outside these locations:
 *
 *   - `<workspace>/.council/observer/**`
 *   - `<workspace>/.council/reviews/**`
 *   - `<workspace>/specs/*observer*.md` (filename contains "observer", `.md` only, one level)
 *
 * The predicate is pure: callers are expected to {@link resolve} and
 * `realpathSync` the path first so symlinks cannot escape the workspace.
 * This separation keeps the rule itself fully unit-testable.
 *
 * Returns `false` for absolute-vs-relative mismatches, NUL bytes, parent
 * traversal, or any path outside the allow-list — never throws.
 */
export function isObserverWriteAllowed(targetAbsolutePath: string, workspaceRootAbsolute: string): boolean {
  if (!isAbsolute(targetAbsolutePath) || !isAbsolute(workspaceRootAbsolute)) return false;
  if (targetAbsolutePath.includes("\0") || workspaceRootAbsolute.includes("\0")) return false;

  // `path.relative` returns a string with `..` prefixes when target lives
  // outside root — that's our escape detector.
  const rel = relative(workspaceRootAbsolute, targetAbsolutePath);
  if (rel === "" || rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;

  const segments = rel.split(sep);
  // Defence-in-depth: split should never yield ".." after the relative()
  // shortcut above, but guard explicitly.
  if (segments.some((s) => s === "..")) return false;

  if (segments[0] === ".council") {
    return segments[1] === "observer" || segments[1] === "reviews";
  }

  if (segments[0] === "specs" && segments.length === 2) {
    const name = segments[1] ?? "";
    return name.endsWith(".md") && name.toLowerCase().includes("observer");
  }

  return false;
}
