/**
 * Tests for the A/B skill delta. Contracts:
 *  - direction matters: a token_cost INCREASE is "worse" (lower_better), a
 *    success_rate increase is "better" (higher_better) — the headline shows BOTH
 *    so a skill that helps quality but costs more isn't laundered into one score.
 *  - pct_change is computed against |baseline|, and is "n/a" when baseline is 0.
 *  - a metric absent from an arm (or "unavailable") yields n/a delta + verdict,
 *    never 0.
 *  - both text and markdown render every row + the tally.
 */

import { describe, it, expect } from "vitest";
import {
  compareSkillArms,
  renderABText,
  renderABMarkdown,
  type ABMetricSpec,
  type ArmResult,
} from "./ab-skill.js";

const specs: ABMetricSpec[] = [
  { name: "task_success_rate", direction: "higher_better" },
  { name: "token_cost", direction: "lower_better", unit: "$" },
  { name: "time_to_green", direction: "lower_better", unit: "s" },
];

describe("compareSkillArms", () => {
  it("scores quality gain and cost regression independently", () => {
    const off: ArmResult = {
      label: "skill-off",
      metrics: { task_success_rate: 0.6, token_cost: 1.0, time_to_green: 100 },
    };
    const on: ArmResult = {
      label: "skill-on",
      metrics: { task_success_rate: 0.75, token_cost: 1.5, time_to_green: 100 },
    };
    const cmp = compareSkillArms(specs, off, on);

    const success = cmp.rows.find((r) => r.name === "task_success_rate")!;
    expect(success.verdict).toBe("better");
    expect(success.delta).toBeCloseTo(0.15, 10);
    expect(success.pct_change).toBeCloseTo(25, 6); // 0.15 / 0.6 = 25%

    const cost = cmp.rows.find((r) => r.name === "token_cost")!;
    expect(cost.verdict).toBe("worse"); // cost went up → worse
    expect(cost.pct_change).toBeCloseTo(50, 6);

    const time = cmp.rows.find((r) => r.name === "time_to_green")!;
    expect(time.verdict).toBe("same");

    expect(cmp.better).toBe(1);
    expect(cmp.worse).toBe(1);
    expect(cmp.same).toBe(1);
  });

  it("returns n/a delta when a metric is unavailable or absent, and n/a pct when baseline is 0", () => {
    const off: ArmResult = {
      label: "off",
      metrics: { task_success_rate: 0, token_cost: "unavailable" },
    };
    const on: ArmResult = {
      label: "on",
      metrics: { task_success_rate: 0.5 },
    };
    const cmp = compareSkillArms(specs, off, on);

    const success = cmp.rows.find((r) => r.name === "task_success_rate")!;
    expect(success.verdict).toBe("better");
    expect(success.delta).toBeCloseTo(0.5, 10);
    expect(success.pct_change).toBe("n/a"); // baseline 0 → undefined pct

    const cost = cmp.rows.find((r) => r.name === "token_cost")!;
    expect(cost.delta).toBe("n/a"); // unavailable on baseline
    expect(cost.verdict).toBe("n/a");

    const time = cmp.rows.find((r) => r.name === "time_to_green")!;
    expect(time.delta).toBe("n/a"); // absent from both arms
    expect(time.verdict).toBe("n/a");
    expect(cmp.na).toBe(2);
  });
});

describe("renderABText / renderABMarkdown", () => {
  const off: ArmResult = { label: "skill-off", metrics: { task_success_rate: 0.6, token_cost: 1.0 } };
  const on: ArmResult = { label: "skill-on", metrics: { task_success_rate: 0.75, token_cost: 1.5 } };
  const cmp = compareSkillArms(specs, off, on);

  it("text form lists rows, verdicts and the tally", () => {
    const text = renderABText(cmp);
    expect(text).toContain("A/B Skill Delta: skill-off → skill-on");
    expect(text).toContain("task_success_rate");
    expect(text).toContain("BETTER");
    expect(text).toContain("WORSE");
    expect(text).toContain("better: 1");
  });

  it("markdown form renders a header per arm and a row per metric", () => {
    const md = renderABMarkdown(cmp);
    expect(md).toContain("| Metric | skill-off | skill-on | Δ | % | Verdict |");
    expect(md).toContain("🟢 better");
    expect(md).toContain("🔴 worse");
    expect(md).toContain("Better: 1");
  });
});
