// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  parseAutoProceedConfig,
  parseAutoProceedOnIdleAtBoundary,
  formatAutoProceedConfigError,
  IDLE_MS_MIN,
  IDLE_MS_MAX,
  MAX_ITERATIONS_MIN,
  MAX_ITERATIONS_MAX,
  type AutoProceedConfigParseError,
} from "./auto-proceed-config-validator.js";
import { AUTO_PROCEED_MAX_ITERATIONS_CEILING } from "./auto-proceed-types.js";

// ── parseAutoProceedConfig — strict inner parser ────────────────────

describe("parseAutoProceedConfig — shape gate", () => {
  // EC-5 enforcement: the strict-shape rule is the canary that
  // distinguishes a real strict parser from a permissive one. If this
  // ever passes for an extra key, the spec convention is broken.
  it("rejects objects with unknown keys (EC-5 strict-shape canary)", () => {
    const result = parseAutoProceedConfig({
      idleMs: 60_000,
      maxIterations: 5,
      foo: "bar",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unknown-keys");
      if (result.error.kind === "unknown-keys") {
        expect(result.error.keys).toEqual(["foo"]);
      }
    }
  });

  // Reject lists ALL unknown keys, not just the first — so the user
  // can correct multiple typos in one round-trip rather than discovering
  // them serially (UX quality).
  it("lists every unknown key on rejection, not just the first", () => {
    const result = parseAutoProceedConfig({
      idleMs: 60_000,
      maxIterations: 5,
      foo: "bar",
      baz: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "unknown-keys") {
      expect(result.error.keys.sort()).toEqual(["baz", "foo"]);
    }
  });

  // Non-object shapes are rejected at the top with `not-object`.
  // Important: arrays are objects in JS but should also be rejected —
  // a `[60_000, 5]` payload is a real bug class (positional vs keyed).
  it.each([
    null,
    undefined, // routes through the boundary parser, but the inner one rejects
    42,
    "hello",
    true,
    [60_000, 5],
  ])("rejects non-plain-object shape: %p", (raw) => {
    const result = parseAutoProceedConfig(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not-object");
  });
});

describe("parseAutoProceedConfig — idleMs", () => {
  // Each adversarial input gets its own discriminated reason so the
  // 400 message tells the user precisely what's wrong — not a generic
  // "invalid" that they have to bisect.
  it.each<[unknown, AutoProceedConfigParseError["kind"]]>([
    [NaN, "invalid-idleMs"],
    [Infinity, "invalid-idleMs"],
    [-Infinity, "invalid-idleMs"],
    [60_000.5, "invalid-idleMs"], // non-integer
    [0, "invalid-idleMs"], // not positive
    [-1_000, "invalid-idleMs"], // negative
    ["60000", "invalid-idleMs"], // wrong type — number expected
  ])("rejects idleMs=%p", (idleMs, kind) => {
    const result = parseAutoProceedConfig({ idleMs, maxIterations: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(kind);
  });

  it("clamps idleMs below IDLE_MS_MIN up to the minimum", () => {
    const result = parseAutoProceedConfig({ idleMs: 100, maxIterations: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.idleMs).toBe(IDLE_MS_MIN);
  });

  it("clamps idleMs above IDLE_MS_MAX down to the maximum", () => {
    const result = parseAutoProceedConfig({
      idleMs: 10_000_000,
      maxIterations: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.idleMs).toBe(IDLE_MS_MAX);
  });

  it("passes through idleMs within range unchanged", () => {
    const result = parseAutoProceedConfig({ idleMs: 60_000, maxIterations: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.idleMs).toBe(60_000);
  });

  it("rejects when idleMs is missing", () => {
    const result = parseAutoProceedConfig({ maxIterations: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("missing-field");
      if (result.error.kind === "missing-field") {
        expect(result.error.field).toBe("idleMs");
      }
    }
  });
});

describe("parseAutoProceedConfig — maxIterations", () => {
  it.each<[unknown, AutoProceedConfigParseError["kind"]]>([
    [NaN, "invalid-maxIterations"],
    [Infinity, "invalid-maxIterations"],
    [5.5, "invalid-maxIterations"], // non-integer
    [0, "invalid-maxIterations"], // below minimum
    [-1, "invalid-maxIterations"], // negative
    ["5", "invalid-maxIterations"], // wrong type
  ])("rejects maxIterations=%p", (maxIterations, kind) => {
    const result = parseAutoProceedConfig({ idleMs: 60_000, maxIterations });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(kind);
  });

  // Ceiling is REJECTED not clamped — the spec calls this out as an
  // "ask first" event. Silently shrinking maxIterations: 50 to 10 would
  // hide intent.
  it("rejects maxIterations above the protocol ceiling (no silent clamp)", () => {
    const result = parseAutoProceedConfig({
      idleMs: 60_000,
      maxIterations: AUTO_PROCEED_MAX_ITERATIONS_CEILING + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "invalid-maxIterations") {
      expect(result.error.reason).toBe("above-ceiling");
    }
  });

  it("accepts maxIterations at the protocol ceiling unchanged", () => {
    const result = parseAutoProceedConfig({
      idleMs: 60_000,
      maxIterations: MAX_ITERATIONS_MAX,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.maxIterations).toBe(MAX_ITERATIONS_MAX);
  });

  it("accepts maxIterations at the floor unchanged", () => {
    const result = parseAutoProceedConfig({
      idleMs: 60_000,
      maxIterations: MAX_ITERATIONS_MIN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.maxIterations).toBe(MAX_ITERATIONS_MIN);
  });

  it("rejects when maxIterations is missing", () => {
    const result = parseAutoProceedConfig({ idleMs: 60_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("missing-field");
      if (result.error.kind === "missing-field") {
        expect(result.error.field).toBe("maxIterations");
      }
    }
  });
});

describe("parseAutoProceedConfig — happy path", () => {
  it("accepts a valid minimal payload", () => {
    const result = parseAutoProceedConfig({
      idleMs: 300_000,
      maxIterations: 10,
    });
    expect(result).toEqual({
      ok: true,
      value: { idleMs: 300_000, maxIterations: 10 },
    });
  });
});

// ── parseAutoProceedOnIdleAtBoundary — HTTP-boundary collapse ────────

describe("parseAutoProceedOnIdleAtBoundary — tri-state-collapse", () => {
  // The regression invariant is "opt-out is bit-identical to never-opted-in".
  // Every absent-equivalent input must produce the SAME boundary result so
  // the session record's `autoProceedOnIdle` is never set.
  it.each<[unknown, string]>([
    [undefined, "undefined"],
    [null, "null"],
    [false, "false"],
  ])("collapses %s to {kind: 'absent'} (opt-out bit-identical)", (raw, _label) => {
    expect(parseAutoProceedOnIdleAtBoundary(raw)).toEqual({ kind: "absent" });
  });

  // `true` is NOT a valid absent-equivalent — it would be a user signaling
  // "enable with default settings" which isn't supported. Treat as invalid
  // shape so the user gets a clear error.
  it("rejects `true` as a shape error (not an absent-equivalent)", () => {
    const result = parseAutoProceedOnIdleAtBoundary(true);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.error.kind).toBe("not-object");
    }
  });

  it("returns valid on a well-formed object", () => {
    const result = parseAutoProceedOnIdleAtBoundary({
      idleMs: 300_000,
      maxIterations: 7,
    });
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.value).toEqual({ idleMs: 300_000, maxIterations: 7 });
    }
  });

  it("returns invalid + propagates the parser error on bad shape", () => {
    const result = parseAutoProceedOnIdleAtBoundary({
      idleMs: 60_000,
      maxIterations: 5,
      extra: "key",
    });
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.error.kind).toBe("unknown-keys");
    }
  });
});

// ── formatAutoProceedConfigError — stable error-message wrapper ──────

describe("formatAutoProceedConfigError", () => {
  // Each discriminant maps to a recognisable English substring so e2e
  // tests can assert on user-visible text without coupling to copy edits.
  it("formats every error variant with a stable substring", () => {
    const cases: Array<{ error: AutoProceedConfigParseError; contains: string }> = [
      { error: { kind: "not-object" }, contains: "must be an object" },
      { error: { kind: "unknown-keys", keys: ["foo"] }, contains: "unknown keys" },
      { error: { kind: "missing-field", field: "idleMs" }, contains: "required" },
      {
        error: { kind: "invalid-idleMs", reason: "not-finite" },
        contains: "idleMs invalid",
      },
      {
        error: { kind: "invalid-maxIterations", reason: "above-ceiling" },
        contains: "maxIterations invalid",
      },
    ];
    for (const c of cases) {
      expect(formatAutoProceedConfigError(c.error)).toContain(c.contains);
    }
  });
});
