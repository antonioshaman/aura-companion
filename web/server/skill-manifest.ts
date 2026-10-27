// Shipped skill manifest + ownership marker (spec `uiux-agent-enrichment.md`
// AC2.2–AC2.4, PLAN Task 5 — ritchie B1 "prove before you delete").
//
// `packs/skills/skills-manifest.json` lists every skill (and the Council catalog)
// Aura ships: name, source, licence verdict, Claude/Codex flag, ship gate and a
// sha256 per file. `web/scripts/skill-manifest.ts` generates and checks it.
//
// Ownership: wherever Aura places a copy of a pack entry, it writes OWNER_MARKER_FILE
// at the copy's root, recording the exact bytes it wrote. A copy belongs to Aura only
// while its marker parses AND the copy still holds exactly those bytes; anything else
// — no marker, a broken marker, an edited / added / removed file, a symlink — belongs
// to the user and is never overwritten or deleted. The marker carries its own hashes
// (not a reference to the current manifest) so a copy written by an older Aura
// version can still be proven untouched and upgraded.
//
// Names: a pack entry name must be a lowercase slug (or the one catalog dir), and
// names are compared case-insensitively, after NFC, because macOS and Windows home
// dirs are case-insensitive: `Polish/` and `polish/` are the same skill there.
//
// Pure core + one small reader. This module ships with the server (B2 consumes it);
// it must not import from `web/scripts/`, which is not in the npm package.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const SKILL_MANIFEST_SCHEMA_VERSION = 1;
export const OWNER_MARKER_SCHEMA_VERSION = 1;
/** Written by Aura at the root of every copy it places; never part of a pack entry. */
export const OWNER_MARKER_FILE = ".aura-owned.json";
/** The Council experts catalog dir: the one pack entry whose name is not a slug. */
export const CATALOG_NAME = "_council-experts";
/** Skill names: lowercase slug, safe as one path segment. Same shape as scripts/licences.ts SLUG_RE. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** Generated cache dirs a tree read does not hash; reported to the caller, never silent. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set(["__pycache__", "node_modules"]);

export interface ManifestEntry {
  /** Directory name under packs/skills — what Claude Code invokes. */
  name: string;
  /** `name:` from SKILL.md frontmatter when it differs from the dir (Codex reads it); null otherwise. */
  frontmatterName: string | null;
  kind: "skill" | "catalog";
  source:
    | { type: "first-party"; repo: string }
    | { type: "vendored"; repo: string; path: string; commit: string };
  licence: { spdx: string; verdict: "shippable" | "not-shippable" };
  /** Whether the skill works under each CLI. `note` is required when either is false. */
  compat: { claude: boolean; codex: boolean; note?: string };
  /** Phase B gate: `blocked` entries never ship; `reasons` says why (AC2.4). */
  ship: { status: "ship" | "blocked"; reasons: string[] };
  /** filesDigest(files). */
  digest: string;
  /** Relative path → sha256 of every file in the entry. */
  files: Record<string, string>;
}

export interface SkillManifest {
  _doc: string;
  schemaVersion: typeof SKILL_MANIFEST_SCHEMA_VERSION;
  entries: ManifestEntry[];
}

export interface OwnerMarker {
  schemaVersion: typeof OWNER_MARKER_SCHEMA_VERSION;
  name: string;
  digest: string;
  files: Record<string, string>;
}

export type Ownership =
  | { owner: "aura"; current: boolean; inManifest: boolean }
  | { owner: "user"; reason: string };

// ─── Hashing ────────────────────────────────────────────────────────────────

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** One digest over a whole path → sha256 map (order-independent). */
export function filesDigest(files: Record<string, string>): string {
  const lines = Object.keys(files).sort().map((p) => `${p}\0${files[p]}\n`);
  return sha256(lines.join(""));
}

export function hashTree(files: Map<string, Buffer>): Record<string, string> {
  return Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, b]) => [p, sha256(b)]));
}

// ─── Names and collisions ───────────────────────────────────────────────────

/** The key two names collide on: NFC + lowercase (case-insensitive home dirs). */
export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export function isPackName(name: string): boolean {
  return name === CATALOG_NAME || SKILL_NAME_RE.test(name);
}

/** Every name that fails the allowlist, plus every case-insensitive duplicate. */
export function packNameErrors(names: string[]): string[] {
  const errs: string[] = [];
  const seen = new Map<string, string>();
  for (const n of names) {
    if (!isPackName(n)) errs.push(`${JSON.stringify(n)} is not an allowed pack name (lowercase slug)`);
    const prev = seen.get(nameKey(n));
    if (prev !== undefined) errs.push(`${JSON.stringify(n)} collides with ${JSON.stringify(prev)} (case-insensitive)`);
    else seen.set(nameKey(n), n);
  }
  return errs;
}

/** Names an entry can be invoked by: its dir and, if different, its frontmatter name. */
export function invocationNames(e: Pick<ManifestEntry, "name" | "frontmatterName">): string[] {
  return e.frontmatterName && e.frontmatterName !== e.name ? [e.name, e.frontmatterName] : [e.name];
}

/**
 * Pack entries that clash with names already present (e.g. the user's
 * `~/.claude/skills` dirs). The user's entry always wins; the caller skips the pack one.
 */
export function nameCollisions(
  entries: Pick<ManifestEntry, "name" | "frontmatterName">[],
  existing: string[],
): { entry: string; existing: string }[] {
  const byKey = new Map(existing.map((n) => [nameKey(n), n]));
  const out: { entry: string; existing: string }[] = [];
  for (const e of entries) {
    for (const n of invocationNames(e)) {
      const hit = byKey.get(nameKey(n));
      if (hit !== undefined) {
        out.push({ entry: e.name, existing: hit });
        break;
      }
    }
  }
  return out;
}

// ─── Ownership marker ───────────────────────────────────────────────────────

export function markerFor(entry: Pick<ManifestEntry, "name" | "digest" | "files">): OwnerMarker {
  return { schemaVersion: OWNER_MARKER_SCHEMA_VERSION, name: entry.name, digest: entry.digest, files: { ...entry.files } };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Strict parse of a marker file. Anything unexpected → null (= not proven Aura's). */
export function parseMarker(raw: string): OwnerMarker | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  if (m.schemaVersion !== OWNER_MARKER_SCHEMA_VERSION) return null;
  if (typeof m.name !== "string" || !isPackName(m.name)) return null;
  if (typeof m.digest !== "string" || !HEX64.test(m.digest)) return null;
  if (!m.files || typeof m.files !== "object" || Array.isArray(m.files)) return null;
  const files = m.files as Record<string, unknown>;
  for (const [p, h] of Object.entries(files)) {
    if (typeof h !== "string" || !HEX64.test(h) || p === OWNER_MARKER_FILE) return null;
  }
  return { schemaVersion: OWNER_MARKER_SCHEMA_VERSION, name: m.name, digest: m.digest, files: files as Record<string, string> };
}

/**
 * Who owns the copy in directory `dirName`, given its files (marker included, as read)
 * and the current manifest. `aura` only when the bytes are exactly what the marker
 * says Aura wrote; `current` when that is also this manifest's version of the entry.
 */
export function ownership(dirName: string, files: Map<string, Buffer>, manifest: Pick<SkillManifest, "entries">): Ownership {
  const raw = files.get(OWNER_MARKER_FILE);
  if (!raw) return { owner: "user", reason: "no ownership marker" };
  const marker = parseMarker(raw.toString("utf8"));
  if (!marker) return { owner: "user", reason: "ownership marker is unreadable" };
  if (marker.name !== dirName) return { owner: "user", reason: `marker names ${marker.name}, not ${dirName}` };
  if (filesDigest(marker.files) !== marker.digest) return { owner: "user", reason: "marker digest does not match its own file list" };
  for (const [p, h] of Object.entries(marker.files)) {
    const buf = files.get(p);
    if (!buf) return { owner: "user", reason: `${p} was removed since Aura wrote this copy` };
    if (sha256(buf) !== h) return { owner: "user", reason: `${p} was modified since Aura wrote this copy` };
  }
  for (const p of files.keys()) {
    if (p !== OWNER_MARKER_FILE && !(p in marker.files)) return { owner: "user", reason: `${p} was added since Aura wrote this copy` };
  }
  const entry = manifest.entries.find((e) => e.name === dirName);
  return { owner: "aura", inManifest: !!entry, current: entry?.digest === marker.digest };
}

// ─── Reader ─────────────────────────────────────────────────────────────────

/**
 * Read a tree into relative-path → bytes. Refuses symlinks, including a symlinked
 * root (a link could point anywhere). Generated cache dirs are not read; their
 * paths are pushed to `skipped` so a caller can report them rather than hide them.
 */
export function readTree(root: string, skipped: string[] = []): Map<string, Buffer> {
  if (lstatSync(root).isSymbolicLink()) throw new Error(`skill root is a symlink: ${root}`);
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error(`symlink in skill tree: ${relative(root, abs)}`);
      if (st.isDirectory()) {
        if (SKIPPED_DIRS.has(name)) {
          skipped.push(relative(root, abs).split(sep).join("/"));
          continue;
        }
        walk(abs);
      } else if (st.isFile()) out.set(relative(root, abs).split(sep).join("/"), readFileSync(abs));
    }
  };
  walk(root);
  return out;
}

/**
 * Ownership of an on-disk copy. Any read failure (symlink, permissions) → the user's.
 * A skipped cache dir also → the user's: readTree does not look inside it, so its
 * contents (user files, links) are unproven, and deleting the copy would take them too.
 */
export function readOwnership(dir: string, dirName: string, manifest: Pick<SkillManifest, "entries">): Ownership {
  let files: Map<string, Buffer>;
  const skipped: string[] = [];
  try {
    files = readTree(dir, skipped);
  } catch (err) {
    return { owner: "user", reason: `cannot prove ownership: ${(err as Error).message}` };
  }
  if (skipped.length) return { owner: "user", reason: `cannot prove ownership: unread dir ${skipped[0]}` };
  return ownership(dirName, files, manifest);
}
