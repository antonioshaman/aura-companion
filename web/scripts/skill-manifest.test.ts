// Tests for the shipped skills manifest generator (PLAN Task 5, spec AC2.2–AC2.4).
//
// Pure-core tests build an in-memory pack and plant one defect each — an undeclared
// dir, a stray root file, a vendored skill missing from the lock, a pending review,
// a known issue, a bad licence file, a case-only name clash — and assert the build
// goes red (structural error) or the entry is blocked (ship gate) for that reason.
// The last block checks the REAL packs/skills tree against the committed manifest.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { filesDigest, hashTree, OWNER_MARKER_FILE } from "../server/skill-manifest.js";
import {
  buildManifest,
  excludedReason,
  frontmatterName,
  MANIFEST_FILE,
  readInput,
  serialiseManifest,
  type ManifestInput,
  type PackDecl,
} from "./skill-manifest.js";
import { instructionInventory, networkInventory, type VendoredSkill } from "./vendored-skills.js";

const LICENSE = "MIT License\n\nCopyright (c) 2026 Someone\n";
const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));

function vendoredTree() {
  return files({ "SKILL.md": "---\nname: \"pretty-name\"\n---\nbody\n", LICENSE });
}
function lockEntry(t: Map<string, Buffer>, over: Partial<VendoredSkill> = {}): VendoredSkill {
  const hashes = hashTree(t);
  return {
    name: "vend",
    upstream: { repo: "o/vend", path: "skills/vend", commit: "a".repeat(40) },
    licence: { spdx: "MIT", copyright: "Copyright (c) 2026 Someone", file: "LICENSE" },
    network: networkInventory(t),
    instructionHosts: instructionInventory(t),
    runtimeCapabilities: {},
    knownIssues: [],
    files: hashes,
    humanReview: {
      status: "approved", basis: "human-read", reviewer: "t", date: "2026-10-27", notes: "",
      reviewedCommit: "a".repeat(40), reviewedDigest: filesDigest(hashes),
    },
    ...over,
  };
}

function input(over: { pack?: Partial<PackDecl>; lockSkill?: VendoredSkill | null } & Partial<ManifestInput> = {}): ManifestInput {
  const vt = vendoredTree();
  const pack: PackDecl = {
    _doc: "",
    schemaVersion: 1,
    firstParty: { repo: "o/aura", licence: "MIT", licenceFile: "LICENSE" },
    entries: [
      { name: "mine", kind: "skill", origin: "first-party", compat: { claude: true, codex: true } },
      { name: "vend", kind: "skill", origin: "vendored", compat: { claude: true, codex: false, note: "claude-only" } },
    ],
    ...over.pack,
  };
  const lockSkill = over.lockSkill === undefined ? lockEntry(vt) : over.lockSkill;
  return {
    pack,
    lock: { _doc: "", skills: lockSkill ? [lockSkill] : [] },
    rootDirs: over.rootDirs ?? ["mine", "vend"],
    rootFiles: over.rootFiles ?? ["pack.json", "vendor-lock.json"],
    trees: over.trees ?? new Map([["mine", files({ "SKILL.md": "---\nname: mine\n---\n" })], ["vend", vt]]),
    repoLicenceText: over.repoLicenceText === undefined ? LICENSE : over.repoLicenceText,
  };
}

const entry = (i: ManifestInput, name: string) => buildManifest(i).manifest.entries.find((e) => e.name === name)!;

describe("buildManifest — a clean pack", () => {
  it("lists every entry with source, licence verdict, compat, ship gate and per-file hashes", () => {
    const { manifest, errors } = buildManifest(input());
    expect(errors).toEqual([]);
    expect(manifest.entries.map((e) => e.name)).toEqual(["mine", "vend"]);
    const v = manifest.entries[1];
    expect(v.source).toEqual({ type: "vendored", repo: "o/vend", path: "skills/vend", commit: "a".repeat(40) });
    expect(v.licence).toEqual({ spdx: "MIT", verdict: "shippable" });
    expect(v.ship).toEqual({ status: "ship", reasons: [] });
    expect(v.frontmatterName).toBe("pretty-name");
    expect(v.digest).toBe(filesDigest(v.files));
    expect(Object.keys(v.files)).toEqual(["LICENSE", "SKILL.md"]);
    expect(manifest.entries[0].source).toEqual({ type: "first-party", repo: "o/aura" });
    expect(manifest.entries[0].frontmatterName).toBeNull();
  });
});

// PLAN Task 9 / B1 decision 7: the package carries no dev-only files (canary
// scripts, evals, upstream test suites, fixtures, VCS metadata), and the manifest
// must hash EXACTLY what ships — otherwise an installed copy never matches its
// manifest and ownership() reads every Aura copy as the user's.
describe("buildManifest — the shipped set excludes dev-only files (Task 9)", () => {
  it("names a reason for each excluded path and keeps everything else", () => {
    for (const p of [".verify/c2.py", ".verify/verify-catalog.sh", "a/.gitignore", ".gitignore", "evals/evals.json",
      "scripts/tests/test_core.py", "x/__fixtures__/a.json", ".git/HEAD", "x/__tests__/a.ts"]) {
      expect(excludedReason(p), p).toEqual(expect.any(String));
    }
    // Runtime data the selection engine reads stays, and only whole path segments match.
    for (const p of ["SKILL.md", ".verify/capability-vocabulary.json", "references/tests-guide.md", "scripts/search.py", "evals.md"]) {
      expect(excludedReason(p), p).toBeNull();
    }
  });

  it("hashes only the shipped files and reports the rest", () => {
    const mine = files({ "SKILL.md": "---\nname: mine\n---\n", "evals/e.json": "{}", ".gitignore": "x\n" });
    const { manifest, errors, excluded } = buildManifest(input({ trees: new Map([["mine", mine], ["vend", vendoredTree()]]) }));
    expect(errors).toEqual([]);
    const e = manifest.entries.find((x) => x.name === "mine")!;
    expect(Object.keys(e.files)).toEqual(["SKILL.md"]);
    expect(e.digest).toBe(filesDigest(e.files));
    expect(excluded).toEqual([
      { entry: "mine", path: ".gitignore", reason: expect.any(String) },
      { entry: "mine", path: "evals/e.json", reason: expect.any(String) },
    ]);
  });

  it("a vendored skill is still checked against its lock over the FULL tree", () => {
    // The lock pins every upstream byte (tests included); excluding a file from the
    // package must not hide drift in it from the vendored-skills gate.
    const vt = vendoredTree();
    vt.set("scripts/tests/t.py", Buffer.from("ok\n"));
    const lockSkill = lockEntry(vt);
    const drifted = new Map(vt);
    drifted.set("scripts/tests/t.py", Buffer.from("tampered\n"));
    const ok = buildManifest(input({ lockSkill, trees: new Map([["mine", files({ "SKILL.md": "x" })], ["vend", vt]]) }));
    expect(ok.manifest.entries[1].ship.status).toBe("ship");
    expect(Object.keys(ok.manifest.entries[1].files)).toEqual(["LICENSE", "SKILL.md"]);
    const bad = buildManifest(input({ lockSkill, trees: new Map([["mine", files({ "SKILL.md": "x" })], ["vend", drifted]]) }));
    expect(bad.manifest.entries[1].ship.status).toBe("blocked");
  });

  it("an entry left with no shipped files is a structural error", () => {
    const { errors } = buildManifest(input({ trees: new Map([["mine", files({ "evals/a.json": "{}" })], ["vend", vendoredTree()]]),
      pack: { entries: [{ name: "mine", kind: "catalog", origin: "first-party", compat: { claude: true, codex: true } },
        { name: "vend", kind: "skill", origin: "vendored", compat: { claude: true, codex: false, note: "n" } }] } }));
    expect(errors.join("\n")).toMatch(/mine: every file is excluded/);
  });
});

describe("buildManifest — ship gate blocks, with a reason (AC2.4)", () => {
  it("a pending human review blocks the vendored skill", () => {
    const t = vendoredTree();
    const i = input({ lockSkill: lockEntry(t, { humanReview: { status: "pending", reviewer: null, date: null, notes: "" } }) });
    expect(entry(i, "vend").ship).toEqual({ status: "blocked", reasons: ["human review pending"] });
  });

  it("a rejected review blocks it", () => {
    const t = vendoredTree();
    const i = input({ lockSkill: lockEntry(t, { humanReview: { status: "rejected", reviewer: "x", date: null, notes: "" } }) });
    expect(entry(i, "vend").ship.reasons).toEqual(["human review rejected this skill"]);
  });

  it("a non-empty knownIssues list blocks it even when approved", () => {
    const i = input({ lockSkill: lockEntry(vendoredTree(), { knownIssues: ["path breaks"] }) });
    expect(entry(i, "vend").ship).toEqual({ status: "blocked", reasons: ["known issue: path breaks"] });
  });

  it("bytes drifting from the lock block it", () => {
    const i = input();
    i.trees.get("vend")!.set("SKILL.md", Buffer.from("tampered"));
    expect(entry(i, "vend").ship.reasons).toContain("SKILL.md sha256 differs from the lock");
  });

  it("a non-shippable vendored licence is verdict not-shippable and blocked", () => {
    const i = input({ lockSkill: lockEntry(vendoredTree(), { licence: { spdx: "GPL-3.0-only", copyright: "Copyright (c) 2026 Someone", file: "LICENSE" } }) });
    const v = entry(i, "vend");
    expect(v.licence.verdict).toBe("not-shippable");
    expect(v.ship.status).toBe("blocked");
  });

  it("a missing repo licence file blocks first-party entries", () => {
    const m = entry(input({ repoLicenceText: null }), "mine");
    expect(m.licence.verdict).toBe("not-shippable");
    expect(m.ship.reasons).toEqual(["repo licence file LICENSE is missing"]);
  });

  it("a repo licence file that is not the declared licence blocks first-party entries", () => {
    expect(entry(input({ repoLicenceText: "Apache License\n" }), "mine").ship.reasons).toEqual(['repo licence file does not start with "MIT License"']);
  });
});

describe("buildManifest — structural errors (nothing ships unaccounted)", () => {
  it("an undeclared dir in packs/skills", () => {
    const i = input({ rootDirs: ["mine", "vend", "sneaky"] });
    expect(buildManifest(i).errors).toContain("sneaky/ is in packs/skills but not declared in pack.json");
  });

  it("a stray root file", () => {
    expect(buildManifest(input({ rootFiles: ["pack.json", "notes.txt"] })).errors).toContain(
      "notes.txt at the packs/skills root is not an allowed root file",
    );
  });

  it("a declared entry whose dir is missing", () => {
    expect(buildManifest(input({ rootDirs: ["vend"] })).errors).toContain("mine is declared in pack.json but packs/skills/mine/ does not exist");
  });

  it("a vendored declaration with no lock entry", () => {
    expect(buildManifest(input({ lockSkill: null })).errors).toContain("vend is declared vendored but has no vendor-lock.json entry");
  });

  it("a lock entry not declared as vendored", () => {
    const i = input();
    i.pack.entries[1] = { ...i.pack.entries[1], origin: "first-party" };
    expect(buildManifest(i).errors).toContain("vend is in vendor-lock.json but not declared as vendored in pack.json");
  });

  it("a false compat flag with no note", () => {
    const i = input();
    i.pack.entries[1] = { ...i.pack.entries[1], compat: { claude: true, codex: false } };
    expect(buildManifest(i).errors).toContain("vend: compat has a false flag but no note saying why");
  });

  it("a committed ownership marker", () => {
    const i = input();
    i.trees.get("mine")!.set(OWNER_MARKER_FILE, Buffer.from("{}"));
    expect(buildManifest(i).errors).toContain(`mine: ${OWNER_MARKER_FILE} must never be committed into the pack`);
  });

  it("a skill with no SKILL.md", () => {
    const i = input({ trees: new Map([["mine", files({ "x.md": "" })], ["vend", vendoredTree()]]) });
    expect(buildManifest(i).errors).toContain("mine: kind skill but no SKILL.md");
  });

  it("a frontmatter name that clashes case-insensitively with another entry's dir", () => {
    // Why: Codex invokes by the frontmatter name, so two entries answering to the
    // same name (after case folding) would shadow each other.
    const i = input({ trees: new Map([["mine", files({ "SKILL.md": "---\nname: Vend\n---\n" })], ["vend", vendoredTree()]]) });
    expect(buildManifest(i).errors).toContain('"vend" collides with "Vend" (case-insensitive)');
  });
});

describe("frontmatterName", () => {
  it("reads plain, quoted and absent names", () => {
    expect(frontmatterName("---\nname: a-b\ndescription: x\n---\n")).toBe("a-b");
    expect(frontmatterName("---\nname: 'a-b'\n---\n")).toBe("a-b");
    expect(frontmatterName("no frontmatter\nname: x\n")).toBeNull();
  });
});

describe("the real packs/skills tree", () => {
  it("matches the committed skills-manifest.json, with no structural errors", () => {
    const { manifest, errors } = buildManifest(readInput().input);
    expect(errors).toEqual([]);
    expect(serialiseManifest(manifest)).toBe(readFileSync(MANIFEST_FILE, "utf8"));
  });

  it("the phase-B gate holds: nothing with a pending review or a known issue ships", () => {
    // Why: owner rule for Phase B — humanReview != approved or a non-empty
    // knownIssues list means the skill does not ship (ui-ux-pro-max today).
    const { input: inp } = readInput();
    const { manifest } = buildManifest(inp);
    for (const s of inp.lock.skills) {
      const e = manifest.entries.find((x) => x.name === s.name)!;
      if (s.humanReview.status !== "approved" || s.knownIssues.length) expect(e.ship.status, s.name).toBe("blocked");
    }
    expect(manifest.entries.find((e) => e.name === "ui-ux-pro-max")?.ship.status).toBe("blocked");
  });

  it("the committed manifest lists no excluded file, and the catalog keeps its runtime vocabulary", () => {
    const m = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as { entries: Array<{ name: string; files: Record<string, string> }> };
    for (const e of m.entries) for (const p of Object.keys(e.files)) expect(excludedReason(p), `${e.name}/${p}`).toBeNull();
    const cat = m.entries.find((e) => e.name === "_council-experts")!;
    expect(cat.files[".verify/capability-vocabulary.json"]).toEqual(expect.any(String));
    expect(cat.files[".verify/verify-catalog.sh"]).toBeUndefined();
  });
});
