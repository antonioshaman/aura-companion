/**
 * The three filesystem roots the Diagnostics feature touches, each derived
 * server-side and resolved once (EC-7 resolving wrapper; hunt 2, ritchie B6):
 *
 *   KB root      `<repo>/.agents/knowledge`                  read + archive move
 *   reports root `<COMPANION_HOME>/diagnostics/kb-analysis`  read / write
 *   memory root  `~/.claude/projects/<repo slug>/memory`     READ ONLY
 *
 * No request ever supplies a path component. Ids from a request are looked up
 * in loaded data, and only the resulting basenames are joined here.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { COMPANION_HOME } from "../paths.js";

/** web/server/diagnostics → web/server → web → repo root. */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/**
 * Claude CLI project slug: the absolute path with BOTH `/` and `_` replaced by
 * `-` (same rule as `resolveCliSessionPaths` in silent-stdio-drift-detector.ts).
 */
export function claudeProjectSlug(absPath: string): string {
  return absPath.replace(/[/_]/g, "-");
}

/** realpath of `p`, or of its nearest existing ancestor with the rest re-joined. */
export function resolveRootPath(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cur = parent;
  }
  return join(realpathSync(cur), ...rest);
}

export class PathOutsideRootError extends Error {
  constructor(rel: string) {
    super(`path escapes its root: ${JSON.stringify(rel)}`);
    this.name = "PathOutsideRootError";
  }
}

/**
 * Resolve `rel` inside `root`. Rejects absolute paths, `..` segments, NUL
 * bytes, symlinks, and anything whose realpath lands outside the root.
 * A path that does not exist yet is allowed (it resolves lexically inside).
 */
export function resolveInside(root: string, rel: string): string {
  if (rel === "" || isAbsolute(rel) || rel.includes("\0") || rel.split(/[\\/]/).includes("..")) {
    throw new PathOutsideRootError(rel);
  }
  const target = join(root, rel);
  if (!(target === root || target.startsWith(root + sep))) throw new PathOutsideRootError(rel);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new PathOutsideRootError(rel);
    const real = realpathSync(target);
    if (!(real === root || real.startsWith(root + sep))) throw new PathOutsideRootError(rel);
  }
  return target;
}

export interface DiagnosticsRoots {
  kb: string;
  reports: string;
  memory: string;
}

export function defaultDiagnosticsRoots(overrides: Partial<DiagnosticsRoots> = {}): DiagnosticsRoots {
  return {
    kb: resolveRootPath(overrides.kb ?? join(REPO_ROOT, ".agents", "knowledge")),
    reports: resolveRootPath(overrides.reports ?? join(COMPANION_HOME, "diagnostics", "kb-analysis")),
    memory: resolveRootPath(
      overrides.memory ?? join(homedir(), ".claude", "projects", claudeProjectSlug(REPO_ROOT), "memory"),
    ),
  };
}
