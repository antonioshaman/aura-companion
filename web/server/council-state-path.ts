/**
 * Resolving wrapper for `<workspaceRoot>/.council/state/<group-id><suffix>`
 * paths. Single source of truth for the path-construction + bounds-check
 * idiom — every persistence helper that writes auto-proceed artefacts
 * (trace JSON, AFK summary) MUST go through this wrapper.
 *
 * The wrapper exists to enforce EC-7 ("filesystem-access predicates inline
 * path resolution OR are exposed only via a resolving wrapper") and to
 * prevent the path-traversal class of bugs caused by a malformed groupId
 * smuggling `..` segments past a naive `path.join`. Duplicating the
 * `join + resolve + startsWith` idiom inline at each call site IS the
 * EC-7 violation pattern; this wrapper IS the rule's enforcement.
 *
 * Slug normalisation: groupIds are already lowercase hex by construction
 * (`grp_[a-f0-9]{32}` per `GROUP_ID_PATTERN`), so the realpath of the
 * resulting filename is stable across macOS (case-insensitive HFS+) and
 * Linux (case-sensitive ext4). The wrapper still lowercases defensively
 * — protects against a future broadening of the group-id charset.
 */

import path from "node:path";
import { isWellFormedGroupId } from "./group-authorization.js";

/**
 * Reasons {@link resolveCouncilStatePath} may refuse to return a path.
 * Callers should EC-9-log the discriminant and fail closed — never fall
 * back to a partially-validated path.
 */
export type CouncilStatePathError =
  | { kind: "invalid-group-id" }
  | { kind: "invalid-suffix"; reason: "empty" | "contains-separator" | "control-bytes" }
  | { kind: "invalid-workspace-root"; reason: "not-absolute" | "empty" }
  | { kind: "escapes-state-dir"; resolved: string; stateDir: string };

/**
 * Successful resolution.
 *
 *  - `absolutePath` — the safe-to-write path under `<workspaceRoot>/.council/state/`.
 *  - `stateDir` — the `<workspaceRoot>/.council/state/` directory itself
 *    (useful so the caller can `mkdir -p` ahead of the write).
 */
export interface CouncilStatePath {
  absolutePath: string;
  stateDir: string;
}

/**
 * Resolve a `<workspaceRoot>/.council/state/<group-id><suffix>` path
 * with full validation. Returns either a typed success or a
 * discriminated error — never throws (the caller decides whether the
 * error is a hard failure or an EC-9 log entry, and that decision is
 * easier when no `try/catch` is involved).
 *
 * Validation pass:
 *  1. `workspaceRoot` is non-empty and absolute (refuses
 *     relative-from-cwd paths so the wrapper is safe to call before any
 *     `chdir`).
 *  2. `groupId` matches `GROUP_ID_PATTERN` via `isWellFormedGroupId` —
 *     cryptographic identifier, not a free-form slug.
 *  3. `suffix` is non-empty, contains no path separators (`/` or `\`),
 *     and has no control bytes / NUL.
 *  4. The final `path.resolve` of the joined path MUST `startsWith` the
 *     `path.resolve` of the state directory + trailing separator — the
 *     classic anti-traversal check.
 */
export function resolveCouncilStatePath(
  workspaceRoot: string,
  groupId: string,
  suffix: string,
): { ok: true; value: CouncilStatePath } | { ok: false; error: CouncilStatePathError } {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    return { ok: false, error: { kind: "invalid-workspace-root", reason: "empty" } };
  }
  if (!path.isAbsolute(workspaceRoot)) {
    return { ok: false, error: { kind: "invalid-workspace-root", reason: "not-absolute" } };
  }
  if (!isWellFormedGroupId(groupId)) {
    return { ok: false, error: { kind: "invalid-group-id" } };
  }
  if (typeof suffix !== "string" || suffix.length === 0) {
    return { ok: false, error: { kind: "invalid-suffix", reason: "empty" } };
  }
  if (suffix.includes("/") || suffix.includes("\\")) {
    return { ok: false, error: { kind: "invalid-suffix", reason: "contains-separator" } };
  }
  // Control bytes (incl. NUL, CR, LF) would corrupt downstream consumers
  // that read the path back from a JSON log entry. Reject up-front.
  for (let i = 0; i < suffix.length; i++) {
    const c = suffix.charCodeAt(i);
    if (c === 0 || (c < 0x20 && c !== 0x09) || c === 0x7f) {
      return { ok: false, error: { kind: "invalid-suffix", reason: "control-bytes" } };
    }
  }

  // Defensive lowercase — groupId is already constrained to lowercase
  // hex by `GROUP_ID_PATTERN`, but a future widening of the charset must
  // not silently produce two paths that differ only in case (HFS+
  // collision on macOS).
  const normalisedGroupId = groupId.toLowerCase();

  const stateDir = path.resolve(workspaceRoot, ".council", "state");
  const candidate = path.resolve(stateDir, `${normalisedGroupId}${suffix}`);

  // The classic anti-traversal check. `path.resolve` normalises
  // `..` segments; this assertion catches any suffix that smuggled a
  // way out of the state dir despite passing the separator-check (e.g.
  // a future relaxation of the separator filter).
  const stateDirWithSep = stateDir.endsWith(path.sep) ? stateDir : stateDir + path.sep;
  if (!candidate.startsWith(stateDirWithSep)) {
    return {
      ok: false,
      error: { kind: "escapes-state-dir", resolved: candidate, stateDir },
    };
  }

  return {
    ok: true,
    value: { absolutePath: candidate, stateDir },
  };
}

/**
 * Convenience: build the `.council/state/` directory path itself, with
 * the same workspace-root validation as {@link resolveCouncilStatePath}.
 * Callers use this to `mkdir -p` ahead of any write.
 */
export function resolveCouncilStateDir(
  workspaceRoot: string,
): { ok: true; value: string } | { ok: false; error: CouncilStatePathError } {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    return { ok: false, error: { kind: "invalid-workspace-root", reason: "empty" } };
  }
  if (!path.isAbsolute(workspaceRoot)) {
    return { ok: false, error: { kind: "invalid-workspace-root", reason: "not-absolute" } };
  }
  return {
    ok: true,
    value: path.resolve(workspaceRoot, ".council", "state"),
  };
}
