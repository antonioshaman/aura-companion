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
// hermetically in CI without network access. seed.json also carries two blocks of
// judgement: `scope.tasteOnlySkills` (shipped skills deliberately given no source)
// and `conflicts` (the source-conflict ledger: claim, sources, default, reason,
// platform scope).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { COUNCIL_CATALOG_DIR, COUNCIL_SKILLS_DIR } from "./capability-catalog.js";
import { COPYLEFT_PREFIXES, PARAPHRASE_OK_LICENCES, SLUG_RE } from "./licences.js";

export const UIUX_SOURCES_DIR = resolve(import.meta.dirname, "..", "..", "docs", "research", "uiux-sources");
export const SEED_FILE = join(UIUX_SOURCES_DIR, "seed.json");
export const CATALOG_FILE = join(UIUX_SOURCES_DIR, "catalog.json");
export const CATALOG_MD_FILE = join(UIUX_SOURCES_DIR, "CATALOG.md");
/**
 * Source-text corpus (PLAN Task 2): the texts the verbatim-copy check compares
 * enrichment against. The texts are third-party and mostly NOT redistributable,
 * and this repo is public, so the directory is gitignored and lives outside
 * `web/` (never in the npm package). Only the manifest (url, pinned ref, sha256)
 * is committed. `verify-corpus` proves a local corpus is the one the manifest
 * describes; `corpus` rebuilds it from the manifest's pinned refs (README at a
 * commit — reproducible) and refuses to re-pin unless `--refresh`. Web pages have
 * no ref and are live: a rebuild reports them as drifted instead of re-pinning.
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
  "ai-interaction-patterns",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const MIN_INCLUDED_SOURCES = 30;
/** AC1.4: more than 18 months without activity → excluded (unless canonical). */
export const STALE_AFTER_MONTHS = 18;
/** Community-adoption floor: a non-canonical repo with fewer stars is excluded
 *  (owner decision 2026-10-27 — do not fold in projects the community has not backed). */
export const MIN_STARS = 500;

/** Licences that allow paraphrase with attribution (re-exported for existing callers). */
export const PERMISSIVE_LICENCES = PARAPHRASE_OK_LICENCES;

const ID_RE = SLUG_RE;
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
  /** Corpus text location when the README is not the substance (docs page). https only. */
  textUrl?: string;
  takeaway: string;
  receivers: string[];
}

/** One row of the source-conflict ledger (spec AC3.4, PLAN Task 11 shape). */
export interface SourceConflict {
  claim: string;
  sources: string[];
  default: string;
  reason: string;
  scope: string;
}

export interface SeedDoc {
  _doc?: string;
  scope: { tasteOnlySkills: Record<string, string> };
  conflicts: SourceConflict[];
  sources: SeedSource[];
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
  textUrl: string | null;
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
  if (s.textUrl !== undefined && !/^https:\/\//.test(s.textUrl)) errs.push(`${where}: textUrl must be https`);
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
    textUrl: seed.textUrl ?? null,
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

/** The API answered for a different repository (renamed/moved): stop, fix the seed. */
export function assertSameRepo(requested: string, fullName: string): void {
  if (requested.toLowerCase() !== fullName.toLowerCase()) {
    throw new Error(`repo ${requested} has moved to ${fullName} — update seed.json`);
  }
}

/**
 * Catalog-level gate (AC1.1–AC1.4) over the committed catalog. Returns errors;
 * empty means the catalog satisfies Story 1. Every verdict is re-derived against
 * its own `fetchedAt`, so a hand-edited verdict in catalog.json is caught, and
 * every judgement field must equal the seed's, so catalog.json cannot drift from
 * seed.json.
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
    const expected = buildEntry(seed, e, e.fetchedAt, new Date(e.fetchedAt));
    for (const field of ["title", "category", "link", "canonical", "textUrl", "takeaway", "receivers"] as const) {
      if (JSON.stringify(e[field] ?? null) !== JSON.stringify(expected[field] ?? null)) errs.push(`${e.id}: ${field} differs from seed`);
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

/** Every receiver must name a real agent setting (`known` is built from the repo tree). */
export function checkReceivers(seeds: SeedSource[], known: ReadonlySet<string>): string[] {
  return seeds.flatMap((s) => s.receivers.filter((r) => !known.has(r)).map((r) => `${s.id}: unknown receiver ${r}`));
}

/** Shipped UI/UX skills that no source feeds and that are not declared taste-only (AC3.1 scope). */
export function uncoveredSkills(shipped: string[], seeds: SeedSource[], tasteOnly: string[]): string[] {
  const fed = new Set(seeds.flatMap((s) => s.receivers).filter((r) => r.startsWith("skill:")).map((r) => r.slice(6)));
  return shipped.filter((k) => !fed.has(k) && !tasteOnly.includes(k));
}

/** The source-conflict ledger: fixed shape, sources must be catalogued ids. */
export function validateConflicts(conflicts: SourceConflict[], seeds: SeedSource[]): string[] {
  const ids = new Set(seeds.map((s) => s.id));
  const errs: string[] = [];
  conflicts.forEach((c, i) => {
    const where = `conflict #${i + 1} (${c.claim || "?"})`;
    for (const f of ["claim", "default", "reason", "scope"] as const) if (!c[f]?.trim()) errs.push(`${where}: missing ${f}`);
    if (!Array.isArray(c.sources) || c.sources.length < 2) errs.push(`${where}: needs at least two sources`);
    for (const id of c.sources ?? []) if (!ids.has(id)) errs.push(`${where}: unknown source ${id}`);
  });
  return errs;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  redistributable: "redistributable (paraphrase + attribute)",
  "ask-first": "ask first (copyleft) — reference only until approved",
  "reference-only": "reference only",
  excluded: "excluded",
};

/** Render the human-readable view. Generated — never hand-edit CATALOG.md. */
export function renderMarkdown(entries: CatalogEntry[], doc: Pick<SeedDoc, "scope" | "conflicts"> = { scope: { tasteOnlySkills: {} }, conflicts: [] }): string {
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
  if (doc.conflicts.length) {
    lines.push("## Source conflicts", "", "| Claim | Sources | Default | Reason | Scope |", "|---|---|---|---|---|");
    for (const c of doc.conflicts) lines.push(`| ${c.claim} | ${c.sources.join(", ")} | ${c.default} | ${c.reason} | ${c.scope} |`);
    lines.push("");
  }
  const taste = Object.entries(doc.scope.tasteOnlySkills);
  if (taste.length) {
    lines.push("## Shipped skills with no source (taste-only, by decision)", "");
    for (const [k, why] of taste) lines.push(`- \`${k}\` — ${why}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Corpus (Task 2) ─────────────────────────────────────────────────────────

export interface CorpusItem {
  id: string;
  /** Where the text was fetched from (README API for repos, a docs/standard page otherwise). */
  textUrl: string;
  /** Commit the README was read at (repo sources); null for live web pages. */
  ref?: string | null;
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
export function corpusTextUrl(e: Pick<CatalogEntry, "link" | "verdict"> & { textUrl?: string | null }): string | null {
  if (e.verdict === "excluded") return null;
  if (e.textUrl) return e.textUrl;
  const gh = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(e.link);
  return gh ? `https://api.github.com/repos/${gh[1]}/readme` : e.link;
}

/** A README read at a pinned commit, so the same bytes can be fetched again later. */
export function readmeAtRef(readmeUrl: string, ref: string): string {
  return `${readmeUrl}?ref=${encodeURIComponent(ref)}`;
}

/** Request headers. The GitHub token goes ONLY to api.github.com, never to a docs host. */
export function fetchHeaders(url: string, token = process.env.GITHUB_TOKEN): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "aura-uiux-sources" };
  if (new URL(url).hostname === "api.github.com") {
    headers.Accept = url.endsWith("/readme") || url.includes("/readme?") ? "application/vnd.github.raw+json" : "application/vnd.github+json";
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
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

export function corpusItem(id: string, textUrl: string, text: string, fetchedAt: string, ref: string | null = null): CorpusItem {
  const bytes = Buffer.byteLength(text, "utf8");
  return { id, textUrl, ref, sha256: sha256(text), bytes, fetchedAt, thin: bytes < THIN_TEXT_BYTES };
}

/**
 * The items a copy check may certify against. Thin texts are UNCHECKABLE, not
 * clean: a "no copy found" against a 15-byte JS shell proves nothing (finding #8).
 */
export function checkableCorpus(manifest: CorpusItem[]): CorpusItem[] {
  return manifest.filter((m) => !m.thin);
}

/**
 * Prove a local corpus matches the committed manifest. Errors on a missing text,
 * a hash mismatch (drift or tampering), an included catalog source with no corpus
 * item, or a text on disk the manifest does not list (orphan). Empty result = the
 * copy check may trust this corpus (minus its thin items).
 */
export function verifyCorpus(
  manifest: CorpusItem[],
  entries: (Pick<CatalogEntry, "id" | "link" | "verdict"> & { textUrl?: string | null })[],
  readText: (id: string) => string | null,
  onDisk: string[] = [],
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
  for (const id of onDisk) if (!byId.has(id)) errs.push(`${id}: corpus text not in manifest (orphan)`);
  return errs;
}

export function corpusTextPath(id: string, dir = CORPUS_DIR): string {
  if (!ID_RE.test(id)) throw new Error(`bad corpus id ${JSON.stringify(id)}`);
  return join(dir, `${id}.txt`);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: fetchHeaders(url), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.text();
  return new URL(url).hostname === "api.github.com" ? body : htmlToText(body);
}

/** HEAD commit of a repo's default branch, for pinning its README. */
async function headSha(readmeUrl: string): Promise<string> {
  const repo = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/readme$/.exec(readmeUrl)?.[1];
  if (!repo) throw new Error(`not a README API url: ${readmeUrl}`);
  const url = `https://api.github.com/repos/${repo}/commits/HEAD`;
  const res = await fetch(url, { headers: fetchHeaders(url), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return ((await res.json()) as { sha: string }).sha;
}

function isReadmeApi(url: string): boolean {
  return /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/readme$/.test(url);
}

function stamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** tmp + rename: a crash mid-write never leaves a torn generated file. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function listCorpusIds(dir = CORPUS_DIR): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4)) : [];
}

/**
 * Build the corpus into a staging dir and swap it in only when every fetch
 * succeeded, so a single network failure never damages the verified corpus
 * (finding #7). Without `--refresh` an existing manifest is REBUILT from its
 * pinned refs and every hash must match; with `--refresh` sources are re-read at
 * today's HEAD and the manifest is re-pinned.
 */
async function runCorpus(refresh: boolean): Promise<number> {
  const entries = loadCatalogEntries();
  const prior = existsSync(CORPUS_MANIFEST_FILE) ? loadCorpusManifest() : null;
  const rebuild = prior !== null && !refresh;
  const staging = `${CORPUS_DIR}.staging-${process.pid}`;
  mkdirSync(staging, { recursive: true });
  const items: CorpusItem[] = [];
  const drift: string[] = [];
  try {
    for (const e of entries) {
      const base = corpusTextUrl(e);
      if (base === null) continue;
      const pinned = rebuild ? prior.find((m) => m.id === e.id) : undefined;
      if (rebuild && !pinned) {
        drift.push(`${e.id}: not in the manifest (run with --refresh to add it)`);
        continue;
      }
      const ref = isReadmeApi(base) ? (pinned?.ref ?? (await headSha(base))) : null;
      const url = ref ? readmeAtRef(base, ref) : base;
      const text = await fetchText(url);
      writeFileSync(corpusTextPath(e.id, staging), text);
      const item = corpusItem(e.id, base, text, pinned?.fetchedAt ?? stamp(), ref);
      if (pinned && item.sha256 !== pinned.sha256) {
        drift.push(`${e.id}: ${ref ? "README at the pinned commit" : "live page"} no longer matches the manifest`);
      }
      items.push(item);
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    console.error(`uiux corpus: aborted, existing corpus untouched — ${(err as Error).message}`);
    return 1;
  }
  if (drift.length) {
    rmSync(staging, { recursive: true, force: true });
    console.error(`uiux corpus: rebuild does not reproduce the manifest; existing corpus untouched (use --refresh to re-pin):\n${drift.join("\n")}`);
    return 1;
  }
  const old = `${CORPUS_DIR}.old-${process.pid}`;
  if (existsSync(CORPUS_DIR)) renameSync(CORPUS_DIR, old);
  renameSync(staging, CORPUS_DIR);
  rmSync(old, { recursive: true, force: true });
  if (!rebuild) {
    writeAtomic(
      CORPUS_MANIFEST_FILE,
      JSON.stringify({ _doc: "GENERATED by scripts/uiux-sources.ts corpus --refresh — texts live in corpus/ (gitignored, never shipped). README texts are pinned to `ref`; web pages are live.", items }, null, 2) + "\n",
    );
  }
  const thin = items.filter((i) => i.thin).map((i) => i.id);
  console.log(`uiux corpus: ${items.length} texts ${rebuild ? "rebuilt from the manifest" : "re-pinned"}${thin.length ? `; UNCHECKABLE (thin): ${thin.join(", ")}` : ""}`);
  return 0;
}

export function loadCorpusManifest(path = CORPUS_MANIFEST_FILE): CorpusItem[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { items: CorpusItem[] }).items;
}

function runVerifyCorpus(): number {
  const manifest = loadCorpusManifest();
  const errs = verifyCorpus(manifest, loadCatalogEntries(), (id) => {
    const p = corpusTextPath(id);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }, listCorpusIds());
  if (errs.length) {
    console.error(errs.join("\n"));
    return 1;
  }
  const thin = manifest.filter((m) => m.thin).map((m) => m.id);
  console.log(`uiux corpus: matches manifest${thin.length ? `; uncheckable (thin): ${thin.join(", ")}` : ""}`);
  return 0;
}

// ─── Effect shell ───────────────────────────────────────────────────────────

export function loadSeedDoc(path = SEED_FILE): SeedDoc {
  return JSON.parse(readFileSync(path, "utf8")) as SeedDoc;
}

export function loadSeeds(path = SEED_FILE): SeedSource[] {
  return loadSeedDoc(path).sources;
}

export function loadCatalogEntries(path = CATALOG_FILE): CatalogEntry[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { entries: CatalogEntry[] }).entries;
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

function dirsIn(path: string): string[] {
  return existsSync(path)
    ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name)
    : [];
}

/** Agent settings a source may feed: real skills, real experts, and the two declared check surfaces. */
export function knownReceivers(): Set<string> {
  return new Set([
    ...dirsIn(COUNCIL_SKILLS_DIR).map((d) => `skill:${d}`),
    ...dirsIn(join(REPO_ROOT, ".agents", "skills")).map((d) => `skill:${d}`),
    ...dirsIn(COUNCIL_CATALOG_DIR).map((d) => `expert:${d}`),
    "aura-check",
    "council-review:a11y-scan",
  ]);
}

/** The shipped UI/UX skills: the impeccable set (skills-lock.json) + the vendored skills. */
export function shippedUiuxSkills(): string[] {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, "skills-lock.json"), "utf8")) as { skills: Record<string, { source: string }> };
  const vendored = JSON.parse(readFileSync(join(COUNCIL_SKILLS_DIR, "vendor-lock.json"), "utf8")) as { skills: { name: string }[] };
  return [
    ...Object.entries(lock.skills).filter(([, v]) => v.source === "pbakaus/impeccable").map(([k]) => k),
    ...vendored.skills.map((v) => v.name),
  ].sort();
}

/** Every seed-level gate that needs no network: shape, receivers, conflicts, AC3.1 scope. */
export function checkSeedDoc(doc: SeedDoc): string[] {
  return [
    ...doc.sources.flatMap(validateSeed),
    ...checkReceivers(doc.sources, knownReceivers()),
    ...validateConflicts(doc.conflicts, doc.sources),
    ...uncoveredSkills(shippedUiuxSkills(), doc.sources, Object.keys(doc.scope.tasteOnlySkills)).map(
      (k) => `shipped skill ${k} has no source and is not declared taste-only`,
    ),
  ];
}

async function fetchRepoFacts(repo: string): Promise<RepoFacts> {
  const url = `https://api.github.com/repos/${repo}`;
  const res = await fetch(url, { headers: fetchHeaders(url), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}`);
  const body = (await res.json()) as { full_name?: string };
  assertSameRepo(repo, body.full_name ?? "");
  return factsFromGithub(body);
}

/** Fetch facts and regenerate the catalog. Writes NOTHING unless every gate passes. */
async function runFetch(): Promise<number> {
  const doc = loadSeedDoc();
  const seeds = doc.sources;
  const seedErrs = checkSeedDoc(doc);
  if (seedErrs.length) {
    console.error(seedErrs.join("\n"));
    return 1;
  }
  const entries: CatalogEntry[] = [];
  for (const s of seeds) {
    const fetchedAt = stamp();
    // Web-only canonical sources have no fetchable facts: null licence → reference only.
    const facts = s.repo ? await fetchRepoFacts(s.repo) : { licence: null, lastActivity: null, archived: false, stars: null };
    entries.push(buildEntry(s, facts, fetchedAt, new Date(fetchedAt)));
  }
  const errs = checkCatalog(entries, seeds);
  if (errs.length) {
    console.error(`uiux catalog: not written —\n${errs.join("\n")}`);
    return 1;
  }
  writeAtomic(CATALOG_FILE, JSON.stringify({ _doc: "GENERATED by scripts/uiux-sources.ts fetch — do not edit.", entries }, null, 2) + "\n");
  writeAtomic(CATALOG_MD_FILE, renderMarkdown(entries, doc));
  console.log(`uiux catalog: ${entries.length} sources written`);
  return 0;
}

function runCheck(): number {
  const doc = loadSeedDoc();
  const errs = [...checkSeedDoc(doc), ...checkCatalog(loadCatalogEntries(), doc.sources)];
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
  else if (cmd === "corpus") process.exit(await runCorpus(process.argv.includes("--refresh")));
  else if (cmd === "verify-corpus") process.exit(runVerifyCorpus());
  else {
    console.error("usage: bun scripts/uiux-sources.ts fetch|check|corpus [--refresh]|verify-corpus");
    process.exit(2);
  }
}
