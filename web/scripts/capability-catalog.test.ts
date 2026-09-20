// Tests for the RC-2 capability-catalog loader/validator (PLAN Task 4).
//
// Uses an in-repo FIXTURE catalog (temp dir), never the live ~/.claude catalog
// (dahl #9). Asserts the load-boundary contract: valid profiles load; ABSENT
// capabilities are skipped (not errors, AC2.2); MALFORMED / unknown-token /
// YAML-coercion are LOUD errors (ritchie B-3/B-8, dahl #6).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalog, loadVocabulary, loadAdvisorProfile } from "./capability-catalog.js";
import { realpathSync } from "node:fs";

const roots: string[] = [];
function newCatalog(): string {
  const r = mkdtempSync(join(tmpdir(), "catalog-"));
  roots.push(r);
  // minimal vocabulary
  mkdirSync(join(r, ".verify"), { recursive: true });
  writeFileSync(
    join(r, ".verify", "capability-vocabulary.json"),
    JSON.stringify({
      schema_version: 1,
      signals: { reserved: ["any"], frameworks: ["react", "fastapi"], datastores: ["postgres"] },
      domains: ["security", "frontend-architecture", "database-persistence"],
    }),
  );
  return r;
}
function advisor(root: string, id: string, meta: string) {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "meta.yaml"), meta);
}
beforeEach(() => {
  roots.length = 0;
});
afterEach(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("loadVocabulary", () => {
  it("reads the flat signal + domain sets", () => {
    const r = realpathSync(newCatalog());
    const v = loadVocabulary(r)!;
    expect(v.signals.has("any")).toBe(true);
    expect(v.signals.has("react")).toBe(true);
    expect(v.domains.has("security")).toBe(true);
  });
});

describe("loadAdvisorProfile — valid", () => {
  it("loads + lowercases a well-formed profile", () => {
    const r = realpathSync(newCatalog());
    advisor(r, "hunt", 'creator: "Troy Hunt"\ncapabilities:\n  signals: [any]\n  domains: [security]\n');
    const v = loadVocabulary(r)!;
    const load = loadAdvisorProfile(r, "hunt", v);
    expect(load.ok).toBe(true);
    if (load.ok) {
      expect(load.profile.signals).toEqual(["any"]);
      expect(load.profile.domains).toEqual(["security"]);
    }
  });
});

describe("loadCatalog — partitioning", () => {
  it("splits seatable / skipped(absent) / errors, and absent is NOT an error", () => {
    const r = newCatalog();
    advisor(r, "hunt", 'creator: "Troy Hunt"\ncapabilities:\n  signals: [any]\n  domains: [security]\n');
    advisor(r, "abramov", 'creator: "Dan Abramov"\ncapabilities:\n  signals: [react]\n  domains: [frontend-architecture]\n');
    // not-yet-migrated: has meta.yaml, no capabilities → skipped, never an error
    advisor(r, "torvalds", 'creator: "Linus Torvalds"\nstack: [common]\n');
    const c = loadCatalog(r);
    expect(c.profiles.map((p) => p.id)).toEqual(["abramov", "hunt"]);
    expect(c.skipped.some((s) => s.id === "torvalds" && s.reason === "absent-capabilities")).toBe(true);
    expect(c.errors).toEqual([]);
  });

  it("unknown/typo'd token is a LOUD error, never a silent seat or drop", () => {
    const r = newCatalog();
    advisor(r, "brandur", 'capabilities:\n  signals: [postgress]\n  domains: [database-persistence]\n'); // typo
    const c = loadCatalog(r);
    expect(c.profiles).toEqual([]);
    expect(c.errors.some((e) => e.id === "brandur" && e.reason === "unknown-token")).toBe(true);
  });

  it("YAML numeric coercion is caught as malformed, not never-matched", () => {
    const r = newCatalog();
    // A bare number coerces to `number` under yaml v2's 1.2 core schema →
    // non-string member → malformed (ritchie B-8 coercion guard).
    advisor(r, "willison", "capabilities:\n  signals: [8080, react]\n  domains: [security]\n");
    const c = loadCatalog(r);
    expect(c.errors.some((e) => e.id === "willison" && e.reason === "malformed")).toBe(true);
  });

  it("an unrecognised bare word (e.g. YAML 1.1 `no`, a string under 1.2) is a loud unknown-token error", () => {
    const r = newCatalog();
    // Guards against a future yaml-schema change: whether `no` is a string or a
    // bool, it must be LOUD (unknown-token or malformed), never a silent drop.
    advisor(r, "beck", "capabilities:\n  signals: [no, react]\n  domains: [security]\n");
    const c = loadCatalog(r);
    expect(c.errors.some((e) => e.id === "beck" && (e.reason === "unknown-token" || e.reason === "malformed"))).toBe(true);
  });

  it("empty capability list is malformed (a seated advisor must declare something)", () => {
    const r = newCatalog();
    advisor(r, "fowler", "capabilities:\n  signals: []\n  domains: [security]\n");
    const c = loadCatalog(r);
    expect(c.errors.some((e) => e.id === "fowler" && e.reason === "malformed")).toBe(true);
  });

  // dahl #13: a present-but-empty `capabilities:` key is a half-migrated advisor →
  // LOUD malformed, NOT a silent absent-capabilities skip.
  it("present-but-null capabilities is malformed, not a silent skip", () => {
    const r = newCatalog();
    advisor(r, "dahl", "creator: x\ncapabilities:\n"); // key present, value null
    const c = loadCatalog(r);
    expect(c.skipped.some((s) => s.id === "dahl")).toBe(false);
    expect(c.errors.some((e) => e.id === "dahl" && e.reason === "malformed")).toBe(true);
  });

  // P1-2 (ritchie #1): a SYMLINKED advisor directory must never be silently dropped
  // by the enumerator — it must surface loudly (symlink/out_of_bounds error), because
  // this is the trust root that decides who reviews code.
  it("a symlinked advisor directory pointing outside the catalog is a LOUD error, never a silent drop", () => {
    const r = newCatalog();
    advisor(r, "abramov", "capabilities:\n  signals: [react]\n  domains: [frontend-architecture]\n");
    // stow-style: `hunt` is a symlink to a real advisor dir OUTSIDE the catalog root
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    roots.push(outside);
    mkdirSync(join(outside, "hunt"), { recursive: true });
    writeFileSync(join(outside, "hunt", "meta.yaml"), "capabilities:\n  signals: [any]\n  domains: [security]\n");
    symlinkSync(join(outside, "hunt"), join(r, "hunt"), "dir");
    const c = loadCatalog(r);
    // hunt is NOT silently absent: it appears in errors (out_of_bounds), not vanished.
    const seenAnywhere =
      c.profiles.some((p) => p.id === "hunt") ||
      c.skipped.some((s) => s.id === "hunt") ||
      c.errors.some((e) => e.id === "hunt");
    expect(seenAnywhere).toBe(true);
    expect(c.errors.some((e) => e.id === "hunt" && e.reason === "out_of_bounds")).toBe(true);
  });

  it("a bad advisor id shape is a loud bad-id error", () => {
    const r = realpathSync(newCatalog());
    const v = loadVocabulary(r)!;
    const load = loadAdvisorProfile(r, "../evil", v);
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.reason).toBe("bad-id");
  });
});
