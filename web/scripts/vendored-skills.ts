#!/usr/bin/env bun
// Pinned vendoring of third-party skills (spec `uiux-agent-enrichment.md` AC2.4,
// PLAN Task 3 — hunt R1 supply chain).
//
// `packs/skills/vendor-lock.json` pins each vendored skill to an upstream commit
// and records, per skill:
//   - the licence verdict (SPDX + copyright line, verified against the upstream
//     LICENSE at that commit; the copy carries that LICENSE file),
//   - a sha256 for every file — any added, removed or edited file goes red,
//   - two host inventories: `network` = hosts written literally in executable
//     code, `instructionHosts` = hosts written in markdown the agent reads. Both are
//     LITERAL-ONLY: a host built at run time (API response, template string) is
//     invisible to them, which is why `runtimeCapabilities` records what a script
//     can do (e.g. network-download) for Phase B to act on,
//   - the human review: status, basis (ai-prereview | human-read), and the upstream
//     commit + files digest the approval covers. An approval never outlives the
//     bytes it approved: `check` fails when they differ, `lock` resets it to
//     pending, and `pending` itself fails `check` (fail closed).
//
// `lock` regenerates hashes + inventories from the tree; `approve` records an
// approval for the current bytes; `check` verifies the tree against the lock.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { filesDigest, readTree, sha256 } from "../server/skill-manifest.js";
import { COUNCIL_SKILLS_DIR } from "./capability-catalog.js";
import { SHIPPABLE_CODE_LICENCES, SLUG_RE } from "./licences.js";

/** The in-repo skills root (same dir as the council catalog's — one constant, EC-20). */
export const PACK_SKILLS_DIR = COUNCIL_SKILLS_DIR;
export const VENDOR_LOCK_FILE = join(PACK_SKILLS_DIR, "vendor-lock.json");

/** Files whose content counts as executable for the network inventory. */
const CODE_EXT = /\.(mjs|cjs|js|ts|py|sh)$/;
const HOST_RE = /\bhttps?:\/\/([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g;
/** Placeholder / loopback hosts that are not outbound calls. */
const NON_OUTBOUND = new Set(["127.0.0.1", "localhost"]);

// Hashing and the symlink-refusing tree reader live in the shipped module, so the
// lock and the skills manifest can never hash a tree two different ways.
export { filesDigest, readTree, sha256 };

export interface HumanReview {
  status: "pending" | "approved" | "rejected";
  /** What the approval rests on: an AI pre-review the owner accepted, or a person's own read. */
  basis?: "ai-prereview" | "human-read";
  reviewer: string | null;
  date: string | null;
  notes: string;
  /** The upstream commit and files digest this approval covers. */
  reviewedCommit?: string;
  reviewedDigest?: string;
}

export interface VendoredSkill {
  name: string;
  upstream: { repo: string; path: string; commit: string };
  licence: { spdx: string; copyright: string; file: "LICENSE" };
  /** Executable files → outbound hosts written literally in them. */
  network: Record<string, string[]>;
  /** Markdown files → hosts written in them (instructions the agent may act on). */
  instructionHosts: Record<string, string[]>;
  /** File → what it can do at run time that Phase B must surface (e.g. "network-download"). */
  runtimeCapabilities: Record<string, string[]>;
  /** Known integration issues Phase B must resolve before shipping (free text). */
  knownIssues: string[];
  humanReview: HumanReview;
  files: Record<string, string>;
}

export interface VendorLock {
  _doc: string;
  skills: VendoredSkill[];
}

// ─── Pure core ──────────────────────────────────────────────────────────────

/** Outbound hosts named in one code file's text, sorted and de-duplicated. */
export function outboundHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const m of text.matchAll(HOST_RE)) if (!NON_OUTBOUND.has(m[1])) hosts.add(m[1].toLowerCase());
  return [...hosts].sort();
}

function inventory(files: Map<string, Buffer>, include: (path: string) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, buf] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!include(path)) continue;
    const hosts = outboundHosts(buf.toString("utf8"));
    if (hosts.length) out[path] = hosts;
  }
  return out;
}

/** Network inventory of a skill tree: code files (outside its own tests) → literal hosts. */
export function networkInventory(files: Map<string, Buffer>): Record<string, string[]> {
  return inventory(files, (p) => CODE_EXT.test(p) && !/(^|\/)tests?\//.test(p));
}

/** Instruction inventory: markdown the agent reads → literal hosts (finding #3). */
export function instructionInventory(files: Map<string, Buffer>): Record<string, string[]> {
  return inventory(files, (p) => p.endsWith(".md"));
}

/**
 * The review block after re-locking to `newFiles`. An approval survives only if it
 * still covers exactly these bytes and this upstream commit; otherwise → pending.
 */
export function relockReview(entry: VendoredSkill, newFiles: Record<string, string>): HumanReview {
  const r = entry.humanReview;
  if (r.status !== "approved") return r;
  if (r.reviewedCommit === entry.upstream.commit && r.reviewedDigest === filesDigest(newFiles)) return r;
  return { status: "pending", reviewer: null, date: null, notes: "content or upstream commit changed since the approval; re-review required" };
}

function reviewErrors(entry: VendoredSkill): string[] {
  const n = entry.name;
  const r = entry.humanReview;
  if (r.status === "rejected") return [`${n}: human review rejected this skill`];
  if (r.status === "pending") return [`${n}: human review pending`];
  const errs: string[] = [];
  if (r.basis !== "ai-prereview" && r.basis !== "human-read") errs.push(`${n}: approval has no basis (ai-prereview | human-read)`);
  if (r.reviewedCommit !== entry.upstream.commit) errs.push(`${n}: approval was for a different upstream commit — re-review required`);
  if (r.reviewedDigest !== filesDigest(entry.files)) errs.push(`${n}: approval does not cover the current files — re-review required`);
  return errs;
}

/** Compare one vendored skill's on-disk files against its lock entry. */
export function checkSkill(entry: VendoredSkill, files: Map<string, Buffer>): string[] {
  const errs: string[] = [];
  const n = entry.name;
  if (!SLUG_RE.test(n)) errs.push(`${n}: name is not a safe slug`);
  if (!/^[0-9a-f]{40}$/.test(entry.upstream.commit)) errs.push(`${n}: upstream commit is not a full sha`);
  if (!SHIPPABLE_CODE_LICENCES.has(entry.licence.spdx)) errs.push(`${n}: licence ${entry.licence.spdx} is not shippable — exclude it`);
  const licence = files.get("LICENSE");
  if (!licence) errs.push(`${n}: LICENSE file missing from the vendored copy`);
  else if (!licence.toString("utf8").includes(entry.licence.copyright)) {
    errs.push(`${n}: LICENSE does not carry the recorded copyright line`);
  }
  if (!files.has("SKILL.md")) errs.push(`${n}: SKILL.md missing`);
  for (const [path, hash] of Object.entries(entry.files)) {
    const buf = files.get(path);
    if (!buf) errs.push(`${n}: ${path} is locked but missing`);
    else if (sha256(buf) !== hash) errs.push(`${n}: ${path} sha256 differs from the lock`);
  }
  for (const path of files.keys()) if (!(path in entry.files)) errs.push(`${n}: ${path} is not in the lock`);
  if (JSON.stringify(networkInventory(files)) !== JSON.stringify(entry.network)) {
    errs.push(`${n}: network inventory changed — a human must re-review before re-locking`);
  }
  if (JSON.stringify(instructionInventory(files)) !== JSON.stringify(entry.instructionHosts ?? {})) {
    errs.push(`${n}: instruction-host inventory changed — a human must re-review before re-locking`);
  }
  for (const path of Object.keys(entry.runtimeCapabilities ?? {})) {
    if (!(path in entry.files)) errs.push(`${n}: runtimeCapabilities names ${path}, which is not in the lock`);
  }
  errs.push(...reviewErrors(entry));
  return errs;
}

// ─── Effect shell ───────────────────────────────────────────────────────────

/** Resolve a lock entry's directory, refusing any name that is not a single safe segment (EC-7). */
export function skillDir(name: string, root = PACK_SKILLS_DIR): string {
  if (!SLUG_RE.test(name)) throw new Error(`skill name ${JSON.stringify(name)} is not a safe slug`);
  return join(root, name);
}

export function loadLock(path = VENDOR_LOCK_FILE): VendorLock {
  return JSON.parse(readFileSync(path, "utf8")) as VendorLock;
}

/** tmp + rename: a crash mid-write never leaves a torn lock. */
function writeLock(lock: VendorLock): void {
  const tmp = `${VENDOR_LOCK_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(lock, null, 2) + "\n");
  renameSync(tmp, VENDOR_LOCK_FILE);
}

function runCheck(): number {
  const lock = loadLock();
  const errs: string[] = [];
  for (const s of lock.skills) {
    const skipped: string[] = [];
    errs.push(...checkSkill(s, readTree(skillDir(s.name), skipped)));
    for (const d of skipped) console.warn(`${s.name}: not hashed (generated cache dir): ${d}`);
  }
  if (errs.length) {
    console.error(errs.join("\n"));
    return 1;
  }
  const basis = lock.skills.map((s) => `${s.name} (${s.humanReview.basis})`).join(", ");
  console.log(`vendored skills: ${lock.skills.length} match the lock; approved: ${basis}`);
  return 0;
}

/** Re-hash the trees and inventories. Any change the approval does not cover resets it. */
function runLock(): number {
  const lock = loadLock();
  for (const s of lock.skills) {
    const files = readTree(skillDir(s.name));
    const hashes = Object.fromEntries([...files].map(([p, b]) => [p, sha256(b)]));
    const net = networkInventory(files);
    const instr = instructionInventory(files);
    const invChanged = JSON.stringify(net) !== JSON.stringify(s.network) || JSON.stringify(instr) !== JSON.stringify(s.instructionHosts ?? {});
    s.humanReview = invChanged
      ? { status: "pending", reviewer: null, date: null, notes: "host inventory changed; re-review required" }
      : relockReview(s, hashes);
    s.network = net;
    s.instructionHosts = instr;
    s.files = hashes;
  }
  writeLock(lock);
  console.log(`vendor-lock: re-hashed ${lock.skills.length} skills`);
  return 0;
}

/** Record an approval bound to the skill's CURRENT locked bytes and commit. */
function runApprove(args: string[]): number {
  const [name] = args;
  const flag = (f: string) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : undefined);
  const basis = flag("--basis");
  const reviewer = flag("--reviewer");
  if (!name || (basis !== "ai-prereview" && basis !== "human-read") || !reviewer) {
    console.error('usage: approve <skill> --basis ai-prereview|human-read --reviewer "<name>" [--notes "<text>"]');
    return 2;
  }
  const lock = loadLock();
  const s = lock.skills.find((x) => x.name === name);
  if (!s) {
    console.error(`no vendored skill named ${name}`);
    return 1;
  }
  const pre = checkSkill({ ...s, humanReview: { ...s.humanReview, status: "rejected" } }, readTree(skillDir(s.name)))
    .filter((e) => !e.endsWith("human review rejected this skill"));
  if (pre.length) {
    console.error(`refusing to approve bytes that do not match the lock:\n${pre.join("\n")}`);
    return 1;
  }
  s.humanReview = {
    status: "approved",
    basis,
    reviewer,
    date: new Date().toISOString().slice(0, 10),
    notes: flag("--notes") ?? s.humanReview.notes,
    reviewedCommit: s.upstream.commit,
    reviewedDigest: filesDigest(s.files),
  };
  writeLock(lock);
  console.log(`vendor-lock: ${name} approved (${basis}) for ${s.upstream.commit.slice(0, 8)}`);
  return 0;
}

if (import.meta.main) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "check") process.exit(runCheck());
  else if (cmd === "lock") process.exit(runLock());
  else if (cmd === "approve") process.exit(runApprove(rest));
  else {
    console.error("usage: bun scripts/vendored-skills.ts check|lock|approve");
    process.exit(2);
  }
}
