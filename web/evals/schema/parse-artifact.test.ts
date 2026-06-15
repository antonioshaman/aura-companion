/**
 * Tests for the boundary parsers (Task 4). These pin the trust-boundary
 * contract: a parser NEVER throws on bad bytes — it returns
 * `{ok:false,reason}`. Coverage targets the failure surfaces that matter for
 * version-portability and recall scoring:
 *   - unknown version = hard reject (we wrote it; a mismatch is a real bug)
 *   - unknown EXTRA fields = tolerated (additive evolution)
 *   - size cap fires BEFORE the JSON parse
 *   - structural rejects name the offending field (debuggable reason)
 *   - label-log dedup is last-write-wins by id; malformed lines counted not thrown
 */

import { describe, it, expect } from "vitest";
import {
  parseSidecarArtifact,
  parseLabelRecord,
  parseLabelLog,
} from "./parse-artifact.js";
import {
  EVAL_ARTIFACT_VERSION,
  EVAL_LABEL_VERSION,
  type EvalSidecarArtifact,
  type EvalLabelRecord,
} from "./eval-artifact.js";

function goodSidecar(): EvalSidecarArtifact {
  return {
    eval_artifact_version: EVAL_ARTIFACT_VERSION,
    session_group_id: "grp_abc",
    checkpoint_id: "council-plan-0-deadbeef",
    phase: "council-plan",
    observer_provider: "claude",
    observer_model: "claude-opus-4-7",
    observer_cli_version: "1.2.3",
    observer_prompt_sha256: "f".repeat(64),
    emitted_at: "2026-06-14T12:00:00Z",
    manifest_partition: { delta: ["a.ts"], carried: ["b.ts"], dropped: [] },
    raw_findings: [
      { severity: "STOP", claim: "boom", evidence_path: "a.ts", confidence: "high" },
    ],
    grounding_downgrades: [
      { index: 0, original_severity: "STOP", reason: "evidence_missing_on_disk" },
    ],
    grounding_inputs: { existence_by_path: { "a.ts": false } },
  };
}

function goodLabel(): EvalLabelRecord {
  return {
    eval_label_version: EVAL_LABEL_VERSION,
    id: "lbl_deadbeef",
    session_group_id: "grp_abc",
    checkpoint_id: "council-plan-0-deadbeef",
    evidence_path: "race.ts",
    issue_class: "concurrency-race",
    verdict: "expected_blocker_missed",
  };
}

describe("parseSidecarArtifact", () => {
  it("round-trips a well-formed sidecar", () => {
    const r = parseSidecarArtifact(JSON.stringify(goodSidecar()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.checkpoint_id).toBe("council-plan-0-deadbeef");
      expect(r.value.manifest_partition.delta).toEqual(["a.ts"]);
      expect(r.value.grounding_inputs.existence_by_path["a.ts"]).toBe(false);
    }
  });

  it("tolerates unknown extra fields (additive evolution)", () => {
    const withExtra = { ...goodSidecar(), some_future_field: 42 };
    const r = parseSidecarArtifact(JSON.stringify(withExtra));
    expect(r.ok).toBe(true);
  });

  it("hard-rejects an unknown version", () => {
    const bumped = { ...goodSidecar(), eval_artifact_version: 999 };
    const r = parseSidecarArtifact(JSON.stringify(bumped));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unsupported eval_artifact_version");
  });

  it("rejects non-JSON without throwing", () => {
    const r = parseSidecarArtifact("{not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not valid JSON");
  });

  it("enforces the size cap BEFORE parsing", () => {
    // A 20-byte cap against a valid but larger document: must reject on size,
    // not attempt the parse. Reason must be the cap reason.
    const r = parseSidecarArtifact(JSON.stringify(goodSidecar()), 20);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("byte cap");
  });

  it("rejects a missing required string field, naming it", () => {
    const broken = goodSidecar() as unknown as Record<string, unknown>;
    delete broken.observer_model;
    const r = parseSidecarArtifact(JSON.stringify(broken));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("observer_model");
  });

  it("rejects a downgrade index out of raw_findings range", () => {
    const broken = goodSidecar();
    broken.grounding_downgrades = [
      { index: 5, original_severity: "STOP", reason: "evidence_missing_on_disk" },
    ];
    const r = parseSidecarArtifact(JSON.stringify(broken));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("out of raw_findings range");
  });

  it("rejects a non-boolean existence value", () => {
    const broken = goodSidecar() as unknown as Record<string, unknown>;
    broken.grounding_inputs = { existence_by_path: { "a.ts": "yes" } };
    const r = parseSidecarArtifact(JSON.stringify(broken));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("existence_by_path");
  });

  it("rejects a raw finding with an out-of-vocab severity", () => {
    const broken = goodSidecar();
    broken.raw_findings = [
      { severity: "CRITICAL" as never, claim: "x", evidence_path: "a.ts" },
    ];
    const r = parseSidecarArtifact(JSON.stringify(broken));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("severity");
  });
});

describe("parseLabelRecord", () => {
  it("round-trips a well-formed label", () => {
    const r = parseLabelRecord(goodLabel());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.verdict).toBe("expected_blocker_missed");
  });

  it("preserves the optional fields when present", () => {
    const r = parseLabelRecord({ ...goodLabel(), labeler: "anton", note: "tricky" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.labeler).toBe("anton");
      expect(r.value.note).toBe("tricky");
    }
  });

  it("hard-rejects an unknown label version", () => {
    const r = parseLabelRecord({ ...goodLabel(), eval_label_version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unsupported eval_label_version");
  });

  it("rejects an invalid verdict", () => {
    const r = parseLabelRecord({ ...goodLabel(), verdict: "maybe" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("verdict");
  });

  it("rejects an empty required field", () => {
    const r = parseLabelRecord({ ...goodLabel(), issue_class: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("issue_class");
  });
});

describe("parseLabelLog", () => {
  it("parses multiple records and skips blank lines", () => {
    const text = [
      JSON.stringify(goodLabel()),
      "",
      JSON.stringify({ ...goodLabel(), id: "lbl_second", evidence_path: "x.ts" }),
    ].join("\n");
    const out = parseLabelLog(text);
    expect(out.records).toHaveLength(2);
    expect(out.skipped).toBe(0);
  });

  it("dedups by id with last-write-wins", () => {
    const first = JSON.stringify({ ...goodLabel(), verdict: "true_positive" });
    const second = JSON.stringify({ ...goodLabel(), verdict: "false_positive" });
    const out = parseLabelLog([first, second].join("\n"));
    expect(out.records).toHaveLength(1);
    expect(out.records[0].verdict).toBe("false_positive");
  });

  it("counts malformed lines in skipped, never throws", () => {
    const text = [JSON.stringify(goodLabel()), "{truncated", "not json at all"].join("\n");
    const out = parseLabelLog(text);
    expect(out.records).toHaveLength(1);
    expect(out.skipped).toBe(2);
  });
});
