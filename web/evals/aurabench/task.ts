/**
 * AuraBench task contract (P5/D1) — an ADDITIVE extension of the golden-task
 * schema (`../schema/golden-task.ts`). Every AuraBench task is a valid golden
 * task (the golden parser tolerates unknown extra keys), plus an `aurabench`
 * block that pins where the task came from and how it was validated:
 *
 *   - `pr` / `merge_commit`: the merged PR the task was mined from;
 *   - `class`: one of {@link AURABENCH_CLASSES} (per-class Aura Lift in D2/D3);
 *   - `hidden_tests`: test files the PR added/changed. They are withheld from
 *     the agent and restored after it finishes — `expected_tests` mirrors them
 *     so golden-task tooling scores the same selectors;
 *   - `validation`: proof that the hidden tests FAIL on `start_commit` (the
 *     merge commit's parent) and PASS on `merge_commit`. A task without that
 *     proof never enters the corpus.
 *
 * Both SHAs must be full-length: the corpus outlives abbreviated-SHA
 * uniqueness, and the ablation harness checks them out verbatim.
 *
 * Firewall-clean: imports only the eval schema. Never `server/`.
 */

import { parseGoldenTask } from "../schema/parse-golden-task.js";
import type { GoldenTask } from "../schema/golden-task.js";
import type { ParseResult } from "../schema/parse-artifact.js";

export const AURABENCH_CLASSES = [
  "bugfix",
  "feature",
  "refactor",
  "architecture",
  "security",
  "ui",
  "debug",
] as const;
export type AuraBenchClass = (typeof AURABENCH_CLASSES)[number];

/** How the hidden tests failed on the base commit. `missing-interface` = the
 *  tests import a file or symbol the PR created (the task prompt must name
 *  that interface, or no agent can pass); `assertion` = the tests load and a
 *  behavioural expectation fails. */
export type BaseFailureKind = "assertion" | "missing-interface";

export interface AuraBenchValidation {
  base: "fail";
  merge: "pass";
  base_failure: BaseFailureKind;
  /** ISO timestamp of the validation run. */
  checked_at: string;
}

export interface AuraBenchMeta {
  pr: number;
  merge_commit: string;
  class: AuraBenchClass;
  hidden_tests: string[];
  validation: AuraBenchValidation;
}

export interface AuraBenchTask extends GoldenTask {
  aurabench: AuraBenchMeta;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(reason: string): ParseResult<T> => ({ ok: false, reason });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isAuraBenchClass(v: unknown): v is AuraBenchClass {
  return typeof v === "string" && (AURABENCH_CLASSES as readonly string[]).includes(v);
}

function parseValidation(v: unknown): ParseResult<AuraBenchValidation> {
  if (!isObject(v)) return fail("aurabench.validation is missing");
  // A task is admitted ONLY with the fail-on-base / pass-on-merge proof.
  if (v.base !== "fail") return fail('aurabench.validation.base must be "fail"');
  if (v.merge !== "pass") return fail('aurabench.validation.merge must be "pass"');
  if (v.base_failure !== "assertion" && v.base_failure !== "missing-interface") {
    return fail('aurabench.validation.base_failure must be "assertion" or "missing-interface"');
  }
  if (typeof v.checked_at !== "string" || Number.isNaN(Date.parse(v.checked_at))) {
    return fail("aurabench.validation.checked_at must be an ISO timestamp");
  }
  return ok({ base: "fail", merge: "pass", base_failure: v.base_failure, checked_at: v.checked_at });
}

/** Parse an already-deserialized task object into a typed {@link AuraBenchTask}. */
export function parseAuraBenchTask(v: unknown): ParseResult<AuraBenchTask> {
  const golden = parseGoldenTask(v);
  if (!golden.ok) return golden;
  if (!FULL_SHA_RE.test(golden.value.start_commit)) {
    return fail("start_commit must be a full 40-hex SHA for AuraBench tasks");
  }
  const meta = (v as Record<string, unknown>).aurabench;
  if (!isObject(meta)) return fail("aurabench block is missing");
  if (typeof meta.pr !== "number" || !Number.isInteger(meta.pr) || meta.pr <= 0) {
    return fail("aurabench.pr must be a positive integer");
  }
  if (typeof meta.merge_commit !== "string" || !FULL_SHA_RE.test(meta.merge_commit)) {
    return fail("aurabench.merge_commit must be a full 40-hex SHA");
  }
  if (meta.merge_commit === golden.value.start_commit) {
    return fail("aurabench.merge_commit must differ from start_commit");
  }
  if (!isAuraBenchClass(meta.class)) {
    return fail(`aurabench.class must be one of ${AURABENCH_CLASSES.join("/")}`);
  }
  const hidden = meta.hidden_tests;
  if (!Array.isArray(hidden) || hidden.length === 0 || !hidden.every((s) => typeof s === "string" && s !== "")) {
    return fail("aurabench.hidden_tests must be a non-empty string[]");
  }
  const expected = [...golden.value.expected_tests].sort();
  if (JSON.stringify(expected) !== JSON.stringify([...hidden].sort())) {
    return fail("expected_tests must equal aurabench.hidden_tests");
  }
  const validation = parseValidation(meta.validation);
  if (!validation.ok) return validation;
  return ok({
    ...golden.value,
    aurabench: {
      pr: meta.pr,
      merge_commit: meta.merge_commit,
      class: meta.class,
      hidden_tests: hidden as string[],
      validation: validation.value,
    },
  });
}
