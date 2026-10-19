/**
 * FINAL-REVIEW parsing + known-defect matching for COUNCIL-PANEL-BENCH.
 *
 * Two layers: synthetic reviews pin each rule (section scoping, summary table
 * ignored, file-and-(line|keyword) requirement, unmatched-P1 reporting), and a
 * replay over the ARCHIVED historical reviews proves the matcher recovers the
 * very P1s those reviews reported (EC-6: a load-bearing parser gets a
 * replay-based regression test). If the matcher can't find 7/7 on the review
 * that defined the PR #54 ground truth, its recall numbers for new runs mean
 * nothing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadCases, parseCases } from "./cases.js";
import { LINE_TOLERANCE, parseFinalReview, scoreReview } from "./score.js";

const REPO = resolve(new URL(".", import.meta.url).pathname, "../../../..");
const archived = (ts: string) => readFileSync(resolve(REPO, "docs/history/council/review-output", ts, "FINAL-REVIEW.md"), "utf8");

const REVIEW = `# Council Review (Aura): x

**Council dispatched:** hunt

---

## P1 — Fix Now

### 1. Probe gate fails open

| | |
|---|---|
| **File** | \`web/server/a.ts:100-110\` |
| **Council** | Hunt × Carmack — Fail closed |

**Finding:** When the probe is null the gate lets everything through.

### 2. Unrelated scary thing

| | |
|---|---|
| **File** | \`web/server/other.ts:5\` |

**Finding:** Something else entirely.

## P2 — Fix Soon

### 3. Slug drops underscores

| | |
|---|---|
| **File** | \`b.ts:40\` (\`resolveThing\`) vs \`web/server/c.ts\` |

**Finding:** The underscore case.

## P3 — Consider

### 4. Naming

| | |
|---|---|
| **File** | \`web/server/a.ts:900\` |

Rename it.

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Probe gate fails open | P1 | Hunt | 1 line |
`;

const CASE = parseCases({
  schemaVersion: 1,
  cases: [{
    id: "c1", pr: 1, base: "abcdef0^", head: "abcdef0", title: "t", changedDomains: ["security"], evidence: "e",
    knownDefects: [
      { id: "fails-open", kind: "defect", severity: "P1", summary: "s", fixedBy: ["abcdef1"],
        locations: [{ file: "web/server/a.ts", lines: [95, 105] }], keywords: ["fails open"] },
      { id: "slug", kind: "defect", severity: "P1", summary: "s", fixedBy: ["abcdef1"],
        locations: [{ file: "web/server/b.ts", lines: [200, 210] }], keywords: ["underscore"] },
      { id: "missed", kind: "test-gap", severity: "P1", summary: "s", fixedBy: ["abcdef1"],
        locations: [{ file: "web/server/z.ts" }], keywords: ["never asserted"] },
    ],
  }],
})[0]!;

describe("parseFinalReview", () => {
  const f = parseFinalReview(REVIEW);

  it("reads one finding per ### block under P1/P2/P3 and ignores the summary table", () => {
    expect(f.map((x) => [x.priority, x.number, x.title])).toEqual([
      ["P1", 1, "Probe gate fails open"],
      ["P1", 2, "Unrelated scary thing"],
      ["P2", 3, "Slug drops underscores"],
      ["P3", 4, "Naming"],
    ]);
  });

  it("extracts every backticked path from the File row, with and without line ranges", () => {
    expect(f[0]!.refs).toEqual([{ file: "web/server/a.ts", lines: [100, 110] }]);
    // `resolveThing` has no extension → not a path; two refs in one cell both kept.
    expect(f[2]!.refs).toEqual([{ file: "b.ts", lines: [40, 40] }, { file: "web/server/c.ts" }]);
  });
});

describe("scoreReview", () => {
  const s = scoreReview(CASE, parseFinalReview(REVIEW));

  it("matches on file + overlapping line, and on path suffix + keyword when lines disagree", () => {
    const byId = Object.fromEntries(s.defects.map((d) => [d.defectId, d]));
    expect(byId["fails-open"]!.found).toBe(true);
    expect(byId["fails-open"]!.bestPriority).toBe("P1");
    // `b.ts:40` is 160 lines from the hint (> tolerance) but names the keyword.
    expect(byId.slug!.matches[0]!.evidence).toEqual({ file: true, line: false, keywords: ["underscore"] });
    expect(byId.slug!.bestPriority).toBe("P2");
    expect(byId.missed!.found).toBe(false);
  });

  it("does not match the same file far from the hint without a keyword (P3 #4 at a.ts:900)", () => {
    const m = s.defects.find((d) => d.defectId === "fails-open")!.matches;
    expect(m.map((x) => x.finding)).toEqual([1]);
    expect(900 - 105).toBeGreaterThan(LINE_TOLERANCE);
  });

  it("reports recall, found-as-P1 and unmatched P1 candidates", () => {
    expect(s.findings).toEqual({ P1: 2, P2: 1, P3: 1 });
    expect(s.recall).toEqual({ found: 2, total: 3 });
    expect(s.recallAsP1).toEqual({ found: 1, total: 3 });
    expect(s.unmatchedP1).toEqual([{ finding: 2, title: "Unrelated scary thing", refs: [{ file: "web/server/other.ts", lines: [5, 5] }] }]);
  });
});

describe("replay over the archived reviews that define the ground truth", () => {
  const cases = loadCases();

  it("PR #54: review 2026-05-15-0336 recovers all 7 known P1s as P1", () => {
    const s = scoreReview(cases.find((c) => c.id === "pr54-auto-proceed-wireup")!, parseFinalReview(archived("2026-05-15-0336")));
    expect(s.recallAsP1).toEqual({ found: 7, total: 7 });
    expect(s.unmatchedP1).toEqual([]);
  });

  it("PR #91: review 2026-06-04-1826 recovers all 4 known P1s as P1", () => {
    const s = scoreReview(cases.find((c) => c.id === "pr91-dynamic-models")!, parseFinalReview(archived("2026-06-04-1826")));
    expect(s.recallAsP1).toEqual({ found: 4, total: 4 });
    expect(s.unmatchedP1).toEqual([]);
  });

  it("a review of a DIFFERENT PR matches none of PR #54's defects (no keyword-soup recall)", () => {
    const s = scoreReview(cases.find((c) => c.id === "pr54-auto-proceed-wireup")!, parseFinalReview(archived("2026-06-04-1826")));
    expect(s.recall.found).toBe(0);
  });
});
