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
 * B2 (meta-diet) adds line-level checks when the caller supplies line facts:
 * a cited range past EOF or untouched by the checkpoint downgrades too, and a
 * STOP whose claim names nothing on its cited lines (or cites no lines at
 * all) is marked weak evidence — kept as STOP, kept out of the banner.
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
  | "evidence_missing_on_disk"
  /** `evidence_lines` points past the end of the file (or is an inverted /
   *  non-positive range) — the cited code cannot be what the claim is about. */
  | "evidence_lines_out_of_range"
  /** Every cited line is untouched by this checkpoint — the STOP blames the
   *  phase for code the phase did not write. */
  | "evidence_lines_unchanged";

/**
 * Why a STOP that survived every downgrade check is still only weakly
 * grounded. Weak evidence never changes severity or drops the finding (the
 * recall-side cost of a wrong downgrade is a silenced real blocker); it only
 * keeps the STOP out of the destructive blocker banner until a human reads it.
 */
export type WeakEvidenceReason =
  /** STOP cites no line range — only its path was checked, so any runtime
   *  claim ("command X fails") is unverified by the host. */
  | "no_cited_lines"
  /** The claim names no identifier that appears on the cited lines. */
  | "claim_symbols_not_on_cited_lines"
  /** Lines were cited but the host could not read the file content to check them. */
  | "cited_lines_unreadable";

/**
 * Host facts about one evidence file, as the observer was asked to review it.
 * Supplied by the caller (live: checkpoint snapshots; eval rerun: the frozen
 * sidecar) so the gate itself never touches the disk for line checks.
 */
export interface EvidenceLineFacts {
  /** Number of lines in the file. */
  lineCount: number;
  /** Text of a 1-indexed line; `undefined` outside `[1, lineCount]`. */
  lineText: (line: number) => string | undefined;
  /**
   * 1-indexed inclusive ranges changed by this checkpoint, or `null` when the
   * host has no baseline to diff against (first checkpoint for the file,
   * server restart). `null` skips the unchanged-lines check — fail-open on
   * severity, never a guess.
   */
  changedRanges: ReadonlyArray<readonly [number, number]> | null;
}

/** `null` = the host has no content for this path (unreadable / not captured). */
export type EvidenceLineFactsProvider = (relativePath: string) => EvidenceLineFacts | null;

export interface GroundingDowngrade {
  /** Index in the original `review.findings` array. Stable so downstream UI/log can correlate. */
  index: number;
  /** Original finding before downgrade (severity === "STOP"). */
  original: ObserverReviewFinding;
  reason: GroundingFailReason;
}

export interface WeakEvidenceMark {
  /** Index in the original `review.findings` array (still a STOP). */
  index: number;
  reason: WeakEvidenceReason;
}

export interface GroundingResult {
  /** All findings, with downgraded STOPs converted to NOTE. Same order, same length. */
  findings: ObserverReviewFinding[];
  /** Record of each downgrade. Empty when nothing was downgraded. */
  downgrades: GroundingDowngrade[];
  /**
   * STOPs that stayed STOP but are only weakly grounded. Empty when the
   * caller supplied no line facts (line checks are opt-in; see
   * {@link ValidateObserverFindingsArgs.lineFacts}).
   */
  weakEvidence: WeakEvidenceMark[];
}

export type StopGroundingCheck =
  | { grounded: true }
  | { grounded: false; reason: GroundingFailReason };

export type StopLineCheck =
  | { grounded: true; weak?: WeakEvidenceReason }
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

/**
 * Words too generic to count as "the claim names something on the cited
 * lines". Language keywords plus common English glue — a claim and a line
 * sharing only `const` or `the` is not evidence of anything.
 */
const NON_IDENTIFIER_TOKENS: ReadonlySet<string> = new Set([
  "and", "are", "as", "async", "await", "break", "but", "case", "catch", "class", "const",
  "continue", "default", "delete", "does", "else", "enum", "export", "extends", "false",
  "for", "from", "function", "get", "has", "if", "implements", "import", "in", "instanceof",
  "interface", "is", "let", "new", "not", "null", "of", "or", "private", "protected",
  "public", "readonly", "return", "set", "static", "super", "switch", "that", "the", "then",
  "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "when",
  "while", "with", "yield", "def", "self", "none", "elif", "pass", "lambda", "string",
  "number", "boolean", "any", "unknown", "never", "object", "was", "will", "should",
  "can", "its", "into", "only", "all", "one", "two", "line", "lines", "file",
]);

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Identifier-like tokens of a text: 3+ chars, not a keyword / glue word.
 * Case-sensitive — `SessionOrchestrator` and `session` are different names.
 */
export function extractIdentifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENTIFIER_RE)) {
    const tok = m[0];
    if (tok.length < 3) continue;
    if (NON_IDENTIFIER_TOKENS.has(tok.toLowerCase())) continue;
    out.add(tok);
  }
  return out;
}

/**
 * Pure helper: line-level grounding for a STOP that already passed
 * {@link checkStopGrounding}. Order: range sanity → changed-in-checkpoint →
 * claim/line symbol overlap. The first two downgrade; the third only marks
 * weak evidence (a wrong downgrade silences a real blocker, a wrong weak mark
 * only keeps it out of the banner).
 *
 * `facts === null` means the host has no content for the path: a STOP that
 * cites lines is then unverifiable → weak, never downgraded.
 */
export function checkStopLines(
  finding: ObserverReviewFinding,
  facts: EvidenceLineFacts | null,
): StopLineCheck {
  const lines = finding.evidence_lines;
  if (!lines) return { grounded: true, weak: "no_cited_lines" };
  if (!facts) return { grounded: true, weak: "cited_lines_unreadable" };
  const [start, end] = lines;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > facts.lineCount) {
    return { grounded: false, reason: "evidence_lines_out_of_range" };
  }
  if (facts.changedRanges !== null) {
    const touched = facts.changedRanges.some(([cs, ce]) => cs <= end && ce >= start);
    if (!touched) return { grounded: false, reason: "evidence_lines_unchanged" };
  }
  const onLines = new Set<string>();
  for (let n = start; n <= end; n++) {
    for (const tok of extractIdentifiers(facts.lineText(n) ?? "")) onLines.add(tok);
  }
  for (const tok of extractIdentifiers(finding.claim)) {
    if (onLines.has(tok)) return { grounded: true };
  }
  return { grounded: true, weak: "claim_symbols_not_on_cited_lines" };
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
  /**
   * Line facts per evidence path. Omitted → line checks are skipped entirely
   * and the result is exactly the path-only gate (what an eval sidecar
   * recorded before line facts existed is rerun byte-identically). Supplied →
   * {@link checkStopLines} runs on every path-grounded STOP.
   */
  lineFacts?: EvidenceLineFactsProvider;
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
  const weakEvidence: WeakEvidenceMark[] = [];

  for (let i = 0; i < review.findings.length; i++) {
    const f = review.findings[i]!;
    if (f.severity !== "STOP") {
      findings.push(f);
      continue;
    }
    const pathCheck = checkStopGrounding(f, args.modifiedFiles, exists);
    const check: StopLineCheck = pathCheck.grounded && args.lineFacts
      ? checkStopLines(f, args.lineFacts(f.evidence_path))
      : pathCheck;
    if (check.grounded) {
      findings.push(f);
      if (check.weak) weakEvidence.push({ index: i, reason: check.weak });
    } else {
      downgrades.push({ index: i, original: f, reason: check.reason });
      findings.push({ ...f, severity: "NOTE" });
    }
  }

  return { findings, downgrades, weakEvidence };
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
  const resolveRel = createWorkspaceResolver(workspaceRoot);
  return (relPath: string): boolean => resolveRel(relPath) !== null;
}

/**
 * Workspace-bounded resolver: relative path → realpath inside the workspace,
 * or `null` when it is absolute, traverses `..`, is missing, or escapes via a
 * symlink. Exported for callers that must READ evidence files (checkpoint line
 * snapshots) under the exact bounds the gate uses — EC-7: resolution and the
 * bounds check are one unit, never a bare predicate.
 */
export function createWorkspaceResolver(workspaceRoot: string): (relPath: string) => string | null {
  const rootResolved = (() => {
    try {
      return realpathSync(workspaceRoot);
    } catch {
      return resolve(workspaceRoot);
    }
  })();

  return (relPath: string): string | null => {
    if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\0")) return null;
    if (isAbsolute(relPath)) return null;
    if (relPath.split(/[\\/]/).some((seg) => seg === "..")) return null;
    const target = resolve(rootResolved, relPath);
    let resolvedTarget: string;
    try {
      resolvedTarget = realpathSync(target);
    } catch {
      // File does not exist (or some other stat error). For grounding,
      // the safe answer is `null`; the finding then downgrades.
      return null;
    }
    // Bounds check after realpath — a symlink that escapes the workspace
    // resolves to outside-root and is rejected here.
    const rel = relative(rootResolved, resolvedTarget);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    if (rel.split(sep).some((s) => s === "..")) return null;
    return resolvedTarget;
  };
}
