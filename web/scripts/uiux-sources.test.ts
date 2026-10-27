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

import {
  buildEntry,
  CATEGORIES,
  checkCatalog,
  classifySource,
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

  it("satisfies AC1.1–AC1.4: ≥30 included sources, all 8 categories, verdicts follow from facts", () => {
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
    const { CATALOG_MD_FILE } = await import("./uiux-sources.js");
    expect(readFileSync(CATALOG_MD_FILE, "utf8")).toBe(renderMarkdown(entries));
  });
});
