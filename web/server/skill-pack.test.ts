// Tests for the skill-pack module (PLAN Task 6; spec AC2.1 "every UI/UX skill is
// invocable", AC2.3 "the user's skill is left untouched", AC2.4 "blocked skills do
// not ship", AC2.5 "toggle off → new sessions start without it").
//
// Two halves:
// - planPack: the pure decision. Each test pins one outcome and the input that
//   forces it; a wrong "provide" here is how a user's skill would get shadowed.
// - the effect shell, on real temp dirs (the suite runs as a non-root user, so the
//   read-only modes are actually enforced): the versioned tree, the atomic pointer,
//   the EC-8 sweeps and the marker-guarded copies. Every destructive path is tested
//   with a user-owned dir next to it that must come out byte-identical.

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  filesDigest,
  hashTree,
  OWNER_MARKER_FILE,
  readOwnership,
  readTree,
  type ManifestEntry,
  type Ownership,
  type SkillManifest,
} from "./skill-manifest.js";
import {
  installPack,
  isSafeRelPath,
  listExistingSkills,
  manifestPathErrors,
  PACK_MANIFEST_FILE,
  packVersionId,
  planPack,
  readCurrentPack,
  readPointer,
  sweepCopies,
  sweepPackRoot,
  syncCopies,
  type ExistingSkill,
} from "./skill-pack.js";

const REPO_PACKS = resolve(__dirname, "..", "..", "packs", "skills");

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "skill-pack-test-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  // The trees under test are read-only on purpose; restore write access to clean up.
  for (const d of tmps.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", d]);
    rmSync(d, { recursive: true, force: true });
  }
});

/** Write `files` under `dir` and return the manifest entry describing exactly them. */
function plant(dir: string, name: string, files: Record<string, string>, over: Partial<ManifestEntry> = {}): ManifestEntry {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, p, ".."), { recursive: true });
    writeFileSync(join(dir, name, p), body);
  }
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

/** A source dir (stand-in for packs/skills) with two shippable entries and one blocked. */
function source(): { dir: string; manifest: SkillManifest } {
  const dir = tmp();
  const entries = [
    plant(dir, "polish", { "SKILL.md": "---\nname: polish\n---\nv1\n", "references/a.md": "a\n" }),
    plant(dir, "audit", { "SKILL.md": "---\nname: audit\n---\nv1\n", "scripts/run.py": "print(1)\n" }),
    plant(dir, "blocked-one", { "SKILL.md": "x\n" }, { ship: { status: "blocked", reasons: ["knownIssues: CLAUDE_PLUGIN_ROOT"] } }),
  ];
  return { dir, manifest: { _doc: "test", schemaVersion: 1, entries } };
}

const user = (name: string, frontmatterName: string | null = null): ExistingSkill => ({
  name,
  frontmatterName,
  ownership: { owner: "user", reason: "no ownership marker" },
});

function snapshot(dir: string): Record<string, string> {
  return hashTree(readTree(dir));
}

// ─── planPack ───────────────────────────────────────────────────────────────

describe("planPack", () => {
  it("provides shippable entries and blocks gated ones with the gate's reasons", () => {
    const { manifest } = source();
    const plan = planPack({ manifest, existing: [], enabled: true });
    expect(plan).toEqual([
      { name: "polish", outcome: "provide", reasons: [] },
      { name: "audit", outcome: "provide", reasons: [] },
      { name: "blocked-one", outcome: "blocked-by-gate", reasons: ["knownIssues: CLAUDE_PLUGIN_ROOT"] },
    ]);
  });

  it("a user skill wins on a case-insensitive name clash (macOS/Windows homes)", () => {
    const { manifest } = source();
    const plan = planPack({ manifest, existing: [user("Polish")], enabled: true });
    expect(plan.find((p) => p.name === "polish")).toMatchObject({ outcome: "skip-user-owns" });
    expect(plan.find((p) => p.name === "polish")!.reasons[0]).toContain("Polish");
  });

  it("a clash on the frontmatter name counts too (Codex invokes by it)", () => {
    // taste-skill's dir is `taste-skill` but its frontmatter name differs; a user
    // skill whose own frontmatter name is that one must still win.
    const { manifest } = source();
    manifest.entries[1] = { ...manifest.entries[1], frontmatterName: "design-audit" };
    const plan = planPack({ manifest, existing: [user("my-dir", "design-audit")], enabled: true });
    expect(plan.find((p) => p.name === "audit")?.outcome).toBe("skip-user-owns");
  });

  it("an Aura-owned copy at the destination is not a clash (it is ours to upgrade)", () => {
    const { manifest } = source();
    const aura: Ownership = { owner: "aura", current: false, inManifest: true };
    const plan = planPack({ manifest, existing: [{ name: "polish", frontmatterName: null, ownership: aura }], enabled: true });
    expect(plan.find((p) => p.name === "polish")?.outcome).toBe("provide");
  });

  it("toggle off → every entry is disabled, blocked ones included", () => {
    const { manifest } = source();
    const plan = planPack({ manifest, existing: [], enabled: false });
    expect(new Set(plan.map((p) => p.outcome))).toEqual(new Set(["disabled"]));
  });
});

describe("pure helpers", () => {
  it("packVersionId is order-independent and moves with any entry digest", () => {
    const a = { name: "a", digest: "1".repeat(64) };
    const b = { name: "b", digest: "2".repeat(64) };
    expect(packVersionId([a, b])).toBe(packVersionId([b, a]));
    expect(packVersionId([a, b])).not.toBe(packVersionId([a, { ...b, digest: "3".repeat(64) }]));
    expect(packVersionId([a])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("isSafeRelPath refuses every way out of an entry dir", () => {
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a\\b", "a\0b", OWNER_MARKER_FILE]) {
      expect(isSafeRelPath(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const ok of ["SKILL.md", "references/a.md", ".verify/x.py", "a/.gitignore"]) expect(isSafeRelPath(ok)).toBe(true);
  });

  it("manifestPathErrors flags an unsafe path, a bad name and a lying digest", () => {
    const { manifest } = source();
    manifest.entries[0] = { ...manifest.entries[0], files: { ...manifest.entries[0].files, "../evil": "0".repeat(64) } };
    manifest.entries[1] = { ...manifest.entries[1], name: "../audit" };
    const errs = manifestPathErrors(manifest).join("\n");
    expect(errs).toContain('unsafe file path "../evil"');
    expect(errs).toContain("polish: digest does not match");
    expect(errs).toContain('entry name "../audit"');
  });
});

// ─── The Aura tree ──────────────────────────────────────────────────────────

describe("installPack / readCurrentPack", () => {
  it("builds a read-only version with only the shipped entries and points current at it", () => {
    const { dir, manifest } = source();
    const root = tmp();
    const r = installPack({ sourceDir: dir, manifest, root });
    expect(r.reused).toBe(false);
    expect(readPointer(root)).toEqual({ schemaVersion: 1, version: r.version, previous: null });

    const cur = readCurrentPack(root);
    if ("error" in cur) throw new Error(cur.error);
    expect(cur.manifest.entries.map((e) => e.name)).toEqual(["polish", "audit"]);
    expect(existsSync(join(r.dir, "blocked-one"))).toBe(false);
    expect(readFileSync(join(r.dir, "polish", "references", "a.md"), "utf8")).toBe("a\n");

    expect(statSync(join(r.dir, "audit", "scripts")).mode & 0o777).toBe(0o555);
    expect(statSync(join(r.dir, "audit", "scripts", "run.py")).mode & 0o777).toBe(0o444);
    // The point of read-only (B1 observer STOP): a skill script run from the tree
    // cannot drop a __pycache__ into it and make the copy unprovable.
    expect(() => mkdirSync(join(r.dir, "audit", "scripts", "__pycache__"))).toThrow(/EACCES/);
  });

  it("a second install of the same set reuses the verified dir and keeps the pointer", () => {
    const { dir, manifest } = source();
    const root = tmp();
    const a = installPack({ sourceDir: dir, manifest, root });
    const b = installPack({ sourceDir: dir, manifest, root });
    expect(b).toEqual({ ...a, reused: true });
    expect(readPointer(root)?.previous).toBeNull();
  });

  it("an upgrade records the old version as previous and leaves it intact", () => {
    const { dir, manifest } = source();
    const root = tmp();
    const v1 = installPack({ sourceDir: dir, manifest, root });
    manifest.entries[0] = plant(dir, "polish", { "SKILL.md": "---\nname: polish\n---\nv2\n", "references/a.md": "a\n" });
    const v2 = installPack({ sourceDir: dir, manifest, root });
    expect(v2.version).not.toBe(v1.version);
    expect(readPointer(root)).toMatchObject({ version: v2.version, previous: v1.version });
    expect(readFileSync(join(v1.dir, "polish", "SKILL.md"), "utf8")).toContain("v1");
  });

  it("fails closed when a source file drifted from the manifest: no pointer, no leftovers", () => {
    const { dir, manifest } = source();
    const root = tmp();
    writeFileSync(join(dir, "audit", "scripts", "run.py"), "print('tampered')\n");
    expect(() => installPack({ sourceDir: dir, manifest, root })).toThrow(/audit\/scripts\/run.py: source bytes do not match/);
    expect(readPointer(root)).toBeNull();
    // Staging dir and its intent were both cleaned up on the failure path.
    expect(readTree(join(root, "versions")).size).toBe(0);
  });

  it("refuses a symlinked source file (it could point anywhere)", () => {
    const { dir, manifest } = source();
    const root = tmp();
    const outside = join(tmp(), "secret");
    writeFileSync(outside, "a\n"); // same bytes as the real file, so only the link check can catch it
    rmSync(join(dir, "polish", "references", "a.md"));
    symlinkSync(outside, join(dir, "polish", "references", "a.md"));
    expect(() => installPack({ sourceDir: dir, manifest, root })).toThrow(/not a regular file/);
  });

  it("refuses an unsafe manifest before writing anything", () => {
    const { dir, manifest } = source();
    const root = tmp();
    manifest.entries[0] = { ...manifest.entries[0], files: { "../../escape": "0".repeat(64) } };
    expect(() => installPack({ sourceDir: dir, manifest, root })).toThrow(/unsafe to install/);
    expect(existsSync(join(root, "versions"))).toBe(false);
  });

  it("a damaged version dir is reported by readCurrentPack and rebuilt by the next install", () => {
    const { dir, manifest } = source();
    const root = tmp();
    const r = installPack({ sourceDir: dir, manifest, root });
    chmodSync(join(r.dir, "audit", "scripts"), 0o755);
    mkdirSync(join(r.dir, "audit", "scripts", "__pycache__"));
    const cur = readCurrentPack(root);
    expect("error" in cur && cur.error).toContain("unread dir audit/scripts/__pycache__");

    const again = installPack({ sourceDir: dir, manifest, root });
    expect(again.reused).toBe(false);
    expect("manifest" in readCurrentPack(root)).toBe(true);
  });

  it("a version whose manifest has a malformed entry is an error, not a throw (observer STOP 1)", () => {
    // `entries: [{}]` used to reach Object.keys(e.files) and throw a TypeError out of
    // readCurrentPack, so a caller could not fall back and installPack could not repair it.
    const { dir, manifest } = source();
    const root = tmp();
    const r = installPack({ sourceDir: dir, manifest, root });
    chmodSync(r.dir, 0o755);
    chmodSync(join(r.dir, PACK_MANIFEST_FILE), 0o644);
    // `{}` and `null` (follow-up review): both must come back as an error, not a throw.
    for (const bad of [{}, null, 7, []]) {
      writeFileSync(join(r.dir, PACK_MANIFEST_FILE), JSON.stringify({ schemaVersion: 1, entries: [bad] }));
      const cur = readCurrentPack(root);
      expect("error" in cur && cur.error, JSON.stringify(bad)).toContain("malformed entry");
    }
    expect(installPack({ sourceDir: dir, manifest, root }).reused).toBe(false);
    expect("manifest" in readCurrentPack(root)).toBe(true);
  });

  it("a failed rebuild of a damaged version leaves that version dir in place (observer STOP 2)", () => {
    // The damaged dir used to be deleted BEFORE the replacement was staged; a failing
    // rebuild then left current.json pointing at nothing.
    const { dir, manifest } = source();
    const root = tmp();
    const r = installPack({ sourceDir: dir, manifest, root });
    chmodSync(join(r.dir, "polish"), 0o755);
    writeFileSync(join(r.dir, "polish", "extra.md"), "damage\n");
    writeFileSync(join(dir, "audit", "scripts", "run.py"), "drifted\n");
    expect(() => installPack({ sourceDir: dir, manifest, root })).toThrow(/source bytes do not match/);
    expect(readPointer(root)?.version).toBe(r.version);
    expect(readFileSync(join(r.dir, "polish", "SKILL.md"), "utf8")).toContain("v1");
    expect(readdirSync(join(root, "versions"))).toEqual([r.version]);
  });

  it("ships exactly the gate-passing entries of the real packs/skills manifest", () => {
    // AC2.1 / AC2.4 against the real tree: everything with ship.status "ship" lands,
    // ui-ux-pro-max (blocked until B3/B4) does not.
    const manifest = JSON.parse(readFileSync(join(REPO_PACKS, "skills-manifest.json"), "utf8")) as SkillManifest;
    const root = tmp();
    const r = installPack({ sourceDir: REPO_PACKS, manifest, root });
    const cur = readCurrentPack(root);
    if ("error" in cur) throw new Error(cur.error);
    const shipped = manifest.entries.filter((e) => e.ship.status === "ship").map((e) => e.name);
    expect(cur.manifest.entries.map((e) => e.name)).toEqual(shipped);
    expect(shipped).not.toContain("ui-ux-pro-max");
    expect(existsSync(join(r.dir, "ui-ux-pro-max"))).toBe(false);
    expect(existsSync(join(r.dir, PACK_MANIFEST_FILE))).toBe(true);
  });
});

describe("sweepPackRoot (EC-8)", () => {
  /** A pid that is certainly gone: a child that already exited. */
  const deadPid = () => spawnSync("true").pid!;

  it("removes staging whose writer is gone, keeps live and unproven staging", () => {
    const root = tmp();
    const v = join(root, "versions");
    mkdirSync(join(v, ".staging-dead"), { recursive: true });
    writeFileSync(join(v, ".staging-dead.json"), JSON.stringify({ pid: deadPid(), startedAt: Date.now() }));
    mkdirSync(join(v, ".staging-live"));
    writeFileSync(join(v, ".staging-live.json"), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    mkdirSync(join(v, ".staging-nointent"));

    const r = sweepPackRoot(root);
    expect(r.removedStaging).toEqual([join(v, ".staging-dead")]);
    expect(existsSync(join(v, ".staging-dead.json"))).toBe(false);
    expect(existsSync(join(v, ".staging-live"))).toBe(true);
    expect(existsSync(join(v, ".staging-nointent"))).toBe(true);
  });

  it("an intent older than the stale window is swept even if its pid is (recycled and) alive", () => {
    const root = tmp();
    const v = join(root, "versions");
    mkdirSync(join(v, ".staging-old"), { recursive: true });
    writeFileSync(join(v, ".staging-old.json"), JSON.stringify({ pid: process.ppid, startedAt: 0 }));
    expect(sweepPackRoot(root).removedStaging).toHaveLength(1);
  });

  it("prunes versions other than current, previous and keep; leftover trash goes too", () => {
    const { dir, manifest } = source();
    const root = tmp();
    const versions: string[] = [];
    for (const body of ["v1", "v2", "v3", "v4"]) {
      manifest.entries[0] = plant(dir, "polish", { "SKILL.md": body });
      versions.push(installPack({ sourceDir: dir, manifest, root }).version);
    }
    mkdirSync(join(root, "versions", `.trash-${versions[0]}-abc`));
    const r = sweepPackRoot(root, { keep: [versions[0]] });
    expect(r.removedVersions).toEqual([versions[1]]);
    expect(existsSync(join(root, "versions", versions[0]))).toBe(true);
    expect(existsSync(join(root, "versions", versions[1]))).toBe(false);
    expect(existsSync(join(root, "versions", `.trash-${versions[0]}-abc`))).toBe(false);
    expect("manifest" in readCurrentPack(root)).toBe(true);
  });

  it("without a valid pointer it cannot tell which version is live, so it removes none", () => {
    const { dir, manifest } = source();
    const root = tmp();
    const r = installPack({ sourceDir: dir, manifest, root });
    writeFileSync(join(root, "current.json"), "{broken");
    expect(sweepPackRoot(root).removedVersions).toEqual([]);
    expect(existsSync(r.dir)).toBe(true);
  });
});

// ─── Copies outside the Aura tree ───────────────────────────────────────────

describe("syncCopies / sweepCopies", () => {
  function setup() {
    const src = source();
    const root = tmp();
    installPack({ sourceDir: src.dir, manifest: src.manifest, root });
    const cur = readCurrentPack(root);
    if ("error" in cur) throw new Error(cur.error);
    const parent = tmp(); // stands in for a Codex home's skills dir
    return { ...src, cur, parent };
  }
  const sync = (s: ReturnType<typeof setup>, enabled = true) =>
    syncCopies({
      parent: s.parent,
      packDir: s.cur.dir,
      manifest: s.cur.manifest,
      plan: planPack({ manifest: s.manifest, existing: listExistingSkills(s.parent, s.cur.manifest), enabled }),
    });

  it("places marked, read-only copies that prove Aura's and current", () => {
    const s = setup();
    const r = sync(s);
    expect(r.placed.sort()).toEqual(["audit", "polish"]);
    expect(readOwnership(join(s.parent, "polish"), "polish", s.cur.manifest)).toEqual({ owner: "aura", current: true, inManifest: true });
    expect(existsSync(join(s.parent, "blocked-one"))).toBe(false);
    expect(statSync(join(s.parent, "polish")).mode & 0o777).toBe(0o555);
    expect(sync(s).unchanged.sort()).toEqual(["audit", "polish"]);
  });

  it("a user skill of the same name is never touched and stays the one used (AC2.3)", () => {
    const s = setup();
    mkdirSync(join(s.parent, "polish"));
    writeFileSync(join(s.parent, "polish", "SKILL.md"), "my own polish\n");
    const before = snapshot(join(s.parent, "polish"));
    const r = sync(s);
    expect(r.placed).toEqual(["audit"]);
    expect(snapshot(join(s.parent, "polish"))).toEqual(before);
    // Off switch: Aura copies go, the user's stays byte-identical.
    const off = sync(s, false);
    expect(off.removed).toEqual(["audit"]);
    expect(snapshot(join(s.parent, "polish"))).toEqual(before);
  });

  it("a copy without a marker but with identical bytes is the user's", () => {
    const s = setup();
    mkdirSync(join(s.parent, "polish"));
    for (const p of Object.keys(s.manifest.entries[0].files)) {
      mkdirSync(join(s.parent, "polish", p, ".."), { recursive: true });
      writeFileSync(join(s.parent, "polish", p), readFileSync(join(s.dir, "polish", p)));
    }
    expect(sync(s, false).removed).toEqual([]);
    expect(existsSync(join(s.parent, "polish", "SKILL.md"))).toBe(true);
  });

  it("upgrades an Aura copy from an older version, but leaves an edited one alone", () => {
    const s = setup();
    sync(s);
    // New pack version: polish changes.
    s.manifest.entries[0] = plant(s.dir, "polish", { "SKILL.md": "---\nname: polish\n---\nv2\n", "references/a.md": "a\n" });
    s.manifest.entries[1] = plant(s.dir, "audit", { "SKILL.md": "---\nname: audit\n---\nv2\n", "scripts/run.py": "print(1)\n" });
    const root = tmp();
    installPack({ sourceDir: s.dir, manifest: s.manifest, root });
    const cur = readCurrentPack(root);
    if ("error" in cur) throw new Error(cur.error);
    // The user edits their (Aura-placed) audit copy: from then on it is theirs.
    chmodSync(join(s.parent, "audit"), 0o755);
    chmodSync(join(s.parent, "audit", "SKILL.md"), 0o644);
    writeFileSync(join(s.parent, "audit", "SKILL.md"), "edited by the user\n");
    const before = snapshot(join(s.parent, "audit"));

    // The edited copy is caught at plan time: it reads as the user's, so it clashes.
    const plan = planPack({ manifest: cur.manifest, existing: listExistingSkills(s.parent, cur.manifest), enabled: true });
    expect(plan.find((p) => p.name === "audit")).toEqual({ name: "audit", outcome: "skip-user-owns", reasons: ['the user\'s skill "audit" has this name'] });
    const r = syncCopies({ parent: s.parent, packDir: cur.dir, manifest: cur.manifest, plan });
    expect(r.replaced).toEqual(["polish"]);
    expect(r.removed).toEqual([]);
    expect(readFileSync(join(s.parent, "polish", "SKILL.md"), "utf8")).toContain("v2");
    expect(snapshot(join(s.parent, "audit"))).toEqual(before);
    // No staging or trash left behind.
    expect(readdirSync(s.parent).sort()).toEqual(["audit", "polish"]);
  });

  it("a copy where a script dropped __pycache__ is not provably Aura's and is not removed", () => {
    const s = setup();
    sync(s);
    chmodSync(join(s.parent, "audit", "scripts"), 0o755);
    mkdirSync(join(s.parent, "audit", "scripts", "__pycache__"));
    writeFileSync(join(s.parent, "audit", "scripts", "__pycache__", "notes.txt"), "user data\n");
    const r = sync(s, false);
    expect(r.removed).toEqual(["polish"]);
    expect(readFileSync(join(s.parent, "audit", "scripts", "__pycache__", "notes.txt"), "utf8")).toBe("user data\n");
  });

  it("an Aura copy whose entry left the manifest is removed; a user dir beside it is not", () => {
    const s = setup();
    sync(s);
    mkdirSync(join(s.parent, "mine"));
    writeFileSync(join(s.parent, "mine", "SKILL.md"), "mine\n");
    const shrunk = { ...s.cur.manifest, entries: s.cur.manifest.entries.filter((e) => e.name !== "audit") };
    const r = syncCopies({
      parent: s.parent,
      packDir: s.cur.dir,
      manifest: shrunk,
      plan: planPack({ manifest: shrunk, existing: listExistingSkills(s.parent, shrunk), enabled: true }),
    });
    expect(r.removed).toEqual(["audit"]);
    expect(readFileSync(join(s.parent, "mine", "SKILL.md"), "utf8")).toBe("mine\n");
  });

  it("sweepCopies removes proven trash, restores unproven trash, removes stale staging", () => {
    const s = setup();
    sync(s);
    // A crash after moving an Aura copy aside: the trash still proves Aura's.
    spawnSync("mv", [join(s.parent, "polish"), join(s.parent, ".aura-trash-polish-0123456789ab")]);
    // A crash after moving aside a dir that a user edited in the window.
    spawnSync("mv", [join(s.parent, "audit"), join(s.parent, ".aura-trash-audit-ba9876543210")]);
    chmodSync(join(s.parent, ".aura-trash-audit-ba9876543210"), 0o755);
    writeFileSync(join(s.parent, ".aura-trash-audit-ba9876543210", "extra.md"), "user\n");
    // Stale copy staging from a dead writer.
    mkdirSync(join(s.parent, ".aura-staging-polish-deadbeef0000"));
    writeFileSync(join(s.parent, ".aura-staging-polish-deadbeef0000.json"), JSON.stringify({ pid: spawnSync("true").pid, startedAt: Date.now() }));

    const r = sweepCopies(s.parent);
    expect(r.removed).toEqual(
      expect.arrayContaining([join(s.parent, ".aura-trash-polish-0123456789ab"), join(s.parent, ".aura-staging-polish-deadbeef0000")]),
    );
    expect(r.restored).toEqual(["audit"]);
    expect(readFileSync(join(s.parent, "audit", "extra.md"), "utf8")).toBe("user\n");
    expect(existsSync(join(s.parent, ".aura-staging-polish-deadbeef0000.json"))).toBe(false);
  });

  it("listExistingSkills treats a symlinked skill dir as the user's", () => {
    const s = setup();
    const elsewhere = tmp();
    symlinkSync(elsewhere, join(s.parent, "polish"));
    const existing = listExistingSkills(s.parent, s.cur.manifest);
    expect(existing).toEqual([{ name: "polish", frontmatterName: null, ownership: { owner: "user", reason: "not a plain directory" } }]);
    expect(sync(s).placed).toEqual(["audit"]);
  });

  it("the marker file is the only thing a copy adds to the entry's bytes", () => {
    const s = setup();
    sync(s);
    const files = readTree(join(s.parent, "polish"));
    expect([...files.keys()].sort()).toEqual([OWNER_MARKER_FILE, ...Object.keys(s.manifest.entries[0].files)].sort());
  });
});
