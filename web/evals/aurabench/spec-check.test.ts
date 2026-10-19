/**
 * Tests for the AuraBench spec-completeness check (P6/CORPUS-SPEC-CHECK). The
 * LLM call is not exercised (no LLM in CI); pinned here is everything around it:
 *   - the request carries prompt, new names, diff and hidden tests, and clips
 *     huge inputs visibly;
 *   - the reply parser is fail-closed: an unknown verdict, malformed gaps,
 *     "ok" with gaps and "underspecified" without gaps are all rejected, never
 *     coerced to "ok" (a silent "ok" would let an ambiguous task into D2-full);
 *   - verdicts are keyed by prompt hash + rubric version, so a prompt edited
 *     after the check needs a new verdict;
 *   - the corpus gate reports missing, stale and underspecified verdicts and
 *     honours an explicit waiver list.
 */

import { describe, it, expect } from "vitest";
import {
  SPEC_JSON_SCHEMA,
  SPEC_RUBRIC_VERSION,
  buildSpecRequest,
  checkCorpusSpecified,
  parseSpecReply,
  readSpecRecords,
  specKey,
  type SpecRecord,
} from "./spec-check.js";
import { promptSha256 } from "./prompt-judge.js";

const input = {
  id: "t1",
  cls: "debug",
  title: "Resume streak",
  prompt: "Require two fast resume-deaths before discarding.\n",
  requiredInterface: ["shouldClearResumeAfterExit"],
  sourceDiff: "+ session.resumeImmediateFailures = n",
  hiddenTests: "+ expect(s.resumeImmediateFailures).toBe(2)",
};

const gap = { test: "clears after two", assertion: "resumeImmediateFailures toBe(2)", missing: "the streak after a discard" };

const record = (over: Partial<SpecRecord> = {}): SpecRecord => ({
  id: "t1",
  prompt_sha256: promptSha256(input.prompt),
  rubric_version: SPEC_RUBRIC_VERSION,
  model: "claude-opus-5-5",
  checked_at: "2026-09-29T20:00:00Z",
  verdict: "ok",
  gaps: [],
  rationale: "every assertion is stated",
  ...over,
});

describe("buildSpecRequest", () => {
  it("includes prompt, class, new names, diff and hidden tests", () => {
    const req = buildSpecRequest(input);
    expect(req).toContain("<prompt>\nRequire two fast resume-deaths before discarding.\n</prompt>");
    expect(req).toContain("class: debug");
    expect(req).toContain("- shouldClearResumeAfterExit");
    expect(req).toContain("+ session.resumeImmediateFailures = n");
    expect(req).toContain("+ expect(s.resumeImmediateFailures).toBe(2)");
  });

  it("says (none) when the tests use no new name", () => {
    expect(buildSpecRequest({ ...input, requiredInterface: [] })).toContain("(none)");
  });

  it("clips oversized diff and tests with a visible marker", () => {
    // A silently truncated test file would hide assertions from the checker.
    const req = buildSpecRequest({ ...input, sourceDiff: "d".repeat(50), hiddenTests: "t".repeat(40) }, { diff: 10, tests: 10 });
    expect(req).toContain("[truncated 40 chars]");
    expect(req).toContain("[truncated 30 chars]");
  });
});

describe("SPEC_JSON_SCHEMA", () => {
  it("requires verdict, gaps and rationale and forbids extra keys", () => {
    expect(SPEC_JSON_SCHEMA.required).toEqual(["verdict", "gaps", "rationale"]);
    expect(SPEC_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(SPEC_JSON_SCHEMA.properties.verdict.enum).toEqual(["ok", "underspecified"]);
  });
});

describe("parseSpecReply", () => {
  it("accepts ok without gaps and underspecified with gaps", () => {
    expect(parseSpecReply({ verdict: "ok", gaps: [], rationale: "r" })).toEqual({ ok: true, value: { verdict: "ok", gaps: [], rationale: "r" } });
    const u = parseSpecReply({ verdict: "underspecified", gaps: [gap], rationale: "r" });
    expect(u.ok && u.value.gaps).toEqual([gap]);
  });

  it("rejects ok that still lists gaps", () => {
    expect(parseSpecReply({ verdict: "ok", gaps: [gap], rationale: "r" }).ok).toBe(false);
  });

  it("rejects underspecified without a single gap", () => {
    // A verdict with nothing to fix cannot drive a prompt revision.
    expect(parseSpecReply({ verdict: "underspecified", gaps: [], rationale: "r" }).ok).toBe(false);
  });

  it("rejects unknown verdicts, non-objects and malformed gaps", () => {
    expect(parseSpecReply(null).ok).toBe(false);
    expect(parseSpecReply({ verdict: "fine", gaps: [], rationale: "r" }).ok).toBe(false);
    expect(parseSpecReply({ verdict: "ok", gaps: "none", rationale: "r" }).ok).toBe(false);
    expect(parseSpecReply({ verdict: "ok", gaps: [], rationale: 1 }).ok).toBe(false);
    expect(parseSpecReply({ verdict: "underspecified", gaps: [{ test: "x", assertion: "y" }], rationale: "r" }).ok).toBe(false);
    expect(parseSpecReply({ verdict: "underspecified", gaps: [null], rationale: "r" }).ok).toBe(false);
  });
});

describe("specKey / readSpecRecords", () => {
  it("changes when the prompt or the rubric changes", () => {
    expect(specKey("t1", "a")).not.toBe(specKey("t1", "b"));
    expect(specKey("t1", "a", 1)).not.toBe(specKey("t1", "a", 2));
  });

  it("keeps the latest record per key and ignores torn lines", () => {
    const first = record({ verdict: "underspecified", gaps: [gap] });
    const second = record();
    const map = readSpecRecords([JSON.stringify(first), "{torn", JSON.stringify(second), ""].join("\n"));
    expect(map.size).toBe(1);
    expect(map.get(specKey("t1", input.prompt))?.verdict).toBe("ok");
  });
});

describe("checkCorpusSpecified", () => {
  const task = { id: "t1", prompt: input.prompt };

  it("passes when the current prompt has an ok verdict", () => {
    expect(checkCorpusSpecified([task], [record()])).toEqual([]);
  });

  it("reports a missing verdict, a stale verdict and an underspecified one", () => {
    expect(checkCorpusSpecified([task], [])[0]?.problem).toMatch(/no spec verdict/);
    // Verdict for an older prompt text does not cover the edited prompt.
    expect(checkCorpusSpecified([{ id: "t1", prompt: "edited" }], [record()])[0]?.problem).toMatch(/no spec verdict/);
    expect(checkCorpusSpecified([task], [record({ verdict: "underspecified", gaps: [gap] })])[0]?.problem).toMatch(/underspecified \(1 gaps\)/);
  });

  it("skips waived tasks only", () => {
    expect(checkCorpusSpecified([task, { id: "t2", prompt: "p" }], [], new Set(["t1"]))).toEqual([
      { id: "t2", problem: "no spec verdict for the current prompt and rubric" },
    ]);
  });
});
