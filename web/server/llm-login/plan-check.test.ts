import { describe, expect, it } from "vitest";
import { knownField, unknownField } from "../auth-status/auth-types.js";
import {
  EXPECTED_PLANS,
  applyExpectedPlansPatch,
  normalizeExpectedPlans,
  normalizeObservedPlan,
  parseExpectedPlan,
  planCheck,
} from "./plan-check.js";

/**
 * Plan check (phase 2 task 7, D7, spec Story 2 S2-AC1…AC3).
 *
 * What is pinned:
 * - the expected plan is a closed list per provider; anything else is refused
 *   (REST) or ignored (settings file) — never stored as free text;
 * - "max" matches any Max tier (5x / 20x) — the provider reports the tier;
 * - an unknown or unrecognised observed plan is `unknown`, NEVER `match`
 *   (S2-AC3: "plan not determined", not "as expected");
 * - no expectation → `unset` (S2-AC2: no warning).
 */

describe("planCheck", () => {
  it("no expected plan → unset, whatever was observed (S2-AC2)", () => {
    expect(planCheck("claude", knownField("pro"), null)).toBe("unset");
    expect(planCheck("codex", unknownField, null)).toBe("unset");
  });

  it("same plan → match; different plan → mismatch (S2-AC1), for both providers", () => {
    expect(planCheck("claude", knownField("max"), "max")).toBe("match");
    expect(planCheck("claude", knownField("pro"), "max")).toBe("mismatch");
    expect(planCheck("codex", knownField("pro"), "pro")).toBe("match");
    expect(planCheck("codex", knownField("plus"), "pro")).toBe("mismatch");
  });

  it("\"max\" matches any Max tier and tolerates case/prefix noise", () => {
    expect(planCheck("claude", knownField("max_20x"), "max")).toBe("match");
    expect(planCheck("claude", knownField("Max 5x"), "max")).toBe("match");
    expect(planCheck("claude", knownField("claude_max"), "max")).toBe("match");
    expect(planCheck("codex", knownField("ChatGPT_Plus"), "plus")).toBe("match");
  });

  it("an unknown observed plan is unknown, never match (S2-AC3)", () => {
    expect(planCheck("claude", unknownField, "max")).toBe("unknown");
    expect(planCheck("codex", unknownField, "plus")).toBe("unknown");
  });

  it("an observed plan outside the provider's vocabulary is unknown, never match or mismatch", () => {
    // A new/renamed plan string must not be read as "your plan is wrong" nor as "as expected".
    expect(planCheck("claude", knownField("ultra_galactic"), "max")).toBe("unknown");
    expect(planCheck("codex", knownField(""), "pro")).toBe("unknown");
  });

  it("free is a real plan: it mismatches a paid expectation", () => {
    expect(planCheck("claude", knownField("free"), "pro")).toBe("mismatch");
    expect(planCheck("codex", knownField("free"), "plus")).toBe("mismatch");
  });
});

describe("normalizeObservedPlan", () => {
  it("maps provider strings to one vocabulary value, or null when unrecognised", () => {
    expect(normalizeObservedPlan("claude", "MAX_20X")).toBe("max");
    expect(normalizeObservedPlan("claude", "enterprise")).toBe("enterprise");
    expect(normalizeObservedPlan("codex", "business")).toBe("business");
    expect(normalizeObservedPlan("codex", "max")).toBeNull();
    expect(normalizeObservedPlan("claude", "plus")).toBeNull();
  });
});

describe("parseExpectedPlan / normalizeExpectedPlans (closed list, D7)", () => {
  it("accepts only the provider's list", () => {
    for (const p of EXPECTED_PLANS.claude) expect(parseExpectedPlan("claude", p)).toBe(p);
    for (const p of EXPECTED_PLANS.codex) expect(parseExpectedPlan("codex", p)).toBe(p);
    expect(parseExpectedPlan("claude", "plus")).toBeNull();
    expect(parseExpectedPlan("codex", "max")).toBeNull();
    expect(parseExpectedPlan("claude", "free")).toBeNull();
    expect(parseExpectedPlan("claude", 42)).toBeNull();
  });

  it("accepts the display casing (MAX) and stores the canonical value", () => {
    expect(parseExpectedPlan("claude", "MAX")).toBe("max");
  });

  it("settings normalisation keeps known values and silently drops the rest", () => {
    expect(normalizeExpectedPlans({ claude: "max", codex: "pro" })).toEqual({ claude: "max", codex: "pro" });
    expect(normalizeExpectedPlans({ claude: "bogus", codex: "plus", gemini: "x" })).toEqual({ codex: "plus" });
    expect(normalizeExpectedPlans(null)).toEqual({});
    expect(normalizeExpectedPlans("max")).toEqual({});
  });
});

describe("applyExpectedPlansPatch (REST, strict)", () => {
  it("sets, replaces and removes (null) per provider without touching the other", () => {
    expect(applyExpectedPlansPatch({ codex: "pro" }, { claude: "max" })).toEqual({ ok: true, value: { claude: "max", codex: "pro" } });
    expect(applyExpectedPlansPatch({ claude: "max", codex: "pro" }, { claude: null })).toEqual({ ok: true, value: { codex: "pro" } });
  });

  it("refuses an off-list plan, an unknown provider, or a non-object", () => {
    expect(applyExpectedPlansPatch({}, { claude: "plus" }).ok).toBe(false);
    expect(applyExpectedPlansPatch({}, { gemini: "pro" }).ok).toBe(false);
    expect(applyExpectedPlansPatch({}, "max").ok).toBe(false);
    expect(applyExpectedPlansPatch({}, null).ok).toBe(false);
  });
});
