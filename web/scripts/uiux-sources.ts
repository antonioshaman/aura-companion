#!/usr/bin/env bun
// UI/UX source catalog (spec `uiux-agent-enrichment.md` Story 1, PLAN Task 1).
//
// Two halves, deliberately kept apart (willison R3 — never trust facts from model
// text):
//   - `seed.json` is hand/model-authored JUDGEMENT only: which source, category,
//     what we take from it, which agent setting receives it.
//   - licence, last-activity date and archived state are FACTS: `fetch` reads them
//     (and star count) from the GitHub API, stamps `fetchedAt`, and writes `catalog.json` + a
//     rendered `CATALOG.md`. A web-only source has no machine-readable licence, so
//     it is always reference only (fail-closed) and must be a canonical standard.
//
// The verdict rules (`classifySource`) and the catalog-level AC1.1 gate
// (`checkCatalog`) are pure, so the committed catalog.json is re-validated
// hermetically in CI without network access.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const UIUX_SOURCES_DIR = resolve(import.meta.dirname, "..", "..", "docs", "research", "uiux-sources");
export const SEED_FILE = join(UIUX_SOURCES_DIR, "seed.json");
export const CATALOG_FILE = join(UIUX_SOURCES_DIR, "catalog.json");
export const CATALOG_MD_FILE = join(UIUX_SOURCES_DIR, "CATALOG.md");
/**
 * Source-text corpus (PLAN Task 2): the texts the verbatim-copy check compares
 * enrichment against. The texts are third-party and mostly NOT redistributable,
 * and this repo is public, so the directory is gitignored and lives outside
 * `web/` (never in the npm package). Only the manifest (url + sha256) is
 * committed, so anyone can rebuild the exact corpus and prove it unchanged.
 */
export const CORPUS_DIR = join(UIUX_SOURCES_DIR, "corpus");
export const CORPUS_MANIFEST_FILE = join(UIUX_SOURCES_DIR, "corpus-manifest.json");
/** Below this many bytes a fetched text is too thin to compare against (JS-rendered page). */
export const THIN_TEXT_BYTES = 2_000;

/** The 8 categories AC1.1 requires, in display order. */
export const CATEGORIES = [
  "heuristics-evaluation",
  "accessibility-standards-testing",
  "automated-ui-checking",
  "design-systems-tokens",
  "ux-writing",
  "visual-regression",
  "platform-guidelines",
  "llm-agent-skill-packs",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const MIN_INCLUDED_SOURCES = 30;
/** AC1.4: more than 18 months without activity → excluded (unless canonical). */
export const STALE_AFTER_MONTHS = 18;
/** Community-adoption floor: a non-canonical repo with fewer stars is excluded
 *  (owner decision 2026-10-27 — do not fold in projects the community has not backed). */
export const MIN_STARS = 500;

/** Licences whose terms allow redistribution with attribution. SPDX ids. */
export const PERMISSIVE_LICENCES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
]);
/** Copyleft (strong or weak): the spec's "ask first" boundary. Prefix match. */
const COPYLEFT_PREFIXES = ["GPL-", "LGPL-", "AGPL-", "MPL-", "EPL-", "CC-BY-SA-", "EUPL-", "OSL-"];

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface SeedSource {
  id: string;
  category: Category;
  title: string;
  /** GitHub `owner/name` — the source of licence + activity facts. */
  repo?: string;
  /** Web-only source (no repo). Only allowed for canonical standards. */
  url?: string;
  /** Name of the canonical standard, when this source is one (AC1.4 exemption). */
  canonical?: string;
  takeaway: string;
  receivers: string[];
}

export interface RepoFacts {
  licence: string | null;
  lastActivity: string | null;
  archived: boolean;
  /** GitHub stargazers count; null for a web-only source. */
  stars: number | null;
}

export type Verdict = "redistributable" | "ask-first" | "reference-only" | "excluded";

export interface CatalogEntry {
  id: string;
  category: Category;
  title: string;
  link: string;
  canonical: string | null;
  /** SPDX id from the GitHub API, or null when none/unknown (web source, NOASSERTION, no licence). */
  licence: string | null;
  licenceSource: "github-api" | "none";
  lastActivity: string | null;
  archived: boolean;
  stars: number | null;
  fetchedAt: string;
  takeaway: string;
  receivers: string[];
  verdict: Verdict;
  verdictReason: string;
}

// ─── Pure core ──────────────────────────────────────────────────────────────

/** Validate one seed record's shape. Returns error strings (empty = valid). */
export function validateSeed(s: SeedSource): string[] {
  const errs: string[] = [];
  const where = `seed ${JSON.stringify(s.id)}`;
  if (typeof s.id !== "string" || !ID_RE.test(s.id)) errs.push(`${where}: bad id`);
  if (!(CATEGORIES as readonly string[]).includes(s.category)) errs.push(`${where}: unknown category ${s.category}`);
  if (!s.title?.trim()) errs.push(`${where}: missing title`);
  if (!s.takeaway?.trim()) errs.push(`${where}: missing takeaway`);
  if (!Array.isArray(s.receivers) || s.receivers.length === 0) errs.push(`${where}: no receivers`);
  if (s.repo !== undefined && s.url !== undefined) errs.push(`${where}: has both repo and url`);
  if (s.repo === undefined && s.url === undefined) errs.push(`${where}: needs repo or url`);
  if (s.repo !== undefined && !REPO_RE.test(s.repo)) errs.push(`${where}: bad repo ${s.repo}`);
  if (s.url !== undefined && !/^https:\/\//.test(s.url)) errs.push(`${where}: url must be https`);
  // A web-only page has no licence or activity facts we can fetch, so it may only
  // enter as a canonical standard (which is exempt from the activity rule).
  if (s.url !== undefined && !s.canonical) errs.push(`${where}: web-only source must be canonical`);
  return errs;
}

function monthsBetween(fromIso: string, to: Date): number {
  const from = new Date(fromIso);
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) -
    (to.getUTCDate() < from.getUTCDate() ? 1 : 0);
}

/**
 * Decide a source's verdict from fetched facts. Fail-closed: anything not
 * positively permissive is at best reference only.
 */
export function classifySource(
  seed: Pick<SeedSource, "canonical">,
  facts: RepoFacts,
  now: Date,
): { verdict: Verdict; reason: string } {
  const canonical = Boolean(seed.canonical);
  if (!canonical) {
    if (facts.archived) return { verdict: "excluded", reason: "repository archived" };
    if (facts.lastActivity === null) return { verdict: "excluded", reason: "no activity date" };
    const months = monthsBetween(facts.lastActivity, now);
    if (months > STALE_AFTER_MONTHS) {
      return { verdict: "excluded", reason: `no activity for ${months} months (> ${STALE_AFTER_MONTHS})` };
    }
    if (facts.stars === null || facts.stars < MIN_STARS) {
      return { verdict: "excluded", reason: `${facts.stars ?? 0} stars (< ${MIN_STARS}) — low community adoption` };
    }
  }
  const prefix = canonical ? "canonical standard; " : "";
  const lic = facts.licence;
  if (lic === null) return { verdict: "reference-only", reason: `${prefix}no machine-readable licence` };
  if (PERMISSIVE_LICENCES.has(lic)) {
    return { verdict: "redistributable", reason: `${prefix}permissive licence ${lic}` };
  }
  if (COPYLEFT_PREFIXES.some((p) => lic.startsWith(p))) {
    return { verdict: "ask-first", reason: `${prefix}copyleft licence ${lic} — owner approval needed before shipping` };
  }
  return { verdict: "reference-only", reason: `${prefix}licence ${lic} not on the permissive allowlist` };
}

export function buildEntry(seed: SeedSource, facts: RepoFacts, fetchedAt: string, now: Date): CatalogEntry {
  const { verdict, reason } = classifySource(seed, facts, now);
  return {
    id: seed.id,
    category: seed.category,
    title: seed.title,
    link: seed.repo ? `https://github.com/${seed.repo}` : (seed.url as string),
    canonical: seed.canonical ?? null,
    licence: facts.licence,
    licenceSource: seed.repo ? "github-api" : "none",
    lastActivity: facts.lastActivity,
    archived: facts.archived,
    stars: facts.stars,
    fetchedAt,
    takeaway: seed.takeaway,
    receivers: seed.receivers,
    verdict,
    verdictReason: reason,
  };
}

/** Normalise a GitHub `GET /repos/{repo}` body into facts. NOASSERTION/other → null. */
export function factsFromGithub(body: unknown): RepoFacts {
  const b = body as {
    license?: { spdx_id?: string | null } | null;
    pushed_at?: string | null;
    archived?: boolean;
    stargazers_count?: number;
  };
  const spdx = b?.license?.spdx_id ?? null;
  return {
    licence: spdx && spdx !== "NOASSERTION" ? spdx : null,
    lastActivity: typeof b?.pushed_at === "string" ? b.pushed_at.slice(0, 10) : null,
    archived: b?.archived === true,
    stars: typeof b?.stargazers_count === "number" ? b.stargazers_count : null,
  };
}

/**
 * Catalog-level gate (AC1.1–AC1.4) over the committed catalog. Returns errors;
 * empty means the catalog satisfies Story 1. `now` re-derives every verdict so a
 * hand-edited verdict in catalog.json is caught.
 */
export function checkCatalog(entries: CatalogEntry[], seeds: SeedSource[]): string[] {
  const errs: string[] = [];
  const seedById = new Map(seeds.map((s) => [s.id, s]));
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) errs.push(`duplicate id ${e.id}`);
    ids.add(e.id);
    const seed = seedById.get(e.id);
    if (!seed) {
      errs.push(`${e.id}: in catalog but not in seed`);
      continue;
    }
    for (const field of ["link", "takeaway", "fetchedAt", "verdict", "verdictReason"] as const) {
      if (!e[field]) errs.push(`${e.id}: missing ${field}`);
    }
    if (!Array.isArray(e.receivers) || e.receivers.length === 0) errs.push(`${e.id}: missing receivers`);
    if (!e.canonical && e.lastActivity === null) errs.push(`${e.id}: missing last-activity date`);
    if (!e.canonical && e.stars === null) errs.push(`${e.id}: missing star count`);
    // Re-derive the verdict against the fetch moment: facts are frozen at fetchedAt.
    const again = classifySource(seed, e, new Date(e.fetchedAt));
    if (again.verdict !== e.verdict) errs.push(`${e.id}: verdict ${e.verdict} does not follow from its facts (${again.verdict})`);
  }
  for (const s of seeds) if (!ids.has(s.id)) errs.push(`${s.id}: in seed but not fetched into catalog`);
  const included = entries.filter((e) => e.verdict !== "excluded");
  if (included.length < MIN_INCLUDED_SOURCES) {
    errs.push(`only ${included.length} included sources (< ${MIN_INCLUDED_SOURCES})`);
  }
  const covered = new Set(included.map((e) => e.category));
  for (const c of CATEGORIES) if (!covered.has(c)) errs.push(`category ${c} has no included source`);
  return errs;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  redistributable: "redistributable (paraphrase + attribute)",
  "ask-first": "ask first (copyleft) — reference only until approved",
  "reference-only": "reference only",
  excluded: "excluded",
};

/** Render the human-readable view. Generated — never hand-edit CATALOG.md. */
export function renderMarkdown(entries: CatalogEntry[]): string {
  const included = entries.filter((e) => e.verdict !== "excluded");
  const lines = [
    "# UI/UX source catalog",
    "",
    "<!-- GENERATED by `bun scripts/uiux-sources.ts fetch` from seed.json + the GitHub API. Do not edit by hand. -->",
    "",
    `${included.length} included sources across ${new Set(included.map((e) => e.category)).size} categories ` +
      `(${entries.length - included.length} excluded). Licence, last activity and archived state come from the ` +
      "GitHub API at `fetchedAt`; a source with no machine-readable licence is reference only. " +
      `A non-canonical repo is excluded when archived, inactive for more than ${STALE_AFTER_MONTHS} months or below ` +
      `${MIN_STARS} stars. Canonical standards are exempt from both rules and are paraphrase-only.`,
    "",
  ];
  for (const c of CATEGORIES) {
    const rows = entries.filter((e) => e.category === c);
    if (rows.length === 0) continue;
    lines.push(`## ${c}`, "", "| Source | Licence | Last activity | Stars | Verdict | What we take | Receives it |", "|---|---|---|---|---|---|---|");
    for (const e of rows) {
      const name = e.canonical ? `[${e.title}](${e.link}) — *canonical: ${e.canonical}*` : `[${e.title}](${e.link})`;
      const verdict = `${VERDICT_LABEL[e.verdict]}${e.verdict === "redistributable" ? "" : ` — ${e.verdictReason}`}`;
      lines.push(
        `| ${name} | ${e.licence ?? "none / unknown"} | ${e.lastActivity ?? "n/a"} | ${e.stars ?? "n/a"} | ${verdict} | ${e.takeaway} | ${e.receivers.join(", ")} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Corpus (Task 2) ─────────────────────────────────────────────────────────

export interface CorpusItem {
  id: string;
  /** Where the text was fetched from (README API for repos, the page for web sources). */
  textUrl: string;
  sha256: string;
  bytes: number;
  fetchedAt: string;
  /** True when the text is too short to be a useful comparison base. */
  thin: boolean;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Where a source's comparison text comes from. Excluded sources get no text. */
export function corpusTextUrl(e: Pick<CatalogEntry, "link" | "verdict">): string | null {
  if (e.verdict === "excluded") return null;
  const gh = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(e.link);
  return gh ? `https://api.github.com/repos/${gh[1]}/readme` : e.link;
}

/** Crude, dependency-free HTML → text: drop script/style/markup, decode the common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/^ +| +$/gm, "")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export function corpusItem(id: string, textUrl: string, text: string, fetchedAt: string): CorpusItem {
  const bytes = Buffer.byteLength(text, "utf8");
  return { id, textUrl, sha256: sha256(text), bytes, fetchedAt, thin: bytes < THIN_TEXT_BYTES };
}

/**
 * Prove a local corpus matches the committed manifest. Errors on a missing text,
 * a hash mismatch (drift or tampering), or an included catalog source with no
 * corpus item. Empty result = the copy check may trust this corpus.
 */
export function verifyCorpus(
  manifest: CorpusItem[],
  entries: Pick<CatalogEntry, "id" | "link" | "verdict">[],
  readText: (id: string) => string | null,
): string[] {
  const errs: string[] = [];
  const byId = new Map(manifest.map((m) => [m.id, m]));
  for (const e of entries) {
    if (corpusTextUrl(e) !== null && !byId.has(e.id)) errs.push(`${e.id}: included source has no corpus item`);
  }
  for (const m of manifest) {
    const text = readText(m.id);
    if (text === null) errs.push(`${m.id}: corpus text missing (run \`corpus\`)`);
    else if (sha256(text) !== m.sha256) errs.push(`${m.id}: corpus text does not match manifest sha256`);
  }
  return errs;
}

export function corpusTextPath(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new Error(`bad corpus id ${JSON.stringify(id)}`);
  return join(CORPUS_DIR, `${id}.txt`);
}

async function fetchCorpusText(url: string): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": "aura-uiux-sources" };
  if (url.startsWith("https://api.github.com/")) {
    headers.Accept = "application/vnd.github.raw+json";
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.text();
  return url.startsWith("https://api.github.com/") ? body : htmlToText(body);
}

async function runCorpus(): Promise<number> {
  const entries = loadCatalogEntries();
  mkdirSync(CORPUS_DIR, { recursive: true });
  const items: CorpusItem[] = [];
  for (const e of entries) {
    const url = corpusTextUrl(e);
    if (url === null) continue;
    const text = await fetchCorpusText(url);
    writeFileSync(corpusTextPath(e.id), text);
    items.push(corpusItem(e.id, url, text, new Date().toISOString().replace(/\.\d{3}Z$/, "Z")));
  }
  writeFileSync(
    CORPUS_MANIFEST_FILE,
    JSON.stringify({ _doc: "GENERATED by scripts/uiux-sources.ts corpus — texts live in corpus/ (gitignored, never shipped).", items }, null, 2) + "\n",
  );
  const thin = items.filter((i) => i.thin).map((i) => i.id);
  console.log(`uiux corpus: ${items.length} texts${thin.length ? `; thin (JS-rendered?): ${thin.join(", ")}` : ""}`);
  return 0;
}

export function loadCorpusManifest(path = CORPUS_MANIFEST_FILE): CorpusItem[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { items: CorpusItem[] }).items;
}

function runVerifyCorpus(): number {
  const errs = verifyCorpus(loadCorpusManifest(), loadCatalogEntries(), (id) => {
    const p = corpusTextPath(id);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  });
  if (errs.length) {
    console.error(errs.join("\n"));
    return 1;
  }
  console.log("uiux corpus: matches manifest");
  return 0;
}

// ─── Effect shell ───────────────────────────────────────────────────────────

export function loadSeeds(path = SEED_FILE): SeedSource[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { sources: SeedSource[] }).sources;
}

export function loadCatalogEntries(path = CATALOG_FILE): CatalogEntry[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { entries: CatalogEntry[] }).entries;
}

async function fetchRepoFacts(repo: string): Promise<RepoFacts> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "aura-uiux-sources" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}`);
  return factsFromGithub(await res.json());
}

async function runFetch(): Promise<number> {
  const seeds = loadSeeds();
  const seedErrs = seeds.flatMap(validateSeed);
  if (seedErrs.length) {
    console.error(seedErrs.join("\n"));
    return 1;
  }
  const entries: CatalogEntry[] = [];
  for (const s of seeds) {
    const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    // Web-only canonical sources have no fetchable facts: null licence → reference only.
    const facts = s.repo ? await fetchRepoFacts(s.repo) : { licence: null, lastActivity: null, archived: false, stars: null };
    entries.push(buildEntry(s, facts, fetchedAt, new Date(fetchedAt)));
  }
  const errs = checkCatalog(entries, seeds);
  writeFileSync(CATALOG_FILE, JSON.stringify({ _doc: "GENERATED by scripts/uiux-sources.ts fetch — do not edit.", entries }, null, 2) + "\n");
  writeFileSync(CATALOG_MD_FILE, renderMarkdown(entries));
  console.log(`uiux catalog: ${entries.length} sources written`);
  if (errs.length) {
    console.error(errs.join("\n"));
    return 1;
  }
  return 0;
}

function runCheck(): number {
  const seeds = loadSeeds();
  const errs = [...seeds.flatMap(validateSeed), ...checkCatalog(loadCatalogEntries(), seeds)];
  if (errs.length) {
    console.error(errs.join("\n"));
    return 1;
  }
  console.log("uiux catalog: OK");
  return 0;
}

if (import.meta.main) {
  const [, , cmd] = process.argv;
  if (cmd === "fetch") process.exit(await runFetch());
  else if (cmd === "check") process.exit(runCheck());
  else if (cmd === "corpus") process.exit(await runCorpus());
  else if (cmd === "verify-corpus") process.exit(runVerifyCorpus());
  else {
    console.error("usage: bun scripts/uiux-sources.ts fetch|check|corpus|verify-corpus");
    process.exit(2);
  }
}
