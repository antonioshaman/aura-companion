// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  AUTO_PROCEED_DIRECTIVE_PREFIX,
  AUTO_PROCEED_MAX_ITERATIONS_CEILING,
  buildAutoProceedDirectiveBody,
  parseAutoProceedDirectiveBody,
  type AutoProceedDropReason,
  type AutoProceedEnvelope,
} from "./auto-proceed-types.js";

// Reference envelope: every field at a known-valid value. Each negative
// test mutates ONE field so a failure points to the exact validator
// that fired — keeps test diagnostics specific per
// `feedback_validator_per_semantic_category`.
const VALID_ENVELOPE: AutoProceedEnvelope = {
  directive: "proceed-with-best-judgment",
  iteration: 1,
  max_iterations: 10,
  paused_at: "2026-05-14T16:00:00.000Z",
  phase: "council-implement",
  group_id: "grp_4469a4c2",
};

describe("AUTO_PROCEED_DIRECTIVE_PREFIX", () => {
  // Static-grep canary: the prefix is the wire-protocol token that the
  // skill recognition canary (Task 2 of the plan) asserts is present in
  // the council-aura SKILL.md files. Bumping `v1` is a coordinated
  // breaking change; this test pins the literal so a typo or rename
  // shows up immediately in this file's diff before the skill canary
  // discovers it.
  it("is the exact literal v1 prefix downstream skills look for", () => {
    expect(AUTO_PROCEED_DIRECTIVE_PREFIX).toBe("[auto-proceed:idle-timeout v1]");
  });

  it("contains no whitespace at its tail (single space joins prefix + JSON)", () => {
    // Producer convention: prefix + " " + JSON. The parser strips the
    // exact `prefix + " "` head; a trailing space on the constant would
    // collapse two spaces into one and corrupt the round-trip.
    expect(AUTO_PROCEED_DIRECTIVE_PREFIX.endsWith("]")).toBe(true);
  });
});

describe("AUTO_PROCEED_MAX_ITERATIONS_CEILING", () => {
  it("is the hard cap of 10 per the Carmack-Council plan", () => {
    // The cap is also enforced server-side in the Hono boundary
    // validator (Task 10 of the plan). Bumping above 10 is an "ask
    // first" event documented in External Setup Required.
    expect(AUTO_PROCEED_MAX_ITERATIONS_CEILING).toBe(10);
  });
});

describe("buildAutoProceedDirectiveBody — happy path", () => {
  it("produces a one-line body starting with the v1 prefix", () => {
    const body = buildAutoProceedDirectiveBody(VALID_ENVELOPE);
    expect(body.startsWith(`${AUTO_PROCEED_DIRECTIVE_PREFIX} `)).toBe(true);
    expect(body.includes("\n")).toBe(false);
    expect(body.includes("\r")).toBe(false);
  });

  it("emits JSON in canonical key order so replay fixtures stay bit-stable", () => {
    // Future replay-regression tests (Task 15) commit a canonical
    // fixture and assert the producer output matches byte-for-byte.
    // The fixed insertion order in the builder protects that against
    // accidental reshuffling during refactors.
    const body = buildAutoProceedDirectiveBody(VALID_ENVELOPE);
    const json = body.slice(AUTO_PROCEED_DIRECTIVE_PREFIX.length + 1);
    expect(json).toBe(
      `{"directive":"proceed-with-best-judgment","iteration":1,"max_iterations":10,"paused_at":"2026-05-14T16:00:00.000Z","phase":"council-implement","group_id":"grp_4469a4c2"}`,
    );
  });

  it("round-trips: parse(build(envelope)) === envelope", () => {
    const body = buildAutoProceedDirectiveBody(VALID_ENVELOPE);
    expect(parseAutoProceedDirectiveBody(body)).toEqual(VALID_ENVELOPE);
  });
});

describe("buildAutoProceedDirectiveBody — input validation tripwires", () => {
  it("throws on unknown directive (closed-enum guard)", () => {
    expect(() =>
      buildAutoProceedDirectiveBody({
        ...VALID_ENVELOPE,
        directive: "not-a-real-directive" as unknown as AutoProceedEnvelope["directive"],
      }),
    ).toThrow(/unknown directive/);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["zero", 0],
    ["above ceiling", AUTO_PROCEED_MAX_ITERATIONS_CEILING + 1],
    ["non-integer", 3.5],
  ])("throws on max_iterations = %s", (_label, value) => {
    expect(() =>
      buildAutoProceedDirectiveBody({ ...VALID_ENVELOPE, max_iterations: value as number }),
    ).toThrow(/max_iterations/);
  });

  it("throws when iteration exceeds max_iterations", () => {
    // The cap is enforced at BOTH endpoints — the cap value itself
    // must be ≤ ceiling, AND the current iteration must not exceed
    // the cap. Defence-in-depth so a corrupt envelope can't smuggle
    // an unbounded iteration past one validator alone.
    expect(() =>
      buildAutoProceedDirectiveBody({ ...VALID_ENVELOPE, iteration: 11, max_iterations: 10 }),
    ).toThrow(/iteration/);
  });

  it("throws on non-ISO paused_at", () => {
    expect(() =>
      buildAutoProceedDirectiveBody({ ...VALID_ENVELOPE, paused_at: "2026-05-14 16:00:00" }),
    ).toThrow(/paused_at/);
  });

  it("throws on phase with whitespace (not a bounded token)", () => {
    expect(() =>
      buildAutoProceedDirectiveBody({ ...VALID_ENVELOPE, phase: "council implement" }),
    ).toThrow(/phase/);
  });

  it("throws on empty group_id", () => {
    expect(() =>
      buildAutoProceedDirectiveBody({ ...VALID_ENVELOPE, group_id: "" }),
    ).toThrow(/group_id/);
  });
});

describe("parseAutoProceedDirectiveBody — happy path", () => {
  it("parses the exact body the builder emits", () => {
    const body = buildAutoProceedDirectiveBody(VALID_ENVELOPE);
    const parsed = parseAutoProceedDirectiveBody(body);
    expect(parsed).toEqual(VALID_ENVELOPE);
  });
});

describe("parseAutoProceedDirectiveBody — drop reasons", () => {
  function captureDrop(body: string): AutoProceedDropReason | null {
    let captured: AutoProceedDropReason | null = null;
    parseAutoProceedDirectiveBody(body, (r) => {
      captured = r;
    });
    return captured;
  }

  it("drops empty input as missing-prefix", () => {
    expect(parseAutoProceedDirectiveBody("")).toBeNull();
    expect(captureDrop("")).toBe("missing-prefix");
  });

  it("drops embedded-newline before any prefix check", () => {
    // Newlines are an NDJSON-splitter trap; they must short-circuit so
    // a malicious body can't bypass the parser by including a fake
    // second frame after a newline.
    const malicious = `${AUTO_PROCEED_DIRECTIVE_PREFIX} {"directive":"proceed-with-best-judgment"}\n{"evil":true}`;
    expect(parseAutoProceedDirectiveBody(malicious)).toBeNull();
    expect(captureDrop(malicious)).toBe("embedded-newline");
  });

  it("drops bodies without the v1 prefix as missing-prefix", () => {
    expect(captureDrop("hello world")).toBe("missing-prefix");
  });

  it("drops bodies with a sibling [auto-proceed:...] prefix as version-mismatch", () => {
    // Forward-compat tripwire: a v2 producer hitting a v1-only reader
    // should land as version-mismatch, not silently ignored.
    const v2 = `[auto-proceed:idle-timeout v2] {"some":"future"}`;
    expect(captureDrop(v2)).toBe("version-mismatch");
  });

  it("drops invalid JSON after the prefix", () => {
    expect(captureDrop(`${AUTO_PROCEED_DIRECTIVE_PREFIX} {not-json`)).toBe("invalid-json");
  });

  it("drops JSON arrays / primitives at the top level (not-object)", () => {
    expect(captureDrop(`${AUTO_PROCEED_DIRECTIVE_PREFIX} [1,2,3]`)).toBe("not-object");
    expect(captureDrop(`${AUTO_PROCEED_DIRECTIVE_PREFIX} null`)).toBe("not-object");
    expect(captureDrop(`${AUTO_PROCEED_DIRECTIVE_PREFIX} 42`)).toBe("not-object");
  });

  it("drops unknown directive values (closed-enum guard)", () => {
    const envelope = {
      directive: "shutdown-everything",
      iteration: 1,
      max_iterations: 10,
      paused_at: VALID_ENVELOPE.paused_at,
      phase: VALID_ENVELOPE.phase,
      group_id: VALID_ENVELOPE.group_id,
    };
    const body = `${AUTO_PROCEED_DIRECTIVE_PREFIX} ${JSON.stringify(envelope)}`;
    expect(captureDrop(body)).toBe("unknown-directive");
  });

  it.each<[string, AutoProceedDropReason, Partial<AutoProceedEnvelope>]>([
    [
      "max_iterations above ceiling",
      "invalid-field:max_iterations",
      { max_iterations: AUTO_PROCEED_MAX_ITERATIONS_CEILING + 1 },
    ],
    ["iteration above max_iterations", "invalid-field:iteration", { iteration: 11, max_iterations: 10 }],
    ["paused_at not ISO", "invalid-field:paused_at", { paused_at: "not-a-timestamp" }],
    ["phase with whitespace", "invalid-field:phase", { phase: "council implement" }],
    ["group_id empty", "invalid-field:group_id", { group_id: "" }],
  ])("drops %s as %s", (_label, expectedReason, override) => {
    const envelope = { ...VALID_ENVELOPE, ...override };
    const body = `${AUTO_PROCEED_DIRECTIVE_PREFIX} ${JSON.stringify(envelope)}`;
    expect(captureDrop(body)).toBe(expectedReason);
  });
});
