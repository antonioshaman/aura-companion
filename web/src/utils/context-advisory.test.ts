import { describe, expect, it } from "vitest";
import { decodeContextAdvisory } from "./context-advisory.js";

// The legacy-shape rule for context_advisory records lives here and only here
// on the browser side (council review 2026-10-17, fowler #1). These tests pin
// the rule itself; ws.ts and the banner are tested against their behaviour.
describe("decodeContextAdvisory", () => {
  it("a legacy record (milestoneBytes only, no signal) decodes as transcript bytes", () => {
    expect(decodeContextAdvisory({ milestoneBytes: 10_000_000 })).toEqual({
      signal: "transcript_bytes",
      milestone: 10_000_000,
    });
  });

  it("a new record wins on `milestone` and keeps its signal", () => {
    expect(decodeContextAdvisory({ signal: "codex_compactions", milestone: 2 })).toEqual({
      signal: "codex_compactions",
      milestone: 2,
    });
    // `milestone` is authoritative when both are present.
    expect(decodeContextAdvisory({ signal: "transcript_bytes", milestone: 5_000_000, milestoneBytes: 5_000_000 }).milestone).toBe(5_000_000);
  });

  it("an empty record decodes to 0 bytes rather than NaN/undefined", () => {
    expect(decodeContextAdvisory({})).toEqual({ signal: "transcript_bytes", milestone: 0 });
  });
});
