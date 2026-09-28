/**
 * AuraBench candidate miner (P5/D1). Turns merged PRs into task CANDIDATES —
 * the cheap, pure half of corpus construction. The expensive half (running the
 * hidden tests on base and merge) is `validate.ts`; only candidates that
 * survive both become tasks.
 *
 * Per PR:
 *   - base = first parent of the merge commit (every PR here is squash-merged,
 *     so this is the tree the author started from);
 *   - hidden tests = test files the PR added or modified (deleted ones can't be
 *     run; renamed ones count at their new path);
 *   - source files = non-test code the PR changed — the part the agent must
 *     reproduce. A PR that changes only tests has nothing for the agent to do.
 *   - class = deterministic heuristic over the conventional-commit title and
 *     the touched paths (see {@link classifyPr}).
 *
 * Every rejected PR carries a reason, so the corpus report can account for all
 * of them. Git access is injected (`changedFiles`) — this module is pure.
 *
 * Firewall-clean. Never `server/`.
 */

import type { AuraBenchClass } from "./task.js";

export interface MergedPr {
  number: number;
  title: string;
  body: string;
  mergeCommit: { oid: string } | null;
}

/** One `git diff --name-status` row: status letter (A/M/D/R…) and the
 *  post-change path. */
export interface ChangedFile {
  status: string;
  path: string;
}

export interface Candidate {
  pr: number;
  title: string;
  body: string;
  merge_commit: string;
  class: AuraBenchClass;
  hidden_tests: string[];
  source_files: string[];
}

export interface MineExclusion {
  pr: number;
  title: string;
  reason: string;
}

export interface MineResult {
  candidates: Candidate[];
  excluded: MineExclusion[];
}

const TEST_RE = /\.(test|spec)\.(ts|tsx)$/;
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|css)$/;
/** Candidates above this many changed source files are multi-feature drops
 *  that no single prompt can describe fairly. */
export const MAX_SOURCE_FILES = 30;
/** Conventional-commit types that never describe agent-sized code work. */
const NON_TASK_TYPES = new Set(["docs", "ci", "revert", "test", "build", "style"]);

export function isTestPath(path: string): boolean {
  return TEST_RE.test(path);
}

/** Conventional-commit type of a title (`fix(server): x` → `fix`), else null. */
export function commitType(title: string): string | null {
  const m = /^([a-z]+)(\([^)]*\))?!?:/i.exec(title.trim());
  return m ? m[1]!.toLowerCase() : null;
}

const SECURITY_RE = /\b(security|xss|csrf|ssrf|injection|sanitiz\w*|traversal|origin allowlist|allowed[- ]origin|secrets?|redact\w*|csp)\b/i;
const DEBUG_RE = /\b(diagnos\w*|debug\w*|canary|drift detector|root[- ]cause)\b/i;
const ARCH_RE = /\b(extract|decouple|architecture|split|modular\w*|layer)\b/i;

/**
 * Deterministic class heuristic. Order matters: the specific intents
 * (security, debug) win over the generic type; UI is a feature/fix confined to
 * the browser tree; architecture is a refactor/feat whose title says so or
 * that spans ≥ 5 source files.
 */
export function classifyPr(title: string, sourceFiles: string[]): AuraBenchClass {
  const type = commitType(title);
  const subject = title.replace(/^[^:]*:\s*/, "");
  // Security/debug intent may sit in the scope (`feat(security): …`), so
  // match the whole title for those two.
  if (SECURITY_RE.test(title)) return "security";
  if (DEBUG_RE.test(title)) return "debug";
  const uiOnly = sourceFiles.length > 0 && sourceFiles.every((p) => p.startsWith("web/src/"));
  if (type === "refactor" || type === "chore" || type === "perf") {
    return ARCH_RE.test(subject) || sourceFiles.length >= 5 ? "architecture" : "refactor";
  }
  if (type === "feat") {
    if (ARCH_RE.test(subject)) return "architecture";
    return uiOnly ? "ui" : "feature";
  }
  return uiOnly && type !== "fix" ? "ui" : "bugfix";
}

export function minePrs(prs: MergedPr[], changedFiles: (mergeCommit: string) => ChangedFile[]): MineResult {
  const candidates: Candidate[] = [];
  const excluded: MineExclusion[] = [];
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  for (const pr of sorted) {
    const drop = (reason: string) => excluded.push({ pr: pr.number, title: pr.title, reason });
    if (!pr.mergeCommit?.oid) {
      drop("no merge commit");
      continue;
    }
    const type = commitType(pr.title);
    if (type !== null && NON_TASK_TYPES.has(type)) {
      drop(`non-task PR type "${type}"`);
      continue;
    }
    const files = changedFiles(pr.mergeCommit.oid);
    const hidden = files
      .filter((f) => !f.status.startsWith("D") && isTestPath(f.path) && f.path.startsWith("web/"))
      .map((f) => f.path)
      .sort();
    const source = files
      .filter((f) => !isTestPath(f.path) && CODE_RE.test(f.path) && f.path.startsWith("web/"))
      .map((f) => f.path)
      .sort();
    if (hidden.length === 0) {
      drop("PR adds/changes no web/ test files, so nothing distinguishes before from after");
      continue;
    }
    if (source.length === 0) {
      drop("PR changes only tests; there is no code for the agent to write");
      continue;
    }
    if (source.length > MAX_SOURCE_FILES) {
      drop(`too large: ${source.length} source files (> ${MAX_SOURCE_FILES})`);
      continue;
    }
    candidates.push({
      pr: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      merge_commit: pr.mergeCommit.oid,
      class: classifyPr(pr.title, source),
      hidden_tests: hidden,
      source_files: source,
    });
  }
  return { candidates, excluded };
}
