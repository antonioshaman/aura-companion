#!/usr/bin/env bun
// Enrichment verifiers (spec `uiux-agent-enrichment.md` Story 3, PLAN Task 12).
//
// The Phase C knowledge enrichment is append-only: every file in scope keeps its
// pre-existing bytes, and everything new is a dated `## Addendum (YYYY-MM-DD) — …`
// block whose first line is `Source: <catalog ids>`, optionally closed by one
// fixed-shape `## Source conflicts` block. `enrichment.json` names the files and
// pins each one's pre-existing bytes (length + sha256) at a baseline commit on
// main, so CI checks them without needing that commit's objects.
//
//   check       hermetic gate (CI): old sections intact, attribution, conflict
//               ledger shape, cited sources checkable, copy-check receipt current,
//               injection lint over all shipped markdown, description lint + cap,
//               every platform has its tagged section.
//   copy-check  needs the local corpus (gitignored, third-party text): shingle
//               overlap of every new block against it; on pass, writes the receipt
//               that `check` verifies.
//   baseline    (re)pin the baseline bytes of the scoped files from a commit.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { COUNCIL_SKILLS_DIR } from "./capability-catalog.js";
import {
  CORPUS_DIR,
  CORPUS_MANIFEST_FILE,
  checkableCorpus,
  corpusTextPath,
  loadCatalogEntries,
  loadCorpusManifest,
  UIUX_SOURCES_DIR,
  verifyCorpus,
  type CorpusItem,
  type Verdict,
} from "./uiux-sources.js";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const ENRICHMENT_FILE = join(UIUX_SOURCES_DIR, "enrichment.json");
export const RECEIPT_FILE = join(UIUX_SOURCES_DIR, "copy-check-receipt.json");
export const INJECTION_BASELINE_FILE = join(UIUX_SOURCES_DIR, "injection-baseline.json");
const MANIFEST_FILE = join(COUNCIL_SKILLS_DIR, "skills-manifest.json");

/** Platforms that must each have a tagged section (spec AC3.3). */
export const PLATFORMS = ["telegram-mini-app", "ios", "android"] as const;
/** Owners of platform sections: the first-party skill and the three UI/UX seats. */
export const PLATFORM_OWNERS = ["aura-uiux/references", "_council-experts/friedman/references", "_council-experts/saarinen/references", "_council-experts/watson/references"];
/** Values a conflict's platform scope may take. */
export const SCOPES: ReadonlySet<string> = new Set(["web", ...PLATFORMS, "all"]);
/** Sources whose facts we may paraphrase with attribution (never their text). */
const CITABLE: ReadonlySet<Verdict | string> = new Set(["redistributable", "reference-only"]);
/** First-party pseudo-source: routing or method text written by Aura, no external content. */
export const FIRST_PARTY_SOURCE = "aura";

/** Copy rule (spec AC3.2): a verbatim passage of this many sentences or more is a copy. */
export const COPY_RUN_SENTENCES = 3;
export const SHINGLE_WORDS = 8;
/** A sentence counts as verbatim when this share of its words sits inside matched shingles. */
const VERBATIM_COVERAGE = 0.8;

/** All shipped skill descriptions are listed to the model every session (willison: curse of instructions). */
export const DESCRIPTION_CAP_BYTES = 12_288;
/** Word-bigram Jaccard at or above this = two descriptions compete for the same trigger (shipped max today: 0.49). */
export const NEAR_DUPLICATE_JACCARD = 0.6;

export type SourceVerdicts = ReadonlyMap<string, Verdict | string>;

export interface BaselineRecord {
  bytes: number;
  sha256: string;
}

export interface EnrichmentDoc {
  _doc?: string;
  baselineCommit: string;
  /** Repo-relative path → pre-existing bytes at the baseline, or null for a file new in this enrichment. */
  files: Record<string, BaselineRecord | null>;
}

export interface Receipt {
  corpusManifestSha256: string;
  enrichmentDigest: string;
  checkedAt: string;
  result: "pass";
}

export interface ConflictEntry {
  claim: string;
  sources: string[];
  default: string;
  reason: string;
  scope: string[];
}

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

// ─── Old sections intact ────────────────────────────────────────────────────

export function oldSectionsIntact(path: string, current: Buffer, base: BaselineRecord | null): string[] {
  if (base === null) return [];
  if (current.length < base.bytes) return [`${path}: shorter than its baseline (${current.length} < ${base.bytes} bytes) — a pre-existing section was removed`];
  if (sha256(current.subarray(0, base.bytes)) !== base.sha256) return [`${path}: pre-existing bytes changed since the baseline — add an Addendum instead of editing`];
  return [];
}

/** The text appended after the baseline bytes (the whole file when it is new). */
export function tailOf(current: Buffer, base: BaselineRecord | null): string {
  return current.subarray(base?.bytes ?? 0).toString("utf8");
}

// ─── Block structure + attribution ──────────────────────────────────────────

interface Block {
  heading: string;
  body: string;
}

/** Split markdown into the text before the first `## ` heading and the `## ` blocks, ignoring fenced code. */
export function splitBlocks(md: string): { preamble: string; blocks: Block[] } {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  const pre: string[] = [];
  let fence = false;
  let cur: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && line.startsWith("## ")) {
      if (cur) blocks.push({ heading: cur.heading, body: cur.body.join("\n") });
      cur = { heading: line.slice(3).trim(), body: [] };
      continue;
    }
    (cur ? cur.body : pre).push(line);
  }
  if (cur) blocks.push({ heading: cur.heading, body: cur.body.join("\n") });
  return { preamble: pre.join("\n"), blocks };
}

const ADDENDUM_RE = /^Addendum \((\d{4}-\d{2}-\d{2})\) — \S/;
const NEW_FILE_PREAMBLE_LINE = /^(# .+|Platform: (telegram-mini-app|ios|android|all)|---|)$/;

/** Ids on a `Source:` line. */
export function sourceIds(line: string): string[] {
  return line
    .replace(/^Source:\s*/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function citationErrors(where: string, ids: string[], verdicts: SourceVerdicts, allowFirstParty: boolean): string[] {
  const errs: string[] = [];
  for (const id of ids) {
    if (allowFirstParty && id === FIRST_PARTY_SOURCE) continue;
    const v = verdicts.get(id);
    if (v === undefined) errs.push(`${where}: source ${id} is not in the catalog`);
    else if (!CITABLE.has(v)) errs.push(`${where}: source ${id} is ${v} — it may not feed shipped guidance`);
  }
  return errs;
}

/** Strip a SKILL.md frontmatter so its `---` lines are not read as content. */
function withoutFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/**
 * Structure of the appended part of one file. An existing file's tail holds only
 * Addendum blocks and at most one trailing Source conflicts block; a new file may
 * also open with a title, a `Platform:` tag and a `When this applies` section.
 */
export function checkTail(path: string, tail: string, isNew: boolean, verdicts: SourceVerdicts): string[] {
  const errs: string[] = [];
  const { preamble, blocks } = splitBlocks(isNew ? withoutFrontmatter(tail) : tail);
  const stray = preamble.split("\n").filter((l) => !(isNew ? NEW_FILE_PREAMBLE_LINE : /^(---|\s*)$/).test(l.trim()));
  if (stray.length) errs.push(`${path}: text before the first Addendum is not attributed (${JSON.stringify(stray[0].slice(0, 60))})`);
  let addenda = 0;
  let conflicts = 0;
  blocks.forEach((b, i) => {
    if (b.heading === "When this applies" && isNew && addenda === 0 && conflicts === 0) return;
    if (b.heading === "Source conflicts") {
      conflicts++;
      if (conflicts > 1) errs.push(`${path}: more than one Source conflicts block`);
      else if (i !== blocks.length - 1) errs.push(`${path}: Source conflicts must be the last block`);
      errs.push(...parseConflicts(b.body.trim(), verdicts).errors.map((e) => `${path}: Source conflicts: ${e}`));
      return;
    }
    if (!ADDENDUM_RE.test(b.heading)) {
      errs.push(`${path}: "${b.heading}" is not an Addendum — new content goes in a dated "## Addendum (YYYY-MM-DD) — title" block`);
      return;
    }
    addenda++;
    const first = b.body.split("\n").find((l) => l.trim() !== "") ?? "";
    if (!/^Source: \S/.test(first)) {
      errs.push(`${path}: Addendum "${b.heading}" has no Source line`);
      return;
    }
    errs.push(...citationErrors(`${path}: "${b.heading}"`, sourceIds(first), verdicts, true));
  });
  if (addenda === 0) errs.push(`${path}: no Addendum block — an enriched file must carry attributed guidance`);
  return errs;
}

// ─── Conflict ledger ────────────────────────────────────────────────────────

export const NO_CONFLICTS = "None between the sources used here.";
const FIELDS = [
  ["claim", "- **Claim:**"],
  ["sources", "  **Sources:**"],
  ["default", "  **Default:**"],
  ["reason", "  **Reason:**"],
  ["scope", "  **Platform scope:**"],
] as const;

/** Parse a Source conflicts block body. Fixed shape: five fields per entry, in order, none empty. */
export function parseConflicts(body: string, verdicts: SourceVerdicts): { entries: ConflictEntry[]; errors: string[] } {
  if (body.trim() === NO_CONFLICTS) return { entries: [], errors: [] };
  const errors: string[] = [];
  const entries: ConflictEntry[] = [];
  const lines = body.split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return { entries, errors: [`empty block — write "${NO_CONFLICTS}" when there is none`] };
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith(FIELDS[0][1])) {
      errors.push(`unexpected line ${JSON.stringify(lines[i].slice(0, 60))}`);
      i++;
      continue;
    }
    const raw: Record<string, string> = {};
    for (const [key, prefix] of FIELDS) {
      const line = lines[i] ?? "";
      if (!line.startsWith(prefix)) {
        errors.push(`entry ${entries.length + 1}: expected ${prefix.trim()} here`);
        break;
      }
      raw[key] = line.slice(prefix.length).trim();
      if (!raw[key]) errors.push(`entry ${entries.length + 1}: ${prefix.replace(/[-*:]/g, "").trim()} is empty`);
      i++;
    }
    if (Object.keys(raw).length < FIELDS.length) {
      while (i < lines.length && !lines[i].startsWith(FIELDS[0][1])) i++;
      continue;
    }
    const sources = raw.sources.split(",").map((s) => s.trim()).filter(Boolean);
    const scope = raw.scope.split(",").map((s) => s.trim()).filter(Boolean);
    if (sources.length < 2) errors.push(`entry ${entries.length + 1}: a conflict needs at least two sources`);
    errors.push(...citationErrors(`entry ${entries.length + 1}`, sources, verdicts, false));
    for (const s of scope) if (!SCOPES.has(s)) errors.push(`entry ${entries.length + 1}: unknown platform ${s}`);
    entries.push({ claim: raw.claim, sources, default: raw.default, reason: raw.reason, scope });
  }
  return { entries, errors };
}

// ─── Copy check ─────────────────────────────────────────────────────────────

/** Lowercased words of plain text, markdown markers dropped. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Sentences of a markdown block: split at sentence ends, list items and blank lines. */
export function sentences(md: string): string[] {
  return md
    .replace(/[*_`#>|]/g, " ")
    .split(/(?<=[.!?])\s+|\n\s*\n|\n\s*(?:[-+]|\d+\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => words(s).length > 0);
}

/**
 * Runs of consecutive sentences in `text` that are verbatim in a corpus text. A
 * sentence is verbatim when ≥80% of its words sit inside 8-word shingles that
 * also occur in the corpus; a run of COPY_RUN_SENTENCES or more is a copy.
 */
export function verbatimRuns(text: string, corpus: { id: string; text: string }[]): { sentences: number; source: string; excerpt: string }[] {
  const index = new Map<string, string>();
  for (const c of corpus) {
    const w = words(c.text);
    for (let i = 0; i + SHINGLE_WORDS <= w.length; i++) {
      const k = w.slice(i, i + SHINGLE_WORDS).join(" ");
      if (!index.has(k)) index.set(k, c.id);
    }
  }
  const sents = sentences(text);
  const flat: { s: number; w: string }[] = sents.flatMap((s, si) => words(s).map((w) => ({ s: si, w })));
  const covered = new Array<boolean>(flat.length).fill(false);
  const sourceOf = new Array<string | undefined>(sents.length);
  for (let i = 0; i + SHINGLE_WORDS <= flat.length; i++) {
    const id = index.get(flat.slice(i, i + SHINGLE_WORDS).map((x) => x.w).join(" "));
    if (id === undefined) continue;
    for (let j = i; j < i + SHINGLE_WORDS; j++) {
      covered[j] = true;
      sourceOf[flat[j].s] ??= id;
    }
  }
  const verbatim = sents.map((_, si) => {
    const idx = flat.map((x, i) => (x.s === si ? i : -1)).filter((i) => i >= 0);
    return idx.filter((i) => covered[i]).length / idx.length >= VERBATIM_COVERAGE;
  });
  const runs: { sentences: number; source: string; excerpt: string }[] = [];
  for (let i = 0; i < sents.length; ) {
    if (!verbatim[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < sents.length && verbatim[j]) j++;
    if (j - i >= COPY_RUN_SENTENCES) runs.push({ sentences: j - i, source: sourceOf[i] ?? "?", excerpt: sents.slice(i, j).join(" ").slice(0, 160) });
    i = j;
  }
  return runs;
}

/** Cited sources the copy check cannot certify against: no corpus text, or a thin one (fail closed). */
export function uncheckableCitations(ids: string[], manifest: CorpusItem[]): string[] {
  const byId = new Map(manifest.map((m) => [m.id, m]));
  return ids
    .filter((id) => id !== FIRST_PARTY_SOURCE)
    .flatMap((id) => {
      const m = byId.get(id);
      if (!m) return [`${id}: cited but has no corpus text — the copy check cannot compare against it`];
      if (m.thin) return [`${id}: cited but its corpus text is thin (${m.bytes} bytes) — capture it before citing`];
      return [];
    });
}

/** Digest over the scoped files' current bytes: what a copy-check receipt certifies. */
export function enrichmentDigest(files: { path: string; text: string }[]): string {
  return sha256([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\0${sha256(f.text)}\n`).join(""));
}

export function receiptErrors(receipt: Receipt | null, manifestSha: string, files: { path: string; text: string }[]): string[] {
  if (!receipt) return ["no copy-check receipt — run `bun scripts/uiux-enrichment.ts copy-check` with the corpus"];
  const errs: string[] = [];
  if (receipt.result !== "pass") errs.push("copy-check receipt does not record a pass");
  if (receipt.corpusManifestSha256 !== manifestSha) errs.push("copy-check receipt was made against a different corpus manifest — re-run copy-check");
  if (receipt.enrichmentDigest !== enrichmentDigest(files)) errs.push("copy-check receipt is stale: an enriched file changed after the check — re-run copy-check");
  return errs;
}

// ─── Injection lint ─────────────────────────────────────────────────────────

export interface InjectionFinding {
  path: string;
  line: number;
  rule: "invisible-unicode" | "html-comment" | "pipe-to-shell" | "ignore-instructions";
  excerpt: string;
}

// Zero-width and bidi controls, soft hyphen, word joiners, BOM, and Unicode tag characters.
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u;
const PIPE_TO_SHELL = /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/;
const IGNORE_INSTRUCTIONS = /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+|your\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules|messages)\b/i;
/** The catalog's fixed provenance header: allowed only as a whole first line. */
const METADATA_HEADER = /^<!-- (canonical-source: [^<>]+|council-selection-engine v\d+) -->$/;

/** Blank out fenced code and inline code spans (same length, same line breaks): visible code is not hidden text. */
function maskCode(md: string): string {
  const fenced = md.replace(/^(\s*)(```|~~~)[\s\S]*?^\s*\2/gm, (m) => m.replace(/[^\n]/g, " "));
  return fenced.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

export function injectionFindings(path: string, md: string): InjectionFinding[] {
  const out: InjectionFinding[] = [];
  const raw = md.split("\n");
  const masked = maskCode(md).split("\n");
  raw.forEach((line, i) => {
    const add = (rule: InjectionFinding["rule"]) => out.push({ path, line: i + 1, rule, excerpt: line.trim().slice(0, 120) });
    if (INVISIBLE.test(line)) add("invisible-unicode");
    if (masked[i].includes("<!--") && !(i === 0 && METADATA_HEADER.test(line.trim()))) add("html-comment");
    if (PIPE_TO_SHELL.test(line)) add("pipe-to-shell");
    if (IGNORE_INSTRUCTIONS.test(line)) add("ignore-instructions");
  });
  return out;
}

export interface InjectionBaselineEntry {
  path: string;
  rule: InjectionFinding["rule"];
  excerpt: string;
  reason: string;
}

/** Findings not covered by the documented baseline, plus baseline entries that no longer match (stale). */
export function unbaselinedFindings(findings: InjectionFinding[], baseline: InjectionBaselineEntry[]): string[] {
  const key = (f: { path: string; rule: string; excerpt: string }) => `${f.path}\0${f.rule}\0${f.excerpt}`;
  const allowed = new Set(baseline.map(key));
  const seen = new Set(findings.map(key));
  return [
    ...findings.filter((f) => !allowed.has(key(f))).map((f) => `${f.path}:${f.line}: ${f.rule}: ${f.excerpt}`),
    ...baseline.filter((b) => !seen.has(key(b))).map((b) => `injection baseline entry no longer matches (remove it): ${b.path} ${b.rule}`),
  ];
}

// ─── Description lint ───────────────────────────────────────────────────────

/** `description:` from SKILL.md frontmatter: single-line, quoted, or a folded/literal block. */
export function frontmatterDescription(skillMd: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return null;
  const first = lines[i].replace(/^description:\s*/, "");
  if (/^[>|][+-]?$/.test(first) || first === "") {
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) body.push(lines[j].trim());
    return body.join(" ");
  }
  return first.replace(/^(['"])(.*)\1$/, "$2");
}

function bigrams(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2).join(" "));
  return out;
}

export function descriptionFindings(skills: { name: string; description: string }[]): string[] {
  const errs: string[] = [];
  const total = skills.reduce((n, s) => n + Buffer.byteLength(s.description, "utf8"), 0);
  if (total > DESCRIPTION_CAP_BYTES) errs.push(`total description bytes ${total} > cap ${DESCRIPTION_CAP_BYTES} — every exposed skill's description is listed in every session`);
  const grams = skills.map((s) => bigrams(s.description));
  for (let a = 0; a < skills.length; a++) {
    for (let b = a + 1; b < skills.length; b++) {
      const inter = [...grams[a]].filter((g) => grams[b].has(g)).length;
      const union = grams[a].size + grams[b].size - inter;
      const j = union ? inter / union : 0;
      if (j >= NEAR_DUPLICATE_JACCARD) errs.push(`${skills[a].name} and ${skills[b].name}: near-duplicate descriptions (bigram Jaccard ${j.toFixed(2)}) — they compete for the same trigger`);
    }
  }
  return errs;
}

// ─── Platform coverage (Task 13 CI gate) ────────────────────────────────────

export function platformCoverage(files: { path: string; text: string }[]): string[] {
  const missing: string[] = [];
  for (const owner of PLATFORM_OWNERS) {
    const tags = new Set(
      files.filter((f) => f.path.startsWith(`${owner}/`)).map((f) => /^Platform: (\S+)$/m.exec(f.text)?.[1]).filter(Boolean),
    );
    for (const p of PLATFORMS) if (!tags.has(p)) missing.push(`${owner.replace(/\/references$/, "")}: no section tagged Platform: ${p}`);
  }
  return missing;
}

// ─── Effect shell ───────────────────────────────────────────────────────────

export function loadEnrichment(path = ENRICHMENT_FILE): EnrichmentDoc {
  return JSON.parse(readFileSync(path, "utf8")) as EnrichmentDoc;
}

function catalogVerdicts(): SourceVerdicts {
  return new Map(loadCatalogEntries().map((e) => [e.id, e.verdict]));
}

function scopedFiles(doc: EnrichmentDoc): { path: string; text: string; buf: Buffer }[] {
  return Object.keys(doc.files).map((p) => {
    const buf = readFileSync(join(REPO_ROOT, p));
    return { path: p, text: buf.toString("utf8"), buf };
  });
}

/** Every shipped `.md` file, from the committed manifest (what users actually receive). */
function shippedMarkdown(): { path: string; text: string }[] {
  const m = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as { entries: { name: string; ship: { status: string }; files: Record<string, string> }[] };
  return m.entries
    .filter((e) => e.ship.status === "ship")
    .flatMap((e) => Object.keys(e.files).filter((f) => f.endsWith(".md")).map((f) => `${e.name}/${f}`))
    .map((p) => ({ path: p, text: readFileSync(join(COUNCIL_SKILLS_DIR, p), "utf8") }));
}

function shippedDescriptions(): { name: string; description: string }[] {
  return shippedMarkdown()
    .filter((f) => /^[^/]+\/SKILL\.md$/.test(f.path))
    .map((f) => ({ name: f.path.split("/")[0], description: frontmatterDescription(f.text) ?? "" }));
}

function readReceipt(): Receipt | null {
  return existsSync(RECEIPT_FILE) ? (JSON.parse(readFileSync(RECEIPT_FILE, "utf8")) as Receipt) : null;
}

/** Every check that needs no corpus and no network. Empty = the committed tree passes. */
export function runHermeticChecks(): string[] {
  const doc = loadEnrichment();
  const verdicts = catalogVerdicts();
  const files = scopedFiles(doc);
  const manifest = loadCorpusManifest();
  const errs: string[] = [];
  for (const f of files) {
    const base = doc.files[f.path];
    errs.push(...oldSectionsIntact(f.path, f.buf, base));
    const tail = tailOf(f.buf, base);
    errs.push(...checkTail(f.path, tail, base === null, verdicts));
    const cited = splitBlocks(tail).blocks.flatMap((b) => (ADDENDUM_RE.test(b.heading) ? sourceIds(b.body.trim().split("\n")[0]) : []));
    errs.push(...uncheckableCitations(cited, manifest).map((e) => `${f.path}: ${e}`));
  }
  errs.push(...receiptErrors(readReceipt(), sha256(readFileSync(CORPUS_MANIFEST_FILE)), files));
  const baseline = existsSync(INJECTION_BASELINE_FILE) ? (JSON.parse(readFileSync(INJECTION_BASELINE_FILE, "utf8")) as { entries: InjectionBaselineEntry[] }).entries : [];
  errs.push(...unbaselinedFindings(shippedMarkdown().flatMap((f) => injectionFindings(f.path, f.text)), baseline));
  errs.push(...descriptionFindings(shippedDescriptions()));
  const packFiles = files
    .filter((f) => f.path.startsWith("packs/skills/"))
    .map((f) => ({ path: relative(COUNCIL_SKILLS_DIR, join(REPO_ROOT, f.path)), text: f.text }));
  errs.push(...platformCoverage(packFiles));
  return errs;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Copy check against the local corpus; writes the receipt only when every new block passes. */
function runCopyCheck(): number {
  const manifest = loadCorpusManifest();
  const ids = existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4)) : [];
  const corpusErrs = verifyCorpus(manifest, loadCatalogEntries(), (id) => (existsSync(corpusTextPath(id)) ? readFileSync(corpusTextPath(id), "utf8") : null), ids);
  if (corpusErrs.length) {
    console.error(`copy-check: the local corpus is missing or does not match the manifest — run \`bun scripts/uiux-sources.ts corpus\`:\n${corpusErrs.join("\n")}`);
    return 1;
  }
  const corpus = checkableCorpus(manifest).map((m) => ({ id: m.id, text: readFileSync(corpusTextPath(m.id), "utf8") }));
  const doc = loadEnrichment();
  const files = scopedFiles(doc);
  const errs: string[] = [];
  let checked = 0;
  for (const f of files) {
    for (const b of splitBlocks(tailOf(f.buf, doc.files[f.path])).blocks) {
      checked += sentences(b.body).length;
      for (const r of verbatimRuns(b.body, corpus)) errs.push(`${f.path}: "${b.heading}": ${r.sentences} sentences verbatim from ${r.source}: ${r.excerpt}`);
    }
  }
  if (errs.length) {
    console.error(`copy-check: FAIL — paraphrase these passages:\n${errs.join("\n")}`);
    return 1;
  }
  const receipt: Receipt = {
    corpusManifestSha256: sha256(readFileSync(CORPUS_MANIFEST_FILE)),
    enrichmentDigest: enrichmentDigest(files),
    checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    result: "pass",
  };
  writeAtomic(RECEIPT_FILE, JSON.stringify(receipt, null, 2) + "\n");
  console.log(`copy-check: OK — ${checked} sentences in ${files.length} files, none in a ${COPY_RUN_SENTENCES}-sentence verbatim run against ${corpus.length} corpus texts; receipt written`);
  return 0;
}

/** `baseline <commit> [path...]`: pin pre-existing bytes from a commit; paths default to the current scope. */
function runBaseline(args: string[]): number {
  const [commit, ...paths] = args;
  if (!commit) {
    console.error("usage: baseline <commit> [repo-relative path...]");
    return 2;
  }
  const full = execFileSync("git", ["rev-parse", `${commit}^{commit}`], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const scope = paths.length ? paths : Object.keys(loadEnrichment().files);
  const files: Record<string, BaselineRecord | null> = {};
  for (const p of [...scope].sort()) {
    let buf: Buffer | null = null;
    try {
      buf = execFileSync("git", ["show", `${full}:${p}`], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      buf = null;
    }
    files[p] = buf === null ? null : { bytes: buf.length, sha256: sha256(buf) };
  }
  const doc: EnrichmentDoc = {
    _doc: "Phase C enrichment scope (PLAN Task 12). Each file keeps its pre-existing bytes (length + sha256 at baselineCommit, a commit on main); null = new file. Regenerate with `bun scripts/uiux-enrichment.ts baseline <commit> [paths]`.",
    baselineCommit: full,
    files,
  };
  writeAtomic(ENRICHMENT_FILE, JSON.stringify(doc, null, 2) + "\n");
  console.log(`enrichment: ${Object.keys(files).length} files pinned at ${full.slice(0, 12)}`);
  return 0;
}

if (import.meta.main) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "check") {
    const errs = runHermeticChecks();
    if (errs.length) console.error(errs.join("\n"));
    else console.log("uiux enrichment: OK");
    process.exit(errs.length ? 1 : 0);
  } else if (cmd === "copy-check") process.exit(runCopyCheck());
  else if (cmd === "baseline") process.exit(runBaseline(rest));
  else {
    console.error("usage: bun scripts/uiux-enrichment.ts check|copy-check|baseline <commit> [paths]");
    process.exit(2);
  }
}
