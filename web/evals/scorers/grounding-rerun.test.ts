/**
 * Tests for the grounding-rerun oracle (Task 7). These pin the two invariants
 * that make it trustworthy:
 *   1. RECOMPUTE not believe — the result is derived from re-running the real
 *      gate, so a sidecar whose recorded downgrades DISAGREE with the gate's
 *      recomputation reads as non-deterministic (the recorded set is the
 *      expectation, not echoed truth).
 *   2. HERMETIC — existence answers come from the frozen map, never disk. A
 *      path marked existing in the map is treated as existing even though it
 *      does not exist on the real filesystem here.
 * Plus the happy path: a faithfully-recorded sidecar reruns deterministically.
 */

import { describe, it, expect } from "vitest";
import { rerunGrounding, GROUNDING_RERUN_ORACLE_VERSION } from "./grounding-rerun.js";
import {
  EVAL_ARTIFACT_VERSION,
  type EvalSidecarArtifact,
} from "../schema/eval-artifact.js";

function sidecar(overrides: Partial<EvalSidecarArtifact> = {}): EvalSidecarArtifact {
  return {
    eval_artifact_version: EVAL_ARTIFACT_VERSION,
    session_group_id: "grp",
    checkpoint_id: "cp0",
    phase: "council-plan",
    observer_provider: "claude",
    observer_model: "claude-opus-4-7",
    observer_cli_version: "1.0.0",
    observer_prompt_sha256: "f".repeat(64),
    emitted_at: "2026-06-14T12:00:00Z",
    manifest_partition: { delta: [], carried: [], dropped: [] },
    raw_findings: [],
    grounding_downgrades: [],
    grounding_inputs: { existence_by_path: {} },
    ...overrides,
  };
}

describe("rerunGrounding — deterministic happy path", () => {
  it("a faithfully-recorded sidecar reruns with zero diffs", () => {
    // One STOP whose evidence is in the modified set AND exists → no downgrade.
    // One STOP whose evidence is NOT in the modified set → downgrade recorded.
    const s = sidecar({
      manifest_partition: { delta: ["in-set.ts"], carried: [], dropped: [] },
      raw_findings: [
        { severity: "STOP", claim: "real", evidence_path: "in-set.ts" },
        { severity: "STOP", claim: "ghost", evidence_path: "outside.ts" },
      ],
      grounding_inputs: { existence_by_path: { "in-set.ts": true } },
      grounding_downgrades: [
        { index: 1, original_severity: "STOP", reason: "evidence_not_in_modified_set" },
      ],
    });
    const r = rerunGrounding(s);
    expect(r.oracle_version).toBe(GROUNDING_RERUN_ORACLE_VERSION);
    expect(r.deterministic).toBe(true);
    expect(r.diffs).toEqual([]);
    expect(r.recomputed).toEqual([
      { index: 1, original_severity: "STOP", reason: "evidence_not_in_modified_set" },
    ]);
  });

  it("downgrades an in-set STOP whose evidence is missing on disk (frozen=false)", () => {
    const s = sidecar({
      manifest_partition: { delta: ["gone.ts"], carried: [], dropped: [] },
      raw_findings: [{ severity: "STOP", claim: "x", evidence_path: "gone.ts" }],
      grounding_inputs: { existence_by_path: { "gone.ts": false } },
      grounding_downgrades: [
        { index: 0, original_severity: "STOP", reason: "evidence_missing_on_disk" },
      ],
    });
    const r = rerunGrounding(s);
    expect(r.deterministic).toBe(true);
  });
});

describe("rerunGrounding — recompute, not believe", () => {
  it("flags a sidecar whose recorded downgrades disagree with the real gate", () => {
    // The gate WILL downgrade index 0 (outside modified set), but the sidecar
    // dishonestly recorded zero downgrades. The oracle must catch the lie.
    const s = sidecar({
      manifest_partition: { delta: ["other.ts"], carried: [], dropped: [] },
      raw_findings: [{ severity: "STOP", claim: "x", evidence_path: "ungrounded.ts" }],
      grounding_inputs: { existence_by_path: {} },
      grounding_downgrades: [], // claims nothing was downgraded
    });
    const r = rerunGrounding(s);
    expect(r.deterministic).toBe(false);
    expect(r.diffs.join(" ")).toContain("not in recorded set");
    expect(r.recomputed).toHaveLength(1);
    expect(r.recorded).toHaveLength(0);
  });

  it("flags a reason drift between recomputed and recorded", () => {
    // Gate reason will be evidence_not_in_modified_set, sidecar claims the
    // other reason. Same index, different reason → drift diff.
    const s = sidecar({
      manifest_partition: { delta: [], carried: [], dropped: [] },
      raw_findings: [{ severity: "STOP", claim: "x", evidence_path: "z.ts" }],
      grounding_inputs: { existence_by_path: {} },
      grounding_downgrades: [
        { index: 0, original_severity: "STOP", reason: "evidence_missing_on_disk" },
      ],
    });
    const r = rerunGrounding(s);
    expect(r.deterministic).toBe(false);
    expect(r.diffs.join(" ")).toContain("reason drift");
  });
});

describe("rerunGrounding — hermetic", () => {
  it("treats a frozen-existing path as existing despite no real file on disk", () => {
    // "definitely-not-a-real-file.ts" does not exist on this machine, but the
    // frozen map says true → the STOP must NOT downgrade. Proves the rerun
    // never stats the live disk.
    const s = sidecar({
      manifest_partition: { delta: ["definitely-not-a-real-file.ts"], carried: [], dropped: [] },
      raw_findings: [
        { severity: "STOP", claim: "x", evidence_path: "definitely-not-a-real-file.ts" },
      ],
      grounding_inputs: { existence_by_path: { "definitely-not-a-real-file.ts": true } },
      grounding_downgrades: [],
    });
    const r = rerunGrounding(s);
    expect(r.deterministic).toBe(true);
    expect(r.recomputed).toEqual([]);
  });

  it("non-STOP findings never downgrade regardless of grounding", () => {
    const s = sidecar({
      manifest_partition: { delta: [], carried: [], dropped: [] },
      raw_findings: [{ severity: "WARN", claim: "stylistic", evidence_path: "anywhere.ts" }],
      grounding_inputs: { existence_by_path: {} },
      grounding_downgrades: [],
    });
    const r = rerunGrounding(s);
    expect(r.deterministic).toBe(true);
    expect(r.recomputed).toEqual([]);
  });
});

// B2 (oracle v2): line facts frozen in the sidecar drive the line checks
// hermetically; `lineChecks: false` reproduces the pre-B2 path-only gate —
// the "before" column of the precision before/after.
describe("rerunGrounding — B2 line facts", () => {
  const withLines = (): EvalSidecarArtifact =>
    sidecar({
      manifest_partition: { delta: ["a.ts"], carried: [], dropped: [] },
      raw_findings: [
        { severity: "STOP", claim: "foo breaks", evidence_path: "a.ts", evidence_lines: [2, 2] },
        { severity: "STOP", claim: "past eof", evidence_path: "a.ts", evidence_lines: [50, 50] },
        { severity: "STOP", claim: "path only", evidence_path: "a.ts" },
      ],
      grounding_inputs: {
        existence_by_path: { "a.ts": true },
        line_facts_by_path: { "a.ts": { line_count: 3, changed_ranges: [[2, 2]], cited_lines: { "2": "foo();" } } },
      },
      grounding_downgrades: [{ index: 1, original_severity: "STOP", reason: "evidence_lines_out_of_range" }],
    });

  it("recomputes line downgrades and weak evidence from the frozen facts", () => {
    const r = rerunGrounding(withLines());
    expect(r.deterministic).toBe(true);
    expect(r.weak_evidence).toEqual([{ index: 2, reason: "no_cited_lines" }]);
  });

  it("lineChecks:false reruns the path-only gate", () => {
    const r = rerunGrounding(withLines(), { lineChecks: false });
    expect(r.recomputed).toEqual([]);
    expect(r.weak_evidence).toEqual([]);
  });

  it("a sidecar without line facts reruns exactly as the path-only gate (v1 compatibility)", () => {
    const s = withLines();
    delete s.grounding_inputs.line_facts_by_path;
    s.grounding_downgrades = [];
    const r = rerunGrounding(s);
    expect(r.deterministic).toBe(true);
    expect(r.weak_evidence).toEqual([]);
  });
});
