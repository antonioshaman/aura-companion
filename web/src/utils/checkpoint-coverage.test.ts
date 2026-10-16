import { describe, it, expect } from "vitest";
import { coverageGapExplanation, removeCoverageGap, upsertCoverageGap } from "./checkpoint-coverage.js";

// Observer rigor (2026-10-16): pure list ops behind GroupRecord.checkpointCoverage.
describe("checkpoint coverage list", () => {
  it("upsert replaces by id and never erases a known phase/sequence with an id-only row", () => {
    let list = upsertCoverageGap(undefined, { checkpointId: "c1", phase: "council-plan", sequence: 7, kind: "unverified" });
    list = upsertCoverageGap(list, { checkpointId: "c1", phase: "", kind: "unreviewed", reason: "superseded" });
    expect(list).toEqual([{ checkpointId: "c1", phase: "council-plan", sequence: 7, kind: "unreviewed", reason: "superseded" }]);
  });

  it("remove drops only the named checkpoint", () => {
    const list = [
      { checkpointId: "a", phase: "p", kind: "unreviewed" as const },
      { checkpointId: "b", phase: "p", kind: "unverified" as const },
    ];
    expect(removeCoverageGap(list, "a").map((g) => g.checkpointId)).toEqual(["b"]);
  });

  it("explains each kind / reason in Russian", () => {
    expect(coverageGapExplanation({ checkpointId: "x", phase: "", kind: "unverified" })).toMatch(/код не проверен/);
    expect(coverageGapExplanation({ checkpointId: "x", phase: "", kind: "unreviewed", reason: "superseded" })).toMatch(/вытеснен/);
    expect(coverageGapExplanation({ checkpointId: "x", phase: "", kind: "unreviewed" })).toMatch(/нет ни одного ревью/);
  });
});
