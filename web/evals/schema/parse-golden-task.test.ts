/**
 * Tests for the golden-task boundary parser. The contract: a well-formed task
 * round-trips into a typed value; any missing/invalid field is rejected with a
 * field-level reason (never a throw); an unknown version is a hard reject; and
 * unknown extra fields are tolerated (additive evolution).
 */

import { describe, it, expect } from "vitest";
import { parseGoldenTask } from "./parse-golden-task.js";

const valid = {
  golden_task_version: 1,
  id: "sample-task",
  title: "A sample golden task",
  start_commit: "82d855a051dbae7395a98d30c681d1597242e6ac",
  prompt: "Fix the thing.",
  expected_files: ["web/server/x.ts"],
  expected_tests: ["web/server/x.test.ts"],
  failure_modes: ["regresses Y"],
  rubric: [{ id: "c1", description: "does the thing", weight: 2 }],
};

describe("parseGoldenTask", () => {
  it("accepts a well-formed task and returns the typed value", () => {
    const r = parseGoldenTask(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe("sample-task");
      expect(r.value.rubric[0]!.weight).toBe(2);
      expect(r.value.golden_task_version).toBe(1);
    }
  });

  it("tolerates unknown extra fields (additive evolution)", () => {
    const r = parseGoldenTask({ ...valid, future_field: "ignored" });
    expect(r.ok).toBe(true);
  });

  it("hard-rejects an unknown version", () => {
    const r = parseGoldenTask({ ...valid, golden_task_version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unsupported golden_task_version/);
  });

  it("rejects a non-object input", () => {
    const r = parseGoldenTask("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not an object/);
  });

  it("rejects a malformed start_commit with a field-level reason", () => {
    const r = parseGoldenTask({ ...valid, start_commit: "zzz" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/start_commit/);
  });

  it("rejects an empty expected_files array", () => {
    const r = parseGoldenTask({ ...valid, expected_files: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expected_files/);
  });

  it("rejects a rubric criterion with a non-positive weight", () => {
    const r = parseGoldenTask({
      ...valid,
      rubric: [{ id: "c1", description: "x", weight: 0 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/weight must be a positive number/);
  });

  it("rejects duplicate rubric ids (would corrupt per-criterion scoring)", () => {
    const r = parseGoldenTask({
      ...valid,
      rubric: [
        { id: "dup", description: "a", weight: 1 },
        { id: "dup", description: "b", weight: 1 },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/duplicated/);
  });

  it("rejects a missing prompt", () => {
    const { prompt: _drop, ...noPrompt } = valid;
    const r = parseGoldenTask(noPrompt);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/prompt is missing/);
  });
});
