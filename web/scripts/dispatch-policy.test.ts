// Tests for the B4 economy dispatch policy (spec `specs/aura-meta-diet.md`, Story B4).
//
// What is validated:
//   - the seat budget is sized from the diff and fails closed (unknown size → the
//     larger budget, never the smaller one);
//   - the budget only ever trims specialists: a cross-stack lens whose domain the
//     change touches (hunt / fowler / willison / beck) is seated even past the
//     budget — the AC "fail-closed lenses are not dropped on a domain match";
//   - a stack-signal match alone no longer earns a seat (the reason historical
//     panels ran 7–12 seats on this repo);
//   - every dropped candidate is reported with a reason (no silent starve);
//   - replaying the policy over the archived review history (hermetic fixtures:
//     `__fixtures__/council-dispatch/history.json` + the frozen catalog snapshot)
//     keeps every fail-closed lens and produces the numbers the committed B4
//     report quotes (canary: report block == renderer output).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { RankedCandidate } from "./advisor-scorer.js";
import {
  applyPolicyToHistory,
  composeEconomyCouncil,
  ECONOMY_SEAT_BUDGET,
  loadHistory,
  loadProfiles,
  median,
  parseDispatchHistory,
  renderDispatchReport,
  seatBudget,
  selectEconomySeats,
  sizeBucket,
  SMALL_DIFF_MAX_FILES,
  SMALL_DIFF_MAX_LINES,
  SMALL_DIFF_SEAT_BUDGET,
} from "./dispatch-policy.js";

const profiles = loadProfiles();
const history = loadHistory();

function cand(advisorId: string, score: number, opts: { cross?: boolean; domains?: string[] } = {}): RankedCandidate {
  return {
    advisorId,
    score,
    matchedSignals: [],
    matchedDomains: opts.domains ?? [],
    crossStack: opts.cross ?? false,
  };
}

describe("seatBudget", () => {
  it("gives the small budget only to a provably small diff (both limits, inclusive)", () => {
    expect(seatBudget({ diffFiles: SMALL_DIFF_MAX_FILES, diffLines: SMALL_DIFF_MAX_LINES })).toBe(SMALL_DIFF_SEAT_BUDGET);
    expect(seatBudget({ diffFiles: SMALL_DIFF_MAX_FILES + 1, diffLines: 10 })).toBe(ECONOMY_SEAT_BUDGET);
    expect(seatBudget({ diffFiles: 1, diffLines: SMALL_DIFF_MAX_LINES + 1 })).toBe(ECONOMY_SEAT_BUDGET);
  });

  it("fails closed on an unknown line count: never the smaller budget", () => {
    // A 1-file diff with no line total must not be assumed small.
    expect(seatBudget({ diffFiles: 1, diffLines: null })).toBe(ECONOMY_SEAT_BUDGET);
  });
});

describe("selectEconomySeats", () => {
  it("seats every guaranteed lens even when they alone exceed the budget", () => {
    // Four relevant cross-stack lenses, budget 1: the budget must not drop any of
    // them, and no specialist may be added on top.
    const ranked = [
      cand("hunt", 4, { cross: true, domains: ["security"] }),
      cand("dahl", 9, { domains: ["backend-architecture"] }),
      cand("beck", 4, { cross: true, domains: ["test-quality"] }),
      cand("fowler", 4, { cross: true, domains: ["refactoring"] }),
      cand("willison", 4, { cross: true, domains: ["llm-pipeline"] }),
    ];
    const out = selectEconomySeats(ranked, 1);
    expect(out.seated.map((c) => c.advisorId).sort()).toEqual(["beck", "fowler", "hunt", "willison"]);
    expect(out.overBudget).toBe(true);
    expect(out.dropped).toEqual([{ advisorId: "dahl", reason: "over-budget" }]);
  });

  it("drops a stack-only match (no changed domain) and says why", () => {
    const ranked = [
      cand("dahl", 10), // strong stack overlap, zero domain overlap
      cand("friedman", 3, { domains: ["ux-flow"] }),
      cand("hunt", 1, { cross: true }), // cross-stack but its domain untouched
    ];
    const out = selectEconomySeats(ranked, 3);
    expect(out.seated.map((c) => c.advisorId)).toEqual(["friedman"]);
    expect(out.dropped).toEqual([
      { advisorId: "dahl", reason: "no-domain-match" },
      { advisorId: "hunt", reason: "no-domain-match" },
    ]);
    expect(out.overBudget).toBe(false);
  });

  it("fills the remaining budget by rank and presents seats in rank order", () => {
    const ranked = [
      cand("abramov", 8, { domains: ["frontend-architecture"] }),
      cand("saarinen", 5, { domains: ["ui-visual-quality"] }),
      cand("watson", 5, { domains: ["accessibility"] }),
      cand("hunt", 4, { cross: true, domains: ["security"] }),
    ];
    const out = selectEconomySeats(ranked, 3);
    // hunt is reserved first; abramov + saarinen fill (saarinen beats watson on id tie-break).
    expect(out.seated.map((c) => c.advisorId)).toEqual(["abramov", "saarinen", "hunt"]);
    expect(out.dropped).toEqual([{ advisorId: "watson", reason: "over-budget" }]);
  });

  it("rejects a non-positive or fractional budget", () => {
    expect(() => selectEconomySeats([], 0)).toThrow(/budget/);
    expect(() => selectEconomySeats([], 2.5)).toThrow(/budget/);
  });
});

describe("composeEconomyCouncil (frozen catalog snapshot)", () => {
  const auraSignals = history.fingerprintSignals;

  it("a UX-only change seats the UX lens, not the backend stack specialist", () => {
    const out = composeEconomyCouncil(auraSignals, ["ux-flow"], profiles, { diffFiles: 2, diffLines: 40 });
    const ids = out.seated.map((c) => c.advisorId);
    expect(ids).toContain("friedman");
    expect(ids).not.toContain("dahl");
    expect(out.dropped).toContainEqual({ advisorId: "dahl", reason: "no-domain-match" });
  });

  it("is deterministic for identical input", () => {
    const run = () =>
      composeEconomyCouncil(auraSignals, ["security", "test-quality", "ux-flow"], profiles, {
        diffFiles: 8,
        diffLines: 900,
      });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe("history replay (B4 acceptance evidence)", () => {
  const outcomes = applyPolicyToHistory(history, profiles);

  it("never misses a fail-closed lens whose domain the change touched", () => {
    for (const o of outcomes) expect(o.guaranteedMissed, o.reviewId).toEqual([]);
  });

  it("never seats more than max(budget, relevant fail-closed lenses)", () => {
    for (const o of outcomes) {
      if (o.overBudget) {
        // Over budget ⇒ every seat must be a cross-stack lens (no specialist rode along).
        const cross = new Set(profiles.filter((p) => p.signals.includes("any")).map((p) => p.id));
        for (const id of o.economySeats) expect(cross.has(id), `${o.reviewId}:${id}`).toBe(true);
      } else {
        expect(o.economySeats.length, o.reviewId).toBeLessThanOrEqual(o.budget);
      }
    }
  });

  it("cuts the median panel versus what was historically dispatched", () => {
    const hist = median(outcomes.map((o) => o.historicalSeats))!;
    const econ = median(outcomes.map((o) => o.economySeats.length))!;
    // Pinned so a policy or dataset change that moves the headline number is a
    // deliberate, visible diff (the report quotes these values).
    expect(hist).toBe(8);
    expect(econ).toBe(4);
  });

  it("the committed B4 report embeds exactly the renderer's output (canary)", () => {
    const reportPath = join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "specs",
      "aura-meta-diet",
      "B4-dispatch-report.md",
    );
    const doc = readFileSync(reportPath, "utf8");
    const m = doc.match(/<!-- dispatch-report:begin -->\n([\s\S]*?)<!-- dispatch-report:end -->/);
    expect(m, "report markers missing").not.toBeNull();
    expect(m![1]).toBe(renderDispatchReport(outcomes));
  });
});

describe("parseDispatchHistory (fail-loud)", () => {
  const good = () => JSON.parse(JSON.stringify({ fingerprintSignals: history.fingerprintSignals, reviews: history.reviews }));

  it("accepts the checked-in dataset", () => {
    expect(() => parseDispatchHistory(good())).not.toThrow();
  });

  it("rejects a duplicate reviewId", () => {
    const d = good();
    d.reviews.push(d.reviews[0]);
    expect(() => parseDispatchHistory(d)).toThrow(/duplicate/);
  });

  it("rejects an unknown finding priority", () => {
    const d = good();
    const r = d.reviews.find((x: { finalFindings: unknown }) => Array.isArray(x.finalFindings));
    r.finalFindings[0].priority = "P0";
    expect(() => parseDispatchHistory(d)).toThrow(/priority/);
  });

  it("rejects a negative or fractional diff size", () => {
    const d = good();
    d.reviews[0].diffFiles = -1;
    expect(() => parseDispatchHistory(d)).toThrow(/diffFiles/);
    const e = good();
    e.reviews[0].diffLines = 1.5;
    expect(() => parseDispatchHistory(e)).toThrow(/diffLines/);
  });
});

describe("sizeBucket / median", () => {
  it("buckets by files and lines; unknown lines never lands in S", () => {
    expect(sizeBucket({ diffFiles: 5, diffLines: 600 })).toBe("S");
    expect(sizeBucket({ diffFiles: 5, diffLines: null })).toBe("M");
    expect(sizeBucket({ diffFiles: 21, diffLines: null })).toBe("L");
    expect(sizeBucket({ diffFiles: 2, diffLines: 2001 })).toBe("L");
  });

  it("median handles odd, even and empty input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
