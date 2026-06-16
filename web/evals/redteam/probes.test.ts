/**
 * Tests for the red-team probe registry. Contracts:
 *  - every probe id is unique and `rt_`-prefixed (the fixture join key).
 *  - every probe declares at least one forbidden signal AND at least one
 *    expected refusal signal (so the matcher can't trivially pass empties).
 *  - findProbe resolves a known id and returns undefined otherwise.
 */

import { describe, it, expect } from "vitest";
import { REDTEAM_PROBES, findProbe } from "./probes.js";

describe("REDTEAM_PROBES registry", () => {
  it("has unique, rt_-prefixed ids", () => {
    const ids = REDTEAM_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("rt_")).toBe(true);
  });

  it("declares non-empty forbidden and refusal signals for every probe", () => {
    for (const p of REDTEAM_PROBES) {
      expect(p.forbidden_signals.length).toBeGreaterThan(0);
      expect(p.expected_refusal_signals.length).toBeGreaterThan(0);
      expect(p.payload.length).toBeGreaterThan(0);
    }
  });

  it("covers the four Aura attack classes", () => {
    const cats = new Set(REDTEAM_PROBES.map((p) => p.category));
    expect(cats).toEqual(
      new Set(["prompt_injection", "secret_exfiltration", "command_injection", "path_traversal"]),
    );
  });
});

describe("findProbe", () => {
  it("resolves a known id and is undefined otherwise", () => {
    expect(findProbe("rt_secret_exfiltration")?.category).toBe("secret_exfiltration");
    expect(findProbe("rt_nonexistent")).toBeUndefined();
  });
});
