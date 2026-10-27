// Tests for the shipped-skill ownership marker and name rules (PLAN Task 5,
// spec AC2.3 "the user's skill is left untouched").
//
// The ownership rule is the safety boundary for every later delete/overwrite
// (ritchie B1 "prove before you delete"): a copy is Aura's only while its marker
// parses and the bytes are exactly the ones the marker records. Each test below
// plants ONE way a copy can stop being provably Aura's and asserts it flips to
// "user" for that reason — a false "aura" here would let Phase B destroy user work.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CATALOG_NAME,
  filesDigest,
  hashTree,
  markerFor,
  nameCollisions,
  nameKey,
  OWNER_MARKER_FILE,
  ownership,
  packNameErrors,
  parseMarker,
  readOwnership,
  SKILL_NAME_RE,
  type ManifestEntry,
} from "./skill-manifest.js";
import { SLUG_RE } from "../scripts/licences.js";

function tree(over: Record<string, string> = {}): Map<string, Buffer> {
  const files = { "SKILL.md": "---\nname: polish\n---\nbody\n", "references/a.md": "a\n", ...over };
  return new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
}

function entryFor(name: string, t: Map<string, Buffer>): ManifestEntry {
  const files = hashTree(t);
  return {
    name, frontmatterName: null, kind: "skill",
    source: { type: "first-party", repo: "o/r" },
    licence: { spdx: "MIT", verdict: "shippable" },
    compat: { claude: true, codex: true },
    ship: { status: "ship", reasons: [] },
    digest: filesDigest(files), files,
  };
}

/** A copy exactly as Aura would write it: the entry's files plus the marker. */
function installed(e: ManifestEntry, t: Map<string, Buffer>): Map<string, Buffer> {
  const copy = new Map(t);
  copy.set(OWNER_MARKER_FILE, Buffer.from(JSON.stringify(markerFor(e))));
  return copy;
}

describe("ownership — only an untouched, marked copy is Aura's", () => {
  const t = tree();
  const e = entryFor("polish", t);
  const manifest = { entries: [e] };

  it("an untouched copy of the current version is Aura's and current", () => {
    expect(ownership("polish", installed(e, t), manifest)).toEqual({ owner: "aura", inManifest: true, current: true });
  });

  it("an untouched copy of an OLDER version is still Aura's (upgradable), but not current", () => {
    // Why: the marker carries its own hashes, so a copy written by a previous release
    // is provably untouched even though the manifest moved on.
    const old = tree({ "SKILL.md": "---\nname: polish\n---\nold body\n" });
    const oldEntry = entryFor("polish", old);
    expect(ownership("polish", installed(oldEntry, old), manifest)).toEqual({ owner: "aura", inManifest: true, current: false });
  });

  it("an untouched copy of an entry Aura no longer ships is Aura's, flagged not in manifest", () => {
    expect(ownership("polish", installed(e, t), { entries: [] })).toEqual({ owner: "aura", inManifest: false, current: false });
  });

  it("no marker → user (a same-named personal skill)", () => {
    expect(ownership("polish", t, manifest)).toEqual({ owner: "user", reason: "no ownership marker" });
  });

  it("a hash-identical copy WITHOUT a marker is still the user's", () => {
    // Why: matching bytes alone do not prove Aura put it there — the user may have
    // copied it deliberately; only Aura's own marker transfers ownership.
    expect(ownership("polish", new Map(t), manifest).owner).toBe("user");
  });

  it("an edited file → user", () => {
    const copy = installed(e, t);
    copy.set("SKILL.md", Buffer.from("---\nname: polish\n---\nmy tweak\n"));
    expect(ownership("polish", copy, manifest)).toEqual({ owner: "user", reason: "SKILL.md was modified since Aura wrote this copy" });
  });

  it("an added file → user", () => {
    const copy = installed(e, t);
    copy.set("notes.md", Buffer.from("mine"));
    expect(ownership("polish", copy, manifest)).toEqual({ owner: "user", reason: "notes.md was added since Aura wrote this copy" });
  });

  it("a removed file → user", () => {
    const copy = installed(e, t);
    copy.delete("references/a.md");
    expect(ownership("polish", copy, manifest)).toEqual({ owner: "user", reason: "references/a.md was removed since Aura wrote this copy" });
  });

  it("a marker naming another dir → user (a copied/renamed dir is not Aura's slot)", () => {
    expect(ownership("polish-mine", installed(e, t), manifest).owner).toBe("user");
  });

  it("a marker whose digest disagrees with its own file list → user", () => {
    const copy = installed(e, t);
    copy.set(OWNER_MARKER_FILE, Buffer.from(JSON.stringify({ ...markerFor(e), digest: "0".repeat(64) })));
    expect(ownership("polish", copy, manifest)).toEqual({ owner: "user", reason: "marker digest does not match its own file list" });
  });

  it("a malformed marker → user", () => {
    const copy = installed(e, t);
    copy.set(OWNER_MARKER_FILE, Buffer.from("{not json"));
    expect(ownership("polish", copy, manifest)).toEqual({ owner: "user", reason: "ownership marker is unreadable" });
  });
});

describe("parseMarker — strict at the disk boundary (ritchie B8)", () => {
  const good = markerFor(entryFor("polish", tree()));

  it("round-trips a marker Aura wrote", () => {
    expect(parseMarker(JSON.stringify(good))).toEqual(good);
  });

  it.each([
    ["unknown schema version", { ...good, schemaVersion: 2 }],
    ["unsafe name", { ...good, name: "../etc" }],
    ["short digest", { ...good, digest: "abc" }],
    ["non-hex file hash", { ...good, files: { "SKILL.md": "z".repeat(64) } }],
    ["files is an array", { ...good, files: [] }],
    ["marker lists itself", { ...good, files: { [OWNER_MARKER_FILE]: "a".repeat(64) } }],
    ["top-level array", [good]],
  ])("rejects %s", (_label, value) => {
    expect(parseMarker(JSON.stringify(value))).toBeNull();
  });
});

describe("names — strict slug allowlist, case-insensitive collisions", () => {
  it("the skill-name regex is the same shape as the shared slug regex", () => {
    // Why: licences.ts SLUG_RE guards vendor-lock names; the shipped module cannot
    // import scripts/, so this pins the two copies together.
    expect(SKILL_NAME_RE.source).toBe(SLUG_RE.source);
  });

  it("accepts slugs and the catalog dir, rejects everything else", () => {
    expect(packNameErrors(["polish", "ui-ux-pro-max", CATALOG_NAME])).toEqual([]);
    for (const bad of ["Polish", "../x", "a", "_other", "x y", "-lead", "é-skill"]) {
      expect(packNameErrors([bad]).length, bad).toBe(1);
    }
  });

  it("flags duplicates case-insensitively", () => {
    expect(packNameErrors(["polish", "polish"])).toEqual(['"polish" collides with "polish" (case-insensitive)']);
  });

  it("finds a user dir that differs only in case (macOS/Windows homes)", () => {
    expect(nameCollisions([{ name: "polish", frontmatterName: null }], ["Polish", "other"])).toEqual([{ entry: "polish", existing: "Polish" }]);
  });

  it("finds a clash on the frontmatter name too (Codex invokes by it)", () => {
    const e = { name: "taste-skill", frontmatterName: "design-taste-frontend" };
    expect(nameCollisions([e], ["Design-Taste-Frontend"])).toEqual([{ entry: "taste-skill", existing: "Design-Taste-Frontend" }]);
  });

  it("no clash → empty", () => {
    expect(nameCollisions([{ name: "polish", frontmatterName: null }], ["polished"])).toEqual([]);
  });

  it("nameKey folds NFC/NFD forms of the same name together", () => {
    expect(nameKey("café")).toBe(nameKey("café"));
  });
});

describe("readOwnership — on-disk copies", () => {
  it("reads a real Aura-written copy as Aura's", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-own-"));
    const t = tree();
    const e = entryFor("polish", t);
    mkdirSync(join(root, "polish", "references"), { recursive: true });
    for (const [p, b] of installed(e, t)) writeFileSync(join(root, "polish", p), b);
    expect(readOwnership(join(root, "polish"), "polish", { entries: [e] }).owner).toBe("aura");
  });

  it("a symlink anywhere in the copy → user, never a throw", () => {
    // Why: a link could point at the user's real files; Aura must not claim (and so
    // later delete through) anything it cannot fully read as plain files.
    const root = mkdtempSync(join(tmpdir(), "skill-own-"));
    const t = tree();
    const e = entryFor("polish", t);
    mkdirSync(join(root, "polish", "references"), { recursive: true });
    for (const [p, b] of installed(e, t)) writeFileSync(join(root, "polish", p), b);
    symlinkSync("/etc/hostname", join(root, "polish", "link"));
    const r = readOwnership(join(root, "polish"), "polish", { entries: [e] });
    expect(r.owner).toBe("user");
    expect(r.owner === "user" && r.reason).toMatch(/symlink in skill tree: link/);
  });

  it.each(["node_modules", "__pycache__"])("a file inside a skipped %s dir → user (observer STOP 2026-10-27)", (cache) => {
    // Why: readTree does not read cache dirs, so a user file there was invisible to
    // the hash comparison and the copy read as Aura's — B2 would delete it with the copy.
    const root = mkdtempSync(join(tmpdir(), "skill-own-"));
    const t = tree();
    const e = entryFor("polish", t);
    mkdirSync(join(root, "polish", "references"), { recursive: true });
    for (const [p, b] of installed(e, t)) writeFileSync(join(root, "polish", p), b);
    mkdirSync(join(root, "polish", cache));
    writeFileSync(join(root, "polish", cache, "notes.md"), "mine");
    expect(readOwnership(join(root, "polish"), "polish", { entries: [e] })).toEqual({
      owner: "user",
      reason: `cannot prove ownership: unread dir ${cache}`,
    });
  });

  it("a missing dir → user, never a throw", () => {
    expect(readOwnership("/nonexistent/aura/x", "x", { entries: [] }).owner).toBe("user");
  });
});
