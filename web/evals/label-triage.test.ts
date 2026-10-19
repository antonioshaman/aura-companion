/**
 * Label-queue triage (P3/FIX-B3-1). The human said a flat TRUE/FALSE sheet
 * over code claims is unjudgeable without the code. These tests pin who gets
 * what: product/policy choices go to the human as A/B, factual code claims go
 * to the orchestrator, INFO and assertion-free text go nowhere — and label
 * provenance is read so orchestrator labels never pass as human ones.
 *
 * The decision fixtures are the two findings the human actually decided on
 * 2026-09-28 (PII retention, SERVICE_ADMIN self-service); the `tier-policy`
 * case is a real misroute caught while calibrating on the 57-finding export.
 */

import { describe, it, expect } from "vitest";
import { classifyFinding, frameDecision, labelSource } from "./label-triage.js";

describe("classifyFinding", () => {
  it("excludes INFO whatever it says", () => {
    const t = classifyFinding({ severity: "INFO", claim: "Lead ingestion persists PII the plan said to withhold." });
    expect(t.kind).toBe("excluded");
  });

  it("excludes claims with no checkable assertion", () => {
    expect(classifyFinding({ severity: "NOTE", claim: "LGTM, nothing else to add here." }).kind).toBe("excluded");
    expect(classifyFinding({ severity: "WARN", claim: "Looks odd." }).kind).toBe("excluded");
  });

  it("routes a data-retention question to the human (real finding #10)", () => {
    const t = classifyFinding({
      severity: "WARN",
      claim:
        "Lead ingestion persists PII the plan explicitly said to withhold. `lead_from_chat` writes `author_tg_id` unconditionally.",
    });
    expect(t).toEqual({ kind: "decision", reason: "privacy / data policy" });
  });

  it("routes a role self-service choice to the human (real finding #35)", () => {
    const t = classifyFinding({
      severity: "NOTE",
      claim:
        "Task 4 proposes optionally adding SERVICE_ADMIN (school admin) to the self-service role allowlist 'for beta'.",
    });
    expect(t.kind).toBe("decision");
  });

  it("keeps `policy` as a code identifier a code-claim (tier-policy.ts misroute)", () => {
    const t = classifyFinding({
      severity: "STOP",
      claim: "Malformed policy entries can bypass the sufficient-data gate: sampleSize NaN makes decideTier return cheap.",
    });
    expect(t.kind).toBe("code-claim");
  });

  it("defaults to code-claim for a factual claim about code", () => {
    const t = classifyFinding({
      severity: "STOP",
      claim: "The HTTP hash endpoint truncates each file before hashing, so two versions collide.",
    });
    expect(t.kind).toBe("code-claim");
  });
});

describe("frameDecision", () => {
  it("quotes the observer's own recommendation as option B", () => {
    const d = frameDecision("The bot stores the author's tg-id. It should store only the text. Low risk otherwise.");
    expect(d.now).toBe("The bot stores the author's tg-id.");
    expect(d.optionB).toContain("It should store only the text.");
    expect(d.optionA).toMatch(/^Оставить как есть/);
  });

  it("falls back to a generic option B when no recommendation is stated", () => {
    const d = frameDecision("SERVICE_ADMIN is self-service for beta.");
    expect(d.optionB).toBe("Изменить — observer прав, это проблема.");
  });
});

describe("labelSource", () => {
  it("reads labeled_by (diet log) and labeler (ingest log)", () => {
    expect(labelSource({ labeled_by: "human-decision" })).toBe("human");
    expect(labelSource({ labeled_by: "orchestrator-c7ef7f5f" })).toBe("orchestrator");
    expect(labelSource({ labeler: "orchestrator-abc" })).toBe("orchestrator");
  });

  it("never promotes an unattributed label to human", () => {
    expect(labelSource({})).toBe("unknown");
    expect(labelSource({ labeler: "anton" })).toBe("unknown");
    expect(labelSource({ labeled_by: "not-human" })).toBe("unknown");
  });
});
