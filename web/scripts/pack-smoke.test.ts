// Tests for pack-smoke's verdict (PLAN Task 9). The smoke itself installs the real
// tarball and boots the server three times (CI job `package`); here the pure
// judgeRun is pinned: each test hands it the observation a broken artifact would
// produce — no pack in the package, boot did not install it, no --plugin-dir, a
// wrong exposure, the user's skill touched or shadowed, the toggle ignored — and
// asserts the run fails for that reason. A healthy observation passes.

import { describe, expect, it } from "vitest";

import type { ManifestEntry, SkillManifest } from "../server/skill-manifest.js";
import { expectedClaudeSkills, judgeRun, SEEDED_SKILL, type RunObservation } from "./pack-smoke.js";

const e = (name: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  name, frontmatterName: null, kind: "skill", source: { type: "first-party", repo: "o/a" },
  licence: { spdx: "MIT", verdict: "shippable" }, compat: { claude: true, codex: true },
  ship: { status: "ship", reasons: [] }, digest: "d", files: { "SKILL.md": "h" }, ...over,
});
const manifest: SkillManifest = {
  _doc: "", schemaVersion: 1,
  entries: [e("_council-experts", { kind: "catalog" }), e("council-plan"), e(SEEDED_SKILL),
    e("ui-ux-pro-max", { ship: { status: "blocked", reasons: ["known issue"] } })],
};
const argvWith = ["-p", "--plugin-dir", "/h/.companion/skill-pack/exposures/v-abc"];

function obs(kind: RunObservation["kind"], over: Partial<RunObservation> = {}): RunObservation {
  return {
    kind, manifest, packInstalled: true,
    argv: kind === "off" ? ["-p"] : argvWith,
    exposed: kind === "off" ? null : kind === "seeded" ? ["council-plan"] : ["council-plan", SEEDED_SKILL],
    ...(kind === "seeded" ? { seeded: { name: SEEDED_SKILL, before: "aaa", after: "aaa" } } : {}),
    ...(kind === "off" ? {} : { canary: [] }),
    ...over,
  };
}

describe("expectedClaudeSkills", () => {
  it("is every shipped, invocable, Claude-compatible skill — never the catalog or a blocked one", () => {
    expect(expectedClaudeSkills(manifest)).toEqual(["council-plan", SEEDED_SKILL]);
  });
});

describe("judgeRun", () => {
  it("passes healthy plain, seeded and off runs", () => {
    for (const k of ["plain", "seeded", "off"] as const) expect(judgeRun(obs(k)), k).toEqual([]);
  });

  it("fails when the installed package carries no skill pack (main today)", () => {
    expect(judgeRun(obs("plain", { manifest: null }))).toEqual(["the installed package has no packs/skills/skills-manifest.json"]);
  });

  it("fails when boot did not install the pack — including the off run, so 'no --plugin-dir' is never a vacuous pass", () => {
    expect(judgeRun(obs("off", { packInstalled: false })).join()).toMatch(/did not install the pack/);
  });

  it("fails without a recorded spawn", () => {
    expect(judgeRun(obs("plain", { argv: null })).join()).toMatch(/no Claude spawn/);
  });

  it("fails a plain run with no --plugin-dir, or an exposure that misses or adds a skill", () => {
    expect(judgeRun(obs("plain", { argv: ["-p"] })).join()).toMatch(/no --plugin-dir/);
    expect(judgeRun(obs("plain", { exposed: ["council-plan"] })).join()).toMatch(/exposure links/);
    expect(judgeRun(obs("plain", { exposed: ["council-plan", SEEDED_SKILL, "ui-ux-pro-max"] })).join()).toMatch(/exposure links/);
  });

  it("fails a seeded run when the user's skill changed or Aura still exposes its own copy", () => {
    expect(judgeRun(obs("seeded", { seeded: { name: SEEDED_SKILL, before: "aaa", after: "bbb" } })).join()).toMatch(/user's taste-skill changed/);
    expect(judgeRun(obs("seeded", { seeded: { name: SEEDED_SKILL, before: "aaa", after: null } })).join()).toMatch(/changed/);
    expect(judgeRun(obs("seeded", { exposed: ["council-plan", SEEDED_SKILL] })).join()).toMatch(/exposure links/);
  });

  // B5: ui-ux-pro-max ships only while its documented ${CLAUDE_PLUGIN_ROOT} commands
  // run from the installed exposure; a red canary or a canary that never ran fails the smoke.
  it("fails when the ${CLAUDE_PLUGIN_ROOT} canary failed or did not run", () => {
    const red = { skill: "ui-ux-pro-max", ok: false, errors: ["exit 2: python \"${CLAUDE_PLUGIN_ROOT}/...\""] };
    expect(judgeRun(obs("plain", { canary: [red] })).join()).toMatch(/ui-ux-pro-max canary: exit 2/);
    expect(judgeRun(obs("plain", { canary: undefined })).join()).toMatch(/canary did not run/);
    expect(judgeRun(obs("plain", { canary: [{ ...red, ok: true, errors: [] }] }))).toEqual([]);
  });

  it("fails an off run whose spawn argv still has --plugin-dir", () => {
    expect(judgeRun(obs("off", { argv: argvWith })).join()).toMatch(/toolkit is off but the spawn argv has --plugin-dir/);
  });
});
