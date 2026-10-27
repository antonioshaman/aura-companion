#!/usr/bin/env bun
// Box ↔ repo drift check for the council skills (review 2026-10-27-2139 #19).
//
// Until Phase B points sessions at packs/skills, the operator box still runs its own
// copy in ~/.claude/skills. The vitest drift arms only compare capability profiles
// and vocabulary; this compares EVERY file of the catalog and the six dispatchers by
// sha256, so a prompt or reference edited on the box but not ported to the repo (or
// the reverse) is reported. Exit 1 on any drift, 2 when the box copy is absent.
//
//   bun scripts/council-catalog-drift.ts [--box <skills root>]

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

import { COUNCIL_SKILLS_DIR } from "./capability-catalog.js";

/** The council part of a skills root: catalog + the six dispatchers. */
export const COUNCIL_TREES = [
  "_council-experts",
  "council-plan",
  "council-plan-aura",
  "council-review",
  "council-review-aura",
  "council-implement",
  "council-implement-aura",
] as const;

/** Local backups and caches that are not part of the catalog. */
const IGNORED = /(^|\/)(__pycache__|node_modules)(\/|$)|\.bak(-[\w-]+)?$|\.pyc$/;

/** path (relative to the skills root) → sha256, for the council trees under `root`. */
export function hashCouncilTrees(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      if (IGNORED.test(rel)) continue;
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.set(rel, createHash("sha256").update(readFileSync(abs)).digest("hex"));
    }
  };
  for (const t of COUNCIL_TREES) if (existsSync(join(root, t))) walk(join(root, t));
  return out;
}

/** Human-readable differences between two hashed trees. Empty = identical. */
export function treeDrift(repo: Map<string, string>, box: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [p, h] of repo) {
    if (!box.has(p)) out.push(`only in repo: ${p}`);
    else if (box.get(p) !== h) out.push(`differs: ${p}`);
  }
  for (const p of box.keys()) if (!repo.has(p)) out.push(`only on box: ${p}`);
  return out.sort();
}

if (import.meta.main) {
  const i = process.argv.indexOf("--box");
  const box = i >= 0 ? process.argv[i + 1] : join(homedir(), ".claude", "skills");
  if (!existsSync(join(box, "_council-experts"))) {
    console.error(`no council catalog at ${box} — nothing to compare`);
    process.exit(2);
  }
  const drift = treeDrift(hashCouncilTrees(COUNCIL_SKILLS_DIR), hashCouncilTrees(box));
  if (drift.length) {
    console.error(`council catalog drift (repo packs/skills vs ${box}):\n${drift.join("\n")}`);
    process.exit(1);
  }
  console.log("council catalog: box copy matches packs/skills");
}
