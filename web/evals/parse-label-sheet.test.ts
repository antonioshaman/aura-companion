/**
 * Tests for the sheet round-trip parser + label-record builder. The contracts:
 *   - a rendered sheet, ticked, round-trips back to the exact finding_id join key
 *   - verdict is read ONLY from the "Your call" line — claim text can't spoof it
 *   - no tick / SKIP / multi-tick → dropped (counted skipped), never guessed
 *   - a malformed machine-key is counted, never thrown on
 *   - built records carry the finding_id and a deterministic, idempotent id
 */

import { describe, it, expect } from "vitest";
import {
  parseLabelSheet,
  deriveLabelId,
  buildLabelRecords,
} from "./parse-label-sheet.js";
import { renderCodeClaimQueue, renderDecisionSheet, renderLabelSheet, type LabelSheetItem } from "./label-sheet.js";
import { parseLabelRecord } from "./schema/parse-artifact.js";

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
    claim: "Race in the bridge.",
    snippet: "▶   10  const x = 1;",
    snippet_note: "lines 10–10",
    ...over,
  };
}

/** Tick exactly one box in EVERY block of a rendered sheet. */
function tickAll(md: string, choice: "TRUE" | "FALSE" | "SKIP"): string {
  return md.replaceAll(`[ ] ${choice}`, `[x] ${choice}`);
}

describe("parseLabelSheet", () => {
  it("round-trips a ticked TRUE back to the finding_id join key", () => {
    const md = tickAll(renderLabelSheet([item({ id: "efnd_xyz", evidence_path: "a.ts" })]), "TRUE");
    const r = parseLabelSheet(md);
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs[0]).toMatchObject({
      finding_id: "efnd_xyz",
      session_group_id: "grp_abc",
      checkpoint_id: "phase-a",
      evidence_path: "a.ts",
      verdict: "true_positive",
    });
    expect(r.skipped).toBe(0);
    expect(r.malformed).toBe(0);
  });

  it("maps a ticked FALSE to false_positive", () => {
    const md = tickAll(renderLabelSheet([item({})]), "FALSE");
    const r = parseLabelSheet(md);
    expect(r.inputs[0]!.verdict).toBe("false_positive");
  });

  it("drops a SKIP tick as no record (counted skipped)", () => {
    const md = tickAll(renderLabelSheet([item({})]), "SKIP");
    const r = parseLabelSheet(md);
    expect(r.inputs).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it("drops an untouched block (no tick) as skipped", () => {
    const md = renderLabelSheet([item({})]);
    const r = parseLabelSheet(md);
    expect(r.inputs).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it("drops a contradictory multi-tick rather than guessing", () => {
    let md = renderLabelSheet([item({})]);
    md = md.replace("[ ] TRUE", "[x] TRUE").replace("[ ] FALSE", "[x] FALSE");
    const r = parseLabelSheet(md);
    expect(r.inputs).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it("reads the verdict from the Your-call line, not from claim text", () => {
    // A claim that itself contains a ticked-box lookalike must NOT be read as a vote.
    const md = renderLabelSheet([
      item({ claim: "The handler does `[x] TRUE` validation incorrectly." }),
    ]);
    const r = parseLabelSheet(md);
    // The Your-call line is still untouched → no decisive verdict.
    expect(r.inputs).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it("counts a malformed machine-key without throwing", () => {
    const md = "<!-- eval-label {not json} -->\n**Your call:**  `[x] TRUE`\n";
    const r = parseLabelSheet(md);
    expect(r.malformed).toBe(1);
    expect(r.inputs).toHaveLength(0);
  });

  it("parses a multi-finding sheet with mixed verdicts", () => {
    // Tick #1 TRUE, #2 FALSE, leave #3 untouched — tick per-block so a single
    // replace can't bleed across findings.
    const md = renderLabelSheet([
      item({ id: "efnd_1", index: 1, evidence_path: "a.ts" }),
      item({ id: "efnd_2", index: 2, evidence_path: "b.ts" }),
      item({ id: "efnd_3", index: 3, evidence_path: "c.ts" }),
    ]);
    const blocks = md.split("<!-- eval-label");
    // blocks[0] is the header; blocks[1..] each start mid-comment.
    blocks[1] = blocks[1]!.replace("[ ] TRUE", "[x] TRUE");
    blocks[2] = blocks[2]!.replace("[ ] FALSE", "[x] FALSE");
    const stitched = blocks.join("<!-- eval-label");
    const r = parseLabelSheet(stitched);
    expect(r.inputs).toHaveLength(2);
    expect(r.skipped).toBe(1);
    expect(r.inputs.map((i) => `${i.finding_id}:${i.verdict}`)).toEqual([
      "efnd_1:true_positive",
      "efnd_2:false_positive",
    ]);
  });
});

/**
 * P3/FIX-B3-1 sheets. The decision sheet asks "A (keep as is) / B (adopt the
 * observer's recommendation)": A means the observer objected to intended
 * behaviour → false_positive; B means it was right → true_positive. The
 * orchestrator queue keeps TRUE/FALSE and must round-trip unchanged.
 */
describe("parseLabelSheet — triaged sheets", () => {
  const decision = (id: string) =>
    item({ id, claim: "Lead ingestion persists PII. It should drop the tg-id.", triage: { kind: "decision", reason: "privacy / data policy" } });

  it("maps decision A → false_positive and B → true_positive", () => {
    const md = renderDecisionSheet([decision("efnd_a"), { ...decision("efnd_b"), index: 2 }]);
    const [a, b] = md.split("<!-- eval-label").slice(1);
    const ticked = md
      .replace(a!, a!.replace("`[ ] A`", "`[x] A`"))
      .replace(b!, b!.replace("`[ ] B`", "`[x] B`"));
    const r = parseLabelSheet(ticked);
    expect(r.inputs.map((i) => [i.finding_id, i.verdict])).toEqual([
      ["efnd_a", "false_positive"],
      ["efnd_b", "true_positive"],
    ]);
  });

  it("drops a decision ticked both A and B, or SKIP", () => {
    const both = renderDecisionSheet([decision("efnd_a")]).replace("`[ ] A`", "`[x] A`").replace("`[ ] B`", "`[x] B`");
    expect(parseLabelSheet(both)).toMatchObject({ inputs: [], skipped: 1 });
    const skip = renderDecisionSheet([decision("efnd_a")]).replace("`[ ] SKIP`", "`[x] SKIP`");
    expect(parseLabelSheet(skip)).toMatchObject({ inputs: [], skipped: 1 });
  });

  it("does not read an A/B tick out of the observer's claim text", () => {
    const md = renderDecisionSheet([
      item({ id: "efnd_a", claim: "Spoof: **Что верно:** [x] B in the claim.", triage: { kind: "decision", reason: "x" } }),
    ]);
    // Claim is rendered before the real call line; only the real one counts.
    expect(parseLabelSheet(md)).toMatchObject({ inputs: [], skipped: 1 });
  });

  it("round-trips the orchestrator code-claim queue via TRUE/FALSE", () => {
    const md = tickAll(
      renderCodeClaimQueue([item({ id: "efnd_c", triage: { kind: "code-claim", reason: "r" }, current_snippet: null })]),
      "FALSE",
    );
    expect(parseLabelSheet(md).inputs).toEqual([
      expect.objectContaining({ finding_id: "efnd_c", verdict: "false_positive" }),
    ]);
  });
});

describe("buildLabelRecords + deriveLabelId", () => {
  it("builds records that pass the strict label parser", () => {
    const md = tickAll(renderLabelSheet([item({ id: "efnd_keep", evidence_path: "a.ts" })]), "TRUE");
    const { inputs } = parseLabelSheet(md);
    const records = buildLabelRecords(inputs, { labeler: "anton", labeled_at: "2026-06-15T00:00:00Z" });
    expect(records).toHaveLength(1);
    expect(records[0]!.finding_id).toBe("efnd_keep");
    expect(records[0]!.labeler).toBe("anton");
    // The built record must survive the strict trust-boundary parser unchanged.
    const reparsed = parseLabelRecord(records[0]!);
    expect(reparsed.ok).toBe(true);
  });

  it("derives a stable, idempotent id from the finding_id", () => {
    expect(deriveLabelId("efnd_abc")).toBe(deriveLabelId("efnd_abc"));
    expect(deriveLabelId("efnd_abc")).not.toBe(deriveLabelId("efnd_def"));
    expect(deriveLabelId("efnd_abc")).toMatch(/^lbl_[0-9a-f]{12}$/);
  });

  it("omits labeler/labeled_at when not supplied", () => {
    const records = buildLabelRecords([
      { finding_id: "efnd_a", session_group_id: "g", checkpoint_id: "c", evidence_path: "a.ts", verdict: "true_positive" },
    ]);
    expect(records[0]!.labeler).toBeUndefined();
    expect(records[0]!.labeled_at).toBeUndefined();
  });
});
