/**
 * Tests for the pure label-sheet renderer. What matters: the headline is a
 * single readable sentence (the dense full claim is collapsed, not lost), each
 * finding offers exactly one binary TRUE/FALSE/SKIP choice, and a missing
 * snippet degrades to a judge-from-claim note rather than an empty code block.
 */

import { describe, it, expect } from "vitest";
import {
  renderCodeClaimQueue,
  renderDecisionSheet,
  renderLabelSheet,
  headlineOf,
  type LabelSheetItem,
} from "./label-sheet.js";

function item(over: Partial<LabelSheetItem>): LabelSheetItem {
  return {
    id: "efnd_abc123",
    session_group_id: "grp_abc",
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

  it("embeds a hidden machine-key comment carrying the round-trip coordinates", () => {
    const md = renderLabelSheet([
      item({ id: "efnd_abc123", session_group_id: "grp_abc", checkpoint_id: "phase-a", evidence_path: "web/server/x.ts" }),
    ]);
    // HTML comment → invisible in a rendered viewer, but parseable on ingest.
    expect(md).toContain(
      '<!-- eval-label {"finding_id":"efnd_abc123","session_group_id":"grp_abc","checkpoint_id":"phase-a","evidence_path":"web/server/x.ts"} -->',
    );
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

/**
 * P3/FIX-B3-1: the human only gets decisions, framed "now → A / B → what is
 * right"; code claims go to the orchestrator with the code at the checkpoint
 * AND now, so a claim can be checked against what the observer actually read.
 */
describe("triaged sheets", () => {
  it("frames a decision as now / option A / option B with an A/B/SKIP call", () => {
    const md = renderDecisionSheet([
      item({
        claim: "The bot stores the author's tg-id. It should store only the text.",
        triage: { kind: "decision", reason: "privacy / data policy" },
      }),
    ]);
    expect(md).toContain("- **Сейчас так:** The bot stores the author's tg-id.");
    expect(md).toContain("- **Вариант А:** Оставить как есть");
    expect(md).toContain("- **Вариант Б:** Изменить, как советует observer: It should store only the text.");
    expect(md).toContain("**Что верно:**  `[ ] A`  ·  `[ ] B`  ·  `[ ] SKIP`");
    expect(md).toContain("Почему к вам: privacy / data policy");
    // No code block and no TRUE/FALSE call for a decision.
    expect(md).not.toContain("**Your call:**");
    expect(md).not.toContain("```");
  });

  it("shows a code claim with the checkpoint-time code and the current code", () => {
    const md = renderCodeClaimQueue([
      item({
        triage: { kind: "code-claim", reason: "r" },
        snippet: "▶    2  const v = 1;",
        snippet_note: "as of commit abc12345",
        current_snippet: "▶    2  const v = 2;",
        current_note: "from the current file",
      }),
    ]);
    expect(md).toContain("**Code at the checkpoint** (as of commit abc12345):\n\n```\n▶    2  const v = 1;\n```");
    expect(md).toContain("**Code now** (from the current file):\n\n```\n▶    2  const v = 2;\n```");
    expect(md).toContain("**Your call:**");
    expect(md).toContain("--labeler orchestrator-");
  });

  it("says why a side is missing instead of printing an empty block", () => {
    const md = renderCodeClaimQueue([
      item({ triage: { kind: "code-claim", reason: "r" }, snippet: null, snippet_note: "uncommitted at review time", current_snippet: null, current_note: "deleted" }),
    ]);
    expect(md).toContain("**Code at the checkpoint** (uncommitted at review time):");
    expect(md).toContain("**Code now** (deleted):");
    expect(md).not.toContain("```");
  });

  it("uses a longer fence when the code itself contains backticks", () => {
    const md = renderCodeClaimQueue([
      item({ triage: { kind: "code-claim", reason: "r" }, snippet: "    1  const s = ```x```;", current_snippet: null }),
    ]);
    expect(md).toContain("````\n    1  const s = ```x```;\n````");
  });
});
