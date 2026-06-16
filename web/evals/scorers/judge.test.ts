/**
 * Tests for the deterministic judge implementations. Contracts:
 *  - ScriptedJudge returns mapped verdicts and `skip`s anything unmapped (it was
 *    never asked) — never guesses.
 *  - HeuristicJudge maps high→true_positive, low→false_positive, else skip — the
 *    zero-quota baseline any real judge must beat.
 *  - runJudge preserves input order and is reproducible.
 *  - both are pure: same input twice → identical verdict.
 */

import { describe, it, expect } from "vitest";
import {
  ScriptedJudge,
  HeuristicJudge,
  runJudge,
  type JudgeInput,
} from "./judge.js";

const input = (over: Partial<JudgeInput>): JudgeInput => ({
  finding_id: "efnd_0001",
  claim: "leaks a PID",
  evidence_path: "web/server/cli-launcher.ts",
  severity: "STOP",
  ...over,
});

describe("ScriptedJudge", () => {
  it("returns the mapped verdict for a known finding", async () => {
    const judge = new ScriptedJudge({ efnd_0001: "true_positive", efnd_0002: "false_positive" });
    expect((await judge.judge(input({ finding_id: "efnd_0001" }))).verdict).toBe("true_positive");
    expect((await judge.judge(input({ finding_id: "efnd_0002" }))).verdict).toBe("false_positive");
  });

  it("skips an unmapped finding rather than guessing", async () => {
    const judge = new ScriptedJudge({ efnd_0001: "true_positive" });
    expect((await judge.judge(input({ finding_id: "efnd_zzzz" }))).verdict).toBe("skip");
  });

  it("accepts a Map and a custom id", async () => {
    const judge = new ScriptedJudge(new Map([["efnd_0001", "false_positive" as const]]), "frozen-claude");
    expect(judge.id).toBe("frozen-claude");
    expect((await judge.judge(input({}))).verdict).toBe("false_positive");
  });
});

describe("HeuristicJudge", () => {
  it("confirms high confidence, rejects low, abstains otherwise", async () => {
    const judge = new HeuristicJudge();
    expect((await judge.judge(input({ confidence: "high" }))).verdict).toBe("true_positive");
    expect((await judge.judge(input({ confidence: "low" }))).verdict).toBe("false_positive");
    expect((await judge.judge(input({ confidence: "medium" }))).verdict).toBe("skip");
    expect((await judge.judge(input({ confidence: undefined }))).verdict).toBe("skip");
  });

  it("is pure: same input yields the same verdict", async () => {
    const judge = new HeuristicJudge();
    const a = await judge.judge(input({ confidence: "high" }));
    const b = await judge.judge(input({ confidence: "high" }));
    expect(a.verdict).toBe(b.verdict);
  });
});

describe("runJudge", () => {
  it("preserves input order across the batch", async () => {
    const judge = new ScriptedJudge({ a: "true_positive", b: "false_positive", c: "skip" });
    const results = await runJudge(judge, [
      input({ finding_id: "a" }),
      input({ finding_id: "b" }),
      input({ finding_id: "c" }),
    ]);
    expect(results.map((r) => r.finding_id)).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.verdict)).toEqual(["true_positive", "false_positive", "skip"]);
  });
});
