/**
 * Auto-proceed (orchestrator-idle) synthetic-frame envelope contract.
 *
 * Scope: when the orchestrator-half of a Council pair sits in
 * `awaiting-user-input` for N minutes, the server may emit a synthetic
 * `user` NDJSON frame so the orchestrator continues with best judgment
 * marked `(unconfirmed)`. This module is the single shared place where
 * the body shape is locked — both the producer (server) and the
 * downstream skill recognition canary in CI gate on the literal prefix
 * `AUTO_PROCEED_DIRECTIVE_PREFIX`. Unknown versions are refused.
 *
 * Body shape (one line, no embedded newlines — NDJSON splitter trap):
 *
 *   [auto-proceed:idle-timeout v1] {"directive":"proceed-with-best-judgment",
 *     "iteration":1,"max_iterations":10,"paused_at":"2026-05-14T16:00:00.000Z",
 *     "phase":"council-implement","group_id":"grp_4469a4c2"}
 *
 * Per-field validators are semantic-category-split: `phase` and `group_id`
 * are `isBoundedToken` (no whitespace, no controls); `paused_at` is
 * `isIsoTimestamp`; iteration counters are integer-bounded.
 *
 * Co-locates writer + reader in one module, mirroring AP-3 (the
 * `council-types.ts` pattern). Adding a v2 envelope = add a new prefix
 * constant + parser branch here; the producer and the canary discover
 * the change in the same diff.
 */

import { isBoundedToken, isIsoTimestamp } from "./council-types.js";

/**
 * Literal version prefix the producer emits and the skill canary in CI
 * asserts is present in every council-aura SKILL.md. Bumping the v1
 * suffix is a breaking change — old skills won't recognise it, new
 * skills won't recognise the old one. v1 is the only supported version
 * at this layer; readers MUST refuse anything else.
 */
export const AUTO_PROCEED_DIRECTIVE_PREFIX = "[auto-proceed:idle-timeout v1]";

/**
 * Hard cap from the Carmack-Council plan (Boundaries section). Raising
 * above 10 is an "ask first" event — the cap is structurally enforced
 * here so a forgetful caller can't bypass it. Also see
 * `COMPANION_ORCH_AUTO_PROCEED_MAX_ITERATIONS_CEILING` env-side
 * sibling (Task 9 of the plan).
 */
export const AUTO_PROCEED_MAX_ITERATIONS_CEILING = 10;

/**
 * Closed-enum set of directives the v1 envelope carries. New directives
 * MUST be added here AND in the skill's recognition clause in the same
 * commit — the canary fails until both move together.
 */
export type AutoProceedDirective = "proceed-with-best-judgment";

const AUTO_PROCEED_DIRECTIVES: ReadonlySet<AutoProceedDirective> = new Set([
  "proceed-with-best-judgment",
]);

/**
 * Closed-key envelope. Field order is significant for canonical
 * stringification (single-line body, deterministic across producers).
 * Add a v2 envelope alongside this rather than mutating v1's shape.
 */
export interface AutoProceedEnvelope {
  readonly directive: AutoProceedDirective;
  readonly iteration: number;
  readonly max_iterations: number;
  readonly paused_at: string;
  readonly phase: string;
  readonly group_id: string;
}

/** Reasons the parser may drop an inbound directive body. */
export type AutoProceedDropReason =
  | "missing-prefix"
  | "version-mismatch"
  | "invalid-json"
  | "not-object"
  | "embedded-newline"
  | "unknown-directive"
  | `invalid-field:${"iteration" | "max_iterations" | "paused_at" | "phase" | "group_id"}`;

/**
 * Integer-in-bounds — rejects NaN/Infinity/non-integer/out-of-range. The
 * iteration counter and cap are the most security-sensitive numeric
 * fields because they bound the runaway exposure: a corrupt
 * `max_iterations: Number.MAX_SAFE_INTEGER` would silently disable the
 * cap, so the validator hard-clamps to the ceiling.
 */
function isBoundedInteger(v: unknown, min: number, max: number): v is number {
  if (typeof v !== "number") return false;
  if (!Number.isFinite(v) || !Number.isInteger(v)) return false;
  return v >= min && v <= max;
}

/**
 * Build the on-wire body for a synthetic `user` NDJSON frame. Guarantees
 * the result is exactly one line (no embedded newline anywhere) so the
 * downstream NDJSON splitter cannot misread a single envelope as two
 * frames. Throws on invalid envelope contents — the caller is expected
 * to build the envelope via type-safe construction; runtime defence is
 * here only as a tripwire for bypass attempts.
 */
export function buildAutoProceedDirectiveBody(envelope: AutoProceedEnvelope): string {
  if (!AUTO_PROCEED_DIRECTIVES.has(envelope.directive)) {
    throw new TypeError(`auto-proceed: unknown directive ${JSON.stringify(envelope.directive)}`);
  }
  if (!isBoundedInteger(envelope.max_iterations, 1, AUTO_PROCEED_MAX_ITERATIONS_CEILING)) {
    throw new RangeError(
      `auto-proceed: max_iterations must be integer in [1, ${AUTO_PROCEED_MAX_ITERATIONS_CEILING}]`,
    );
  }
  if (!isBoundedInteger(envelope.iteration, 1, envelope.max_iterations)) {
    throw new RangeError(
      `auto-proceed: iteration must be integer in [1, max_iterations]`,
    );
  }
  if (!isIsoTimestamp(envelope.paused_at)) {
    throw new TypeError(`auto-proceed: paused_at must be ISO 8601`);
  }
  if (!isBoundedToken(envelope.phase, 64)) {
    throw new TypeError(`auto-proceed: phase must be bounded token`);
  }
  if (!isBoundedToken(envelope.group_id, 128)) {
    throw new TypeError(`auto-proceed: group_id must be bounded token`);
  }
  // Canonical key order — keeps the on-wire body bit-stable across
  // producers so replay-fixture tests (Task 15 of the plan) survive
  // refactors. JSON.stringify of an object literal preserves insertion
  // order; we build a fresh object to control it.
  const ordered = {
    directive: envelope.directive,
    iteration: envelope.iteration,
    max_iterations: envelope.max_iterations,
    paused_at: envelope.paused_at,
    phase: envelope.phase,
    group_id: envelope.group_id,
  };
  const body = `${AUTO_PROCEED_DIRECTIVE_PREFIX} ${JSON.stringify(ordered)}`;
  // Defensive: JSON encoding of a clean envelope never produces a
  // newline, but a future field type might. Refuse to emit a body that
  // would corrupt the NDJSON frame boundary.
  if (body.includes("\n") || body.includes("\r")) {
    throw new TypeError("auto-proceed: serialised body contains a newline");
  }
  return body;
}

/**
 * Strict, version-gated parser. Returns `null` on any failure with an
 * optional drop-reason callback so callers can land EC-9 log entries
 * categorised by failure mode (`feedback_format_transformation_validation`
 * — the wrapper is where format-aware checks happen).
 *
 * Refuses anything not starting with the exact `AUTO_PROCEED_DIRECTIVE_PREFIX`
 * (no whitespace tolerance — the producer always emits a single space
 * between prefix and JSON; readers must agree byte-for-byte).
 */
export function parseAutoProceedDirectiveBody(
  body: string,
  onDrop?: (reason: AutoProceedDropReason) => void,
): AutoProceedEnvelope | null {
  if (typeof body !== "string" || body.length === 0) {
    onDrop?.("missing-prefix");
    return null;
  }
  if (body.includes("\n") || body.includes("\r")) {
    onDrop?.("embedded-newline");
    return null;
  }
  const expectedHead = `${AUTO_PROCEED_DIRECTIVE_PREFIX} `;
  if (!body.startsWith(expectedHead)) {
    // Discriminate between "wrong version" and "completely unrelated
    // body" so consumers can route v0 / v2 differently in the future.
    if (body.startsWith("[auto-proceed:")) {
      onDrop?.("version-mismatch");
    } else {
      onDrop?.("missing-prefix");
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(expectedHead.length));
  } catch {
    onDrop?.("invalid-json");
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    onDrop?.("not-object");
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.directive !== "string" || !AUTO_PROCEED_DIRECTIVES.has(obj.directive as AutoProceedDirective)) {
    onDrop?.("unknown-directive");
    return null;
  }
  if (!isBoundedInteger(obj.max_iterations, 1, AUTO_PROCEED_MAX_ITERATIONS_CEILING)) {
    onDrop?.("invalid-field:max_iterations");
    return null;
  }
  if (!isBoundedInteger(obj.iteration, 1, obj.max_iterations as number)) {
    onDrop?.("invalid-field:iteration");
    return null;
  }
  if (!isIsoTimestamp(obj.paused_at)) {
    onDrop?.("invalid-field:paused_at");
    return null;
  }
  if (!isBoundedToken(obj.phase, 64)) {
    onDrop?.("invalid-field:phase");
    return null;
  }
  if (!isBoundedToken(obj.group_id, 128)) {
    onDrop?.("invalid-field:group_id");
    return null;
  }

  return {
    directive: obj.directive as AutoProceedDirective,
    iteration: obj.iteration as number,
    max_iterations: obj.max_iterations as number,
    paused_at: obj.paused_at as string,
    phase: obj.phase as string,
    group_id: obj.group_id as string,
  };
}
