/**
 * Grounding validation: a STOP finding that doesn't point at a file the
 * orchestrator actually modified in this phase is downgraded to NOTE
 * before reaching the user.
 *
 * Without this gate, a prompt-injected observer can emit "STOP: foo is
 * broken in /etc/passwd" and that destructive-banner alert reaches the
 * orchestrator chat unchallenged. Willison P2/P7 (separate instructions
 * from data; treat the chain as a system) + Hunt P1 (the observer is
 * downstream of an LLM whose bytes are untrusted): the grounding gate
 * is the place where claims get sanity-checked against the orchestrator's
 * actual modification set.
 *
 * Non-STOP findings (WARN/NOTE/INFO) pass through unchanged — the cost
 * of a stray WARN is alert fatigue, not destructive UI, so we trade off
 * the false-negative side of grounding for those tiers.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ObserverReviewFinding, ObserverReviewPayload } from "./council-types.js";

export type GroundingFailReason =
  | "evidence_not_in_modified_set"
  | "evidence_missing_on_disk";

export interface GroundingDowngrade {
  /** Index in the original `review.findings` array. Stable so downstream UI/log can correlate. */
  index: number;
  /** Original finding before downgrade (severity === "STOP"). */
  original: ObserverReviewFinding;
  reason: GroundingFailReason;
}

export interface GroundingResult {
  /** All findings, with downgraded STOPs converted to NOTE. Same order, same length. */
  findings: ObserverReviewFinding[];
  /** Record of each downgrade. Empty when nothing was downgraded. */
  downgrades: GroundingDowngrade[];
}

export type StopGroundingCheck =
  | { grounded: true }
  | { grounded: false; reason: GroundingFailReason };

/**
 * Pure helper: decide whether a single STOP finding is grounded. Both
 * the success branch and each failure branch are independently testable.
 *
 * `existsRelative` is the injected existence predicate. The integrated
 * {@link validateObserverFindings} wires it to a workspace-bounded
 * `realpathSync` check; tests can swap in a deterministic stub.
 *
 * Caller's responsibility: only invoke for STOP findings. The helper
 * does NOT short-circuit on `finding.severity` — it always runs the two
 * grounding checks. That keeps the helper monomorphic and prevents the
 * "but we forgot to check severity" bug class at the call site.
 */
export function checkStopGrounding(
  finding: ObserverReviewFinding,
  modifiedFiles: ReadonlySet<string>,
  existsRelative: (relativePath: string) => boolean,
): StopGroundingCheck {
  if (!modifiedFiles.has(finding.evidence_path)) {
    return { grounded: false, reason: "evidence_not_in_modified_set" };
  }
  if (!existsRelative(finding.evidence_path)) {
    return { grounded: false, reason: "evidence_missing_on_disk" };
  }
  return { grounded: true };
}

export interface ValidateObserverFindingsArgs {
  /** Workspace root used to bound on-disk existence checks. */
  workspaceRoot: string;
  /** Set of workspace-relative paths the orchestrator modified in THIS phase. */
  modifiedFiles: ReadonlySet<string>;
  /**
   * Optional DI seam for tests. Default is a `realpathSync`-backed check
   * bounded to the workspace root. Production callers should omit it.
   */
  existsRelative?: (relativePath: string) => boolean;
}

/**
 * Validate findings against the orchestrator's modification set and the
 * filesystem. STOP findings whose `evidence_path` is outside the modified
 * set OR missing on disk are downgraded to NOTE.
 *
 * Non-STOP findings pass through unchanged (no false-positive cost on
 * lower-tier signals).
 *
 * Throws on a non-absolute or NUL-poisoned workspace root — that argument
 * is a fixed invariant of the caller's environment, not something the
 * observer can influence; failing fast catches misuse early.
 */
export function validateObserverFindings(
  review: ObserverReviewPayload,
  args: ValidateObserverFindingsArgs,
): GroundingResult {
  if (typeof args.workspaceRoot !== "string" || !isAbsolute(args.workspaceRoot) || args.workspaceRoot.includes("\0")) {
    throw new Error("observer-grounding: workspaceRoot must be absolute and NUL-free");
  }
  const exists = args.existsRelative ?? createWorkspaceExistsCheck(args.workspaceRoot);

  const findings: ObserverReviewFinding[] = [];
  const downgrades: GroundingDowngrade[] = [];

  for (let i = 0; i < review.findings.length; i++) {
    const f = review.findings[i]!;
    if (f.severity !== "STOP") {
      findings.push(f);
      continue;
    }
    const check = checkStopGrounding(f, args.modifiedFiles, exists);
    if (check.grounded) {
      findings.push(f);
    } else {
      downgrades.push({ index: i, original: f, reason: check.reason });
      findings.push({ ...f, severity: "NOTE" });
    }
  }

  return { findings, downgrades };
}

/**
 * Build the default workspace-bounded existence check. Resolves the
 * relative path against the workspace, realpaths the result (collapsing
 * symlinks), and rejects anything that escapes the workspace.
 *
 * EC-7 (Hunt): the integrated wrapper performs realpath + bounds check
 * as one unit. The pure {@link checkStopGrounding} stays exported only
 * because it takes the predicate as an injected dependency — it never
 * resolves a path itself.
 */
function createWorkspaceExistsCheck(workspaceRoot: string): (relPath: string) => boolean {
  const rootResolved = (() => {
    try {
      return realpathSync(workspaceRoot);
    } catch {
      return resolve(workspaceRoot);
    }
  })();

  return (relPath: string): boolean => {
    if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\0")) return false;
    if (isAbsolute(relPath)) return false;
    if (relPath.split(/[\\/]/).some((seg) => seg === "..")) return false;
    const target = resolve(rootResolved, relPath);
    let resolvedTarget: string;
    try {
      resolvedTarget = realpathSync(target);
    } catch {
      // File does not exist (or some other stat error). For grounding,
      // the safe answer is `false`; the finding then downgrades.
      return false;
    }
    // Bounds check after realpath — a symlink that escapes the workspace
    // resolves to outside-root and is rejected here.
    const rel = relative(rootResolved, resolvedTarget);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
    if (rel.split(sep).some((s) => s === "..")) return false;
    return true;
  };
}
