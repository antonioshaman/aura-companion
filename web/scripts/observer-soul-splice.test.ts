// Tests for the observer SOUL splice (handoff 2026-10-18 §4).
//
// What is validated:
//   - the SOUL body (header dropped) replaces exactly the text between the
//     markers, leaving the system prompt's header sentinel and every other
//     section untouched;
//   - the splice is idempotent (running it on its own output changes nothing),
//     which is what lets the CI canary assert "no drift";
//   - a missing/malformed SOUL header, an empty body, a missing or duplicated
//     marker pair, or reversed markers fail loud instead of silently no-op'ing;
//   - the real repo artifacts are consistent: splicing the checked-in SOUL
//     into the checked-in system prompt is a no-op, and the pinned loader
//     phrases (`## Failsafe`, `OBSERVER-BLOCKED:`) survive.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SOUL_BEGIN_MARKER,
  SOUL_END_MARKER,
  parseObserverSoulHeader,
  spliceObserverSoul,
} from "./observer-soul-splice.js";

const SYSTEM = [
  "<!-- observer-system-prompt v1 -->",
  "",
  "# Observer",
  "",
  "intro",
  "",
  SOUL_BEGIN_MARKER,
  "old soul text",
  SOUL_END_MARKER,
  "",
  "## Each cycle",
  "steps",
  "",
].join("\n");

const SOUL = ["<!-- observer-soul v1 -->", "## Who you are", "", "- truth one", "- truth two", ""].join("\n");

describe("spliceObserverSoul", () => {
  it("replaces only the text between the markers and keeps the system header", () => {
    const out = spliceObserverSoul(SYSTEM, SOUL);
    expect(out.startsWith("<!-- observer-system-prompt v1 -->\n")).toBe(true);
    expect(out).not.toContain("old soul text");
    expect(out).not.toContain("<!-- observer-soul v1 -->");
    expect(out).toContain(`${SOUL_BEGIN_MARKER}\n## Who you are\n\n- truth one\n- truth two\n${SOUL_END_MARKER}`);
    expect(out).toContain("## Each cycle\nsteps");
  });

  it("is idempotent — the canary can assert zero drift", () => {
    const once = spliceObserverSoul(SYSTEM, SOUL);
    expect(spliceObserverSoul(once, SOUL)).toBe(once);
  });

  it("fails loud on a bad SOUL header or an empty body", () => {
    expect(() => spliceObserverSoul(SYSTEM, "## no header\n- x")).toThrow(/observer-soul vN/);
    expect(() => spliceObserverSoul(SYSTEM, "<!-- observer-soul v1 -->\n\n\n")).toThrow(/body is empty/);
    expect(parseObserverSoulHeader("<!-- observer-soul v0 -->")).toBeNull();
    expect(parseObserverSoulHeader("<!-- observer-soul v2 -->\n")).toBe(2);
  });

  it("fails loud on missing, duplicated or reversed markers", () => {
    expect(() => spliceObserverSoul("<!-- observer-system-prompt v1 -->\nno markers", SOUL)).toThrow(/exactly one soul marker pair/);
    expect(() => spliceObserverSoul(SYSTEM + "\n" + SOUL_BEGIN_MARKER + "\n" + SOUL_END_MARKER, SOUL)).toThrow(/found 2 begin/);
    const reversed = SYSTEM.replace(SOUL_BEGIN_MARKER, "@@B@@").replace(SOUL_END_MARKER, SOUL_BEGIN_MARKER).replace("@@B@@", SOUL_END_MARKER);
    expect(() => spliceObserverSoul(reversed, SOUL)).toThrow(/precedes/);
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

  it("the loader-pinned sections survive the restructuring", () => {
    expect(system).toContain("## Failsafe");
    expect(system).toContain("OBSERVER-BLOCKED:");
    expect(system.startsWith("<!-- observer-system-prompt v1 -->")).toBe(true);
    // The identity moved out of the rule lists: no duplicate "Posture" block remains.
    expect(system).not.toContain("## Posture");
    expect(system).not.toContain("## What NOT to do");
  });
});
