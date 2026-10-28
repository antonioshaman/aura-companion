// The repo's own `.agents/skills/council-{plan,review,implement}` (what Codex and the
// repo-local skill loader see in this checkout) must be byte-identical to the shipped
// copies in `packs/skills/`. Before B5 they had drifted: no references/, an older
// SKILL.md, and the hard-coded ~/.claude/skills/_council-experts path. This test keeps
// a later edit to one side from silently leaving the other behind.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { readTree, sha256 } from "../server/skill-manifest.js";

const REPO = resolve(import.meta.dirname, "..", "..");
const SYNCED = ["council-plan", "council-review", "council-implement"];

const digests = (dir: string) => Object.fromEntries([...readTree(dir)].map(([p, b]) => [p, sha256(b)]));

describe(".agents/skills council copies follow packs/skills (B5)", () => {
  it.each(SYNCED)("%s is byte-identical to packs/skills/%s", (name) => {
    expect(digests(resolve(REPO, ".agents", "skills", name))).toEqual(digests(resolve(REPO, "packs", "skills", name)));
  });
});
