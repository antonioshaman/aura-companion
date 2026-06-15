/**
 * Boundary parser for a golden-task file. A task is hand-authored YAML, so it
 * sits at the trust boundary: every field is validated structurally on read and
 * the result is a three-state `{ok:true,value} | {ok:false,reason}` carrying a
 * field-level rejection reason, never a throw. The loader feeds parsed YAML in
 * and gets back either a fully-typed {@link GoldenTask} or a human-readable
 * reason naming the bad field — so an incomplete task is reported precisely
 * rather than blowing up the whole run.
 *
 * Version policy mirrors the other eval parsers: an unknown VERSION is a hard
 * reject; unknown EXTRA fields are tolerated (additive evolution).
 *
 * Firewall-clean: imports only the eval schema. Never `server/`.
 */

import {
  isSupportedGoldenTaskVersion,
  type GoldenTask,
  type GoldenTaskRubricCriterion,
} from "./golden-task.js";
import type { ParseResult } from "./parse-artifact.js";

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(reason: string): ParseResult<T> => ({ ok: false, reason });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Non-empty string array. An empty array fails — every list field on a task
 *  (expected_files/tests, failure_modes, rubric) must carry at least one entry
 *  or the task scores nothing. */
function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s !== "");
}

/** Full-length (40-hex) or abbreviated (>= 7-hex) git SHA. Existence is checked
 *  separately by the loader against the live repo. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

function parseRubricCriterion(v: unknown, i: number): ParseResult<GoldenTaskRubricCriterion> {
  if (!isObject(v)) return fail(`rubric[${i}] is not an object`);
  if (typeof v.id !== "string" || v.id === "") return fail(`rubric[${i}].id is missing`);
  if (typeof v.description !== "string" || v.description === "") {
    return fail(`rubric[${i}].description is missing`);
  }
  if (typeof v.weight !== "number" || !Number.isFinite(v.weight) || v.weight <= 0) {
    return fail(`rubric[${i}].weight must be a positive number`);
  }
  return ok({ id: v.id, description: v.description, weight: v.weight });
}

/**
 * Parse one already-deserialized task object (e.g. from `Bun.YAML.parse`) into a
 * typed {@link GoldenTask}. The caller is responsible for YAML deserialization
 * and for checking `start_commit` existence against the repo.
 */
export function parseGoldenTask(v: unknown): ParseResult<GoldenTask> {
  if (!isObject(v)) return fail("task is not an object");
  if (!isSupportedGoldenTaskVersion(v.golden_task_version)) {
    return fail(
      `unsupported golden_task_version: ${JSON.stringify(v.golden_task_version)} (expected 1)`,
    );
  }
  if (typeof v.id !== "string" || v.id === "") return fail("id is missing");
  if (typeof v.title !== "string" || v.title === "") return fail("title is missing");
  if (typeof v.start_commit !== "string" || !SHA_RE.test(v.start_commit)) {
    return fail("start_commit is not a valid git SHA (7-40 hex chars)");
  }
  if (typeof v.prompt !== "string" || v.prompt === "") return fail("prompt is missing");
  if (!isNonEmptyStringArray(v.expected_files)) {
    return fail("expected_files must be a non-empty string[]");
  }
  if (!isNonEmptyStringArray(v.expected_tests)) {
    return fail("expected_tests must be a non-empty string[]");
  }
  if (!isNonEmptyStringArray(v.failure_modes)) {
    return fail("failure_modes must be a non-empty string[]");
  }
  if (!Array.isArray(v.rubric) || v.rubric.length === 0) {
    return fail("rubric must be a non-empty array");
  }
  const rubric: GoldenTaskRubricCriterion[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < v.rubric.length; i++) {
    const r = parseRubricCriterion(v.rubric[i], i);
    if (!r.ok) return fail(r.reason);
    if (seenIds.has(r.value.id)) return fail(`rubric[${i}].id "${r.value.id}" is duplicated`);
    seenIds.add(r.value.id);
    rubric.push(r.value);
  }
  return ok({
    golden_task_version: 1,
    id: v.id,
    title: v.title,
    start_commit: v.start_commit,
    prompt: v.prompt,
    expected_files: v.expected_files,
    expected_tests: v.expected_tests,
    failure_modes: v.failure_modes,
    rubric,
  });
}
