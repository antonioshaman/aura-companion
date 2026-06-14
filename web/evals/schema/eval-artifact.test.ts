/**
 * Tests for the eval artifact schema contracts. Task 1 establishes the
 * version discriminator + shapes; the full ingestion parsers are Task 4.
 * These tests pin the version-guard semantics (unknown version = hard
 * reject) and that the constants are stable so a v1 reader keeps reading
 * v1 sidecars.
 */

import { describe, it, expect } from "vitest";
import {
  EVAL_ARTIFACT_VERSION,
  EVAL_LABEL_VERSION,
  EVAL_SIDECAR_MAX_BYTES,
  isSupportedEvalArtifactVersion,
  isSupportedEvalLabelVersion,
  type EvalSidecarArtifact,
  type EvalLabelRecord,
} from "./eval-artifact.js";

describe("eval artifact version constants", () => {
  it("pins v1 — bumping these is a breaking change a reader must opt into", () => {
    expect(EVAL_ARTIFACT_VERSION).toBe(1);
    expect(EVAL_LABEL_VERSION).toBe(1);
  });

  it("sidecar size cap exceeds the 256 KB council-artifact default", () => {
    // The sidecar embeds the raw review + partition; if it shared the
    // council default it would throw against writeAtomicJson for a rich
    // review. Guard the relationship explicitly.
    expect(EVAL_SIDECAR_MAX_BYTES).toBeGreaterThan(256 * 1024);
  });
});

describe("isSupportedEvalArtifactVersion", () => {
  it("accepts exactly the current version", () => {
    expect(isSupportedEvalArtifactVersion(1)).toBe(true);
  });

  it("hard-rejects unknown / malformed versions (locally produced = fail loud)", () => {
    expect(isSupportedEvalArtifactVersion(0)).toBe(false);
    expect(isSupportedEvalArtifactVersion(2)).toBe(false);
    expect(isSupportedEvalArtifactVersion("1")).toBe(false);
    expect(isSupportedEvalArtifactVersion(undefined)).toBe(false);
    expect(isSupportedEvalArtifactVersion(null)).toBe(false);
  });
});

describe("isSupportedEvalLabelVersion", () => {
  it("accepts exactly the current label version and rejects others", () => {
    expect(isSupportedEvalLabelVersion(1)).toBe(true);
    expect(isSupportedEvalLabelVersion(2)).toBe(false);
    expect(isSupportedEvalLabelVersion("1")).toBe(false);
  });
});

describe("schema shapes (compile-time contract, exercised structurally)", () => {
  it("a well-formed sidecar artifact has version as its discriminator field", () => {
    const artifact: EvalSidecarArtifact = {
      eval_artifact_version: EVAL_ARTIFACT_VERSION,
      session_group_id: "grp_abc",
      checkpoint_id: "council-plan-0-deadbeef",
      phase: "council-plan",
      observer_provider: "claude",
      observer_model: "claude-opus-4-7",
      observer_cli_version: "1.2.3",
      observer_prompt_sha256: "f".repeat(64),
      emitted_at: "2026-06-14T12:00:00Z",
      manifest_partition: { delta: ["a.ts"], carried: [], dropped: [] },
      raw_findings: [
        { severity: "STOP", claim: "boom", evidence_path: "a.ts", confidence: "high" },
      ],
      grounding_downgrades: [
        { index: 0, original_severity: "STOP", reason: "evidence_missing_on_disk" },
      ],
      grounding_inputs: { existence_by_path: { "a.ts": false } },
    };
    expect(isSupportedEvalArtifactVersion(artifact.eval_artifact_version)).toBe(true);
    expect(artifact.manifest_partition.delta).toEqual(["a.ts"]);
  });

  it("an expected_blocker_missed label carries no matching finding (recall set)", () => {
    const label: EvalLabelRecord = {
      eval_label_version: EVAL_LABEL_VERSION,
      id: "lbl_deadbeef",
      session_group_id: "grp_abc",
      checkpoint_id: "council-plan-0-deadbeef",
      evidence_path: "race.ts",
      issue_class: "concurrency-race",
      verdict: "expected_blocker_missed",
    };
    expect(label.verdict).toBe("expected_blocker_missed");
    expect(isSupportedEvalLabelVersion(label.eval_label_version)).toBe(true);
  });
});
