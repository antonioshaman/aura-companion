/**
 * Tests for the opt-in eval sidecar emitter (Task 3). These pin the contracts
 * that keep it a safe diagnostics side-channel:
 *   - default OFF; only "1"/"true" enable it (fail-closed parse)
 *   - when enabled, writes a parseable, version-stamped sidecar to
 *     `.council/eval/<checkpoint>.json`
 *   - manifest partition arrays are SORTED (byte-stable serialization)
 *   - existence answers are FROZEN per evidence_path (the hermetic-rerun input)
 *   - an unsafe checkpoint id never produces a write (no path traversal)
 *   - the round-trip parses back through the boundary parser AND reruns
 *     deterministically through the grounding oracle (end-to-end proof)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEvalSidecarEnabled, maybeEmitEvalSidecar } from "./eval-sidecar.js";
import { COUNCIL_SCHEMA_VERSION, type ObserverReviewPayload } from "./council-types.js";
import type { GroundingResult } from "./observer-grounding.js";
import { parseSidecarArtifact } from "../evals/schema/parse-artifact.js";
import { rerunGrounding } from "../evals/scorers/grounding-rerun.js";

const ENV_KEY = "COMPANION_EVAL_SIDECAR";

function review(overrides: Partial<ObserverReviewPayload> = {}): ObserverReviewPayload {
  return {
    schema_version: COUNCIL_SCHEMA_VERSION,
    checkpoint_id: "council-plan-0-deadbeef",
    phase: "council-plan",
    session_group_id: "grp_abc",
    reviewed_at: "2026-06-14T12:00:00Z",
    observer_provider: "claude",
    observer_model: "claude-opus-4-7",
    observer_cli_version: "1.2.3",
    findings: [],
    ...overrides,
  };
}

describe("isEvalSidecarEnabled", () => {
  const prev = process.env[ENV_KEY];
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  });

  it("is OFF by default", () => {
    delete process.env[ENV_KEY];
    expect(isEvalSidecarEnabled()).toBe(false);
  });

  it("enables on '1' and 'true' only, fails closed otherwise", () => {
    process.env[ENV_KEY] = "1";
    expect(isEvalSidecarEnabled()).toBe(true);
    process.env[ENV_KEY] = "true";
    expect(isEvalSidecarEnabled()).toBe(true);
    process.env[ENV_KEY] = "yes";
    expect(isEvalSidecarEnabled()).toBe(false);
    process.env[ENV_KEY] = "0";
    expect(isEvalSidecarEnabled()).toBe(false);
  });
});

describe("maybeEmitEvalSidecar", () => {
  let workspace: string;
  const prev = process.env[ENV_KEY];

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "eval-sidecar-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  });

  function sidecarPath(checkpointId: string): string {
    return join(workspace, ".council", "eval", `${checkpointId}.json`);
  }

  it("writes nothing when the flag is off", () => {
    delete process.env[ENV_KEY];
    maybeEmitEvalSidecar({
      workspaceRoot: workspace,
      sessionGroupId: "grp_abc",
      payload: review(),
      manifest: { delta: [], carried: [], dropped: [] },
      grounding: { findings: [], downgrades: [] },
      observerPromptSha256: "f".repeat(64),
    });
    expect(() => readFileSync(sidecarPath("council-plan-0-deadbeef"))).toThrow();
  });

  it("writes a parseable, version-stamped sidecar when enabled", () => {
    process.env[ENV_KEY] = "1";
    // A real file in the workspace so the frozen existence answer is `true`.
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "a.ts"), "x");

    const payload = review({
      findings: [
        { severity: "STOP", claim: "real bug", evidence_path: "src/a.ts", confidence: "high" },
        { severity: "STOP", claim: "ghost", evidence_path: "src/missing.ts" },
      ],
    });
    const grounding: GroundingResult = {
      findings: [
        payload.findings[0]!,
        { ...payload.findings[1]!, severity: "NOTE" },
      ],
      downgrades: [
        { index: 1, original: payload.findings[1]!, reason: "evidence_missing_on_disk" },
      ],
    };

    maybeEmitEvalSidecar({
      workspaceRoot: workspace,
      sessionGroupId: "grp_abc",
      payload,
      manifest: { delta: ["src/a.ts", "src/missing.ts"], carried: [], dropped: [] },
      grounding,
      observerPromptSha256: "a".repeat(64),
    });

    const text = readFileSync(sidecarPath("council-plan-0-deadbeef"), "utf8");
    const parsed = parseSidecarArtifact(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.eval_artifact_version).toBe(1);
    expect(parsed.value.raw_findings).toHaveLength(2);
    // Frozen existence: real file true, missing file false.
    expect(parsed.value.grounding_inputs.existence_by_path["src/a.ts"]).toBe(true);
    expect(parsed.value.grounding_inputs.existence_by_path["src/missing.ts"]).toBe(false);
    // emitted_at is the server clock, not the review's self-reported time.
    expect(parsed.value.emitted_at).not.toBe(payload.reviewed_at);
  });

  it("sorts manifest partition arrays for byte-stable serialization", () => {
    process.env[ENV_KEY] = "1";
    maybeEmitEvalSidecar({
      workspaceRoot: workspace,
      sessionGroupId: "grp_abc",
      payload: review(),
      manifest: { delta: ["z.ts", "a.ts", "m.ts"], carried: ["c.ts", "b.ts"], dropped: [] },
      grounding: { findings: [], downgrades: [] },
      observerPromptSha256: "f".repeat(64),
    });
    const parsed = parseSidecarArtifact(
      readFileSync(sidecarPath("council-plan-0-deadbeef"), "utf8"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.manifest_partition.delta).toEqual(["a.ts", "m.ts", "z.ts"]);
    expect(parsed.value.manifest_partition.carried).toEqual(["b.ts", "c.ts"]);
  });

  it("never writes to an unsafe checkpoint id (path traversal guard)", () => {
    process.env[ENV_KEY] = "1";
    maybeEmitEvalSidecar({
      workspaceRoot: workspace,
      sessionGroupId: "grp_abc",
      payload: review({ checkpoint_id: "../../etc/evil" }),
      manifest: { delta: [], carried: [], dropped: [] },
      grounding: { findings: [], downgrades: [] },
      observerPromptSha256: "f".repeat(64),
    });
    // No file under the eval dir, and nothing escaped the workspace.
    expect(() => readFileSync(sidecarPath("../../etc/evil"))).toThrow();
  });

  it("round-trips through the grounding rerun oracle deterministically", () => {
    process.env[ENV_KEY] = "1";
    writeFileSync(join(workspace, "real.ts"), "x");
    const payload = review({
      checkpoint_id: "council-implement-1-cafebabe",
      findings: [
        { severity: "STOP", claim: "grounded", evidence_path: "real.ts" },
        { severity: "STOP", claim: "outside set", evidence_path: "other.ts" },
      ],
    });
    const grounding: GroundingResult = {
      findings: [payload.findings[0]!, { ...payload.findings[1]!, severity: "NOTE" }],
      downgrades: [
        { index: 1, original: payload.findings[1]!, reason: "evidence_not_in_modified_set" },
      ],
    };
    maybeEmitEvalSidecar({
      workspaceRoot: workspace,
      sessionGroupId: "grp_abc",
      payload,
      // Only real.ts is in the modified set; other.ts is outside it.
      manifest: { delta: ["real.ts"], carried: [], dropped: [] },
      grounding,
      observerPromptSha256: "f".repeat(64),
    });
    const parsed = parseSidecarArtifact(
      readFileSync(sidecarPath("council-implement-1-cafebabe"), "utf8"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rerun = rerunGrounding(parsed.value);
    expect(rerun.deterministic).toBe(true);
    expect(rerun.diffs).toEqual([]);
  });
});
