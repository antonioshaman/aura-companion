/**
 * Precision-corpus scorer tests. This module is the deterministic, zero-LLM
 * bridge that lets the CI gate measure observer STOP precision/recall against a
 * checked-in synthetic corpus (launch criterion #1 / Story 3.1). The tests
 * assert four load-bearing properties:
 *
 *   1. grounded severity is RECOMPUTED via the live gate, not read from the
 *      sidecar — so a downgraded STOP drops out of the grounded tier.
 *   2. the corpus scores deterministically and byte-stably (no clock/random),
 *      and matches the committed baseline (zero drift on a clean tree).
 *   3. the diff names the exact metric path that drifted (so a CI failure
 *      points straight at e.g. grounded.recall).
 *   4. an empty or unlabeled corpus is visible (zero sidecars/labels) so the
 *      CI gate can refuse to pass on it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildScorableFindings,
  diffPrecisionSummary,
  loadPrecisionCorpus,
  scorePrecisionCorpus,
  summarizePrecision,
  type PrecisionSummary,
} from "./precision-corpus.js";
import { scoreObserverPrecision } from "./observer-precision.js";
import type { EvalSidecarArtifact } from "../schema/eval-artifact.js";

const CORPUS_DIR = fileURLToPath(new URL("../__fixtures__/precision", import.meta.url));
const BASELINE_PATH = fileURLToPath(new URL("../ci-precision-baseline.json", import.meta.url));

/** A minimal sidecar with two STOPs: one whose evidence is in the modified set
 *  and exists (stays STOP), one whose evidence is NOT in the modified set
 *  (grounds-out to NOTE). Lets us assert the recompute without disk. */
function twoStopSidecar(): EvalSidecarArtifact {
  return {
    eval_artifact_version: 1,
    session_group_id: "grp_unit",
    checkpoint_id: "cp0",
    phase: "council-implement",
    observer_provider: "claude",
    observer_model: "m",
    observer_cli_version: "v",
    observer_prompt_sha256: "h",
    emitted_at: "2026-06-15T00:00:00Z",
    manifest_partition: { delta: ["a.ts"], carried: [], dropped: [] },
    raw_findings: [
      { severity: "STOP", claim: "grounded one", evidence_path: "a.ts" },
      { severity: "STOP", claim: "ungrounded one", evidence_path: "b.ts" },
    ],
    grounding_downgrades: [],
    grounding_inputs: { existence_by_path: { "a.ts": true } },
  };
}

describe("buildScorableFindings", () => {
  it("recomputes grounded severity via the live gate (downgrades the out-of-set STOP)", () => {
    const findings = buildScorableFindings(twoStopSidecar());
    expect(findings).toHaveLength(2);
    // In the modified set + exists → stays STOP at both layers.
    expect(findings[0]!.raw_severity).toBe("STOP");
    expect(findings[0]!.grounded_severity).toBe("STOP");
    // Out of the modified set → raw STOP, grounded NOTE (the gate's only target).
    expect(findings[1]!.raw_severity).toBe("STOP");
    expect(findings[1]!.grounded_severity).toBe("NOTE");
  });

  it("derives the same efnd_<hex> id the findings extractor would (stable join key)", () => {
    const findings = buildScorableFindings(twoStopSidecar());
    // Deterministic, prefix-shaped id — the label join key.
    expect(findings[0]!.id).toMatch(/^efnd_[0-9a-f]{12}$/);
    // Re-running yields identical ids (no clock/random in the id path).
    const again = buildScorableFindings(twoStopSidecar());
    expect(again.map((f) => f.id)).toEqual(findings.map((f) => f.id));
  });
});

describe("scorePrecisionCorpus on the committed fixtures", () => {
  it("scores deterministically and byte-stably (no clock, no randomness)", () => {
    const a = scorePrecisionCorpus(CORPUS_DIR);
    const b = scorePrecisionCorpus(CORPUS_DIR);
    expect(JSON.stringify(a.summary)).toBe(JSON.stringify(b.summary));
  });

  it("loads both sidecars and all labels with no rejects", () => {
    const { corpus } = scorePrecisionCorpus(CORPUS_DIR);
    expect(corpus.rejected_sidecars).toEqual([]);
    expect(corpus.skipped_labels).toBe(0);
    expect(corpus.sidecars.length).toBeGreaterThan(0);
    expect(corpus.labels.length).toBeGreaterThan(0);
  });

  it("shows grounding IMPROVING precision without hurting recall (the corpus narrative)", () => {
    const { summary } = scorePrecisionCorpus(CORPUS_DIR);
    // raw precision 0.5 → grounded 0.667: grounding silenced a false STOP.
    expect(summary.raw.precision).toBe(0.5);
    expect(summary.grounded.precision).toBeGreaterThan(0.5);
    // recall unchanged: no real blocker was downgraded.
    expect(summary.grounded.recall).toBe(summary.raw.recall);
    // delta attributes the single downgrade as a true false-positive catch.
    expect(summary.delta.downgraded).toBe(1);
    expect(summary.delta.downgraded_false_positive).toBe(1);
    expect(summary.delta.downgraded_true_positive).toBe(0);
    // expected_blocker_missed row keeps the recall denominator honest.
    expect(summary.missed_blockers).toBe(1);
    expect(summary.orphan_verdict_labels).toBe(0);
  });

  it("matches the committed baseline (zero drift on a clean tree)", () => {
    const { summary } = scorePrecisionCorpus(CORPUS_DIR);
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as PrecisionSummary;
    expect(diffPrecisionSummary(summary, baseline)).toEqual([]);
  });
});

describe("diffPrecisionSummary", () => {
  it("names the exact metric path that drifted (a recall regression points at grounded.recall)", () => {
    const { summary } = scorePrecisionCorpus(CORPUS_DIR);
    const regressed: PrecisionSummary = JSON.parse(JSON.stringify(summary));
    // Simulate a grounding regression that silences a real blocker.
    regressed.grounded.recall = 1 / 3;
    regressed.grounded.true_positive = 1;
    const diffs = diffPrecisionSummary(regressed, summary);
    expect(diffs.some((d) => d.startsWith("grounded.recall:"))).toBe(true);
    expect(diffs.some((d) => d.startsWith("grounded.true_positive:"))).toBe(true);
  });

  it("preserves absent-vs-zero: an 'unavailable' ratio is distinct from 0", () => {
    // A corpus with zero labeled STOPs has unavailable precision, NOT 0.
    const findings = buildScorableFindings(twoStopSidecar());
    const score = scoreObserverPrecision(findings, []); // no labels at all
    const summary = summarizePrecision(score, { sidecars: 1, findings: findings.length, labels: 0 });
    expect(summary.grounded.precision).toBe("unavailable");
    // It must not silently compare-equal to a numeric 0 baseline.
    const zeroBaseline: PrecisionSummary = JSON.parse(JSON.stringify(summary));
    zeroBaseline.grounded.precision = 0;
    const diffs = diffPrecisionSummary(summary, zeroBaseline);
    expect(diffs.some((d) => d.startsWith("grounded.precision:"))).toBe(true);
  });
});

describe("empty / unlabeled corpus visibility (the CI gate's refuse-to-pass guard)", () => {
  it("an unlabeled corpus surfaces zero labels so the gate can fail it", () => {
    // Score the real sidecars but with no labels: summary.labels must be 0.
    const corpus = loadPrecisionCorpus(CORPUS_DIR);
    const score = scoreObserverPrecision(corpus.findings, []);
    const summary = summarizePrecision(score, {
      sidecars: corpus.sidecars.length,
      findings: corpus.findings.length,
      labels: 0,
    });
    expect(summary.labels).toBe(0);
    expect(summary.sidecars).toBeGreaterThan(0);
  });
});
