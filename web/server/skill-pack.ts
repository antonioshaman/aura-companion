// Skill-pack module: the one owner of delivering Aura's shipped skills (spec
// `uiux-agent-enrichment.md` AC2.1 / AC2.3, PLAN Task 6 — fowler R1 "boundaries
// where change lives"; ritchie B1–B3, B6; hunt R2).
//
// Pure core: manifest + what already exists at a destination + the toggle → a plan,
// one outcome per manifest entry:
//   provide          ship gate passed, no clash with a user skill
//   skip-user-owns   a user skill already answers to this name (the user always wins)
//   blocked-by-gate  `ship.status === "blocked"`; `reasons` says why (AC2.4)
//   disabled         the toolkit is off
//
// Effect shell, two places it writes:
// 1. The Aura tree, `<COMPANION_HOME>/skill-pack/`. Never inside a user's skills dir.
//      versions/<id>/       one read-only tree per shipped set (dirs 0555, files 0444),
//                           plus the skills-manifest.json of exactly what it holds
//      current.json         the pointer: { version, previous }, replaced atomically
//      versions/.staging-*  a tree being built; its sibling `<dir>.json` intent (pid,
//                           startedAt) is written BEFORE the dir, so a sweep can prove
//                           a leftover is ours and its writer is gone (EC-8)
//      versions/.trash-*    a version being pruned; renamed first, then removed
//    Read-only is load-bearing: a skill script run from the tree cannot drop a
//    `__pycache__` into it, which would make the copy unprovable (B1 observer STOP).
// 2. Copies placed outside the Aura tree (Codex homes, the container) by syncCopies.
//    Each carries the ownership marker; a dir is replaced or removed only while
//    readOwnership() says `aura`, re-checked after it has been renamed out of the way.
//
// Wiring (boot sweep, spawn exposure, Codex homes, the container) is Phase B3; this
// module only provides the operations.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";

import { writeAtomicJson } from "./atomic-write.js";
import { log } from "./logger.js";
import { COMPANION_HOME } from "./paths.js";
import {
  filesDigest,
  frontmatterName,
  invocationNames,
  isPackName,
  markerFor,
  nameCollisions,
  OWNER_MARKER_FILE,
  readOwnership,
  readTree,
  sha256,
  SKILL_MANIFEST_SCHEMA_VERSION,
  type ManifestEntry,
  type Ownership,
  type SkillManifest,
} from "./skill-manifest.js";

export const DEFAULT_PACK_ROOT = join(COMPANION_HOME, "skill-pack");
export const PACK_POINTER_SCHEMA_VERSION = 1;
export const PACK_MANIFEST_FILE = "skills-manifest.json";
/** A staging intent older than this is stale even if its pid is (recycled and) alive. */
export const STALE_STAGING_MS = 60 * 60 * 1000;
const VERSION_RE = /^[0-9a-f]{16}$/;
const STAGING_PREFIX = ".staging-";
const TRASH_PREFIX = ".trash-";
const COPY_STAGING_PREFIX = ".aura-staging-";
const COPY_TRASH_PREFIX = ".aura-trash-";

// ─── Pure core ──────────────────────────────────────────────────────────────

export type PackOutcome = "provide" | "skip-user-owns" | "blocked-by-gate" | "disabled";

export interface PackPlanItem {
  name: string;
  outcome: PackOutcome;
  reasons: string[];
}

/** A skill dir already present at a destination, as far as planning needs to know it. */
export interface ExistingSkill {
  name: string;
  frontmatterName: string | null;
  ownership: Ownership;
}

export interface PlanInput {
  manifest: Pick<SkillManifest, "entries">;
  existing: ExistingSkill[];
  enabled: boolean;
}

/**
 * One outcome per manifest entry. Only user-owned dirs clash: an Aura-owned copy at
 * the destination is ours to upgrade or remove. A clash is checked on the dir name
 * AND the frontmatter name on both sides (Codex invokes by the frontmatter name).
 */
export function planPack({ manifest, existing, enabled }: PlanInput): PackPlanItem[] {
  const userNames = existing
    .filter((e) => e.ownership.owner === "user")
    .flatMap((e) => invocationNames(e));
  const clashes = new Map(nameCollisions(manifest.entries, userNames).map((c) => [c.entry, c.existing]));
  return manifest.entries.map((e): PackPlanItem => {
    if (!enabled) return { name: e.name, outcome: "disabled", reasons: ["the UI/UX toolkit is turned off"] };
    if (e.ship.status !== "ship") return { name: e.name, outcome: "blocked-by-gate", reasons: [...e.ship.reasons] };
    const hit = clashes.get(e.name);
    if (hit !== undefined) return { name: e.name, outcome: "skip-user-owns", reasons: [`the user's skill ${JSON.stringify(hit)} has this name`] };
    return { name: e.name, outcome: "provide", reasons: [] };
  });
}

/** The entries that pass the ship gate — the only ones an Aura tree may hold. */
export function shippedEntries(manifest: Pick<SkillManifest, "entries">): ManifestEntry[] {
  return manifest.entries.filter((e) => e.ship.status === "ship");
}

/** Content address of a shipped set: same names + digests → same version dir. */
export function packVersionId(entries: Pick<ManifestEntry, "name" | "digest">[]): string {
  const lines = entries.map((e) => `${e.name}\0${e.digest}\n`).sort();
  return sha256(lines.join("")).slice(0, 16);
}

/**
 * A manifest file path is one we may join under a root: relative, forward-slash,
 * no empty / `.` / `..` segment, no NUL or backslash, and never the marker file.
 */
export function isSafeRelPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  if (p === OWNER_MARKER_FILE) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Errors that make a manifest unsafe to materialise; empty = safe. */
export function manifestPathErrors(manifest: Pick<SkillManifest, "entries">): string[] {
  const errs: string[] = [];
  for (const e of manifest.entries) {
    if (!isPackName(e.name)) errs.push(`entry name ${JSON.stringify(e.name)} is not a pack name`);
    for (const p of Object.keys(e.files)) {
      if (!isSafeRelPath(p)) errs.push(`${e.name}: unsafe file path ${JSON.stringify(p)}`);
    }
    if (filesDigest(e.files) !== e.digest) errs.push(`${e.name}: digest does not match its file list`);
  }
  return errs;
}

/**
 * Does `files` (a whole tree read, relative path → bytes) hold exactly `manifest`:
 * its manifest file plus every entry dir with exactly the listed bytes, nothing else?
 */
export function treeMismatches(files: Map<string, Buffer>, manifest: Pick<SkillManifest, "entries">): string[] {
  const errs: string[] = [];
  const expected = new Map<string, string>();
  for (const e of manifest.entries) for (const [p, h] of Object.entries(e.files)) expected.set(`${e.name}/${p}`, h);
  for (const [p, h] of expected) {
    const buf = files.get(p);
    if (!buf) errs.push(`${p} is missing`);
    else if (sha256(buf) !== h) errs.push(`${p} does not match the manifest`);
  }
  for (const p of files.keys()) {
    if (p !== PACK_MANIFEST_FILE && !expected.has(p)) errs.push(`${p} is not in the manifest`);
  }
  return errs;
}

// ─── Strict parsers ─────────────────────────────────────────────────────────

export interface PackPointer {
  schemaVersion: typeof PACK_POINTER_SCHEMA_VERSION;
  version: string;
  previous: string | null;
}

export function parsePointer(raw: string): PackPointer | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  if (p.schemaVersion !== PACK_POINTER_SCHEMA_VERSION) return null;
  if (typeof p.version !== "string" || !VERSION_RE.test(p.version)) return null;
  if (p.previous !== null && (typeof p.previous !== "string" || !VERSION_RE.test(p.previous))) return null;
  return { schemaVersion: PACK_POINTER_SCHEMA_VERSION, version: p.version, previous: p.previous };
}

interface StagingIntent {
  pid: number;
  startedAt: number;
}

function parseIntent(raw: string): StagingIntent | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (Number.isInteger(v.pid) && (v.pid as number) > 0 && typeof v.startedAt === "number") {
      return { pid: v.pid as number, startedAt: v.startedAt };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ─── Filesystem helpers ─────────────────────────────────────────────────────

function rand(): string {
  return randomBytes(6).toString("hex");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A leftover staging dir may be swept only when its intent proves its writer is gone. */
function intentIsStale(intentPath: string, now: number): boolean {
  let intent: StagingIntent | null = null;
  try {
    intent = parseIntent(readFileSync(intentPath, "utf8"));
  } catch {
    return false;
  }
  if (!intent) return false;
  if (intent.pid === process.pid) return false;
  return !isAlive(intent.pid) || now - intent.startedAt > STALE_STAGING_MS;
}

/** `abs` resolves inside `root` (both realpath'd): no link or `..` escapes the root. */
function assertInside(root: string, abs: string): void {
  const r = realpathSync(root);
  const a = realpathSync(abs);
  if (a !== r && !a.startsWith(r + sep)) throw new Error(`path escapes ${root}: ${abs}`);
}

/** Make every dir under `dir` writable again (read-only trees cannot be removed as-is). Never follows links. */
function makeWritable(dir: string): void {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) makeWritable(join(dir, name));
}

function removeTree(dir: string): void {
  makeWritable(dir);
  rmSync(dir, { recursive: true, force: true });
}

/** Dirs read-only bottom-up (0555); files were written 0444. */
function makeReadOnly(dir: string): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (lstatSync(abs).isDirectory()) makeReadOnly(abs);
  }
  chmodSync(dir, 0o555);
}

function writeNewFile(path: string, data: Buffer | string, mode: number): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write one entry's manifest-listed files from `srcDir` into `destDir` (new or empty).
 * Each source file must be a regular file inside `srcDir` whose bytes match the
 * manifest — a drifted source fails the whole install (fail closed).
 */
function writeEntryFiles(srcDir: string, destDir: string, entry: ManifestEntry): void {
  mkdirSync(destDir, { recursive: true, mode: 0o755 });
  for (const rel of Object.keys(entry.files).sort()) {
    if (!isSafeRelPath(rel)) throw new Error(`${entry.name}: unsafe file path ${JSON.stringify(rel)}`);
    const src = join(srcDir, ...rel.split("/"));
    const st = lstatSync(src, { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new Error(`${entry.name}/${rel}: not a regular file in the source`);
    assertInside(srcDir, src);
    const buf = readFileSync(src);
    if (sha256(buf) !== entry.files[rel]) throw new Error(`${entry.name}/${rel}: source bytes do not match the manifest`);
    const dest = join(destDir, ...rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
    writeNewFile(dest, buf, 0o444);
  }
}

/** A fresh staging dir under `parent`, its intent written first (EC-8 sentinel). */
function beginStaging(parent: string, prefix: string): { dir: string; intent: string } {
  const dir = join(parent, `${prefix}${rand()}`);
  const intent = `${dir}.json`;
  writeAtomicJson(intent, { pid: process.pid, startedAt: Date.now() } satisfies StagingIntent);
  mkdirSync(dir, { mode: 0o700 });
  return { dir, intent };
}

function abandonStaging(s: { dir: string; intent: string }): void {
  removeTree(s.dir);
  rmSync(s.intent, { force: true });
}

/** Remove `prefix*` staging dirs under `parent` whose intent proves them stale. */
function sweepStaging(parent: string, prefix: string, now: number): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const abs = join(parent, name);
    if (name.endsWith(".json")) {
      // An intent whose dir is gone: the dir was renamed into place or removed.
      if (!existsSync(abs.slice(0, -".json".length)) && intentIsStale(abs, now)) {
        rmSync(abs, { force: true });
      }
      continue;
    }
    const st = lstatSync(abs);
    if (!st.isDirectory()) continue;
    if (!intentIsStale(`${abs}.json`, now)) {
      if (!existsSync(`${abs}.json`)) {
        log.warn("skill-pack", "staging dir without intent left in place", { event: "skill_pack.staging_unproven", dir: abs });
      }
      continue;
    }
    removeTree(abs);
    rmSync(`${abs}.json`, { force: true });
    removed.push(abs);
  }
  return removed;
}

// ─── The Aura tree ──────────────────────────────────────────────────────────

function versionsDir(root: string): string {
  return join(root, "versions");
}

function pointerPath(root: string): string {
  return join(root, "current.json");
}

export function readPointer(root: string): PackPointer | null {
  try {
    return parsePointer(readFileSync(pointerPath(root), "utf8"));
  } catch {
    return null;
  }
}

/** Verify a version dir holds exactly its own manifest; returns the manifest or the problems. */
export function verifyVersionDir(dir: string): { manifest: SkillManifest } | { errors: string[] } {
  let files: Map<string, Buffer>;
  const skipped: string[] = [];
  try {
    files = readTree(dir, skipped);
  } catch (err) {
    return { errors: [(err as Error).message] };
  }
  if (skipped.length) return { errors: skipped.map((p) => `unread dir ${p}`) };
  const raw = files.get(PACK_MANIFEST_FILE);
  if (!raw) return { errors: [`${PACK_MANIFEST_FILE} is missing`] };
  let manifest: SkillManifest;
  try {
    manifest = JSON.parse(raw.toString("utf8")) as SkillManifest;
  } catch {
    return { errors: [`${PACK_MANIFEST_FILE} is not JSON`] };
  }
  if (manifest?.schemaVersion !== SKILL_MANIFEST_SCHEMA_VERSION || !Array.isArray(manifest.entries)) {
    return { errors: [`${PACK_MANIFEST_FILE} has an unknown shape`] };
  }
  const errors = [
    ...manifestPathErrors(manifest),
    ...manifest.entries.filter((e) => e.ship?.status !== "ship").map((e) => `${e.name} does not pass the ship gate`),
  ];
  if (errors.length) return { errors };
  const mismatch = treeMismatches(files, manifest);
  return mismatch.length ? { errors: mismatch } : { manifest };
}

export interface InstallResult {
  version: string;
  dir: string;
  /** true when an identical, verified version dir already existed. */
  reused: boolean;
}

/**
 * Build (or reuse) the version dir for the shipped part of `manifest`, copied from
 * `sourceDir` (packs/skills), then point `current.json` at it. Order: intent →
 * staging → verify → read-only → rename into versions/ → pointer swap. Any failure
 * leaves the previous pointer and version untouched.
 */
export function installPack(opts: { sourceDir: string; manifest: Pick<SkillManifest, "entries">; root?: string }): InstallResult {
  const root = opts.root ?? DEFAULT_PACK_ROOT;
  const pathErrs = manifestPathErrors(opts.manifest);
  if (pathErrs.length) throw new Error(`manifest is unsafe to install: ${pathErrs.join("; ")}`);
  const entries = shippedEntries(opts.manifest);
  const subset: SkillManifest = {
    _doc: "The shipped subset of packs/skills/skills-manifest.json that this read-only version dir holds.",
    schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
    entries,
  };
  const version = packVersionId(entries);
  const vdir = versionsDir(root);
  mkdirSync(vdir, { recursive: true, mode: 0o700 });
  const dir = join(vdir, version);

  let reused = false;
  if (existsSync(dir)) {
    const v = verifyVersionDir(dir);
    if ("manifest" in v) reused = true;
    else {
      // A damaged copy of our own version: move it aside, rebuild below.
      log.warn("skill-pack", "version dir failed verification, rebuilding", { event: "skill_pack.version_corrupt", version, errors: v.errors.slice(0, 5) });
      trashVersion(root, version);
    }
  }

  if (!reused) {
    const staging = beginStaging(vdir, STAGING_PREFIX);
    try {
      for (const e of entries) writeEntryFiles(join(opts.sourceDir, e.name), join(staging.dir, e.name), e);
      writeNewFile(join(staging.dir, PACK_MANIFEST_FILE), `${JSON.stringify(subset, null, 2)}\n`, 0o444);
      const v = verifyVersionDir(staging.dir);
      if ("errors" in v) throw new Error(`staged tree failed verification: ${v.errors.slice(0, 5).join("; ")}`);
      makeReadOnly(staging.dir);
      try {
        renameSync(staging.dir, dir);
      } catch (err) {
        // A concurrent installer won the rename; use its dir if it verifies.
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== "EEXIST" && code !== "ENOTEMPTY") || !("manifest" in verifyVersionDir(dir))) throw err;
        removeTree(staging.dir);
        reused = true;
      }
      rmSync(staging.intent, { force: true });
    } catch (err) {
      abandonStaging(staging);
      throw err;
    }
  }

  const prev = readPointer(root);
  if (prev?.version !== version) {
    writeAtomicJson(pointerPath(root), {
      schemaVersion: PACK_POINTER_SCHEMA_VERSION,
      version,
      previous: prev?.version ?? null,
    } satisfies PackPointer);
  }
  log.info("skill-pack", "pack installed", { event: "skill_pack.installed", version, reused, entries: entries.length, previous: prev?.version ?? null });
  return { version, dir, reused };
}

export type CurrentPack = { version: string; dir: string; manifest: SkillManifest } | { error: string };

/** The verified current version, or why there is none. Callers expose nothing on error. */
export function readCurrentPack(root = DEFAULT_PACK_ROOT): CurrentPack {
  const ptr = readPointer(root);
  if (!ptr) return { error: "no valid current.json" };
  const dir = join(versionsDir(root), ptr.version);
  const v = verifyVersionDir(dir);
  if ("errors" in v) return { error: `version ${ptr.version}: ${v.errors.slice(0, 3).join("; ")}` };
  return { version: ptr.version, dir, manifest: v.manifest };
}

/** Rename a version dir to a trash sibling (the sentinel), then remove it. */
function trashVersion(root: string, version: string): void {
  const vdir = versionsDir(root);
  const trash = join(vdir, `${TRASH_PREFIX}${version}-${rand()}`);
  renameSync(join(vdir, version), trash);
  removeTree(trash);
}

export interface SweepResult {
  removedStaging: string[];
  removedVersions: string[];
}

/**
 * Boot-time reconciliation of the Aura tree (EC-8): stale staging (writer gone),
 * leftover trash, and every version other than current, previous and `keep`
 * (versions a live session still uses — the caller's knowledge, Phase B3).
 */
export function sweepPackRoot(root = DEFAULT_PACK_ROOT, opts: { keep?: string[]; now?: number } = {}): SweepResult {
  const vdir = versionsDir(root);
  const result: SweepResult = { removedStaging: sweepStaging(vdir, STAGING_PREFIX, opts.now ?? Date.now()), removedVersions: [] };
  let names: string[];
  try {
    names = readdirSync(vdir);
  } catch {
    return result;
  }
  const ptr = readPointer(root);
  const keep = new Set([ptr?.version, ptr?.previous, ...(opts.keep ?? [])].filter((v): v is string => !!v));
  for (const name of names) {
    if (name.startsWith(TRASH_PREFIX)) {
      removeTree(join(vdir, name));
      continue;
    }
    // No pointer at all means we cannot tell which version is live: keep everything.
    if (!ptr || !VERSION_RE.test(name) || keep.has(name)) continue;
    trashVersion(root, name);
    result.removedVersions.push(name);
  }
  if (result.removedStaging.length || result.removedVersions.length) {
    log.info("skill-pack", "pack root swept", { event: "skill_pack.swept", ...result });
  }
  return result;
}

// ─── Copies outside the Aura tree (Codex homes, container) ──────────────────

/** The skill dirs at `parent`, with ownership proven only where a marker is present. */
export function listExistingSkills(parent: string, manifest: Pick<SkillManifest, "entries">): ExistingSkill[] {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  const out: ExistingSkill[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const abs = join(parent, name);
    const st = lstatSync(abs);
    // A link or a file still answers to the name for the CLI: it counts as the user's.
    if (!st.isDirectory()) {
      out.push({ name, frontmatterName: null, ownership: { owner: "user", reason: "not a plain directory" } });
      continue;
    }
    let fm: string | null = null;
    try {
      fm = frontmatterName(readFileSync(join(abs, "SKILL.md"), "utf8"));
    } catch {
      /* no SKILL.md */
    }
    const ownership: Ownership = existsSync(join(abs, OWNER_MARKER_FILE))
      ? readOwnership(abs, name, manifest)
      : { owner: "user", reason: "no ownership marker" };
    out.push({ name, frontmatterName: fm && fm !== name ? fm : null, ownership });
  }
  return out;
}

export interface SyncResult {
  placed: string[];
  replaced: string[];
  unchanged: string[];
  removed: string[];
  /** Left alone because they are (or became) the user's. */
  skipped: { name: string; reason: string }[];
}

/** Build a marked, read-only copy of `entry` from the Aura tree into a staging dir under `parent`. */
function stageCopy(parent: string, packDir: string, entry: ManifestEntry): { dir: string; intent: string } {
  const staging = beginStaging(parent, `${COPY_STAGING_PREFIX}${entry.name}-`);
  try {
    // Staged as a sibling of the destination: a read-only dir can be renamed only
    // within its parent (moving it to another parent needs write access to it).
    writeEntryFiles(join(packDir, entry.name), staging.dir, entry);
    writeNewFile(join(staging.dir, OWNER_MARKER_FILE), `${JSON.stringify(markerFor(entry), null, 2)}\n`, 0o444);
    const own = readOwnership(staging.dir, entry.name, { entries: [entry] });
    if (own.owner !== "aura" || !own.current) throw new Error(`staged copy of ${entry.name} is not provably Aura's`);
    makeReadOnly(staging.dir);
    return staging;
  } catch (err) {
    abandonStaging(staging);
    throw err;
  }
}

/** Renaming out of the way is the sentinel: a crash leaves `.aura-trash-<name>-*`, which sweepCopies re-proves. */
function moveAsideIfAura(parent: string, name: string, manifest: Pick<SkillManifest, "entries">): { trash: string } | { reason: string } {
  const trash = join(parent, `${COPY_TRASH_PREFIX}${name}-${rand()}`);
  renameSync(join(parent, name), trash);
  const own = readOwnership(trash, name, manifest);
  if (own.owner !== "aura") {
    // Edited between the check and the move: put it back untouched.
    renameSync(trash, join(parent, name));
    return { reason: own.reason };
  }
  return { trash };
}

/**
 * Converge `parent` (a CLI's skills dir) on `plan` from the verified version at
 * `packDir`: place missing `provide` entries, upgrade Aura-owned stale copies,
 * remove Aura-owned copies that are no longer provided. A dir that is not provably
 * Aura's is never written, replaced or removed.
 */
export function syncCopies(opts: { parent: string; packDir: string; manifest: Pick<SkillManifest, "entries">; plan: PackPlanItem[] }): SyncResult {
  const { parent, packDir, manifest } = opts;
  const res: SyncResult = { placed: [], replaced: [], unchanged: [], removed: [], skipped: [] };
  mkdirSync(parent, { recursive: true });
  const provide = new Set(opts.plan.filter((p) => p.outcome === "provide").map((p) => p.name));
  const byName = new Map(manifest.entries.map((e) => [e.name, e]));

  for (const name of provide) {
    const entry = byName.get(name);
    if (!entry || entry.ship.status !== "ship" || !isPackName(name)) {
      res.skipped.push({ name, reason: "not a shippable entry of this manifest" });
      continue;
    }
    const dest = join(parent, name);
    if (!lstatSync(dest, { throwIfNoEntry: false })) {
      const s = stageCopy(parent, packDir, entry);
      renameSync(s.dir, dest);
      rmSync(s.intent, { force: true });
      res.placed.push(name);
      continue;
    }
    const own = readOwnership(dest, name, manifest);
    if (own.owner === "user") {
      res.skipped.push({ name, reason: own.reason });
      continue;
    }
    if (own.current) {
      res.unchanged.push(name);
      continue;
    }
    const s = stageCopy(parent, packDir, entry);
    const aside = moveAsideIfAura(parent, name, manifest);
    if ("reason" in aside) {
      abandonStaging(s);
      res.skipped.push({ name, reason: aside.reason });
      continue;
    }
    try {
      renameSync(s.dir, dest);
    } catch (err) {
      renameSync(aside.trash, dest);
      abandonStaging(s);
      throw err;
    }
    rmSync(s.intent, { force: true });
    removeTree(aside.trash);
    res.replaced.push(name);
  }

  for (const e of listExistingSkills(parent, manifest)) {
    if (provide.has(e.name) || e.ownership.owner !== "aura") continue;
    const aside = moveAsideIfAura(parent, e.name, manifest);
    if ("reason" in aside) {
      res.skipped.push({ name: e.name, reason: aside.reason });
      continue;
    }
    removeTree(aside.trash);
    res.removed.push(e.name);
  }
  if (res.placed.length || res.replaced.length || res.removed.length || res.skipped.length) {
    log.info("skill-pack", "copies synced", { event: "skill_pack.copies_synced", parent, ...res });
  }
  return res;
}

/**
 * Boot-time reconciliation of a copy parent (EC-8): stale staging is removed; a
 * trash dir is removed only if it still proves Aura's, otherwise it is put back
 * under its name when that is free (it is the user's), or left and reported.
 */
export function sweepCopies(parent: string, opts: { now?: number } = {}): { removed: string[]; restored: string[]; left: string[] } {
  const out = { removed: sweepStaging(parent, COPY_STAGING_PREFIX, opts.now ?? Date.now()), restored: [] as string[], left: [] as string[] };
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return out;
  }
  for (const n of names) {
    const m = /^\.aura-trash-(.+)-[0-9a-f]{12}$/.exec(n);
    if (!m || !isPackName(m[1])) continue;
    const abs = join(parent, n);
    const own = readOwnership(abs, m[1], { entries: [] });
    if (own.owner === "aura") {
      removeTree(abs);
      out.removed.push(abs);
    } else if (!lstatSync(join(parent, m[1]), { throwIfNoEntry: false })) {
      renameSync(abs, join(parent, m[1]));
      out.restored.push(m[1]);
    } else {
      log.warn("skill-pack", "unproven trash dir left in place", { event: "skill_pack.trash_unproven", dir: abs, reason: own.reason });
      out.left.push(abs);
    }
  }
  return out;
}

