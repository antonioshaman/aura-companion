/**
 * Tests for the AuraBench solution-leak judge (P6/FIX-D2-5). The LLM call is
 * not exercised here (no LLM in CI); what is pinned is everything around it:
 *   - the request carries prompt, required interface, diff and hidden tests,
 *     and clips huge diffs visibly instead of silently;
 *   - the reply parser is fail-closed: unknown verdicts/kinds, missing fields
 *     and a "clean" verdict that contradicts its own cause/fix issue are
 *     rejected, never coerced to "clean";
 *   - verdicts are keyed by prompt hash + rubric version, so editing a prompt
 *     after judging (or bumping the rubric) invalidates the old verdict;
 *   - the corpus gate reports missing, stale and non-clean verdicts.
 */

import { describe, it, expect } from "vitest";
import {
  JUDGE_JSON_SCHEMA,
  JUDGE_RUBRIC_VERSION,
  buildJudgeRequest,
  checkCorpusReviewed,
  judgeKey,
  parseJudgeReply,
  promptSha256,
  readJudgeRecords,
  type JudgeRecord,
} from "./prompt-judge.js";

const input = {
  id: "t1",
  cls: "debug",
  title: "Sessions recover",
  prompt: "Sessions look connected but never answer.\n",
  requiredInterface: ["relaunchDeaf"],
  sourceDiff: "+ if (!adapter) relaunch()",
  hiddenTests: "it('relaunches deaf sessions')",
};

const record = (over: Partial<JudgeRecord> = {}): JudgeRecord => ({
  id: "t1",
  prompt_sha256: promptSha256(input.prompt),
  rubric_version: JUDGE_RUBRIC_VERSION,
  model: "claude-opus-5-5",
  judged_at: "2026-09-28T12:00:00Z",
  verdict: "clean",
  issues: [],
  rationale: "ok",
  ...over,
});

describe("buildJudgeRequest", () => {
  it("includes the prompt, class, required interface, diff and hidden tests", () => {
    const req = buildJudgeRequest(input);
    expect(req).toContain("<prompt>\nSessions look connected but never answer.\n</prompt>");
    expect(req).toContain("class: debug");
    expect(req).toContain("- relaunchDeaf");
    expect(req).toContain("+ if (!adapter) relaunch()");
    expect(req).toContain("it('relaunches deaf sessions')");
  });

  it("says (none) when no new interface is required", () => {
    expect(buildJudgeRequest({ ...input, requiredInterface: [] })).toContain("(none)");
  });

  it("clips an oversized diff and marks the clip", () => {
    const req = buildJudgeRequest({ ...input, sourceDiff: "x".repeat(200) }, { diff: 50, tests: 1000 });
    expect(req).toContain("[truncated 150 chars]");
    expect(req).not.toContain("x".repeat(51));
  });
});

describe("JUDGE_JSON_SCHEMA", () => {
  it("enumerates exactly the verdicts and issue kinds the parser accepts", () => {
    expect(JUDGE_JSON_SCHEMA.properties.verdict.enum).toEqual(["clean", "rewrite", "exclude"]);
    expect(JUDGE_JSON_SCHEMA.properties.issues.items.properties.kind.enum).toEqual([
      "cause",
      "fix",
      "contract_is_fix",
      "underspecified",
    ]);
  });
});

describe("parseJudgeReply", () => {
  it("accepts a well-formed rewrite verdict", () => {
    const r = parseJudgeReply({ verdict: "rewrite", issues: [{ kind: "cause", quote: "q", why: "w" }], rationale: "r" });
    expect(r).toEqual({ ok: true, value: { verdict: "rewrite", issues: [{ kind: "cause", quote: "q", why: "w" }], rationale: "r" } });
  });

  it("accepts clean with only an underspecified note", () => {
    const r = parseJudgeReply({ verdict: "clean", issues: [{ kind: "underspecified", quote: "q", why: "w" }], rationale: "r" });
    expect(r.ok).toBe(true);
  });

  it("rejects clean that contradicts a cause/fix issue (fail-closed, not coerced)", () => {
    for (const kind of ["cause", "fix", "contract_is_fix"]) {
      const r = parseJudgeReply({ verdict: "clean", issues: [{ kind, quote: "q", why: "w" }], rationale: "r" });
      expect(r).toEqual({ ok: false, error: "verdict clean contradicts a cause/fix/contract_is_fix issue" });
    }
  });

  it("rejects unknown verdicts, unknown kinds and missing fields", () => {
    expect(parseJudgeReply(null).ok).toBe(false);
    expect(parseJudgeReply({ verdict: "fine", issues: [], rationale: "r" }).ok).toBe(false);
    expect(parseJudgeReply({ verdict: "clean", issues: [], rationale: 3 }).ok).toBe(false);
    expect(parseJudgeReply({ verdict: "clean", rationale: "r" }).ok).toBe(false);
    expect(parseJudgeReply({ verdict: "rewrite", issues: [{ kind: "hint", quote: "q", why: "w" }], rationale: "r" }).ok).toBe(false);
    expect(parseJudgeReply({ verdict: "rewrite", issues: [{ kind: "fix", quote: 1, why: "w" }], rationale: "r" }).ok).toBe(false);
    expect(parseJudgeReply({ verdict: "rewrite", issues: [null], rationale: "r" }).ok).toBe(false);
  });
});

describe("judge keys", () => {
  it("change when the prompt or the rubric version changes", () => {
    const k = judgeKey("t1", "a");
    expect(judgeKey("t1", "a")).toBe(k);
    expect(judgeKey("t1", "a ")).not.toBe(k);
    expect(judgeKey("t1", "a", JUDGE_RUBRIC_VERSION + 1)).not.toBe(k);
  });

  it("readJudgeRecords keeps the latest record per key and ignores torn lines", () => {
    const first = record({ verdict: "rewrite", issues: [{ kind: "fix", quote: "q", why: "w" }] });
    const second = record();
    const map = readJudgeRecords([JSON.stringify(first), "{torn", JSON.stringify(second)].join("\n"));
    expect(map.size).toBe(1);
    expect(map.get(judgeKey("t1", input.prompt))!.verdict).toBe("clean");
  });
});

describe("checkCorpusReviewed", () => {
  it("passes a task whose current prompt has a clean verdict", () => {
    expect(checkCorpusReviewed([{ id: "t1", prompt: input.prompt }], [record()])).toEqual([]);
  });

  it("reports a prompt edited after judging as unreviewed", () => {
    // The stale-verdict case: a rewrite must be judged again before it counts.
    expect(checkCorpusReviewed([{ id: "t1", prompt: `${input.prompt}more` }], [record()])).toEqual([
      { id: "t1", problem: "no judge verdict for the current prompt and rubric" },
    ]);
  });

  it("reports a non-clean verdict and a verdict from an older rubric", () => {
    const tasks = [{ id: "t1", prompt: input.prompt }];
    expect(checkCorpusReviewed(tasks, [record({ verdict: "exclude" })])).toEqual([{ id: "t1", problem: "judge verdict is exclude" }]);
    expect(checkCorpusReviewed(tasks, [record({ rubric_version: JUDGE_RUBRIC_VERSION - 1 })])).toEqual([
      { id: "t1", problem: "no judge verdict for the current prompt and rubric" },
    ]);
  });
});
