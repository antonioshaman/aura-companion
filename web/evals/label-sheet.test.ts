/**
 * Tests for the pure label-sheet renderer. What matters: the headline is a
 * single readable sentence (the dense full claim is collapsed, not lost), each
 * finding offers exactly one binary TRUE/FALSE/SKIP choice, and a missing
 * snippet degrades to a judge-from-claim note rather than an empty code block.
 */

import { describe, it, expect } from "vitest";
import { renderLabelSheet, headlineOf, type LabelSheetItem } from "./label-sheet.js";

function item(over: Partial<LabelSheetItem>): LabelSheetItem {
  return {
    id: "efnd_abc123",
    index: 1,
    severity: "STOP",
    workspace: "aura-companion",
    evidence_path: "web/server/x.ts",
    checkpoint_id: "phase-a",
    observer_provider: "claude",
    claim: "Race in the bridge. A long second sentence with detail that should be collapsed.",
    snippet: "▶   10  const x = 1;",
    snippet_note: "lines 10–10",
    ...over,
  };
}

describe("headlineOf", () => {
  it("takes the first sentence and drops the dense remainder", () => {
    expect(headlineOf("Race in the bridge. Lots more detail here.")).toBe("Race in the bridge.");
  });
  it("falls back to the first line when there is no sentence terminator", () => {
    expect(headlineOf("single line no period\nsecond line")).toBe("single line no period");
  });
  it("hard-caps a runaway headline", () => {
    const long = "x".repeat(500);
    expect(headlineOf(long).length).toBeLessThanOrEqual(200);
    expect(headlineOf(long).endsWith("…")).toBe(true);
  });
});

describe("renderLabelSheet", () => {
  it("renders the headline, collapses the full claim, and offers one binary choice", () => {
    const md = renderLabelSheet([item({})]);
    expect(md).toContain("**Headline:** Race in the bridge.");
    expect(md).toContain("<details><summary>full claim</summary>");
    expect(md).toContain("`[ ] TRUE`");
    expect(md).toContain("`[ ] FALSE`");
    expect(md).toContain("`[ ] SKIP`");
    expect(md).toContain("```\n▶   10  const x = 1;\n```");
  });

  it("degrades to a judge-from-claim note when the snippet is absent", () => {
    const md = renderLabelSheet([item({ snippet: null, snippet_note: "not found" })]);
    expect(md).toContain("source not available");
    expect(md).not.toContain("```\nnull");
  });

  it("tallies findings by severity in the header", () => {
    const md = renderLabelSheet([
      item({ severity: "STOP", index: 1 }),
      item({ severity: "WARN", index: 2 }),
      item({ severity: "WARN", index: 3 }),
    ]);
    expect(md).toContain("STOP=1 WARN=2");
  });
});
