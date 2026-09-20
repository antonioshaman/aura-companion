// Tests for RC-2 CLI-flow renderers (PLAN Task 8, friedman). Assert the rendered
// text carries the WHY per seat (grounded in scorer data), lists crowded-out
// advisors with an add hint, and that confirm-stack is a recoverable forward
// action, not a dead-end refusal.

import { describe, it, expect } from "vitest";
import { renderRosterPreview, renderConfirmStackPrompt } from "./roster-render.js";
import type { Composition, RankedCandidate } from "./advisor-scorer.js";
import type { Fingerprint } from "./fingerprint";

function cand(id: string, domains: string[], signals: string[], crossStack = false): RankedCandidate {
  return { advisorId: id, score: signals.length * 2 + domains.length * 3, matchedSignals: signals, matchedDomains: domains, crossStack };
}
function nc(signals: string[] = []): Fingerprint {
  const byDimension = { languages: [], runtimes: [], frameworks: [...signals], datastores: [], "orm-migrations": [], infra: [], surfaces: [] };
  return { kind: signals.length ? "fingerprint" : "needs-confirmation", signals: [...signals].sort(), byDimension: byDimension as Fingerprint["byDimension"], provenance: [], scanTruncated: false, failures: [] };
}

describe("renderRosterPreview", () => {
  it("shows one line per seat with its matched-signal WHY, plus a confirm/veto/add footer", () => {
    const comp: Composition = {
      seated: [cand("dahl", ["backend-architecture"], ["rest", "typescript"]), cand("brandur", ["database-persistence"], ["postgres", "alembic"])],
      crowdedOut: [cand("hunt", ["security"], [], true)],
      belowMin: false,
      cappedAtMax: true,
    };
    const out = renderRosterPreview(comp);
    expect(out).toContain("Proposed council — 2 seats");
    expect(out).toContain("dahl");
    expect(out).toContain("rest, typescript"); // the WHY, grounded in matchedSignals
    expect(out).toContain("Crowded out");
    expect(out).toContain("hunt"); // starved lens is VISIBLE (hunt #4)
    expect(out).toContain("add <id>");
    expect(out).toContain("confirm");
    // score is NOT in the headline lines (friedman: score is drill-down)
    expect(out).not.toMatch(/score=/);
  });

  it("surfaces the thin-fingerprint note when below min", () => {
    const comp: Composition = { seated: [cand("hunt", ["security"], [], true)], crowdedOut: [], belowMin: true, cappedAtMax: false };
    expect(renderRosterPreview(comp)).toContain("thin fingerprint");
  });

  // ritchie #2: a partial scan (a marker file over its byte cap / unreadable) must
  // NOT render as a clean roster — the degraded-scan warning is drained from
  // fingerprint.failures above the seats.
  it("surfaces a DEGRADED SCAN warning when the fingerprint carries read failures", () => {
    const comp: Composition = { seated: [cand("dahl", ["backend-architecture"], ["typescript"])], crowdedOut: [], belowMin: false, cappedAtMax: false };
    const fp = nc(["typescript"]);
    fp.failures = [{ path: "api/pyproject.toml", reason: "size_exceeded" }];
    const out = renderRosterPreview(comp, fp);
    expect(out).toContain("DEGRADED SCAN");
    expect(out).toContain("api/pyproject.toml");
    expect(out).toContain("size_exceeded");
  });

  it("renders a clean roster (no degraded warning) when there are no failures", () => {
    const comp: Composition = { seated: [cand("dahl", ["backend-architecture"], ["typescript"])], crowdedOut: [], belowMin: false, cappedAtMax: false };
    expect(renderRosterPreview(comp, nc(["typescript"]))).not.toContain("DEGRADED SCAN");
  });
});

describe("renderConfirmStackPrompt", () => {
  it("is a recoverable forward action with structured choices, not a refusal", () => {
    const out = renderConfirmStackPrompt(nc());
    expect(out).toContain("I need one confirmation to proceed");
    expect(out).toContain("No recognised stack signals");
    expect(out).toContain("Name your stack");
    expect(out).toContain(".council-stack-override");
    // must not read like the old dead-end refusal
    expect(out).not.toMatch(/unsupported|refus/i);
  });

  it("shows low-confidence detected signals when some were found", () => {
    const out = renderConfirmStackPrompt(nc(["react"]));
    expect(out).toContain("Detected so far");
    expect(out).toContain("react");
  });
});
