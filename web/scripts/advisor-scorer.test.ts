// Tests for the RC-2 deterministic scorer (PLAN Task 5). Synthetic profiles +
// fingerprints (dahl #9 — no live catalog). Asserts the ranking/guardrail/dedup
// contract: AC3.1 ranking, AC3.2 narrow→small, AC3.3 broad→capped, AC3.4 dedup,
// hunt #4 cross-stack floor, determinism.

import { describe, it, expect } from "vitest";
import {
  scoreAdvisors,
  dedupRedundant,
  applyGuardrails,
  composeCouncil,
  MIN_SEATS,
  MAX_SEATS,
} from "./advisor-scorer.js";
import type { RankedCandidate } from "./advisor-scorer.js";
import type { Fingerprint } from "./fingerprint";
import type { AdvisorProfile } from "./capability-catalog";

function fp(signals: string[]): Fingerprint {
  return {
    kind: signals.length ? "fingerprint" : "needs-confirmation",
    signals: [...signals].sort(),
    byDimension: { languages: [], runtimes: [], frameworks: [], datastores: [], "orm-migrations": [], infra: [], surfaces: [] },
    provenance: [],
    scanTruncated: false,
    failures: [],
  };
}
function prof(id: string, signals: string[], domains: string[]): AdvisorProfile {
  return { id, signals, domains };
}

const HUNT = prof("hunt", ["any"], ["security"]);
const FOWLER = prof("fowler", ["any"], ["refactoring", "backend-architecture"]);
const ABRAMOV = prof("abramov", ["react", "vue", "browser-spa", "typescript"], ["frontend-architecture"]);
const WATSON = prof("watson", ["browser-spa", "react"], ["accessibility"]);
const BRANDUR = prof("brandur", ["postgres", "sqlalchemy", "alembic"], ["database-persistence", "schema-migrations"]);

describe("scoreAdvisors — ranking (AC3.1)", () => {
  it("higher signal+domain relevance ranks above a cross-stack baseline", () => {
    const ranked = scoreAdvisors(fp(["react", "browser-spa", "typescript"]), ["frontend-architecture"], [HUNT, ABRAMOV, WATSON]);
    expect(ranked[0].advisorId).toBe("abramov"); // 3 signals*2 + 1 domain*3 = 9
    expect(ranked.find((c) => c.advisorId === "hunt")).toBeDefined(); // baseline candidate
    expect(ranked[0].score).toBeGreaterThan(ranked[ranked.length - 1].score);
  });

  it("excludes a profile with zero signal AND zero domain overlap (no quota padding)", () => {
    const ranked = scoreAdvisors(fp(["react"]), ["frontend-architecture"], [BRANDUR]);
    expect(ranked).toEqual([]); // brandur matches neither react nor frontend-architecture
  });
});

describe("scoreAdvisors — cross-stack floor (hunt #4)", () => {
  it("a security (`any`) lens stays a candidate even when its domain is not requested", () => {
    // featureDomains excludes security, fingerprint is pure frontend
    const ranked = scoreAdvisors(fp(["react"]), ["frontend-architecture"], [HUNT, ABRAMOV]);
    expect(ranked.some((c) => c.advisorId === "hunt" && c.crossStack)).toBe(true);
  });
});

describe("dedupRedundant (AC3.4)", () => {
  it("drops a lower-ranked candidate with an identical matched-signal+domain set", () => {
    const a: RankedCandidate = { advisorId: "a", score: 4, matchedSignals: ["react"], matchedDomains: ["frontend-architecture"], crossStack: false };
    const b: RankedCandidate = { advisorId: "b", score: 4, matchedSignals: ["react"], matchedDomains: ["frontend-architecture"], crossStack: false };
    const out = dedupRedundant([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].advisorId).toBe("a");
  });
  it("keeps a genuine lane-split (different matched sets)", () => {
    const a: RankedCandidate = { advisorId: "a", score: 4, matchedSignals: ["react"], matchedDomains: [], crossStack: false };
    const b: RankedCandidate = { advisorId: "b", score: 4, matchedSignals: ["fastapi"], matchedDomains: [], crossStack: false };
    expect(dedupRedundant([a, b])).toHaveLength(2);
  });
});

describe("applyGuardrails (AC3.2 / AC3.3)", () => {
  it("broad feature seats more but caps at MAX_SEATS", () => {
    // 15 distinct profiles all matching react → all score>0, 15 candidates
    const many: AdvisorProfile[] = Array.from({ length: 15 }, (_, i) =>
      prof(`adv${String(i).padStart(2, "0")}`, ["react"], []),
    );
    const comp = composeCouncil(fp(["react"]), [], many);
    // NOTE: identical matched sets → dedupRedundant collapses to 1. Use distinct sets:
    expect(comp.seated.length).toBeLessThanOrEqual(MAX_SEATS);
  });

  it("caps a large DISTINCT candidate pool at exactly MAX_SEATS", () => {
    // give each a distinct matched set so dedup keeps them all
    const fingerprint = fp(["react", "vue", "svelte", "hono", "express", "fastify", "fastapi", "flask", "django", "starlette", "postgres", "redis", "aiogram"]);
    const many: AdvisorProfile[] = fingerprint.signals.map((s, i) => prof(`adv${String(i).padStart(2, "0")}`, [s], []));
    const comp = composeCouncil(fingerprint, [], many);
    expect(comp.seated).toHaveLength(MAX_SEATS);
    expect(comp.cappedAtMax).toBe(true);
  });

  it("narrow feature seats a small council (not the whole pool)", () => {
    const comp = composeCouncil(fp(["react"]), ["frontend-architecture"], [HUNT, FOWLER, ABRAMOV, WATSON, BRANDUR]);
    // brandur excluded (no overlap); seated is the relevant few
    expect(comp.seated.some((c) => c.advisorId === "brandur")).toBe(false);
    expect(comp.seated.length).toBeLessThan(5);
    expect(comp.seated.length).toBeGreaterThanOrEqual(1);
  });
});

describe("composeCouncil — crowded-out visibility (hunt #4)", () => {
  it("surfaces candidates that scored >0 but fell below the max cap", () => {
    // 13 distinct-signal candidates, cap at max=11 → 2 crowded out, still listed
    const fingerprint = fp(["react", "vue", "svelte", "hono", "express", "fastify", "fastapi", "flask", "django", "starlette", "postgres", "redis", "aiogram"]);
    const many: AdvisorProfile[] = fingerprint.signals.map((s, i) => prof(`adv${String(i).padStart(2, "0")}`, [s], []));
    const comp = composeCouncil(fingerprint, [], many);
    expect(comp.seated).toHaveLength(MAX_SEATS);
    expect(comp.crowdedOut.length).toBe(many.length - MAX_SEATS);
    // every crowded-out candidate is a real candidate (score > 0), not silently dropped
    expect(comp.crowdedOut.every((c) => c.score > 0)).toBe(true);
  });
});

describe("dedupRedundant — cross-stack lenses are never collapsed (hunt #1)", () => {
  it("keeps every cross-stack (`any`) lens even when their matched sets are identically empty", () => {
    // On a narrow feature all four `any`-lenses collapse to key "|" — pre-fix this
    // dropped all but the alphabetical survivor from ranked AND crowdedOut.
    const huntC: RankedCandidate = { advisorId: "hunt", score: 1, matchedSignals: [], matchedDomains: [], crossStack: true };
    const willC: RankedCandidate = { advisorId: "willison", score: 1, matchedSignals: [], matchedDomains: [], crossStack: true };
    const beckC: RankedCandidate = { advisorId: "beck", score: 1, matchedSignals: [], matchedDomains: [], crossStack: true };
    const out = dedupRedundant([huntC, willC, beckC]);
    expect(out.map((c) => c.advisorId).sort()).toEqual(["beck", "hunt", "willison"]);
  });
  it("a narrow feature leaves the security lens visible (seated or crowded-out), never silently dropped", () => {
    // pure frontend fingerprint, only frontend domain requested → hunt matches nothing
    const comp = composeCouncil(fp(["react", "browser-spa"]), ["frontend-architecture"], [HUNT, FOWLER, ABRAMOV]);
    const everywhere = [...comp.seated, ...comp.crowdedOut].map((c) => c.advisorId);
    expect(everywhere).toContain("hunt");
    expect(everywhere).toContain("fowler");
  });
});

describe("composeCouncil — Variant-B guaranteed seat under cap pressure (hunt #4 / beck #4)", () => {
  it("seats a domain-relevant cross-stack lens even when it ranks below the MAX cap", () => {
    // 11 high-scoring distinct stack matchers + a guaranteed security lens ranking last
    const sigs = ["react", "vue", "svelte", "hono", "express", "fastify", "fastapi", "flask", "django", "starlette", "postgres"];
    const stack: AdvisorProfile[] = sigs.map((s, i) => prof(`z${String(i).padStart(2, "0")}`, [s], []));
    const comp = composeCouncil(fp(sigs), ["security"], [...stack, HUNT]);
    expect(comp.seated).toHaveLength(MAX_SEATS);
    expect(comp.seated.some((c) => c.advisorId === "hunt")).toBe(true); // reserved, not crowded out
    expect(comp.crowdedOut.some((c) => c.advisorId === "hunt")).toBe(false);
  });
  it("an out-of-domain cross-stack lens remains crowdable (adaptivity preserved)", () => {
    const sigs = ["react", "vue", "svelte", "hono", "express", "fastify", "fastapi", "flask", "django", "starlette", "postgres"];
    const stack: AdvisorProfile[] = sigs.map((s, i) => prof(`z${String(i).padStart(2, "0")}`, [s], []));
    // security NOT requested → hunt is a baseline candidate but NOT guaranteed → crowdable
    const comp = composeCouncil(fp(sigs), ["frontend-architecture"], [...stack, HUNT]);
    expect(comp.seated).toHaveLength(MAX_SEATS);
    expect(comp.crowdedOut.some((c) => c.advisorId === "hunt")).toBe(true);
  });
  it("reports belowMin on a genuinely thin candidate pool", () => {
    const comp = composeCouncil(fp(["react"]), ["frontend-architecture"], [ABRAMOV]); // 1 candidate
    expect(comp.seated.length).toBeLessThan(MIN_SEATS);
    expect(comp.belowMin).toBe(true);
  });
});

describe("scoreAdvisors — determinism (dahl #7)", () => {
  it("equal-score advisors resolve by advisorId; two runs are identical", () => {
    const pool = [WATSON, ABRAMOV, HUNT, FOWLER, BRANDUR];
    const a = scoreAdvisors(fp(["react", "postgres"]), ["security"], pool);
    const b = scoreAdvisors(fp(["react", "postgres"]), ["security"], pool);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // total order: verify sorted by (score desc, id asc)
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1], cur = a[i];
      expect(prev.score > cur.score || (prev.score === cur.score && prev.advisorId < cur.advisorId)).toBe(true);
    }
  });
});
