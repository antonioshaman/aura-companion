// Tests for spawn-time toolkit exposure (PLAN Task 7; spec AC2.1 "invocable in
// Claude sessions", AC2.2 "Codex: available or labelled 'Requires Claude Code'",
// AC2.3 "the user's skill is the one used", AC2.5 "toggle off → new sessions
// start without it").
//
// decideSkillExposure is the pure decision persisted on the session; every
// precondition that fails must yield "unavailable" with a reason (never a silent
// partial exposure). maintainSkillPack is the boot step, run on real temp dirs.

import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { filesDigest, hashTree, sha256, type ManifestEntry, type SkillManifest } from "./skill-manifest.js";
import { readCurrentPack, type CurrentPack, type ExistingSkill } from "./skill-pack.js";
import {
  _resetPluginDirProbeForTest,
  claudeSupportsPluginDir,
  decideSkillExposure,
  defaultPackSource,
  describeToolkit,
  maintainSkillPack,
  missingRuntimes,
  parseSkillExposure,
  providedNames,
} from "./skill-exposure.js";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "skill-exposure-test-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", d]);
    rmSync(d, { recursive: true, force: true });
  }
  _resetPluginDirProbeForTest();
});

function entry(name: string, over: Partial<ManifestEntry> = {}): ManifestEntry {
  const files = { "SKILL.md": `---\nname: ${name}\n---\nbody\n` };
  const hashes = hashTree(new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));
  return {
    name,
    frontmatterName: null,
    kind: "skill",
    source: { type: "first-party", repo: "antonioshaman/aura-companion" },
    licence: { spdx: "MIT", verdict: "shippable" },
    compat: { claude: true, codex: true },
    ship: { status: "ship", reasons: [] },
    digest: filesDigest(hashes),
    files: hashes,
    ...over,
  };
}

const MANIFEST: SkillManifest = {
  _doc: "test",
  schemaVersion: 1,
  entries: [
    entry("polish"),
    entry("council-plan", { compat: { claude: true, codex: false, note: "Task tool; not verified under Codex." } }),
    entry("_council-experts", { kind: "catalog" }),
    entry("ui-ux-pro-max", { ship: { status: "blocked", reasons: ["knownIssues: CLAUDE_PLUGIN_ROOT"] } }),
    entry("taste-skill"),
  ],
};
const PACK: CurrentPack = { version: "0123456789abcdef", dir: "/x", manifest: MANIFEST };
const userSkill = (name: string): ExistingSkill => ({ name, frontmatterName: null, ownership: { owner: "user", reason: "no ownership marker" } });

const claude = (over: Partial<Parameters<typeof decideSkillExposure>[0]> = {}) =>
  decideSkillExposure({ backend: "claude", enabled: true, containerized: false, cliSupportsPluginDir: true, pack: PACK, existing: [], now: 1, ...over });
const codex = (over: Partial<Parameters<typeof decideSkillExposure>[0]> = {}) =>
  decideSkillExposure({ backend: "codex", enabled: true, containerized: false, pack: PACK, existing: [], now: 1, ...over });

describe("decideSkillExposure", () => {
  it("Claude: provides shipped skills, never the blocked one nor the catalog (not invocable)", () => {
    const e = claude();
    expect(e.status).toBe("on");
    expect(e.version).toBe(PACK.version);
    expect(providedNames(e)).toEqual(["polish", "council-plan", "taste-skill"]);
    expect(e.items.find((i) => i.name === "ui-ux-pro-max")).toMatchObject({ outcome: "blocked-by-gate", reasons: ["knownIssues: CLAUDE_PLUGIN_ROOT"] });
    expect(e.items.find((i) => i.name === "_council-experts")?.outcome).toBe("disabled");
  });

  it("Codex: Claude-only skills are labelled requires-claude with the manifest note, not copied", () => {
    const e = codex();
    expect(providedNames(e)).toEqual(["polish", "_council-experts", "taste-skill"]);
    expect(e.items.find((i) => i.name === "council-plan")).toMatchObject({
      outcome: "requires-claude",
      reasons: ["Task tool; not verified under Codex."],
    });
  });

  it("the user's skill with the same name wins (AC2.3)", () => {
    const e = claude({ existing: [userSkill("Polish")] });
    expect(e.items.find((i) => i.name === "polish")?.outcome).toBe("skip-user-owns");
    expect(providedNames(e)).not.toContain("polish");
  });

  it("toggle off → off, nothing provided (AC2.5)", () => {
    expect(claude({ enabled: false })).toMatchObject({ status: "off", items: [] });
    expect(codex({ enabled: false })).toMatchObject({ status: "off", items: [] });
  });

  it("every missing precondition → unavailable with a reason, nothing provided", () => {
    const cases = [
      claude({ cliSupportsPluginDir: false }),
      claude({ cliSupportsPluginDir: undefined }),
      claude({ containerized: true }),
      codex({ containerized: true }),
      claude({ pack: { error: "no valid current.json" } }),
      codex({ pack: { error: "no valid current.json" } }),
    ];
    for (const e of cases) {
      expect(e.status).toBe("unavailable");
      expect(e.reason).toBeTruthy();
      expect(providedNames(e)).toEqual([]);
    }
  });
});

describe("parseSkillExposure (persisted on the session)", () => {
  it("round-trips a decision", () => {
    const e = claude();
    expect(parseSkillExposure(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it("drops anything malformed rather than trusting it", () => {
    for (const bad of [null, 7, [], {}, { ...claude(), schemaVersion: 2 }, { ...claude(), status: "maybe" }, { ...claude(), items: [7] }, { ...claude(), pluginDir: 3 }]) {
      expect(parseSkillExposure(bad)).toBeUndefined();
    }
  });
});

describe("claudeSupportsPluginDir", () => {
  it("is true only when --help lists the flag, and probes each binary once", () => {
    const run = vi.fn((bin: string) => (bin === "new" ? "  --plugin-dir <path>  Load a plugin" : "  --add-dir <dirs>"));
    expect(claudeSupportsPluginDir("new", run)).toBe(true);
    expect(claudeSupportsPluginDir("new", run)).toBe(true);
    expect(claudeSupportsPluginDir("old", run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a failed probe counts as unsupported (fail closed)", () => {
    expect(claudeSupportsPluginDir("broken", () => null)).toBe(false);
  });
});

describe("describeToolkit (Settings row)", () => {
  it("lists every entry with the per-CLI outcome", () => {
    const v = describeToolkit({ pack: PACK, claudeExisting: [userSkill("taste-skill")], codexExisting: [], claudeSupportsPluginDir: false });
    if (!v.installed) throw new Error("expected installed");
    expect(v.claudeUnavailable).toMatch(/--plugin-dir/);
    const row = (n: string) => v.rows.find((r) => r.name === n)!;
    expect(row("taste-skill").claude.outcome).toBe("skip-user-owns");
    expect(row("taste-skill").codex.outcome).toBe("provide");
    expect(row("council-plan").codex.outcome).toBe("requires-claude");
    expect(row("ui-ux-pro-max").claude.outcome).toBe("blocked-by-gate");
  });

  it("names a runtime the server lacks, with the skills that need it", () => {
    const pack: CurrentPack = { ...PACK, manifest: { ...MANIFEST, entries: [entry("taste-skill", { files: { "SKILL.md": "h", "scripts/lint.mjs": "h" } })] } };
    const v = describeToolkit({ pack, claudeExisting: [], codexExisting: [], claudeSupportsPluginDir: true, hasRuntime: () => false });
    if (!v.installed) throw new Error("expected installed");
    expect(v.missingRuntimes).toEqual([{ runtime: "node", skills: ["taste-skill"] }]);
    const ok = describeToolkit({ pack, claudeExisting: [], codexExisting: [], claudeSupportsPluginDir: true, hasRuntime: () => true });
    expect(ok.installed && ok.missingRuntimes).toBeUndefined();
  });

  it("reports a missing pack instead of an empty list", () => {
    expect(describeToolkit({ pack: { error: "no valid current.json" }, claudeExisting: [], codexExisting: [], claudeSupportsPluginDir: true }))
      .toEqual({ installed: false, error: "no valid current.json", rows: [] });
  });
});

describe("maintainSkillPack (boot)", () => {
  function sourceDir(): string {
    const dir = tmp();
    const e = entry("polish");
    mkdirSync(join(dir, "polish"));
    writeFileSync(join(dir, "polish", "SKILL.md"), "---\nname: polish\n---\nbody\n");
    writeFileSync(join(dir, "skills-manifest.json"), JSON.stringify({ _doc: "t", schemaVersion: 1, entries: [e] }));
    return dir;
  }

  it("installs the shipped pack so new sessions can read it", () => {
    const root = tmp();
    const r = maintainSkillPack({ root, sourceDir: sourceDir(), keepVersions: [], codexSkillDirs: [] });
    expect(r.installed).toMatch(/^[0-9a-f]{16}$/);
    const pack = readCurrentPack(root);
    expect("error" in pack ? pack.error : pack.version).toBe(r.installed);
  });

  it("reports a runtime the shipped skills need but the server lacks (never a silent failure)", () => {
    const dir = sourceDir();
    mkdirSync(join(dir, "polish", "scripts"));
    writeFileSync(join(dir, "polish", "scripts", "run.py"), "print(1)\n");
    const m = JSON.parse(readFileSync(join(dir, "skills-manifest.json"), "utf8")) as SkillManifest;
    m.entries[0].files["scripts/run.py"] = sha256(Buffer.from("print(1)\n"));
    m.entries[0].digest = filesDigest(m.entries[0].files);
    writeFileSync(join(dir, "skills-manifest.json"), JSON.stringify(m));
    const r = maintainSkillPack({ root: tmp(), sourceDir: dir, keepVersions: [], codexSkillDirs: [], hasRuntime: (b) => b !== "python3" });
    expect(r.installed).toMatch(/^[0-9a-f]{16}$/);
    expect(r.missingRuntimes).toEqual([{ runtime: "python3", skills: ["polish"] }]);
  });

  it("no shipped pack (e.g. an npm install before B4) → error, no throw", () => {
    const r = maintainSkillPack({ root: tmp(), sourceDir: tmp(), keepVersions: [undefined], codexSkillDirs: [join(tmp(), "missing")] });
    expect(r.installed).toBeUndefined();
    expect(r.error).toMatch(/skills-manifest\.json/);
  });
});

// PLAN Task 9 "Runtimes": a skill whose scripts need python3 or node must be reported
// when the server lacks that runtime, not fail silently inside a session.
describe("missingRuntimes", () => {
  const m = (entries: ManifestEntry[]): SkillManifest => ({ ...MANIFEST, entries });
  it("derives runtimes from shipped scripts only, never from browser assets or blocked entries", () => {
    const entries = [
      entry("taste-skill", { files: { "SKILL.md": "h", "scripts/lint.mjs": "h", "scripts/lib/cdp.mjs": "h", "assets/base.js": "h" } }),
      entry("ui-ux-pro-max", { files: { "scripts/search.py": "h" }, ship: { status: "blocked", reasons: ["x"] } }),
      entry("py-skill", { files: { "SKILL.md": "h", "scripts/run.py": "h" } }),
      entry("docs-only", { files: { "SKILL.md": "h", "references/a.js": "h" } }),
    ];
    expect(missingRuntimes(m(entries), () => false)).toEqual([
      { runtime: "node", skills: ["taste-skill"] },
      { runtime: "python3", skills: ["py-skill"] },
    ]);
    expect(missingRuntimes(m(entries), (b) => b === "node")).toEqual([{ runtime: "python3", skills: ["py-skill"] }]);
    expect(missingRuntimes(m(entries), () => true)).toEqual([]);
  });
});

// PLAN Task 9: the npm tarball carries the pack at `<package>/packs/skills` (staged by
// prepack); a git clone keeps it at `<repo>/packs/skills`. The packaged location wins
// when it holds a manifest, so an npm install never reaches outside its own package
// (`<package>/../packs` would be `node_modules/packs` — some other package's dir).
describe("defaultPackSource", () => {
  function layout(withPackaged: boolean): { serverDir: string; packaged: string; clone: string } {
    const root = tmp();
    const serverDir = join(root, "web", "server");
    mkdirSync(serverDir, { recursive: true });
    const packaged = join(root, "web", "packs", "skills");
    if (withPackaged) {
      mkdirSync(packaged, { recursive: true });
      writeFileSync(join(packaged, "skills-manifest.json"), "{}");
    }
    return { serverDir, packaged, clone: join(root, "packs", "skills") };
  }

  it("an npm install uses the pack inside its own package", () => {
    const l = layout(true);
    expect(defaultPackSource({}, l.serverDir)).toBe(l.packaged);
  });

  it("a git clone (nothing staged) uses <repo>/packs/skills", () => {
    const l = layout(false);
    expect(defaultPackSource({}, l.serverDir)).toBe(l.clone);
  });

  it("COMPANION_SKILL_PACK_SOURCE overrides both", () => {
    const l = layout(true);
    expect(defaultPackSource({ COMPANION_SKILL_PACK_SOURCE: "/opt/pack" }, l.serverDir)).toBe("/opt/pack");
  });
});
