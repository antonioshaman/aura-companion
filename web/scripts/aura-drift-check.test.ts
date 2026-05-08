// Tests for the drift detector (Beck B7).
//
// Three boundary cases per the council plan:
//   1. Two sources return the same upstream version → dedup yields one entry.
//   2. Network throws → detector returns a typed "unavailable" result, never crashes.
//   3. Sources disagree → both surface with provenance so the operator sees the conflict.

import { describe, it, expect } from "vitest";
import {
  computeReport,
  readVersionField,
  readTagField,
  renderIssueBody,
  probeUpstream,
  type DriftPin,
  type UpstreamSources,
} from "./aura-drift-check.js";

describe("readVersionField", () => {
  it("returns the version field when present and non-empty", () => {
    expect(readVersionField({ version: "0.95.0" })).toBe("0.95.0");
  });
  it("returns null on missing/empty/non-string version", () => {
    expect(readVersionField({})).toBeNull();
    expect(readVersionField({ version: "" })).toBeNull();
    expect(readVersionField({ version: 42 })).toBeNull();
    expect(readVersionField(null)).toBeNull();
  });
});

describe("readTagField", () => {
  it("returns tag_name when present", () => {
    expect(readTagField({ tag_name: "the-companion-v0.95.0" })).toBe("the-companion-v0.95.0");
  });
  it("returns null when missing", () => {
    expect(readTagField({})).toBeNull();
  });
});

describe("computeReport — dedup behaviour", () => {
  it("Beck B7 case 1: pinned version equals current → no drift, single source of truth", () => {
    // Both sources happen to agree, AND we already pinned this version.
    // The detector must not refire — that's the dedup contract.
    const current: UpstreamSources = { npmVersion: "0.95.0", ghTag: "the-companion-v0.95.0" };
    const pin: DriftPin = { pinnedVersion: "0.95.0", lastFiredAt: "2026-04-01T00:00:00Z" };
    const report = computeReport(current, pin);
    expect(report.drifted).toBe(false);
    expect(report.resolvedVersion).toBe("0.95.0");
  });

  it("first run with no pin yet — drift fires once to establish baseline", () => {
    const current: UpstreamSources = { npmVersion: "0.95.0", ghTag: null };
    const report = computeReport(current, null);
    expect(report.drifted).toBe(true);
    expect(report.resolvedVersion).toBe("0.95.0");
  });

  it("pin is older than current → drift fires", () => {
    const current: UpstreamSources = { npmVersion: "0.96.0", ghTag: null };
    const pin: DriftPin = { pinnedVersion: "0.95.0", lastFiredAt: "2026-04-01T00:00:00Z" };
    const report = computeReport(current, pin);
    expect(report.drifted).toBe(true);
    expect(report.resolvedVersion).toBe("0.96.0");
  });
});

describe("computeReport — network failure", () => {
  it("Beck B7 case 2: both sources unavailable → not drifted, no resolved version (no crash)", () => {
    // The probe step logs warnings and returns nulls when network throws.
    // computeReport must return a clean "nothing to report" state, not throw.
    const current: UpstreamSources = { npmVersion: null, ghTag: null };
    const report = computeReport(current, null);
    expect(report.drifted).toBe(false);
    expect(report.resolvedVersion).toBeNull();
  });

  it("npm unavailable, github tag works → falls back to gh tag", () => {
    const current: UpstreamSources = { npmVersion: null, ghTag: "the-companion-v0.95.0" };
    const report = computeReport(current, null);
    expect(report.drifted).toBe(true);
    expect(report.resolvedVersion).toBe("the-companion-v0.95.0");
  });
});

describe("computeReport — sources disagree", () => {
  it("Beck B7 case 3: npm and github tags differ → both surfaced with provenance", () => {
    // npm says 0.95.0, github says 0.95.1 — operator needs to see both
    // so they can resolve the discrepancy. We use npm as canonical
    // (release-please publishes here first), but the issue body shows both.
    const current: UpstreamSources = { npmVersion: "0.95.0", ghTag: "the-companion-v0.95.1" };
    const report = computeReport(current, null);
    expect(report.drifted).toBe(true);
    expect(report.resolvedVersion).toBe("0.95.0"); // npm wins
    const body = renderIssueBody(report);
    expect(body).toContain("0.95.0"); // npm version visible
    expect(body).toContain("the-companion-v0.95.1"); // gh tag also visible
    expect(body).toContain("npm"); // labelled
    expect(body).toContain("github"); // labelled
  });
});

describe("renderIssueBody", () => {
  it("first-fire body explicitly says 'baseline fire' so operator doesn't think it's a regression", () => {
    const current: UpstreamSources = { npmVersion: "0.95.0", ghTag: "the-companion-v0.95.0" };
    const report = computeReport(current, null);
    const body = renderIssueBody(report);
    expect(body).toContain("baseline fire");
  });

  it("subsequent-fire body shows previous pin and last-fired timestamp", () => {
    const current: UpstreamSources = { npmVersion: "0.96.0", ghTag: null };
    const pin: DriftPin = { pinnedVersion: "0.95.0", lastFiredAt: "2026-04-01T12:00:00Z" };
    const report = computeReport(current, pin);
    const body = renderIssueBody(report);
    expect(body).toContain("0.95.0");
    expect(body).toContain("2026-04-01T12:00:00Z");
  });

  it("body references the workflow doc so the operator knows the next step", () => {
    const current: UpstreamSources = { npmVersion: "0.96.0", ghTag: null };
    const report = computeReport(current, null);
    const body = renderIssueBody(report);
    expect(body).toContain("docs/aura/upstream-sync.md");
    expect(body).toContain("--pin");
  });
});

describe("probeUpstream", () => {
  it("network throws → returns nulls, never crashes (Beck B7 case 2 at the boundary)", async () => {
    // Inject a failing fetch — probeUpstream should swallow each error and
    // return a record with nulls. The CLI then converts that into a clean
    // "no drift" state via computeReport.
    const failing = async (): Promise<unknown> => {
      throw new Error("ENETUNREACH");
    };
    const result = await probeUpstream(failing);
    expect(result).toEqual({ npmVersion: null, ghTag: null });
  });

  it("first source succeeds, second throws → first source's value survives", async () => {
    // We don't want one transient failure to suppress the other source's
    // signal. Sequential calls so we can disambiguate by URL.
    let calls = 0;
    const mixed = async (url: string): Promise<unknown> => {
      calls++;
      if (url.includes("registry.npmjs.org")) return { version: "0.95.0" };
      throw new Error("github down");
    };
    const result = await probeUpstream(mixed);
    expect(calls).toBe(2);
    expect(result.npmVersion).toBe("0.95.0");
    expect(result.ghTag).toBeNull();
  });
});
