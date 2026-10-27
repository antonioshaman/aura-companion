// Tests for the UI/UX source catalog (spec `uiux-agent-enrichment.md` Story 1,
// PLAN Task 1).
//
// Two layers:
//   1. The pure verdict rules (`classifySource`) — every Story 1 exclusion and
//      licence branch, each with a near-miss on the other side of its threshold,
//      so a flipped comparison or a widened allowlist goes red.
//   2. The COMMITTED catalog.json re-validated hermetically (no network): AC1.1
//      counts, AC1.2 fields, and every verdict re-derived from its frozen facts, so
//      a hand-edited verdict ("make it redistributable") is caught in CI.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

import {
  buildEntry,
  CATEGORIES,
  assertSameRepo,
  checkableCorpus,
  checkCatalog,
  checkReceivers,
  classifySource,
  CORPUS_DIR,
  corpusItem,
  corpusTextPath,
  corpusTextUrl,
  htmlToText,
  loadCorpusManifest,
  THIN_TEXT_BYTES,
  UIUX_SOURCES_DIR,
  fetchHeaders,
  readmeAtRef,
  uncoveredSkills,
  validateConflicts,
  verifyCorpus,
  factsFromGithub,
  loadCatalogEntries,
  loadSeeds,
  MIN_INCLUDED_SOURCES,
  MIN_STARS,
  renderMarkdown,
  validateSeed,
  type RepoFacts,
  type SeedSource,
} from "./uiux-sources.js";

const NOW = new Date("2026-10-27T00:00:00Z");
const fresh: RepoFacts = { licence: "MIT", lastActivity: "2026-10-01", archived: false, stars: 5_000 };

describe("classifySource — fail-closed verdict rules", () => {
  it("a fresh, popular, MIT repo is redistributable", () => {
    expect(classifySource({}, fresh, NOW).verdict).toBe("redistributable");
  });

  it("AC1.4: more than 18 months without activity is excluded; exactly 18 is kept", () => {
    // 2025-04-27 → 2026-10-27 is exactly 18 months: kept (rule is "more than 18").
    expect(classifySource({}, { ...fresh, lastActivity: "2025-04-27" }, NOW).verdict).toBe("redistributable");
    // 19 months: excluded.
    const stale = classifySource({}, { ...fresh, lastActivity: "2025-03-20" }, NOW);
    expect(stale.verdict).toBe("excluded");
    expect(stale.reason).toMatch(/no activity for 19 months/);
  });

  it("AC1.4: a canonical standard is exempt from the activity rule", () => {
    const r = classifySource({ canonical: "WCAG 2.2" }, { ...fresh, lastActivity: "2019-01-01", licence: null }, NOW);
    expect(r.verdict).toBe("reference-only");
    expect(r.reason).toMatch(/^canonical standard/);
  });

  it("archived repos are excluded even when otherwise fine", () => {
    expect(classifySource({}, { ...fresh, archived: true }, NOW).verdict).toBe("excluded");
  });

  it(`owner rule: fewer than ${MIN_STARS} stars is excluded; exactly ${MIN_STARS} is kept`, () => {
    expect(classifySource({}, { ...fresh, stars: MIN_STARS - 1 }, NOW).verdict).toBe("excluded");
    expect(classifySource({}, { ...fresh, stars: MIN_STARS }, NOW).verdict).toBe("redistributable");
    // A missing star count is not "popular enough" — fail closed.
    expect(classifySource({}, { ...fresh, stars: null }, NOW).verdict).toBe("excluded");
    // Canonical standards are exempt (W3C working-group repos have few stars).
    expect(classifySource({ canonical: "x" }, { ...fresh, stars: 3, licence: null }, NOW).verdict).toBe("reference-only");
  });

  it("AC1.3: unknown licence (null / NOASSERTION) is reference only, never redistributable", () => {
    expect(classifySource({}, { ...fresh, licence: null }, NOW).verdict).toBe("reference-only");
    expect(factsFromGithub({ license: { spdx_id: "NOASSERTION" } }).licence).toBeNull();
  });

  it("a licence outside the allowlist (e.g. CC-BY-NC) is reference only", () => {
    expect(classifySource({}, { ...fresh, licence: "CC-BY-NC-4.0" }, NOW).verdict).toBe("reference-only");
  });

  it("copyleft (GPL, LGPL, MPL, CC-BY-SA) is ask-first, per the spec boundary", () => {
    for (const lic of ["GPL-3.0", "LGPL-3.0", "MPL-2.0", "CC-BY-SA-4.0", "AGPL-3.0"]) {
      expect(classifySource({}, { ...fresh, licence: lic }, NOW).verdict, lic).toBe("ask-first");
    }
  });
});

describe("factsFromGithub", () => {
  it("extracts spdx, pushed date, archived and stars from the API body", () => {
    expect(
      factsFromGithub({ license: { spdx_id: "Apache-2.0" }, pushed_at: "2026-10-26T10:07:28Z", archived: false, stargazers_count: 42 }),
    ).toEqual({ licence: "Apache-2.0", lastActivity: "2026-10-26", archived: false, stars: 42 });
  });

  it("a repo with no licence object yields null licence and missing fields stay null", () => {
    expect(factsFromGithub({ license: null })).toEqual({ licence: null, lastActivity: null, archived: false, stars: null });
  });
});

describe("validateSeed", () => {
  const ok: SeedSource = {
    id: "x-src", category: "ux-writing", title: "X", repo: "a/b", takeaway: "t", receivers: ["skill:clarify"],
  };

  it("accepts a well-formed repo seed", () => {
    expect(validateSeed(ok)).toEqual([]);
  });

  it("a web-only source must be canonical — no licence facts can be fetched for it", () => {
    const { repo: _r, ...rest } = ok;
    expect(validateSeed({ ...rest, url: "https://example.org" }).join()).toMatch(/must be canonical/);
    expect(validateSeed({ ...rest, url: "https://example.org", canonical: "Std" })).toEqual([]);
  });

  it("rejects unknown categories, missing receivers and both repo+url", () => {
    expect(validateSeed({ ...ok, category: "vibes" as never }).join()).toMatch(/unknown category/);
    expect(validateSeed({ ...ok, receivers: [] }).join()).toMatch(/no receivers/);
    expect(validateSeed({ ...ok, url: "https://x" }).join()).toMatch(/both repo and url/);
  });
});

describe("checkCatalog — AC1.1/AC1.2 gate", () => {
  it("a forged verdict that does not follow from the frozen facts is caught", () => {
    const seed: SeedSource = { id: "gpl-thing", category: "ux-writing", title: "G", repo: "a/b", takeaway: "t", receivers: ["r"] };
    const entry = buildEntry(seed, { ...fresh, licence: "GPL-3.0" }, "2026-10-27T00:00:00Z", NOW);
    expect(entry.verdict).toBe("ask-first");
    const forged = { ...entry, verdict: "redistributable" as const };
    expect(checkCatalog([forged], [seed]).join("\n")).toMatch(/does not follow from its facts/);
  });

  it("too few sources and uncovered categories are reported", () => {
    const errs = checkCatalog([], []).join("\n");
    expect(errs).toMatch(new RegExp(`only 0 included sources \\(< ${MIN_INCLUDED_SOURCES}\\)`));
    for (const c of CATEGORIES) expect(errs).toContain(`category ${c} has no included source`);
  });
});

describe("committed catalog.json (hermetic re-validation)", () => {
  const seeds = loadSeeds();
  const entries = loadCatalogEntries();

  it("every seed is well-formed", () => {
    expect(seeds.flatMap(validateSeed)).toEqual([]);
  });

  // Fix pass #11/#12/#14: every receiver resolves, the conflict ledger is well-formed,
  // and every shipped UI/UX skill is fed by a source or declared taste-only.
  it("seed-level gates pass on the committed seed (receivers, conflicts, AC3.1 skill scope)", async () => {
    const { checkSeedDoc, loadSeedDoc } = await import("./uiux-sources.js");
    expect(checkSeedDoc(loadSeedDoc())).toEqual([]);
  });

  it("the ledger records the target-size and back-navigation conflicts (finding #12)", async () => {
    const { loadSeedDoc } = await import("./uiux-sources.js");
    const claims = loadSeedDoc().conflicts.map((c) => c.claim).join("\n");
    expect(claims).toMatch(/target size/i);
    expect(claims).toMatch(/back navigation/i);
  });

  it("satisfies AC1.1–AC1.4: ≥30 included sources, every category covered, verdicts follow from facts", () => {
    expect(checkCatalog(entries, seeds)).toEqual([]);
  });

  it("AC1.2: every entry states link, licence field, activity, takeaway and receiver", () => {
    for (const e of entries) {
      expect(e.link, e.id).toMatch(/^https:\/\//);
      expect(e, e.id).toHaveProperty("licence");
      expect(e.takeaway.length, e.id).toBeGreaterThan(0);
      expect(e.receivers.length, e.id).toBeGreaterThan(0);
      if (!e.canonical) expect(e.lastActivity, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("CATALOG.md is the rendering of catalog.json (regenerate with `fetch`, never hand-edit)", async () => {
    const { readFileSync } = await import("node:fs");
    const { CATALOG_MD_FILE, loadSeedDoc } = await import("./uiux-sources.js");
    expect(readFileSync(CATALOG_MD_FILE, "utf8")).toBe(renderMarkdown(entries, loadSeedDoc()));
  });
});

// ─── Task 2: source-text corpus ─────────────────────────────────────────────
// The corpus is what the Phase C copy check compares enrichment against. These
// tests pin the two properties it must have: it is reproducible/tamper-evident
// (sha256 manifest), and it never reaches git or the npm package.

describe("corpus — manifest verification", () => {
  const entries = [
    { id: "a-src", link: "https://github.com/o/a", verdict: "redistributable" as const },
    { id: "b-src", link: "https://example.org/std", verdict: "reference-only" as const },
    { id: "c-src", link: "https://github.com/o/c", verdict: "excluded" as const },
  ];
  const texts: Record<string, string> = { "a-src": "alpha text", "b-src": "beta text" };
  const manifest = Object.entries(texts).map(([id, t]) => corpusItem(id, "u", t, "2026-10-27T00:00:00Z"));

  it("repo sources read their README via the API; web sources their page; excluded ones nothing", () => {
    expect(corpusTextUrl(entries[0])).toBe("https://api.github.com/repos/o/a/readme");
    expect(corpusTextUrl(entries[1])).toBe("https://example.org/std");
    expect(corpusTextUrl(entries[2])).toBeNull();
  });

  it("an intact corpus verifies clean", () => {
    expect(verifyCorpus(manifest, entries, (id) => texts[id] ?? null)).toEqual([]);
  });

  it("a planted edit to one text is caught by its sha256 (red on a planted defect)", () => {
    const tampered = { ...texts, "b-src": "beta text, quietly edited" };
    expect(verifyCorpus(manifest, entries, (id) => tampered[id] ?? null)).toEqual([
      "b-src: corpus text does not match manifest sha256",
    ]);
  });

  it("a missing text and an included source with no manifest item are both reported", () => {
    const errs = verifyCorpus(manifest.slice(1), entries, (id) => (id === "b-src" ? null : texts[id]));
    expect(errs).toContain("a-src: included source has no corpus item");
    expect(errs).toContain("b-src: corpus text missing (run `corpus`)");
  });

  it("thin texts (JS-rendered pages) are flagged so the copy check cannot silently pass on them", () => {
    expect(corpusItem("x-src", "u", "short", "t").thin).toBe(true);
    expect(corpusItem("x-src", "u", "x".repeat(THIN_TEXT_BYTES), "t").thin).toBe(false);
  });

  it("corpus ids cannot escape the corpus directory", () => {
    expect(() => corpusTextPath("../../etc/passwd")).toThrow(/bad corpus id/);
  });

  it("htmlToText drops scripts and markup and decodes entities", () => {
    expect(htmlToText("<p>A&amp;B</p><script>evil()</script><div>C&nbsp;D</div>")).toBe("A&B\nC D");
  });
});

describe("corpus — never committed, never shipped", () => {
  it("the committed manifest covers every included catalog source", () => {
    expect(verifyCorpus(loadCorpusManifest(), loadCatalogEntries(), () => "").filter((e) => e.includes("no corpus item"))).toEqual([]);
  });

  it("corpus/ is gitignored and outside web/ (the npm package root)", () => {
    const repoRoot = resolve(UIUX_SOURCES_DIR, "..", "..", "..");
    expect(relative(join(repoRoot, "web"), CORPUS_DIR).startsWith("..")).toBe(true);
    const r = spawnSync("git", ["check-ignore", "-q", join(relative(repoRoot, CORPUS_DIR), "x.txt")], { cwd: repoRoot });
    expect(r.status, "corpus/ must be gitignored — its texts are third-party").toBe(0);
  });
});

// ─── Fix pass (review 2026-10-27-2139) ──────────────────────────────────────
// Each block cites its FINAL-REVIEW finding and was written to FAIL first.

const seedA: SeedSource = { id: "a-src", category: "ux-writing", title: "A", repo: "o/a", takeaway: "t", receivers: ["skill:clarify"] };
const entryA = buildEntry(seedA, fresh, "2026-10-27T00:00:00Z", NOW);

describe("Finding #9 — every checkCatalog / classifySource integrity branch is exercised", () => {
  it("a non-canonical repo with no activity date is excluded, not passed to the licence rules", () => {
    expect(classifySource({}, { ...fresh, lastActivity: null }, NOW)).toEqual({ verdict: "excluded", reason: "no activity date" });
  });

  it("duplicate ids, an entry without a seed, and a seed never fetched are all reported", () => {
    const orphan = { ...entryA, id: "ghost" };
    const errs = checkCatalog([entryA, entryA, orphan], [seedA, { ...seedA, id: "b-src" }]).join("\n");
    expect(errs).toMatch(/duplicate id a-src/);
    expect(errs).toMatch(/ghost: in catalog but not in seed/);
    expect(errs).toMatch(/b-src: in seed but not fetched into catalog/);
  });

  it("a non-canonical entry with no star count is reported", () => {
    expect(checkCatalog([{ ...entryA, stars: null }], [seedA]).join()).toMatch(/a-src: missing star count/);
  });
});

describe("Finding #14 — catalog judgement fields are bound to the seed; receivers resolve", () => {
  it("a takeaway or receiver edited in catalog.json but not in seed.json is caught", () => {
    expect(checkCatalog([{ ...entryA, takeaway: "rewritten" }], [seedA]).join()).toMatch(/a-src: takeaway differs from seed/);
    expect(checkCatalog([{ ...entryA, receivers: ["skill:other"] }], [seedA]).join()).toMatch(/a-src: receivers differs from seed/);
    expect(checkCatalog([{ ...entryA, link: "https://evil.example" }], [seedA]).join()).toMatch(/a-src: link differs from seed/);
  });

  it("an unknown receiver is reported; known ones pass", () => {
    const known = new Set(["skill:clarify", "aura-check"]);
    expect(checkReceivers([seedA], known)).toEqual([]);
    expect(checkReceivers([{ ...seedA, receivers: ["skill:clarfy"] }], known)).toEqual(["a-src: unknown receiver skill:clarfy"]);
  });
});

describe("Finding #11 — every shipped UI/UX skill is a receiver or declared taste-only", () => {
  it("a shipped skill with no source and no taste-only declaration is reported", () => {
    expect(uncoveredSkills(["clarify", "adapt", "bolder"], [seedA], ["bolder"])).toEqual(["adapt"]);
  });
});

describe("Finding #12 — the source-conflict ledger has a fixed shape", () => {
  const seeds = [seedA, { ...seedA, id: "b-src" }];
  const ok = { claim: "c", sources: ["a-src", "b-src"], default: "d", reason: "r", scope: "web" };
  it("accepts a well-formed conflict and rejects unknown sources, a single source or missing fields", () => {
    expect(validateConflicts([ok], seeds)).toEqual([]);
    expect(validateConflicts([{ ...ok, sources: ["a-src", "nope"] }], seeds).join()).toMatch(/unknown source nope/);
    expect(validateConflicts([{ ...ok, sources: ["a-src"] }], seeds).join()).toMatch(/at least two sources/);
    expect(validateConflicts([{ ...ok, default: "" }], seeds).join()).toMatch(/missing default/);
  });
});

describe("Finding #13 — a renamed/moved repo is an error, not silently different facts", () => {
  it("assertSameRepo throws when the API answers for a different repository", () => {
    expect(() => assertSameRepo("Telegram-Mini-Apps/TelegramUI", "telegram-mini-apps-dev/TelegramUI")).toThrow(/moved/);
    expect(() => assertSameRepo("o/A", "O/a")).not.toThrow();
  });
});

describe("Finding #8 — thin texts are uncheckable; seeds can point at the real docs page", () => {
  it("a textUrl override replaces the README and must be https", () => {
    expect(corpusTextUrl({ link: "https://github.com/o/a", verdict: "redistributable", textUrl: "https://docs.example.org/x" })).toBe("https://docs.example.org/x");
    expect(validateSeed({ ...seedA, textUrl: "http://docs.example.org" }).join()).toMatch(/textUrl must be https/);
  });

  it("checkableCorpus drops thin items, so a copy check can never certify against them", () => {
    const thin = corpusItem("t-src", "u", "short", "x");
    const full = corpusItem("f-src", "u", "y".repeat(THIN_TEXT_BYTES), "x");
    expect(checkableCorpus([thin, full]).map((i) => i.id)).toEqual(["f-src"]);
  });
});

describe("Finding #7/#16 — the corpus is pinned and orphans are flagged", () => {
  it("a repo README is fetched at a recorded commit", () => {
    expect(readmeAtRef("https://api.github.com/repos/o/a/readme", "abc123")).toBe("https://api.github.com/repos/o/a/readme?ref=abc123");
  });

  it("a text on disk that the manifest does not list is reported", () => {
    const m = [corpusItem("a-src", "u", "alpha", "x")];
    expect(verifyCorpus(m, [], (id) => (id === "a-src" ? "alpha" : null), ["a-src", "stale-src"])).toEqual([
      "stale-src: corpus text not in manifest (orphan)",
    ]);
  });
});

describe("GITHUB_TOKEN is only ever sent to api.github.com (beck P3)", () => {
  it("adds Authorization for the API host only", () => {
    expect(fetchHeaders("https://api.github.com/repos/o/a", "tok").Authorization).toBe("Bearer tok");
    expect(fetchHeaders("https://docs.example.org/page", "tok").Authorization).toBeUndefined();
    expect(fetchHeaders("https://api.github.com.evil.example/x", "tok").Authorization).toBeUndefined();
    // A lookalike or the web host must not get it either (exact hostname, not suffix).
    expect(fetchHeaders("https://evil-github.com/x", "tok").Authorization).toBeUndefined();
    expect(fetchHeaders("https://github.com/o/a", "tok").Authorization).toBeUndefined();
  });
});
