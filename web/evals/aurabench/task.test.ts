/**
 * Tests for the AuraBench task schema (P5/D1). The contract: an AuraBench task
 * is a golden task PLUS an `aurabench` block that carries provenance (PR,
 * merge commit), a class, the hidden tests, and the fail-on-base /
 * pass-on-merge proof. A task missing any of that — or whose proof says
 * anything other than fail/pass — must be rejected with a field-level reason,
 * because the ablation harness trusts every loaded task blindly.
 */

import { describe, it, expect } from "vitest";
import { parseGoldenTask } from "../schema/parse-golden-task.js";
import { parseAuraBenchTask } from "./task.js";

const BASE = "a".repeat(40);
const MERGE = "b".repeat(40);

function validTask(): Record<string, unknown> {
  return {
    golden_task_version: 1,
    id: "pr-194",
    title: "Validate resume target before discarding the CLI session id",
    start_commit: BASE,
    prompt: "Do the thing.",
    expected_files: ["web/server/cli-launcher.ts"],
    expected_tests: ["web/server/cli-launcher.test.ts"],
    failure_modes: ["hidden tests still fail"],
    rubric: [{ id: "hidden-tests-pass", description: "hidden tests pass", weight: 1 }],
    aurabench: {
      pr: 194,
      merge_commit: MERGE,
      class: "bugfix",
      hidden_tests: ["web/server/cli-launcher.test.ts"],
      validation: { base: "fail", merge: "pass", base_failure: "assertion", checked_at: "2026-09-28T10:00:00Z" },
    },
  };
}

function withMeta(patch: Record<string, unknown>): Record<string, unknown> {
  const t = validTask();
  return { ...t, aurabench: { ...(t.aurabench as object), ...patch } };
}

describe("parseAuraBenchTask", () => {
  it("accepts a complete task and keeps the aurabench block typed", () => {
    const r = parseAuraBenchTask(validTask());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.aurabench.class).toBe("bugfix");
      expect(r.value.aurabench.validation.base_failure).toBe("assertion");
    }
  });

  it("is an additive extension: the same object is still a valid golden task", () => {
    // Golden tooling (scorecard, loader) must keep reading AuraBench tasks.
    expect(parseGoldenTask(validTask()).ok).toBe(true);
  });

  it("propagates golden-task rejections", () => {
    const r = parseAuraBenchTask({ ...validTask(), prompt: "" });
    expect(r).toEqual({ ok: false, reason: "prompt is missing" });
  });

  it("requires full 40-hex SHAs (abbreviated SHAs are fine for golden tasks, not here)", () => {
    expect(parseAuraBenchTask({ ...validTask(), start_commit: "abcdef1" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/start_commit must be a full/),
    });
    expect(parseAuraBenchTask(withMeta({ merge_commit: "abcdef1" }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/merge_commit must be a full/),
    });
  });

  it("rejects merge_commit == start_commit (nothing to reproduce)", () => {
    expect(parseAuraBenchTask(withMeta({ merge_commit: BASE }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/must differ/),
    });
  });

  it("rejects a missing block, bad PR number and unknown class", () => {
    const { aurabench: _drop, ...noMeta } = validTask();
    expect(parseAuraBenchTask(noMeta)).toMatchObject({ ok: false, reason: "aurabench block is missing" });
    expect(parseAuraBenchTask(withMeta({ pr: 0 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/pr must/) });
    expect(parseAuraBenchTask(withMeta({ class: "perf" }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/class must be one of/),
    });
  });

  it("requires expected_tests to mirror hidden_tests (order-insensitive)", () => {
    const t = withMeta({ hidden_tests: ["web/b.test.ts", "web/a.test.ts"] });
    t.expected_tests = ["web/a.test.ts", "web/b.test.ts"];
    expect(parseAuraBenchTask(t).ok).toBe(true);
    t.expected_tests = ["web/a.test.ts"];
    expect(parseAuraBenchTask(t)).toMatchObject({ ok: false, reason: expect.stringMatching(/must equal/) });
    expect(parseAuraBenchTask(withMeta({ hidden_tests: [] }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/hidden_tests must be/),
    });
  });

  it("admits only the fail-on-base / pass-on-merge proof", () => {
    // Story D1: a task whose hidden tests do not fail before AND pass after is
    // excluded — so a validation block recording anything else is invalid.
    const v = { base: "fail", merge: "pass", base_failure: "assertion", checked_at: "2026-09-28T10:00:00Z" };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...v, base: "pass" }, /base must be "fail"/],
      [{ ...v, merge: "fail" }, /merge must be "pass"/],
      [{ ...v, base_failure: "timeout" }, /base_failure must be/],
      [{ ...v, checked_at: "yesterday" }, /checked_at must be/],
    ];
    for (const [validation, reason] of cases) {
      expect(parseAuraBenchTask(withMeta({ validation }))).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
    }
    expect(parseAuraBenchTask(withMeta({ validation: undefined }))).toMatchObject({
      ok: false,
      reason: "aurabench.validation is missing",
    });
  });
});
