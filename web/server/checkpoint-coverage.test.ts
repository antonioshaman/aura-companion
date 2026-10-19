import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectCheckpointCoverageGaps } from "./checkpoint-coverage.js";

// Observer rigor (2026-10-16): checkpoints without a real review used to
// leave no trace (prod grp_1af4cd: plan-147 never reviewed, panel silent),
// and an unverified empty review looked clean (checkpoint 148). The coverage
// list makes both explicit, from the files on disk.
const EMITTED = "2026-10-15T10:00:00Z";
const GROUP = "grp_cov";
let cwd: string;

function writeCheckpoint(phase: string, id: string, sequence: number, group = GROUP) {
  writeFileSync(join(cwd, ".council", "checkpoints", `${phase}-${group}.json`), JSON.stringify({
    schema_version: 1, checkpoint_id: id, phase, sequence, session_group_id: group,
    emitted_at: "2026-10-15T10:00:00Z", artifact_paths: ["docs/plan.md"],
  }));
}
function writeReview(phase: string, id: string, extra: Record<string, unknown> = {}, group = GROUP) {
  writeFileSync(join(cwd, ".council", "reviews", `${phase}-${group}-codex-observer.md`), JSON.stringify({
    schema_version: 1, checkpoint_id: id, phase, session_group_id: group, reviewed_at: "2026-10-15T10:01:00Z",
    observer_provider: "codex", observer_model: "gpt-6.1-sol", observer_cli_version: "1", findings: [], ...extra,
  }));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cov-"));
  mkdirSync(join(cwd, ".council", "checkpoints"), { recursive: true });
  mkdirSync(join(cwd, ".council", "reviews"), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("collectCheckpointCoverageGaps", () => {
  it("lists a never-reviewed checkpoint as unreviewed and an unverified review as unverified, oldest first", () => {
    writeCheckpoint("council-plan", "council-plan-147", 147); // no review (prod plan-147)
    writeCheckpoint("council-review", "council-review-148", 148);
    writeReview("council-review", "council-review-148", { host_verification: "unverified" });
    writeCheckpoint("council-implement", "council-implement-149", 149);
    writeReview("council-implement", "council-implement-149"); // a real review: covered
    expect(collectCheckpointCoverageGaps({ cwd, sessionGroupId: GROUP })).toEqual([
      // emittedAt (owner request 2026-10-19): the panel shows WHEN each checkpoint was emitted.
      { checkpointId: "council-plan-147", phase: "council-plan", sequence: 147, kind: "unreviewed", reason: "no_review", emittedAt: Date.parse(EMITTED) },
      { checkpointId: "council-review-148", phase: "council-review", sequence: 148, kind: "unverified", emittedAt: Date.parse(EMITTED) },
    ]);
  });

  it("labels unreviewed checkpoints of a degraded pair `degraded`", () => {
    writeCheckpoint("council-plan", "council-plan-147", 147);
    expect(collectCheckpointCoverageGaps({ cwd, sessionGroupId: GROUP, degraded: true }))
      .toMatchObject([{ checkpointId: "council-plan-147", reason: "degraded" }]);
  });

  it("skips the spawn checkpoint, in-flight wakes and other groups' files", () => {
    writeCheckpoint("spawn", `spawn-${GROUP}`, 0);
    writeCheckpoint("council-plan", "council-plan-150", 150);
    writeCheckpoint("council-plan", "council-plan-9", 9, "grp_other");
    writeReview("council-review", "council-review-9", { host_verification: "unverified" }, "grp_other");
    expect(collectCheckpointCoverageGaps({
      cwd, sessionGroupId: GROUP, inFlightCheckpointIds: new Set(["council-plan-150"]),
    })).toEqual([]);
  });

  it("keeps an unverified review whose checkpoint file was already overwritten", () => {
    writeReview("council-review", "council-review-140", { host_verification: "unverified" });
    expect(collectCheckpointCoverageGaps({ cwd, sessionGroupId: GROUP }))
      .toEqual([{ checkpointId: "council-review-140", phase: "council-review", kind: "unverified" }]);
  });

  it("missing .council directories give an empty list, never a throw", () => {
    rmSync(join(cwd, ".council"), { recursive: true, force: true });
    expect(collectCheckpointCoverageGaps({ cwd, sessionGroupId: GROUP })).toEqual([]);
  });
});
