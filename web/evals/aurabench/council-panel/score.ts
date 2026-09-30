/**
 * Scoring for COUNCIL-PANEL-BENCH (P6): parse a `/council-review-aura`
 * FINAL-REVIEW.md into findings and match them against a case's known
 * defects.
 *
 * Matching is deliberately a CANDIDATE step, not the verdict: a finding
 * matches a defect when it points at one of the defect's files (path or path
 * suffix) AND either its line range overlaps the defect's hint (± tolerance)
 * or its text contains one of the defect's keywords. The spec requires a
 * judge + a manual pass by the supervisor on top; this module produces the
 * table they confirm. P1 findings that match no known defect are reported as
 * "unmatched P1" — candidates for false P1s, not proven false (the PR may
 * have carried defects nobody later fixed).
 */

import type { KnownDefect, PanelCase } from "./cases.js";

export type Priority = "P1" | "P2" | "P3";

export interface FindingRef {
  file: string;
  lines?: [number, number];
}

export interface ReviewFinding {
  priority: Priority;
  /** Number from the `### N.` heading (null when the heading has none). */
  number: number | null;
  title: string;
  refs: FindingRef[];
  /** Whole block, lower-cased, for keyword matching. */
  text: string;
}

const SECTION_RE = /^##\s+(P[123])\b/;
const OTHER_H2_RE = /^##\s+/;
const FINDING_RE = /^###\s+(?:(\d+)\.\s*)?(.+?)\s*$/;
const FILE_ROW_RE = /^\|\s*\*\*File\*\*\s*\|(.*)\|\s*$/;
// `path/to/file.ts:12-34`, `file.ts:12`, `file.ts` — inside backticks.
const REF_RE = /`([^`\s:]+\.[A-Za-z0-9]+)(?::(\d+)(?:\s*-\s*(\d+))?)?[^`]*`/g;

function parseRefs(cell: string): FindingRef[] {
  const refs: FindingRef[] = [];
  for (const m of cell.matchAll(REF_RE)) {
    const file = m[1]!.replace(/^\.\//, "");
    if (m[2] === undefined) {
      refs.push({ file });
      continue;
    }
    const a = Number(m[2]);
    const b = m[3] === undefined ? a : Number(m[3]);
    refs.push({ file, lines: [Math.min(a, b), Math.max(a, b)] });
  }
  return refs;
}

/**
 * Findings under `## P1|P2|P3` headings, one per `### ` block. Anything under
 * another `## ` heading (Summary, Findings Breakdown, …) is ignored, so the
 * summary table never double-counts a finding.
 */
export function parseFinalReview(md: string): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  let section: Priority | null = null;
  let cur: { priority: Priority; number: number | null; title: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join("\n");
    const refs: FindingRef[] = [];
    for (const l of cur.lines) {
      const row = FILE_ROW_RE.exec(l);
      if (row) refs.push(...parseRefs(row[1]!));
    }
    out.push({
      priority: cur.priority,
      number: cur.number,
      title: cur.title,
      refs,
      text: `${cur.title}\n${body}`.toLowerCase(),
    });
    cur = null;
  };
  for (const line of md.split(/\r?\n/)) {
    const sec = SECTION_RE.exec(line);
    if (sec) {
      flush();
      section = sec[1] as Priority;
      continue;
    }
    if (OTHER_H2_RE.test(line)) {
      flush();
      section = null;
      continue;
    }
    const f = FINDING_RE.exec(line);
    if (f && section) {
      flush();
      cur = { priority: section, number: f[1] === undefined ? null : Number(f[1]), title: f[2]!, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  flush();
  return out;
}

/** Line tolerance for "same place" — reviews cite ranges loosely. */
export const LINE_TOLERANCE = 20;

function sameFile(findingPath: string, defectPath: string): boolean {
  return findingPath === defectPath || defectPath.endsWith(`/${findingPath}`) || findingPath.endsWith(`/${defectPath}`);
}

function overlaps(a: [number, number], b: [number, number], tol: number): boolean {
  return a[0] <= b[1] + tol && b[0] <= a[1] + tol;
}

export interface MatchEvidence {
  file: boolean;
  line: boolean;
  keywords: string[];
}

export function matchFinding(f: ReviewFinding, d: KnownDefect): MatchEvidence | null {
  let file = false;
  let line = false;
  for (const r of f.refs) {
    for (const l of d.locations) {
      if (!sameFile(r.file, l.file)) continue;
      file = true;
      if (r.lines && l.lines && overlaps(r.lines, l.lines, LINE_TOLERANCE)) line = true;
    }
  }
  if (!file) return null;
  const keywords = d.keywords.filter((k) => f.text.includes(k));
  if (!line && keywords.length === 0) return null;
  return { file, line, keywords };
}

export interface DefectOutcome {
  defectId: string;
  severity: "P1" | "P2";
  kind: KnownDefect["kind"];
  found: boolean;
  /** Highest priority among matching findings (null when not found). */
  bestPriority: Priority | null;
  matches: { finding: number | null; priority: Priority; title: string; evidence: MatchEvidence }[];
}

export interface RunScore {
  caseId: string;
  findings: { P1: number; P2: number; P3: number };
  defects: DefectOutcome[];
  /** Known defects found at any priority / total. */
  recall: { found: number; total: number };
  /** Known P1 defects that the review also rated P1. */
  recallAsP1: { found: number; total: number };
  /** P1 findings matching no known defect: false-P1 CANDIDATES for the judge. */
  unmatchedP1: { finding: number | null; title: string; refs: FindingRef[] }[];
}

const RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

export function scoreReview(c: PanelCase, findings: ReviewFinding[]): RunScore {
  const matchedFindings = new Set<ReviewFinding>();
  const defects = c.knownDefects.map((d): DefectOutcome => {
    const matches: DefectOutcome["matches"] = [];
    for (const f of findings) {
      const ev = matchFinding(f, d);
      if (!ev) continue;
      matchedFindings.add(f);
      matches.push({ finding: f.number, priority: f.priority, title: f.title, evidence: ev });
    }
    const best = matches.reduce<Priority | null>(
      (acc, m) => (acc === null || RANK[m.priority] < RANK[acc] ? m.priority : acc),
      null,
    );
    return { defectId: d.id, severity: d.severity, kind: d.kind, found: matches.length > 0, bestPriority: best, matches };
  });
  const p1Defects = defects.filter((d) => d.severity === "P1");
  return {
    caseId: c.id,
    findings: {
      P1: findings.filter((f) => f.priority === "P1").length,
      P2: findings.filter((f) => f.priority === "P2").length,
      P3: findings.filter((f) => f.priority === "P3").length,
    },
    defects,
    recall: { found: defects.filter((d) => d.found).length, total: defects.length },
    recallAsP1: { found: p1Defects.filter((d) => d.bestPriority === "P1").length, total: p1Defects.length },
    unmatchedP1: findings
      .filter((f) => f.priority === "P1" && !matchedFindings.has(f))
      .map((f) => ({ finding: f.number, title: f.title, refs: f.refs })),
  };
}
