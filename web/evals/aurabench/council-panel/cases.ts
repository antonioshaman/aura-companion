/**
 * COUNCIL-PANEL-BENCH cases (P6). A case is a historical PR whose merged
 * state carried defects that a LATER PR fixed on the same code: the council
 * reviews `base..head`, and `knownDefects` is the ground truth for recall.
 *
 * Why historical PRs and not planted bugs: the question is whether a cheaper
 * panel still catches the defects that actually shipped here — each one is
 * pinned to the commit that fixed it (`fixedBy`), and, where one exists, the
 * archived FINAL-REVIEW that first reported it.
 *
 * The loader is fail-loud (a malformed case would silently skew recall);
 * `verifyCases` checks the pins against a real git repo through an injected
 * runner, so the unit tests never depend on this clone's history.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DefectKind = "defect" | "test-gap";

export interface DefectLocation {
  /** Repo-relative path at `head`. */
  file: string;
  /** Inclusive line hint at `head`; matching tolerates drift. */
  lines?: [number, number];
}

export interface KnownDefect {
  id: string;
  kind: DefectKind;
  /** Severity the defect deserved (the recall headline counts P1s). */
  severity: "P1" | "P2";
  summary: string;
  /** Commits that fixed it — the proof it was real. */
  fixedBy: string[];
  locations: DefectLocation[];
  /** Lower-case fragments; a finding mentioning one is a candidate match. */
  keywords: string[];
}

export interface PanelCase {
  id: string;
  pr: number;
  /** Git revisions (may use `^`); the review scope is `base..head`. */
  base: string;
  head: string;
  title: string;
  /** Closed-vocab domains the diff touches (drives panel composition). */
  changedDomains: string[];
  evidence: string;
  knownDefects: KnownDefect[];
}

export const CASES_SCHEMA_VERSION = 1;
export const DEFAULT_CASES_PATH = join(dirname(new URL(import.meta.url).pathname), "cases.json");

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REV_RE = /^[0-9a-f]{7,40}\^?$/;

function fail(msg: string): never {
  throw new Error(`council-panel cases: ${msg}`);
}

function str(v: unknown, at: string): string {
  if (typeof v !== "string" || v.length === 0) fail(`${at} must be a non-empty string`);
  return v;
}

function strArray(v: unknown, at: string, nonEmpty = true): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0)) {
    fail(`${at} must be an array of non-empty strings`);
  }
  if (nonEmpty && v.length === 0) fail(`${at} must be non-empty`);
  return v as string[];
}

function parseLocation(v: unknown, at: string): DefectLocation {
  if (!v || typeof v !== "object") fail(`${at} must be an object`);
  const o = v as Record<string, unknown>;
  const file = str(o.file, `${at}.file`);
  if (file.startsWith("/") || file.split("/").includes("..")) fail(`${at}.file must be repo-relative`);
  if (o.lines === undefined) return { file };
  const l = o.lines;
  if (
    !Array.isArray(l) || l.length !== 2 ||
    !l.every((n) => Number.isInteger(n) && (n as number) >= 1) || (l[0] as number) > (l[1] as number)
  ) {
    fail(`${at}.lines must be [start, end] with 1 <= start <= end`);
  }
  return { file, lines: [l[0] as number, l[1] as number] };
}

function parseDefect(v: unknown, at: string): KnownDefect {
  if (!v || typeof v !== "object") fail(`${at} must be an object`);
  const o = v as Record<string, unknown>;
  const id = str(o.id, `${at}.id`);
  if (!ID_RE.test(id)) fail(`${at}.id must match ${ID_RE}`);
  if (o.kind !== "defect" && o.kind !== "test-gap") fail(`${at}.kind must be defect|test-gap`);
  if (o.severity !== "P1" && o.severity !== "P2") fail(`${at}.severity must be P1|P2`);
  const fixedBy = strArray(o.fixedBy, `${at}.fixedBy`);
  for (const c of fixedBy) if (!/^[0-9a-f]{7,40}$/.test(c)) fail(`${at}.fixedBy has a non-sha entry ${c}`);
  if (!Array.isArray(o.locations) || o.locations.length === 0) fail(`${at}.locations must be non-empty`);
  const keywords = strArray(o.keywords, `${at}.keywords`);
  for (const k of keywords) {
    if (k !== k.toLowerCase()) fail(`${at}.keywords must be lower-case (${k})`);
    // One- or two-character fragments match almost any prose: a false recall source.
    if (k.length < 3) fail(`${at}.keywords entry too short to be evidence (${k})`);
  }
  return {
    id,
    kind: o.kind,
    severity: o.severity,
    summary: str(o.summary, `${at}.summary`),
    fixedBy,
    locations: o.locations.map((l, i) => parseLocation(l, `${at}.locations[${i}]`)),
    keywords,
  };
}

export function parseCases(raw: unknown): PanelCase[] {
  if (!raw || typeof raw !== "object") fail("expected an object");
  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion !== CASES_SCHEMA_VERSION) fail(`schemaVersion must be ${CASES_SCHEMA_VERSION}`);
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) fail("cases must be a non-empty array");
  const seen = new Set<string>();
  return doc.cases.map((c, i): PanelCase => {
    const at = `cases[${i}]`;
    if (!c || typeof c !== "object") fail(`${at} must be an object`);
    const o = c as Record<string, unknown>;
    const id = str(o.id, `${at}.id`);
    if (!ID_RE.test(id)) fail(`${at}.id must match ${ID_RE}`);
    if (seen.has(id)) fail(`duplicate case id ${id}`);
    seen.add(id);
    if (!Number.isInteger(o.pr) || (o.pr as number) < 1) fail(`${at}.pr must be a positive integer`);
    const base = str(o.base, `${at}.base`);
    const head = str(o.head, `${at}.head`);
    if (!REV_RE.test(base) || !REV_RE.test(head)) fail(`${at}.base/head must be a sha, optionally with ^`);
    if (!Array.isArray(o.knownDefects) || o.knownDefects.length === 0) fail(`${at}.knownDefects must be non-empty`);
    const knownDefects = o.knownDefects.map((d, j) => parseDefect(d, `${at}.knownDefects[${j}]`));
    const dIds = new Set<string>();
    for (const d of knownDefects) {
      if (dIds.has(d.id)) fail(`${at}: duplicate defect id ${d.id}`);
      dIds.add(d.id);
    }
    return {
      id,
      pr: o.pr as number,
      base,
      head,
      title: str(o.title, `${at}.title`),
      changedDomains: strArray(o.changedDomains, `${at}.changedDomains`),
      evidence: str(o.evidence, `${at}.evidence`),
      knownDefects,
    };
  });
}

export function loadCases(path: string = DEFAULT_CASES_PATH): PanelCase[] {
  return parseCases(JSON.parse(readFileSync(path, "utf8")));
}

/** `git <args>` in the repo; returns stdout or null on non-zero exit. */
export type GitRun = (args: string[]) => string | null;

/**
 * Check every pin against a real repo: base/head/fixedBy resolve, the head
 * contains each defect file, each fix commit descends from head (it fixed
 * THIS code, later), and the diff is non-empty. Returns problems (empty = ok).
 */
export function verifyCases(cases: PanelCase[], git: GitRun): string[] {
  const problems: string[] = [];
  for (const c of cases) {
    const base = git(["rev-parse", "--verify", "--quiet", `${c.base}^{commit}`])?.trim();
    const head = git(["rev-parse", "--verify", "--quiet", `${c.head}^{commit}`])?.trim();
    if (!base) problems.push(`${c.id}: base ${c.base} does not resolve`);
    if (!head) problems.push(`${c.id}: head ${c.head} does not resolve`);
    if (!base || !head) continue;
    const diff = git(["diff", "--name-only", base, head]);
    if (diff === null || diff.trim() === "") problems.push(`${c.id}: empty diff ${c.base}..${c.head}`);
    for (const d of c.knownDefects) {
      for (const l of d.locations) {
        if (git(["cat-file", "-e", `${head}:${l.file}`]) === null) {
          problems.push(`${c.id}/${d.id}: ${l.file} absent at head`);
        }
      }
      for (const fix of d.fixedBy) {
        if (git(["rev-parse", "--verify", "--quiet", `${fix}^{commit}`]) === null) {
          problems.push(`${c.id}/${d.id}: fixedBy ${fix} does not resolve`);
        } else if (git(["merge-base", "--is-ancestor", head, fix]) === null) {
          problems.push(`${c.id}/${d.id}: fixedBy ${fix} is not a descendant of head`);
        }
      }
    }
  }
  return problems;
}
