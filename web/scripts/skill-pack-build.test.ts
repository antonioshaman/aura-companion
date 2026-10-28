// Tests for the npm-package side of the skill pack (PLAN Task 9, spec AC2.1/AC2.4).
//
// gatePackage is the fail-closed package gate CI runs on `npm pack --json`: each
// test plants one defect in an otherwise clean listing — over budget, a blocked
// skill's file, a dev-only file, a missing shipped file, a missing licence, a
// shipped entry whose licence is not shippable — and asserts the gate goes red for
// that reason. stagePack is checked against a temp source: it copies exactly the
// shipped set and refuses bytes that differ from the manifest. The last block runs
// against the REAL packs/skills and package.json.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { filesDigest, sha256, type ManifestEntry, type SkillManifest } from "../server/skill-manifest.js";
import {
  cleanStaged,
  freshManifest,
  gatePackage,
  PACK_BUDGET_BYTES,
  PACKAGED_PACK_REL,
  shippedPaths,
  stagePack,
  type PackListing,
} from "./skill-pack-build.js";

function entry(name: string, files: Record<string, string>, over: Partial<ManifestEntry> = {}): ManifestEntry {
  const hashes = Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha256(b)]));
  return {
    name, frontmatterName: null, kind: "skill",
    source: { type: "first-party", repo: "o/aura" },
    licence: { spdx: "MIT", verdict: "shippable" },
    compat: { claude: true, codex: true },
    ship: { status: "ship", reasons: [] },
    digest: filesDigest(hashes), files: hashes, ...over,
  };
}

const SHIP = { "SKILL.md": "ship me\n", "references/a.md": "a\n" };
const BLOCKED = { "SKILL.md": "blocked\n" };
const manifest = (extra: Partial<ManifestEntry> = {}): SkillManifest => ({
  _doc: "", schemaVersion: 1,
  entries: [entry("good", SHIP, extra), entry("held", BLOCKED, { ship: { status: "blocked", reasons: ["known issue: x"] } })],
});

const P = PACKAGED_PACK_REL;
function cleanListing(): PackListing {
  return {
    size: 3_000_000,
    files: ["package.json", "server/index.ts", `${P}/skills-manifest.json`, `${P}/THIRD_PARTY_NOTICES.md`, `${P}/LICENSE`,
      `${P}/good/SKILL.md`, `${P}/good/references/a.md`].map((path) => ({ path })),
  };
}
const withFile = (path: string): PackListing => ({ ...cleanListing(), files: [...cleanListing().files, { path }] });
const without = (path: string): PackListing => ({ ...cleanListing(), files: cleanListing().files.filter((f) => f.path !== path) });

describe("shippedPaths", () => {
  it("lists the root files and only ship entries' files", () => {
    expect([...shippedPaths(manifest()).keys()].sort()).toEqual(
      ["LICENSE", "THIRD_PARTY_NOTICES.md", "good/SKILL.md", "good/references/a.md", "skills-manifest.json"]);
  });
});

describe("gatePackage — fails closed", () => {
  it("passes a clean package and still names what it left out, and why", () => {
    const { errors, notes } = gatePackage(cleanListing(), manifest());
    expect(errors).toEqual([]);
    expect(notes.join("\n")).toMatch(/not shipped: held\n\s+- known issue: x/);
  });

  it("fails over the 15 MB budget", () => {
    expect(PACK_BUDGET_BYTES).toBe(15_000_000);
    const { errors } = gatePackage({ ...cleanListing(), size: 15_000_001 }, manifest());
    expect(errors.join("\n")).toMatch(/over the 15\.00 MB budget/);
  });

  it("fails when npm reports no size (never a silent pass)", () => {
    expect(gatePackage({ ...cleanListing(), size: 0 }, manifest()).errors.join("\n")).toMatch(/no packed size/);
  });

  it("fails when a blocked entry's file is packed", () => {
    expect(gatePackage(withFile(`${P}/held/SKILL.md`), manifest()).errors.join("\n")).toMatch(/held is blocked and must not ship/);
  });

  it("fails on a pack file outside the shipped set (e.g. an excluded dev file)", () => {
    expect(gatePackage(withFile(`${P}/good/notes.txt`), manifest()).errors.join("\n")).toMatch(/not in the shipped set/);
  });

  it("fails on dev-only trees anywhere in the package, except the catalog's runtime vocabulary", () => {
    for (const p of ["evals/ci-baseline.json", "server/__fixtures__/a.json", `${P}/_council-experts/.verify/c2.py`]) {
      expect(gatePackage(withFile(p), manifest()).errors.join("\n"), p).toMatch(/dev-only file/);
    }
    const vocab = `${P}/_council-experts/.verify/capability-vocabulary.json`;
    expect(gatePackage(withFile(vocab), manifest()).errors.join("\n")).not.toMatch(/dev-only/);
  });

  it("fails when a shipped file, the licence or the notices are missing", () => {
    for (const p of [`${P}/good/references/a.md`, `${P}/LICENSE`, `${P}/THIRD_PARTY_NOTICES.md`, `${P}/skills-manifest.json`]) {
      expect(gatePackage(without(p), manifest()).errors.join("\n"), p).toMatch(/shipped file\(s\) missing/);
    }
  });

  it("fails when an entry marked ship has a non-shippable licence or recorded reasons", () => {
    expect(gatePackage(cleanListing(), manifest({ licence: { spdx: "GPL-3.0", verdict: "not-shippable" } })).errors.join("\n"))
      .toMatch(/licence GPL-3.0 is not-shippable/);
    expect(gatePackage(cleanListing(), manifest({ ship: { status: "ship", reasons: ["pending review"] } })).errors.join("\n"))
      .toMatch(/marked ship but has reasons/);
  });

  it("fails a package with no skill pack at all (what main packs today)", () => {
    const bare: PackListing = { size: 3_000_000, files: [{ path: "package.json" }, { path: "server/index.ts" }] };
    const errs = gatePackage(bare, manifest()).errors.join("\n");
    for (const want of ["skills-manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "good/"]) expect(errs).toContain(`${P}/${want}: `);
  });
});

describe("stagePack / cleanStaged", () => {
  function source(): { src: string; licence: string } {
    const root = mkdtempSync(join(tmpdir(), "pack-build-"));
    const src = join(root, "skills");
    for (const [rel, body] of [...Object.entries(SHIP).map(([p, b]) => [`good/${p}`, b]), ["held/SKILL.md", BLOCKED["SKILL.md"]],
      ["good/evals/e.json", "{}"], ["skills-manifest.json", "{}\n"], ["THIRD_PARTY_NOTICES.md", "n\n"]]) {
      mkdirSync(join(src, rel, ".."), { recursive: true });
      writeFileSync(join(src, rel), body);
    }
    writeFileSync(join(root, "LICENSE"), "MIT License\n");
    return { src, licence: join(root, "LICENSE") };
  }
  const list = (d: string): string[] => {
    const out: string[] = [];
    const walk = (x: string) => { for (const n of readdirSync(x, { withFileTypes: true })) n.isDirectory() ? walk(join(x, n.name)) : out.push(relative(d, join(x, n.name))); };
    walk(d);
    return out.sort();
  };

  it("copies exactly the shipped set: no blocked entry, no file outside the manifest", () => {
    const { src, licence } = source();
    const out = join(src, "..", "staged", "packs", "skills");
    expect(stagePack({ sourceDir: src, out, manifest: manifest(), licenceFile: licence })).toBe(5);
    expect(list(out)).toEqual(["LICENSE", "THIRD_PARTY_NOTICES.md", "good/SKILL.md", "good/references/a.md", "skills-manifest.json"]);
    expect(readFileSync(join(out, "LICENSE"), "utf8")).toBe("MIT License\n");
    // Re-staging replaces the previous stage atomically.
    expect(stagePack({ sourceDir: src, out, manifest: manifest(), licenceFile: licence })).toBe(5);
  });

  it("refuses source bytes that differ from the manifest and leaves no stage behind", () => {
    const { src, licence } = source();
    writeFileSync(join(src, "good", "references", "a.md"), "tampered\n");
    const out = join(src, "..", "staged2");
    expect(() => stagePack({ sourceDir: src, out, manifest: manifest(), licenceFile: licence })).toThrow(/bytes differ/);
    expect(existsSync(out)).toBe(false);
  });

  it("cleanStaged refuses a dir that is not a staged pack", () => {
    const d = mkdtempSync(join(tmpdir(), "not-a-pack-"));
    writeFileSync(join(d, "keep.txt"), "x");
    expect(() => cleanStaged(d)).toThrow(/not a staged skill pack/);
    expect(existsSync(join(d, "keep.txt"))).toBe(true);
  });
});

describe("the real pack and package.json", () => {
  it("the committed manifest is fresh, and a package carrying its shipped set passes the gate", () => {
    const fresh = freshManifest();
    if ("error" in fresh) throw new Error(fresh.error);
    const listing: PackListing = { size: 4_000_000, files: [...shippedPaths(fresh.manifest).keys()].map((r) => ({ path: `${P}/${r}` })) };
    expect(gatePackage(listing, fresh.manifest).errors).toEqual([]);
    // B5: ui-ux-pro-max ships now that its CLAUDE_PLUGIN_ROOT canary is green — but
    // never its upstream test suite (dev-only, excluded before hashing).
    const uiux = [...shippedPaths(fresh.manifest).keys()].filter((p) => p.startsWith("ui-ux-pro-max/"));
    expect(uiux).toContain("ui-ux-pro-max/scripts/search.py");
    expect(uiux.some((p) => p.includes("/tests/"))).toBe(false);
  });

  it("package.json ships packs/ and stages / cleans it around every pack", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { files: string[]; scripts: Record<string, string> };
    expect(pkg.files).toContain("packs/");
    expect(pkg.scripts.prepack).toBe("bun scripts/skill-pack-build.ts stage");
    expect(pkg.scripts.postpack).toBe("bun scripts/skill-pack-build.ts clean");
  });

  it("the staged dir is gitignored, so a stage never lands in a commit", () => {
    const gi = readFileSync(join(__dirname, "..", "..", ".gitignore"), "utf8");
    expect(gi.split("\n")).toContain("web/packs/");
  });
});
