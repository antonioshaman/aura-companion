#!/usr/bin/env bun
// RC-2 capability-profile catalog loader + validator (PLAN Task 4).
//
// The catalog (`~/.claude/skills/_council-experts/`) is a SECOND trust root,
// distinct from the workspace the fingerprinter scans (ritchie B-7). It gets its
// own realpath/bounds/symlink discipline anchored on the catalog root — the
// workspace-anchored marker-fs.resolveMarker does NOT protect these reads.
//
// Fail-loud, and — critically — distinguish two failure classes that a naive
// try/catch would collapse (ritchie B-3, dahl #6, AC2.2):
//   - ABSENT capabilities (no `capabilities:` key) → a KNOWN not-yet-migrated
//     state; the advisor is simply not seatable ("no capabilities ⇒ never
//     seated"). This is `skipped`, NOT an error.
//   - MALFORMED capabilities (bad shape, non-string member, unknown/typo'd
//     token) → a LOUD structured `error` the verifier must red on. A silent
//     drop here would deseat a valid advisor invisibly.
//
// YAML is parsed with the already-present `yaml` dep (dahl #5) — synchronous,
// no new dependency, no hand-rolled parser. Scalar-coercion is guarded: a bare
// `no`/`on`/`1.0` list member coerces to boolean/number and is rejected as
// malformed rather than silently never-matching (ritchie B-8).

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import { readText } from "./marker-fs";

// Security canary (spec / catalog convention): advisor IDs are creator surnames.
export const ADVISOR_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

const META_CAP = 16 * 1024;
const VOCAB_CAP = 64 * 1024;

export interface Vocabulary {
  signals: Set<string>;
  domains: Set<string>;
  /** The `frameworks` signal group only — used to classify a signal as a framework
   *  (for stack-mismatch detection in the brief builder, PLAN Task 7). */
  frameworks: Set<string>;
}

export interface AdvisorProfile {
  id: string;
  signals: string[];
  domains: string[];
}

export type ProfileReason =
  | "bad-id"
  | "no-meta"
  | "out_of_bounds"
  | "symlink"
  | "read_error"
  | "yaml_parse"
  | "absent-capabilities"
  | "malformed"
  | "unknown-token";

export type ProfileLoad =
  | { ok: true; profile: AdvisorProfile }
  | { ok: false; id: string; reason: ProfileReason; detail?: string };

export interface CatalogLoad {
  /** Valid, seatable profiles (sorted by id). */
  profiles: AdvisorProfile[];
  /** Not-yet-migrated / no-meta dirs — deliberate, not an error. */
  skipped: { id: string; reason: ProfileReason }[];
  /** Malformed/unknown-token/traversal — LOUD; the verifier fails on any. */
  errors: { id: string; reason: ProfileReason; detail?: string }[];
}

/** Resolve the vocabulary from `<catalogRoot>/.verify/capability-vocabulary.json`. */
export function loadVocabulary(catalogRootResolved: string): Vocabulary | null {
  const abs = join(catalogRootResolved, ".verify", "capability-vocabulary.json");
  if (!existsSync(abs)) return null;
  const read = readText(abs, VOCAB_CAP);
  if (!read.ok) return null;
  let v: unknown;
  try {
    v = JSON.parse(read.text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const sigGroups = obj["signals"];
  const domains = obj["domains"];
  const signals = new Set<string>();
  const frameworks = new Set<string>();
  if (sigGroups && typeof sigGroups === "object") {
    for (const [group, grp] of Object.entries(sigGroups as Record<string, unknown>)) {
      if (Array.isArray(grp)) {
        for (const t of grp) {
          if (typeof t === "string") {
            signals.add(t.toLowerCase());
            if (group === "frameworks") frameworks.add(t.toLowerCase());
          }
        }
      }
    }
  }
  const domSet = new Set<string>();
  if (Array.isArray(domains)) for (const t of domains) if (typeof t === "string") domSet.add(t.toLowerCase());
  if (signals.size === 0 || domSet.size === 0) return null;
  return { signals, domains: domSet, frameworks };
}

// Catalog-root-anchored path resolution (the EC-7 equivalent for the 2nd root).
function resolveInCatalog(catalogRootResolved: string, id: string): { ok: true; abs: string } | { ok: false; reason: ProfileReason } {
  if (!ADVISOR_ID_RE.test(id)) return { ok: false, reason: "bad-id" };
  const abs = join(catalogRootResolved, id, "meta.yaml");
  if (!existsSync(abs)) return { ok: false, reason: "no-meta" };
  let lst;
  try {
    lst = lstatSync(abs);
  } catch {
    return { ok: false, reason: "read_error" };
  }
  if (lst.isSymbolicLink()) return { ok: false, reason: "symlink" };
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return { ok: false, reason: "read_error" };
  }
  if (real !== abs && !real.startsWith(catalogRootResolved + sep)) {
    return { ok: false, reason: "out_of_bounds" };
  }
  return { ok: true, abs };
}

// Validate a raw capabilities list into a lowercase string[] against the vocab.
// Rejects non-string members (YAML coercion guard) and unknown tokens.
function validateTokens(
  raw: unknown,
  vocab: Set<string>,
): { ok: true; tokens: string[] } | { ok: false; reason: ProfileReason; detail: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "malformed", detail: "expected a non-empty list" };
  }
  const tokens: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") {
      return { ok: false, reason: "malformed", detail: `non-string member ${JSON.stringify(t)} (YAML coercion?)` };
    }
    const lower = t.toLowerCase();
    if (!vocab.has(lower)) {
      return { ok: false, reason: "unknown-token", detail: `token not in vocabulary: ${t}` };
    }
    tokens.push(lower);
  }
  return { ok: true, tokens };
}

/** Load + validate ONE advisor's capability profile. */
export function loadAdvisorProfile(catalogRootResolved: string, id: string, vocab: Vocabulary): ProfileLoad {
  const r = resolveInCatalog(catalogRootResolved, id);
  if (!r.ok) return { ok: false, id, reason: r.reason };
  const read = readText(r.abs, META_CAP);
  if (!read.ok) return { ok: false, id, reason: read.reason === "read_error" ? "read_error" : "malformed", detail: read.reason };
  let doc: unknown;
  try {
    doc = parseYaml(read.text);
  } catch {
    return { ok: false, id, reason: "yaml_parse" };
  }
  if (!doc || typeof doc !== "object") return { ok: false, id, reason: "malformed", detail: "meta.yaml is not a mapping" };
  const obj = doc as Record<string, unknown>;
  // Distinguish a genuinely MISSING key (not-yet-migrated → benign skip) from a
  // key that is PRESENT but empty/null (a migration started and left broken →
  // loud malformed). Collapsing the two would let a half-migrated advisor silently
  // drop out of every roster with no verifier red (dahl #13 / AC2.2).
  if (!("capabilities" in obj) || obj["capabilities"] === undefined) {
    return { ok: false, id, reason: "absent-capabilities" };
  }
  const caps = obj["capabilities"];
  if (caps === null) {
    return { ok: false, id, reason: "malformed", detail: "capabilities present but empty" };
  }
  if (typeof caps !== "object" || Array.isArray(caps)) {
    return { ok: false, id, reason: "malformed", detail: "capabilities must be a mapping" };
  }
  const capsObj = caps as Record<string, unknown>;
  const sig = validateTokens(capsObj["signals"], vocab.signals);
  if (!sig.ok) return { ok: false, id, reason: sig.reason, detail: `signals: ${sig.detail}` };
  const dom = validateTokens(capsObj["domains"], vocab.domains);
  if (!dom.ok) return { ok: false, id, reason: dom.reason, detail: `domains: ${dom.detail}` };
  return { ok: true, profile: { id, signals: sig.tokens, domains: dom.tokens } };
}

/**
 * Load the whole catalog. Enumerates depth-1 dirs of the catalog root, loads
 * each advisor profile, and partitions results into seatable / skipped / errors.
 * Deterministic: dirs sorted, profiles sorted by id.
 */
export function loadCatalog(catalogRoot: string, vocab?: Vocabulary): CatalogLoad {
  let root: string;
  try {
    root = realpathSync(catalogRoot);
  } catch {
    return { profiles: [], skipped: [], errors: [{ id: "<catalog-root>", reason: "read_error" }] };
  }
  const v = vocab ?? loadVocabulary(root);
  if (!v) {
    return { profiles: [], skipped: [], errors: [{ id: "<vocabulary>", reason: "malformed", detail: "capability-vocabulary.json missing or invalid" }] };
  }
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      // Include symlinked entries, NOT just `isDirectory()` (ritchie #1). A
      // Dirent for a symlink-to-dir reports isDirectory()===false, so pre-filtering
      // on it would DROP a symlinked advisor dir (e.g. a stow/chezmoi-managed
      // `hunt/`) before resolveInCatalog runs — an entire reviewer vanishing with no
      // error/skip record, the one forbidden silent-absence on the trust root that
      // decides who reviews code. Route every non-hidden dir-or-symlink through
      // resolveInCatalog instead, so a symlinked dir surfaces as a loud `symlink`/
      // `out_of_bounds` error (or is admitted if it resolves inside the catalog root).
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
      .map((e) => e.name)
      .sort();
  } catch {
    return { profiles: [], skipped: [], errors: [{ id: "<catalog-root>", reason: "read_error" }] };
  }
  const out: CatalogLoad = { profiles: [], skipped: [], errors: [] };
  for (const id of entries) {
    const load = loadAdvisorProfile(root, id, v);
    if (load.ok) {
      out.profiles.push(load.profile);
    } else if (load.reason === "absent-capabilities" || load.reason === "no-meta") {
      out.skipped.push({ id: load.id, reason: load.reason });
    } else {
      out.errors.push({ id: load.id, reason: load.reason, detail: load.detail });
    }
  }
  // Code-point sort (NOT localeCompare — ICU collation is runtime-dependent, dahl #4).
  out.profiles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
