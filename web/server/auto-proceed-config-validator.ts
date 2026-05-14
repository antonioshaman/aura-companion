/**
 * Auto-proceed config validator — strict boundary parser for the
 * `autoProceedOnIdle` field on `POST /sessions/create` and `/sessions/create-stream`
 * request bodies (PLAN-tasks-10-11 Task 10).
 *
 * Pure module, no I/O. Lives in its own file rather than inline in
 * `routes.ts` because that god-module's file-level coverage gate
 * cascades any new untested branches past the 80% threshold
 * (`feedback_file_level_coverage_gate_cascade`).
 *
 * Per-field semantic validators are separate predicates with intent-naming
 * (`isPositiveIntegerMs`, `isIterationCount`, etc.) per
 * `feedback_validator_per_semantic_category` — one bounded-string-style
 * predicate reused across categories silently drops valid inputs. Each
 * value class gets its own check.
 *
 * Strict-shape (EC-5): unknown keys are rejected, not silently dropped.
 * `{idleMs, maxIterations, foo: "bar"}` produces `unknown-keys` failure.
 * The closed-key check IS EC-5's enforcement; the convention list in
 * CLAUDE.md is documentation, not the gate (`feedback_council_documented_contract_canary`).
 */

import { AUTO_PROCEED_MAX_ITERATIONS_CEILING } from "./auto-proceed-types.js";

/**
 * On-record shape after successful parse. Two `readonly` numbers, both
 * clamped into the protocol bounds — the session record never holds an
 * out-of-range value.
 */
export interface AutoProceedOnIdleConfig {
  readonly idleMs: number;
  readonly maxIterations: number;
}

/** Inclusive clamp window for `idleMs`. */
export const IDLE_MS_MIN = 5_000;
export const IDLE_MS_MAX = 3_600_000;

/** Inclusive clamp window for `maxIterations`. Top end is the same value
 *  as the protocol ceiling — values above the ceiling are REJECTED (not
 *  clamped), so the user gets a 400 telling them to ask first. */
export const MAX_ITERATIONS_MIN = 1;
export const MAX_ITERATIONS_MAX = AUTO_PROCEED_MAX_ITERATIONS_CEILING;

/**
 * Closed set of allowed keys on the `autoProceedOnIdle` object. Any
 * other key on the inbound JSON triggers `unknown-keys`. This IS the
 * EC-5 enforcement — strict parsers reject unknown shapes.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set(["idleMs", "maxIterations"]);

/** Discriminated failure reasons. Each maps to a structured 400 response. */
export type AutoProceedConfigParseError =
  | { kind: "not-object" }
  | { kind: "unknown-keys"; keys: string[] }
  | { kind: "missing-field"; field: "idleMs" | "maxIterations" }
  | { kind: "invalid-idleMs"; reason: "not-finite" | "not-integer" | "not-positive" }
  | {
    kind: "invalid-maxIterations";
    reason: "not-finite" | "not-integer" | "below-minimum" | "above-ceiling";
  };

/**
 * Parse result. Discriminated union so a forgetful caller cannot read
 * `value` without first narrowing on `ok` — documentation in a JSDoc
 * comment would be enforcement-free per
 * `feedback_council_documented_contract_canary`.
 */
export type AutoProceedConfigParseResult =
  | { ok: true; value: AutoProceedOnIdleConfig }
  | { ok: false; error: AutoProceedConfigParseError };

/**
 * Special tri-state-collapse sentinel: omit / `false` / `null` / `undefined`
 * on the inbound body all map to "no auto-proceed for this session." The
 * caller checks for this discriminant and DOES NOT set the session
 * record's `autoProceedOnIdle` field at all.
 *
 * Keeps the regression-invariant ("opt-out is bit-identical") grep-auditable —
 * a single call site decides what "absent" means.
 */
export type AutoProceedConfigBoundaryResult =
  | { kind: "absent" }
  | { kind: "valid"; value: AutoProceedOnIdleConfig }
  | { kind: "invalid"; error: AutoProceedConfigParseError };

/** Semantic-category predicate — accepts integers ≥ 1 in finite range. */
function isPositiveIntegerMs(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

/** Semantic-category predicate — accepts integers in [1, ceiling] only. */
function isInIterationCountRange(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v >= MAX_ITERATIONS_MIN &&
    v <= MAX_ITERATIONS_MAX
  );
}

/**
 * Clamp `idleMs` into `[IDLE_MS_MIN, IDLE_MS_MAX]`. The producer is
 * responsible for calling this AFTER `isPositiveIntegerMs` accepts the
 * raw input — clamping a non-integer would mask shape bugs.
 */
function clampIdleMs(ms: number): number {
  if (ms < IDLE_MS_MIN) return IDLE_MS_MIN;
  if (ms > IDLE_MS_MAX) return IDLE_MS_MAX;
  return ms;
}

/**
 * Strict parser for `autoProceedOnIdle`. Use {@link parseAutoProceedOnIdleAtBoundary}
 * from the HTTP route handler — it adds the tri-state-collapse for
 * `false | null | undefined | absent` per the spec. This inner parser
 * is exported separately so its branches are independently testable
 * (`feedback_validator_per_semantic_category` — each value class
 * exercised on adversarial inputs).
 */
export function parseAutoProceedConfig(raw: unknown): AutoProceedConfigParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: { kind: "not-object" } };
  }

  // Strict-shape (EC-5): reject unknown keys before reading anything else.
  // A loose validator that silently ignores `foo: "bar"` is the
  // documented-but-unenforced failure mode the convention exists to prevent.
  const keys = Object.keys(raw as Record<string, unknown>);
  const unknown = keys.filter((k) => !ALLOWED_KEYS.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: { kind: "unknown-keys", keys: unknown } };
  }

  const obj = raw as Record<string, unknown>;

  // idleMs — required, positive finite integer (clamp applied after acceptance).
  if (!("idleMs" in obj)) {
    return { ok: false, error: { kind: "missing-field", field: "idleMs" } };
  }
  const idleRaw = obj.idleMs;
  if (typeof idleRaw !== "number" || !Number.isFinite(idleRaw)) {
    return { ok: false, error: { kind: "invalid-idleMs", reason: "not-finite" } };
  }
  if (!Number.isInteger(idleRaw)) {
    return { ok: false, error: { kind: "invalid-idleMs", reason: "not-integer" } };
  }
  if (idleRaw <= 0) {
    return { ok: false, error: { kind: "invalid-idleMs", reason: "not-positive" } };
  }
  // Predicate covers the same checks in a positive form — proof of
  // narrowing for the type system. (Above branches surfaced specific
  // sub-reasons so the 400 message is informative.)
  if (!isPositiveIntegerMs(idleRaw)) {
    return { ok: false, error: { kind: "invalid-idleMs", reason: "not-finite" } };
  }

  // maxIterations — required, integer in [1, ceiling] (NO clamping on the
  // upper end; values above the ceiling are REJECTED so the user knows
  // their request was out-of-bound, not silently shrunken).
  if (!("maxIterations" in obj)) {
    return { ok: false, error: { kind: "missing-field", field: "maxIterations" } };
  }
  const maxRaw = obj.maxIterations;
  if (typeof maxRaw !== "number" || !Number.isFinite(maxRaw)) {
    return { ok: false, error: { kind: "invalid-maxIterations", reason: "not-finite" } };
  }
  if (!Number.isInteger(maxRaw)) {
    return { ok: false, error: { kind: "invalid-maxIterations", reason: "not-integer" } };
  }
  if (maxRaw < MAX_ITERATIONS_MIN) {
    return {
      ok: false,
      error: { kind: "invalid-maxIterations", reason: "below-minimum" },
    };
  }
  if (maxRaw > MAX_ITERATIONS_MAX) {
    return {
      ok: false,
      error: { kind: "invalid-maxIterations", reason: "above-ceiling" },
    };
  }
  if (!isInIterationCountRange(maxRaw)) {
    // Unreachable in practice — the above branches cover all rejections —
    // but the predicate call here forces type narrowing for the compiler.
    return {
      ok: false,
      error: { kind: "invalid-maxIterations", reason: "not-finite" },
    };
  }

  return {
    ok: true,
    value: {
      idleMs: clampIdleMs(idleRaw),
      maxIterations: maxRaw,
    },
  };
}

/**
 * HTTP-boundary parser. Wraps {@link parseAutoProceedConfig} with the
 * tri-state-collapse: `false | null | undefined | absent` all map to
 * `{kind: "absent"}` so the route handler does NOT set the session
 * record's `autoProceedOnIdle` at all. Any other shape goes through
 * the strict parser.
 *
 * The single call site keeps the regression-invariant ("opt-out is
 * bit-identical") grep-auditable — search for `parseAutoProceedOnIdleAtBoundary`
 * and you find the one place that decides "no auto-proceed."
 */
export function parseAutoProceedOnIdleAtBoundary(
  raw: unknown,
): AutoProceedConfigBoundaryResult {
  if (raw === undefined || raw === null || raw === false) {
    return { kind: "absent" };
  }
  const parsed = parseAutoProceedConfig(raw);
  if (!parsed.ok) {
    return { kind: "invalid", error: parsed.error };
  }
  return { kind: "valid", value: parsed.value };
}

/**
 * Format a parser error for the 400 response. Returns a stable English
 * message — i18n is the frontend's concern. Each kind maps to a
 * recognisable string so the e2e tests can assert on substrings without
 * coupling to copy edits in passing.
 */
export function formatAutoProceedConfigError(error: AutoProceedConfigParseError): string {
  switch (error.kind) {
    case "not-object":
      return "autoProceedOnIdle must be an object (or false/null to disable)";
    case "unknown-keys":
      return `autoProceedOnIdle has unknown keys: ${error.keys.join(", ")}`;
    case "missing-field":
      return `autoProceedOnIdle.${error.field} is required`;
    case "invalid-idleMs":
      return `autoProceedOnIdle.idleMs invalid (${error.reason})`;
    case "invalid-maxIterations":
      return `autoProceedOnIdle.maxIterations invalid (${error.reason})`;
  }
}
