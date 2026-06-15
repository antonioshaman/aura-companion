/**
 * Tests for the observer-findings extractor. The behaviours that matter:
 *  - normalizes the real review shape (JSON-in-.md) into flat labelable rows,
 *  - tolerates non-review files (heartbeat ack, malformed JSON) via `skipped`,
 *  - drops shapeless / out-of-vocabulary findings via `malformed_findings`
 *    rather than letting one bad row poison the extract,
 *  - lower-cases severities are normalized; ids are deterministic.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { extractFindings } from "./findings-extractor.js";

const FX = join(__dirname, "..", "__fixtures__");

describe("extractFindings", () => {
  const out = extractFindings([
    join(FX, "review-basic.md"),
    join(FX, "review-heartbeat.md"),
    join(FX, "review-malformed.md"),
  ]);

  it("counts only findings-bearing reviews; skips heartbeat + malformed files", () => {
    expect(out.reviews).toBe(1); // only review-basic carries a findings array
    expect(out.skipped).toBe(2); // heartbeat (no findings array) + malformed JSON
  });

  it("keeps valid findings and drops shapeless/bad-severity/empty-claim ones", () => {
    // 3 valid (STOP, WARN, info→INFO); 2 dropped (BOGUS severity, empty claim).
    expect(out.findings.length).toBe(3);
    expect(out.malformed_findings).toBe(2);
  });

  it("normalizes severity case and tallies by tier", () => {
    expect(out.by_severity).toEqual({ STOP: 1, WARN: 1, NOTE: 0, INFO: 1 });
    const info = out.findings.find((f) => f.severity === "INFO")!;
    expect(info.claim).toBe("style nit"); // the lower-cased "info" entry
  });

  it("carries optional evidence_lines + confidence only when well-formed", () => {
    const stop = out.findings.find((f) => f.severity === "STOP")!;
    expect(stop.evidence_lines).toEqual([10, 20]);
    expect(stop.confidence).toBe("high");
    const info = out.findings.find((f) => f.severity === "INFO")!;
    expect(info.evidence_lines).toBeUndefined();
    expect(info.confidence).toBeUndefined();
  });

  it("derives a deterministic, stable id per finding", () => {
    const again = extractFindings([join(FX, "review-basic.md")]);
    const ids = out.findings.map((f) => f.id).sort();
    const ids2 = again.findings.map((f) => f.id).sort();
    expect(ids2).toEqual(ids);
    expect(ids[0]).toMatch(/^efnd_[0-9a-f]{12}$/);
  });
});
