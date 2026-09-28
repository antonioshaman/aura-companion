/**
 * Label-queue selection (P3/B3). The AC: the exported sheet contains no
 * duplicates and nothing already labeled. Labels arrive in two shapes — the
 * ingest log (`finding_id`) and the hand-kept diet log (checkpoint + severity
 * + path) — and both must suppress. Also covers the labeled-STOP count that
 * drives the "unproven / not evaluated" verdict, which must undercount rather
 * than overcount when a label cannot be tied to a STOP.
 */

import { describe, it, expect } from "vitest";
import type { ExtractedFinding } from "./scorers/findings-extractor.js";
import { collectLabelKeys, countLabeledStops, renderPrecisionBySource, selectUnlabeled } from "./label-export.js";

function finding(id: string, over: Partial<ExtractedFinding> = {}): ExtractedFinding {
  return {
    id,
    review_file: "rec#write@1",
    checkpoint_id: "cp-1",
    phase: "p",
    session_group_id: "grp_x",
    observer_provider: "codex",
    observer_model: "",
    reviewed_at: "",
    severity: "STOP",
    claim: `claim ${id}`,
    evidence_path: `src/${id}.ts`,
    ...over,
  };
}

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("selectUnlabeled", () => {
  it("emits each finding once, skipping repeats of the same id", () => {
    const sel = selectUnlabeled([finding("a"), finding("a"), finding("b")], collectLabelKeys([]));
    expect(sel.queue.map((f) => f.id)).toEqual(["a", "b"]);
    expect(sel.duplicates).toBe(1);
  });

  it("drops findings labeled by finding_id (ingest log)", () => {
    const keys = collectLabelKeys([jsonl({ finding_id: "a", verdict: "true_positive" })]);
    const sel = selectUnlabeled([finding("a"), finding("b")], keys);
    expect(sel.queue.map((f) => f.id)).toEqual(["b"]);
    expect(sel.alreadyLabeled).toBe(1);
  });

  it("drops findings labeled by coordinates (diet log), severity case-insensitive", () => {
    const keys = collectLabelKeys([
      jsonl({ checkpoint_id: "cp-1", severity: "stop", evidence_path: "src/b.ts", label: "false_positive" }),
    ]);
    const sel = selectUnlabeled([finding("a"), finding("b")], keys);
    expect(sel.queue.map((f) => f.id)).toEqual(["a"]);
  });

  it("does not let checkpoint-level rows (severity null) or malformed lines suppress anything", () => {
    const keys = collectLabelKeys([
      jsonl({ checkpoint_id: "cp-1", severity: null, label: "false_negative" }) + "{broken\n",
    ]);
    expect(selectUnlabeled([finding("a")], keys).queue).toHaveLength(1);
  });
});

describe("countLabeledStops", () => {
  const findings = [finding("a"), finding("w", { severity: "WARN" })];

  it("counts STOP verdicts from both logs, collapsing the same finding labeled twice", () => {
    const ingest = jsonl({ finding_id: "a", verdict: "true_positive" });
    // Same finding "a" by coordinates, plus a STOP not in the population.
    const diet = jsonl(
      { checkpoint_id: "cp-1", severity: "STOP", evidence_path: "src/a.ts", label: "true_positive" },
      { checkpoint_id: "cp-9", severity: "STOP", evidence_path: "x", label: "partial_true_positive" },
    );
    const out = countLabeledStops([ingest, diet], findings);
    expect(out.stops).toBe(2);
    // partial_true_positive is not a clean TP → fail-closed precision.
    expect(out.truePositive).toBe(1);
    expect(out.precision).toBe(0.5);
  });

  it("ignores non-STOP findings, unresolvable ids and non-decisive verdicts", () => {
    const logs = [
      jsonl(
        { finding_id: "w", verdict: "true_positive" }, // WARN
        { finding_id: "zzz", verdict: "true_positive" }, // unknown id → not counted
        { checkpoint_id: "cp-1", severity: "STOP", evidence_path: "src/a.ts", label: "skip" },
        { checkpoint_id: "cp-1", severity: null, label: "false_negative" },
      ),
    ];
    expect(countLabeledStops(logs, findings)).toMatchObject({ stops: 0, truePositive: 0, precision: "unavailable" });
    expect(renderPrecisionBySource(countLabeledStops(logs, findings))).toBe(
      "STOP precision by label source: no labeled STOPs",
    );
  });

  // P3/FIX-B3-1: precision is never shown without who labeled. An
  // orchestrator verifying code is not a human confirming the observer.
  it("splits labeled STOPs by label source; the last label of a finding decides its source", () => {
    const b = finding("b");
    const logs = [
      jsonl(
        { checkpoint_id: "cp-1", severity: "STOP", evidence_path: "src/a.ts", label: "false_positive", labeled_by: "orchestrator-x" },
        { checkpoint_id: "cp-2", severity: "STOP", evidence_path: "y", label: "true_positive", labeled_by: "human-decision" },
        { checkpoint_id: "cp-3", severity: "STOP", evidence_path: "z", label: "true_positive" },
      ),
      // Ingest log: a human re-labels "a" → the human verdict wins.
      jsonl({ finding_id: "a", verdict: "true_positive", labeler: "human-anton" }, { finding_id: "b", verdict: "false_positive", labeler: "orchestrator-y" }),
    ];
    const out = countLabeledStops(logs, [...findings, b]);
    expect(out.stops).toBe(4);
    expect(out.bySource).toEqual({
      human: { stops: 2, truePositive: 2 },
      orchestrator: { stops: 1, truePositive: 0 },
      unknown: { stops: 1, truePositive: 1 },
    });
    expect(renderPrecisionBySource(out)).toBe(
      "STOP precision by label source: human 2/2 (100%) · orchestrator 0/1 (0%) · unknown 1/1 (100%)",
    );
  });
});
