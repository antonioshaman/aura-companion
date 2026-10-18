// Tests for the observer SOUL splice (handoff 2026-10-18 §4).
//
// What is validated:
//   - the SOUL body (header dropped) replaces exactly the text between the
//     markers, leaving the system prompt's header sentinel and every other
//     section byte-for-byte untouched (whole-output equality, so a splice
//     that also drops text outside the markers cannot pass);
//   - the splice is idempotent (running it on its own output changes nothing,
//     also with sloppy whitespace around the SOUL body), which is what lets
//     the drift gate assert "no drift";
//   - a missing/malformed/unsupported SOUL header, an empty body, a body that
//     contains a marker, a missing or duplicated marker pair, or reversed
//     markers fail loud instead of silently no-op'ing; CRLF SOULs are
//     normalised so the delivered prompt never carries carriage returns;
//   - the real repo artifacts are consistent: splicing the checked-in SOUL
//     into the checked-in system prompt is a no-op, the pinned loader phrases
//     (`## Failsafe`, `OBSERVER-BLOCKED:`) survive, and the spliced prompt is
//     inside the 5 KB product budget — asserted HERE, where a SOUL author
//     looks first, with a message naming the file to trim (council review
//     2026-10-18-1815, beck P2).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  OBSERVER_PROMPT_BUDGET_BYTES,
  OBSERVER_SOUL_SUPPORTED_VERSION,
  SOUL_BEGIN_MARKER,
  SOUL_END_MARKER,
  extractSoulBlock,
  parseObserverSoulHeader,
  spliceObserverSoul,
} from "./observer-soul-splice.js";

const HEAD = ["<!-- observer-system-prompt v1 -->", "", "# Observer", "", "intro", "", SOUL_BEGIN_MARKER].join("\n");
const TAIL = [SOUL_END_MARKER, "", "## Each cycle", "steps", ""].join("\n");
const SYSTEM = `${HEAD}\nold soul text\n${TAIL}`;

const SOUL = ["<!-- observer-soul v1 -->", "## Who you are", "", "- truth one", "- truth two", ""].join("\n");
const SOUL_BODY = "## Who you are\n\n- truth one\n- truth two";

describe("spliceObserverSoul", () => {
  it("replaces only the text between the markers — everything else is byte-identical", () => {
    const out = spliceObserverSoul(SYSTEM, SOUL);
    // Whole-output equality: header, intro and tail must come through untouched.
    expect(out).toBe(`${HEAD}\n${SOUL_BODY}\n${TAIL}`);
    expect(out).not.toContain("<!-- observer-soul v1 -->");
  });

  it("is idempotent — the drift gate can assert zero change", () => {
    const once = spliceObserverSoul(SYSTEM, SOUL);
    expect(spliceObserverSoul(once, SOUL)).toBe(once);
    // Sloppy whitespace around the SOUL body (blank lines after the header,
    // trailing blank lines) must not produce a different splice.
    const sloppy = "<!-- observer-soul v1 -->\n\n\n" + SOUL_BODY + "\n\n\n";
    expect(spliceObserverSoul(once, sloppy)).toBe(once);
  });

  it("normalises a CRLF SOUL so no carriage return reaches the prompt", () => {
    const crlf = SOUL.replace(/\n/g, "\r\n");
    const out = spliceObserverSoul(SYSTEM, crlf);
    expect(out).toBe(spliceObserverSoul(SYSTEM, SOUL));
    expect(out).not.toContain("\r");
  });

  it("fails loud on a bad, unsupported or missing SOUL header, or an empty body", () => {
    expect(() => spliceObserverSoul(SYSTEM, "## no header\n- x")).toThrow(/observer-soul vN/);
    expect(() => spliceObserverSoul(SYSTEM, "<!-- observer-soul v1 -->\n\n\n")).toThrow(/body is empty/);
    // The version is a contract: a v2 SOUL must not splice into a v1 prompt silently.
    expect(OBSERVER_SOUL_SUPPORTED_VERSION).toBe(1);
    expect(() => spliceObserverSoul(SYSTEM, "<!-- observer-soul v2 -->\n- x")).toThrow(/v2 is not supported/);
  });

  // Same malformed-header table as the system-prompt header in observer-prompt.test.ts.
  it.each([
    ["missing v", "<!-- observer-soul 1 -->"],
    ["non-numeric", "<!-- observer-soul vone -->"],
    ["zero", "<!-- observer-soul v0 -->"],
    ["negative", "<!-- observer-soul v-1 -->"],
    ["trailing junk", "<!-- observer-soul v1 --> extra"],
    ["header not on first line", "\n<!-- observer-soul v1 -->"],
  ])("parseObserverSoulHeader rejects %s", (_label, first) => {
    expect(parseObserverSoulHeader(first + "\nbody")).toBeNull();
  });

  it("parseObserverSoulHeader accepts a well-formed header (also with CRLF)", () => {
    expect(parseObserverSoulHeader("<!-- observer-soul v2 -->\n")).toBe(2);
    expect(parseObserverSoulHeader("<!-- observer-soul v1 -->\r\nbody")).toBe(1);
  });

  it("rejects a SOUL body that contains a marker — it would poison the next splice", () => {
    expect(() => spliceObserverSoul(SYSTEM, `<!-- observer-soul v1 -->\n- x\n${SOUL_END_MARKER}`)).toThrow(/must not contain a soul marker/);
    expect(() => spliceObserverSoul(SYSTEM, `<!-- observer-soul v1 -->\n${SOUL_BEGIN_MARKER}\n- x`)).toThrow(/must not contain a soul marker/);
  });

  it("fails loud on missing, duplicated or reversed markers", () => {
    expect(() => spliceObserverSoul("<!-- observer-system-prompt v1 -->\nno markers", SOUL)).toThrow(/exactly one soul marker pair/);
    expect(() => spliceObserverSoul(SYSTEM + "\n" + SOUL_BEGIN_MARKER + "\n" + SOUL_END_MARKER, SOUL)).toThrow(/found 2 begin/);
    const reversed = SYSTEM.replace(SOUL_BEGIN_MARKER, "@@B@@").replace(SOUL_END_MARKER, SOUL_BEGIN_MARKER).replace("@@B@@", SOUL_END_MARKER);
    expect(() => spliceObserverSoul(reversed, SOUL)).toThrow(/precedes/);
  });

  it("extractSoulBlock returns the trimmed text between the markers", () => {
    expect(extractSoulBlock(SYSTEM)).toBe("old soul text");
    expect(extractSoulBlock(spliceObserverSoul(SYSTEM, SOUL))).toBe(SOUL_BODY);
    expect(() => extractSoulBlock("no markers")).toThrow(/exactly one soul marker pair/);
  });
});

describe("checked-in artifacts", () => {
  const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..");
  const system = readFileSync(join(repoRoot, ".council", "prompts", "observer-system.md"), "utf8");
  const soul = readFileSync(join(repoRoot, ".council", "prompts", "OBSERVER-SOUL.md"), "utf8");

  it("observer-system.md already carries the current OBSERVER-SOUL.md (no drift)", () => {
    // If this fails: edit OBSERVER-SOUL.md, then `bun run build-observer-prompt-bundle`.
    expect(spliceObserverSoul(system, soul)).toBe(system);
  });

  it("the spliced prompt fits the 5 KB product budget (trim OBSERVER-SOUL.md if not)", () => {
    const bytes = Buffer.byteLength(spliceObserverSoul(system, soul), "utf8");
    expect(
      bytes,
      `spliced observer prompt is ${bytes} UTF-8 bytes, over the ${OBSERVER_PROMPT_BUDGET_BYTES}-byte budget — trim .council/prompts/OBSERVER-SOUL.md (or the sections outside the markers)`,
    ).toBeLessThanOrEqual(OBSERVER_PROMPT_BUDGET_BYTES);
  });

  it("the loader-pinned sections survive the restructuring", () => {
    expect(system).toContain("## Failsafe");
    expect(system).toContain("OBSERVER-BLOCKED:");
    expect(system.startsWith("<!-- observer-system-prompt v1 -->")).toBe(true);
    // The identity moved out of the rule lists: no duplicate "Posture" block remains.
    expect(system).not.toContain("## Posture");
    expect(system).not.toContain("## What NOT to do");
  });
});
