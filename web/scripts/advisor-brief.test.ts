// Tests for RC-2 stack-accurate brief construction (PLAN Task 7, willison R3/R4).
// The headline guard: a Python backend advisor seated on a FastAPI repo is briefed
// for fastapi, with ZERO aiogram — and a framework specialist seated with no
// matching framework gets a visible MISMATCH flag.

import { describe, it, expect } from "vitest";
import { buildAdvisorBrief, buildDetectedStackContext } from "./advisor-brief.js";
import type { Fingerprint } from "./fingerprint";
import type { AdvisorProfile, Vocabulary } from "./capability-catalog";

const VOCAB: Vocabulary = {
  signals: new Set(["any", "python", "cpython", "fastapi", "aiogram", "flask", "react", "typescript", "rest"]),
  domains: new Set(["backend-architecture", "frontend-architecture"]),
  frameworks: new Set(["fastapi", "aiogram", "flask", "react"]),
};

function fp(frameworks: string[], others: Partial<Record<string, string[]>> = {}): Fingerprint {
  const byDimension = {
    languages: others.languages ?? [],
    runtimes: others.runtimes ?? [],
    frameworks: [...frameworks].sort(),
    datastores: others.datastores ?? [],
    "orm-migrations": [],
    infra: others.infra ?? [],
    surfaces: others.surfaces ?? [],
  };
  const signals = [...new Set(Object.values(byDimension).flat())].sort();
  return { kind: "fingerprint", signals, byDimension: byDimension as Fingerprint["byDimension"], provenance: [], scanTruncated: false, failures: [] };
}

const VANROSSUM: AdvisorProfile = { id: "vanrossum", signals: ["python", "cpython", "aiogram", "fastapi", "flask"], domains: ["backend-architecture"] };

describe("buildAdvisorBrief — stack-accurate focus (willison R3)", () => {
  it("briefs a Python advisor on FastAPI with ZERO aiogram on a fastapi repo", () => {
    const fingerprint = fp(["fastapi"], { languages: ["python"], runtimes: ["cpython"], surfaces: ["rest"] });
    const matched = ["cpython", "fastapi", "python"]; // scorer's matchedSignals
    const brief = buildAdvisorBrief(VANROSSUM, matched, fingerprint, VOCAB);
    expect(brief.frameworkFocus).toEqual(["fastapi"]);
    expect(brief.adviseOn).not.toContain("aiogram");
    expect(brief.mismatchFlag).toBeNull(); // fastapi present → no mismatch
    // the injected stack context names fastapi, never aiogram
    expect(brief.detectedStack).toContain("fastapi");
    expect(brief.detectedStack).not.toContain("aiogram");
  });
});

describe("buildAdvisorBrief — contradiction flag (willison R4)", () => {
  it("flags a framework specialist seated with none of its frameworks in the stack", () => {
    // an aiogram-only advisor seated (via language/domain) on a fastapi-only repo
    const aiogramAdvisor: AdvisorProfile = { id: "legacy", signals: ["python", "aiogram"], domains: ["backend-architecture"] };
    const fingerprint = fp(["fastapi"], { languages: ["python"] });
    const brief = buildAdvisorBrief(aiogramAdvisor, ["python"], fingerprint, VOCAB);
    expect(brief.frameworkFocus).toEqual([]);
    expect(brief.mismatchFlag).not.toBeNull();
    expect(brief.mismatchFlag).toContain("aiogram");
    expect(brief.mismatchFlag).toContain("fastapi"); // points at the detected framework
  });

  it("no flag for a non-framework advisor (e.g. a security `any` lens)", () => {
    const hunt: AdvisorProfile = { id: "hunt", signals: ["any"], domains: ["backend-architecture"] };
    const fingerprint = fp(["fastapi"]);
    const brief = buildAdvisorBrief(hunt, [], fingerprint, VOCAB);
    expect(brief.mismatchFlag).toBeNull();
  });
});

describe("buildDetectedStackContext", () => {
  it("emits needs-confirmation guidance when the stack is unconfirmed", () => {
    const nc: Fingerprint = { kind: "needs-confirmation", signals: [], byDimension: { languages: [], runtimes: [], frameworks: [], datastores: [], "orm-migrations": [], infra: [], surfaces: [] }, provenance: [], scanTruncated: false, failures: [] };
    expect(buildDetectedStackContext(nc)).toContain("unconfirmed");
  });
});
