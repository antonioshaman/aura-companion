#!/usr/bin/env bun
// Pinned vendoring of third-party skills (spec `uiux-agent-enrichment.md` AC2.4,
// PLAN Task 3 — hunt R1 supply chain).
//
// `packs/skills/vendor-lock.json` pins each vendored skill to an upstream commit
// and records, per skill:
//   - the licence verdict (SPDX + copyright line, verified against the upstream
//     LICENSE at that commit; the copy carries that LICENSE file),
//   - a sha256 for every file — any added, removed or edited file goes red,
//   - the outbound hosts its executable code names (network inventory), so an
//     upstream bump that adds a new remote call goes red until a human re-reviews,
//   - the human review state. The hash gate proves bytes; only a person can judge
//     instructions, so a bump always resets the review to "pending".
//
// `lock` regenerates hashes + network inventory from the tree (keeping the review
// block); `check` verifies the tree against the lock. Pure core is tested.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const PACK_SKILLS_DIR = resolve(import.meta.dirname, "..", "..", "packs", "skills");
export const VENDOR_LOCK_FILE = join(PACK_SKILLS_DIR, "vendor-lock.json");

/** Licences a vendored skill may carry. Anything else is excluded (AC2.4). */
const SHIPPABLE_LICENCES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "CC0-1.0"]);
/** Files whose content counts as executable for the network inventory. */
const CODE_EXT = /\.(mjs|cjs|js|ts|py|sh)$/;
const HOST_RE = /\bhttps?:\/\/([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g;
/** Placeholder / loopback hosts that are not outbound calls. */
const NON_OUTBOUND = new Set(["127.0.0.1", "localhost"]);

export interface VendoredSkill {
  name: string;
  upstream: { repo: string; path: string; commit: string };
  licence: { spdx: string; copyright: string; file: "LICENSE" };
  /** Executable files that reach the network at runtime → outbound hosts named in them. */
  network: Record<string, string[]>;
  humanReview: { status: "pending" | "approved" | "rejected"; reviewer: string | null; date: string | null; notes: string };
  files: Record<string, string>;
}

export interface VendorLock {
  _doc: string;
  skills: VendoredSkill[];
}

// ─── Pure core ──────────────────────────────────────────────────────────────

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Outbound hosts named in one code file's text, sorted and de-duplicated. */
export function outboundHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const m of text.matchAll(HOST_RE)) if (!NON_OUTBOUND.has(m[1])) hosts.add(m[1].toLowerCase());
  return [...hosts].sort();
}

/** Network inventory of a skill tree: code files (outside its own tests) → hosts. */
export function networkInventory(files: Map<string, Buffer>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, buf] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!CODE_EXT.test(path) || /(^|\/)tests?\//.test(path)) continue;
    const hosts = outboundHosts(buf.toString("utf8"));
    if (hosts.length) out[path] = hosts;
  }
  return out;
}

/** Compare one vendored skill's on-disk files against its lock entry. */
export function checkSkill(entry: VendoredSkill, files: Map<string, Buffer>): string[] {
  const errs: string[] = [];
  const n = entry.name;
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(n)) errs.push(`${n}: name is not a safe slug`);
  if (!/^[0-9a-f]{40}$/.test(entry.upstream.commit)) errs.push(`${n}: upstream commit is not a full sha`);
  if (!SHIPPABLE_LICENCES.has(entry.licence.spdx)) errs.push(`${n}: licence ${entry.licence.spdx} is not shippable — exclude it`);
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
  const inv = networkInventory(files);
  if (JSON.stringify(inv) !== JSON.stringify(entry.network)) {
    errs.push(`${n}: network inventory changed — a human must re-review before re-locking`);
  }
  if (entry.humanReview.status === "rejected") errs.push(`${n}: human review rejected this skill`);
  return errs;
}

// ─── Effect shell ───────────────────────────────────────────────────────────

/** Read a skill tree. Refuses symlinks (a vendored link could point anywhere). */
export function readTree(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error(`symlink in vendored tree: ${relative(root, abs)}`);
      if (st.isDirectory()) {
        if (name === "__pycache__" || name === "node_modules") continue;
        walk(abs);
      } else if (st.isFile()) out.set(relative(root, abs).split(sep).join("/"), readFileSync(abs));
    }
  };
  walk(root);
  return out;
}

export function loadLock(path = VENDOR_LOCK_FILE): VendorLock {
  return JSON.parse(readFileSync(path, "utf8")) as VendorLock;
}

function runCheck(): number {
  const lock = loadLock();
  const errs = lock.skills.flatMap((s) => checkSkill(s, readTree(join(PACK_SKILLS_DIR, s.name))));
  const pending = lock.skills.filter((s) => s.humanReview.status !== "approved").map((s) => s.name);
  if (errs.length) {
    console.error(errs.join("\n"));
    return 1;
  }
  console.log(`vendored skills: ${lock.skills.length} match the lock${pending.length ? `; human review pending: ${pending.join(", ")}` : ""}`);
  return 0;
}

/** Re-hash the trees. A changed network inventory or upstream commit resets the review. */
function runLock(): number {
  const lock = loadLock();
  for (const s of lock.skills) {
    const files = readTree(join(PACK_SKILLS_DIR, s.name));
    const inv = networkInventory(files);
    if (JSON.stringify(inv) !== JSON.stringify(s.network)) {
      s.humanReview = { status: "pending", reviewer: null, date: null, notes: "network inventory changed; re-review required" };
    }
    s.network = inv;
    s.files = Object.fromEntries([...files].map(([p, b]) => [p, sha256(b)]));
  }
  writeFileSync(VENDOR_LOCK_FILE, JSON.stringify(lock, null, 2) + "\n");
  console.log(`vendor-lock: re-hashed ${lock.skills.length} skills`);
  return 0;
}

if (import.meta.main) {
  const [, , cmd] = process.argv;
  if (cmd === "check") process.exit(runCheck());
  else if (cmd === "lock") process.exit(runLock());
  else {
    console.error("usage: bun scripts/vendored-skills.ts check|lock");
    process.exit(2);
  }
}
