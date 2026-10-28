// Tests for the ${CLAUDE_PLUGIN_ROOT} canary (B5, owner answer 2). ui-ux-pro-max's
// knownIssue ("the documented script path does not exist once installed") may only be
// cleared while this canary is green. The live test installs the REAL repo pack entry
// into a temp pack root, builds the Claude exposure exactly as a spawn does, and runs
// every concrete documented command from it. The negative test proves the canary is
// not vacuous: the same exposure without the .claude/skills link layer (what B3/B4
// built) fails.

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { SkillManifest } from "../server/skill-manifest.js";
import { ensurePluginExposure, installPack } from "../server/skill-pack.js";
import { documentedCommands, pluginRootSkills, runPluginRootCanary, substitutePluginRoot } from "./plugin-root-canary.js";

const PACK = resolve(import.meta.dirname, "..", "..", "packs", "skills");
const hasPython = spawnSync("sh", ["-c", "command -v python3 || command -v python"]).status === 0;

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", d]);
    rmSync(d, { recursive: true, force: true });
  }
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "canary-test-"));
  tmps.push(d);
  return d;
};

describe("documentedCommands / substitutePluginRoot", () => {
  it("keeps only concrete ${CLAUDE_PLUGIN_ROOT} commands, dropping placeholder templates", () => {
    const md = [
      'python "${CLAUDE_PLUGIN_ROOT}/.claude/skills/x/scripts/s.py" "<query>" --domain <d>',
      'python "${CLAUDE_PLUGIN_ROOT}/.claude/skills/x/scripts/s.py" "spa" --design-system [-p "P"]',
      '  python "${CLAUDE_PLUGIN_ROOT}/.claude/skills/x/scripts/s.py" "keyboard focus" --domain ux',
      'python scripts/s.py "local"',
      "echo ${CLAUDE_PLUGIN_ROOT}",
    ].join("\n");
    expect(documentedCommands(md)).toEqual(['python "${CLAUDE_PLUGIN_ROOT}/.claude/skills/x/scripts/s.py" "keyboard focus" --domain ux']);
  });

  it("substitutes every occurrence, as Claude does in a plugin SKILL.md", () => {
    expect(substitutePluginRoot('a "${CLAUDE_PLUGIN_ROOT}/b" ${CLAUDE_PLUGIN_ROOT}', "/p")).toBe('a "/p/b" /p');
  });
});

describe.skipIf(!hasPython)("ui-ux-pro-max canary from an installed exposure", () => {
  function installUiux(): { root: string; version: string } {
    const m = JSON.parse(readFileSync(join(PACK, "skills-manifest.json"), "utf8")) as SkillManifest;
    const entry = m.entries.find((e) => e.name === "ui-ux-pro-max");
    if (!entry) throw new Error("ui-ux-pro-max missing from the manifest");
    const root = tmp();
    // Forced to ship here so the canary runs independently of the gate it unblocks.
    const { version } = installPack({ sourceDir: PACK, manifest: { entries: [{ ...entry, ship: { status: "ship", reasons: [] } }] }, root });
    return { root, version };
  }

  it("every concrete documented command runs from the exposure: exit 0, output, nothing written to cwd", () => {
    const { root, version } = installUiux();
    const built = ensurePluginExposure({ root, version, names: ["ui-ux-pro-max"] });
    if ("error" in built) throw new Error(built.error);
    expect(pluginRootSkills(built.dir)).toEqual(["ui-ux-pro-max"]);
    const r = runPluginRootCanary(built.dir, "ui-ux-pro-max");
    expect(r.errors).toEqual([]);
    expect(r.runs.length).toBeGreaterThanOrEqual(3);
    expect(r.ok).toBe(true);
  }, 120_000);

  it("fails on a pre-B5 exposure without the .claude/skills link layer", () => {
    const { root, version } = installUiux();
    const old = join(tmp(), "old-exposure");
    mkdirSync(join(old, "skills"), { recursive: true });
    symlinkSync(join(root, "versions", version, "ui-ux-pro-max"), join(old, "skills", "ui-ux-pro-max"));
    chmodSync(old, 0o555);
    const r = runPluginRootCanary(old, "ui-ux-pro-max");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/^exit 2: /);
  }, 120_000);
});
