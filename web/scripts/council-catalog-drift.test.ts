// Tests for the box ↔ repo council catalog drift check (review 2026-10-27-2139 #19).
// Builds two throwaway skills roots and plants one drift of each kind.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashCouncilTrees, treeDrift } from "./council-catalog-drift.js";

function root(files: Record<string, string>): string {
  const r = mkdtempSync(join(tmpdir(), "drift-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(r, p, ".."), { recursive: true });
    writeFileSync(join(r, p), body);
  }
  return r;
}

describe("council catalog drift", () => {
  const base = { "_council-experts/hunt/review-aura.md": "a", "council-plan/SKILL.md": "b" };

  it("identical trees report nothing; backups, caches and non-council skills are ignored", () => {
    const repo = root(base);
    const box = root({ ...base, "council-plan/SKILL.md.bak-2026-10-19": "old", "_council-experts/.verify/__pycache__/x.pyc": "c", "synced/x.md": "y" });
    expect(treeDrift(hashCouncilTrees(repo), hashCouncilTrees(box))).toEqual([]);
  });

  it("an edit on the box, a file only on the box and a file only in the repo are each reported", () => {
    const repo = root({ ...base, "council-review/SKILL.md": "r" });
    const box = root({ ...base, "council-plan/SKILL.md": "edited on box", "_council-experts/new/meta.yaml": "n" });
    expect(treeDrift(hashCouncilTrees(repo), hashCouncilTrees(box))).toEqual([
      "differs: council-plan/SKILL.md",
      "only in repo: council-review/SKILL.md",
      "only on box: _council-experts/new/meta.yaml",
    ]);
  });
});
