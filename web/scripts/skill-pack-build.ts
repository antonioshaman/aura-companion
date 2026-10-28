#!/usr/bin/env bun
// Put the shipped skill pack into the npm package, and gate the package
// (spec `uiux-agent-enrichment.md` AC2.1, AC2.4; PLAN Task 9 — hashimoto R1–R5).
//
// The npm package root is `web/`, and npm cannot pack `../packs/skills`. So
// `prepack` STAGES the shipped set into `web/packs/skills/` (gitignored) and
// `postpack` removes it again. What gets staged:
//   - each entry with ship.status === "ship": exactly its manifest-listed files,
//     each verified against its sha256 while copying (blocked entries never ship;
//     the build prints their ship.reasons),
//   - skills-manifest.json, THIRD_PARTY_NOTICES.md and the repo licence as LICENSE
//     (the first-party skills ship under it; web/ has no LICENSE of its own).
// The server finds it via defaultPackSource() (`<package>/packs/skills`).
//
// `gate <npm-pack.json>` reads `npm pack --json` output and fails closed:
//   - packed size over the budget (15 MB; more is ask-first in the spec),
//   - a packs/skills path that is not in the shipped set (e.g. a blocked skill or an
//     excluded dev file), or a shipped file that is missing,
//   - a shipped entry whose licence verdict is not shippable,
//   - the licence or notices file missing,
//   - dev-only trees (evals, fixtures, .git, canary scripts) anywhere in the package.
// It always prints what it left out and why.
//
// Commands: stage | clean | gate <npm-pack.json> [--budget-bytes N]

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256, type SkillManifest } from "../server/skill-manifest.js";
import { buildManifest, MANIFEST_FILE, readInput, serialiseManifest, type PackDecl } from "./skill-manifest.js";
import { PACK_SKILLS_DIR } from "./vendored-skills.js";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACK_SKILLS_DIR, "..", "..");
/** Where prepack stages the pack, relative to the package root. Must match defaultPackSource(). */
export const PACKAGED_PACK_REL = "packs/skills";
export const STAGED_PACK_DIR = join(WEB_ROOT, PACKAGED_PACK_REL);
/** Spec: "growing the packed npm package beyond 15 MB" is ask-first. */
export const PACK_BUDGET_BYTES = 15 * 1000 * 1000;
/** Root files of the staged pack besides the entries. */
export const STAGED_ROOT_FILES = ["skills-manifest.json", "THIRD_PARTY_NOTICES.md", "LICENSE"] as const;
/** Path segments that are dev-only anywhere in the package. */
const DEV_ONLY_SEGMENTS = new Set(["evals", "__fixtures__", ".git", ".verify", "__pycache__", "node_modules"]);
/** The one excluded-dir file that ships (see skill-manifest.ts KEPT_PATHS). */
const DEV_ONLY_EXCEPTIONS = new Set([`${PACKAGED_PACK_REL}/_council-experts/.verify/capability-vocabulary.json`]);

// ─── Pure core ──────────────────────────────────────────────────────────────

/** Every file the package must carry under packs/skills, relative to it: entry files of ship entries + root files. */
export function shippedPaths(manifest: SkillManifest): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const f of STAGED_ROOT_FILES) out.set(f, null);
  for (const e of manifest.entries) {
    if (e.ship.status !== "ship") continue;
    for (const [p, h] of Object.entries(e.files)) out.set(`${e.name}/${p}`, h);
  }
  return out;
}

export interface PackListing {
  size: number;
  files: Array<{ path: string }>;
}

export interface GateResult {
  errors: string[];
  /** Human-readable "left out, and why" lines; printed whether or not the gate passes. */
  notes: string[];
}

/** The package gate (size, licence, contents). Pure: takes the `npm pack --json` listing. */
export function gatePackage(listing: PackListing, manifest: SkillManifest, budgetBytes = PACK_BUDGET_BYTES): GateResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`;
  if (!(listing.size > 0)) errors.push("npm pack reported no packed size");
  else if (listing.size > budgetBytes) errors.push(`packed size ${mb(listing.size)} is over the ${mb(budgetBytes)} budget (growing it is ask-first)`);
  else notes.push(`packed size ${mb(listing.size)} (budget ${mb(budgetBytes)})`);

  const prefix = `${PACKAGED_PACK_REL}/`;
  const want = shippedPaths(manifest);
  const have = new Set<string>();
  const blocked = new Map(manifest.entries.filter((e) => e.ship.status !== "ship").map((e) => [e.name, e.ship.reasons]));
  for (const { path } of listing.files) {
    const segs = path.split("/");
    if (segs.some((s) => DEV_ONLY_SEGMENTS.has(s)) && !DEV_ONLY_EXCEPTIONS.has(path)) errors.push(`${path}: dev-only file in the package`);
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    have.add(rel);
    if (want.has(rel)) continue;
    const top = rel.split("/")[0];
    errors.push(blocked.has(top) ? `${path}: ${top} is blocked and must not ship` : `${path}: not in the shipped set`);
  }
  const missing = new Map<string, string[]>();
  for (const rel of want.keys()) {
    if (have.has(rel)) continue;
    const top = rel.includes("/") ? `${rel.split("/")[0]}/` : rel;
    missing.set(top, [...(missing.get(top) ?? []), rel]);
  }
  for (const [top, rels] of missing) {
    errors.push(`${prefix}${top}: ${rels.length} shipped file(s) missing from the package${rels.length > 1 ? ` (first: ${rels[0]})` : ""}`);
  }

  for (const e of manifest.entries) {
    if (e.ship.status === "ship" && e.licence.verdict !== "shippable") errors.push(`${e.name}: marked ship but licence ${e.licence.spdx} is ${e.licence.verdict}`);
    if (e.ship.status === "ship" && e.ship.reasons.length) errors.push(`${e.name}: marked ship but has reasons: ${e.ship.reasons.join("; ")}`);
  }
  for (const [name, reasons] of blocked) notes.push(`not shipped: ${name}\n    - ${reasons.join("\n    - ") || "(no reason recorded)"}`);
  if (blocked.size && [...blocked.values()].some((r) => r.length === 0)) errors.push("a blocked entry has no recorded reason");
  return { errors, notes };
}

// ─── Effect shell ───────────────────────────────────────────────────────────

/** The committed manifest, refused unless the tree still produces it byte-for-byte. */
export function freshManifest(): { manifest: SkillManifest } | { error: string } {
  const { input } = readInput();
  const built = buildManifest(input);
  if (built.errors.length) return { error: built.errors.join("\n") };
  const committed = readFileSync(MANIFEST_FILE, "utf8");
  if (committed !== serialiseManifest(built.manifest)) return { error: "skills-manifest.json is stale — run: bun scripts/skill-manifest.ts generate" };
  return { manifest: built.manifest };
}

/** Remove the staged pack; only a dir that holds a staged manifest (never a link). */
export function cleanStaged(dir = STAGED_PACK_DIR): void {
  if (!existsSync(dir)) return;
  if (lstatSync(dir).isSymbolicLink() || !existsSync(join(dir, "skills-manifest.json"))) {
    throw new Error(`${dir} is not a staged skill pack; refusing to remove it`);
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Copy the shipped set into `out`, verifying every entry byte against the manifest. */
export function stagePack(opts: { sourceDir?: string; out?: string; manifest: SkillManifest; licenceFile: string }): number {
  const src = opts.sourceDir ?? PACK_SKILLS_DIR;
  const out = opts.out ?? STAGED_PACK_DIR;
  const tmp = `${out}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  let n = 0;
  for (const [rel, hash] of shippedPaths(opts.manifest)) {
    const from = rel === "LICENSE" ? opts.licenceFile : join(src, rel);
    if (lstatSync(from).isSymbolicLink()) throw new Error(`${rel}: symlink in the pack source`);
    const buf = readFileSync(from);
    if (hash !== null && sha256(buf) !== hash) throw new Error(`${rel}: bytes differ from skills-manifest.json`);
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    writeFileSync(join(tmp, rel), buf);
    n++;
  }
  cleanStaged(out);
  mkdirSync(dirname(out), { recursive: true });
  renameSync(tmp, out);
  return n;
}

function runStage(): number {
  const fresh = freshManifest();
  if ("error" in fresh) {
    console.error(`skill pack not staged: ${fresh.error}`);
    return 1;
  }
  const pack = JSON.parse(readFileSync(join(PACK_SKILLS_DIR, "pack.json"), "utf8")) as PackDecl;
  const n = stagePack({ manifest: fresh.manifest, licenceFile: join(REPO_ROOT, pack.firstParty.licenceFile) });
  // stderr: prepack runs inside `npm pack --json`, whose stdout must stay JSON.
  console.warn(`staged ${n} skill-pack files into ${STAGED_PACK_DIR}`);
  for (const e of fresh.manifest.entries.filter((x) => x.ship.status !== "ship")) {
    console.warn(`  not shipped: ${e.name}\n    - ${e.ship.reasons.join("\n    - ")}`);
  }
  return 0;
}

function runGate(args: string[]): number {
  const file = args[0];
  if (!file) {
    console.error("usage: bun scripts/skill-pack-build.ts gate <npm-pack.json> [--budget-bytes N]");
    return 2;
  }
  const i = args.indexOf("--budget-bytes");
  const budget = i >= 0 ? Number(args[i + 1]) : PACK_BUDGET_BYTES;
  const raw = JSON.parse(readFileSync(file, "utf8")) as PackListing | PackListing[];
  const listing = Array.isArray(raw) ? raw[0] : raw;
  const fresh = freshManifest();
  if ("error" in fresh) {
    console.error(`package gate: ${fresh.error}`);
    return 1;
  }
  const { errors, notes } = gatePackage(listing, fresh.manifest, budget);
  for (const n of notes) console.log(n);
  if (errors.length) {
    console.error(`package gate FAILED:\n  ${errors.join("\n  ")}`);
    return 1;
  }
  console.log("package gate OK");
  return 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "stage") process.exit(runStage());
  else if (cmd === "clean") {
    cleanStaged();
    process.exit(0);
  } else if (cmd === "gate") process.exit(runGate(rest));
  else {
    console.error("usage: bun scripts/skill-pack-build.ts stage|clean|gate <npm-pack.json>");
    process.exit(2);
  }
}
