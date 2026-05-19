// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  ProviderBadges,
  parsePairing,
  isHomogeneousPairing,
  pairHalvesAfterBackendCollapse,
} from "./ProviderBadges.js";

// ── parsePairing (Beck F4: both branches) ──────────────────────────────────

describe("parsePairing", () => {
  it("parses a well-formed `<a>+<b>` pairing", () => {
    expect(parsePairing("claude+codex")).toEqual({ orchestrator: "claude", observer: "codex" });
  });

  it("lower-cases both halves so equality checks downstream are normalised", () => {
    expect(parsePairing("Claude+CODEX")).toEqual({ orchestrator: "claude", observer: "codex" });
  });

  it.each([
    ["empty", ""],
    ["single half", "claude"],
    ["three parts", "claude+codex+extra"],
    ["empty left", "+codex"],
    ["empty right", "claude+"],
  ])("returns null for malformed input: %s", (_label, raw) => {
    expect(parsePairing(raw)).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parsePairing(undefined as unknown as string)).toBeNull();
  });
});

// ── isHomogeneousPairing (callers in dense rows suppress chips when both halves match) ──

describe("isHomogeneousPairing", () => {
  it("returns true when both halves of the pairing are the same provider", () => {
    expect(isHomogeneousPairing("claude+claude")).toBe(true);
  });

  it("is case-insensitive — `Claude+CLAUDE` is still homogeneous", () => {
    // parsePairing lower-cases both halves; this test exists so future refactors
    // that change normalisation can't silently regress the dense-row suppression.
    expect(isHomogeneousPairing("Claude+CLAUDE")).toBe(true);
  });

  it("returns false for asymmetric pairings (claude+codex)", () => {
    expect(isHomogeneousPairing("claude+codex")).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["single half", "claude"],
    ["three parts", "claude+codex+extra"],
    ["empty left", "+claude"],
    ["empty right", "claude+"],
  ])("returns false for malformed input (%s) — callers fall back to ProviderBadges' own neutral chips", (_label, raw) => {
    expect(isHomogeneousPairing(raw)).toBe(false);
  });
});

// ── pairHalvesAfterBackendCollapse (Sidebar suppression beyond homogeneous) ──
//
// Extension of `isHomogeneousPairing` for the asymmetric case: in SessionItem
// the BackendBadge already shows the orchestrator backend ("CC" / "CX"), so
// rendering ANY pair-half whose provider equals the backend is pure
// duplication. This helper returns the pair halves that should still be
// rendered after that collapse, in orchestrator-then-observer order.
//
// Truth table covered:
//   ("claude+claude", "claude") → []           # PR #27 homogeneous case
//   ("claude+codex",  "claude") → ["codex"]    # NEW: redundant claude half dropped
//   ("claude+codex",  "codex")  → ["claude"]   # NEW: redundant codex half dropped
//   ("codex+codex",   "codex")  → []           # symmetric homogeneous on codex backend
//   malformed                    → []           # SessionItem renders nothing — same as homogeneous

describe("pairHalvesAfterBackendCollapse", () => {
  it("returns [] for homogeneous pair on matching backend (PR #27 case)", () => {
    expect(pairHalvesAfterBackendCollapse("claude+claude", "claude")).toEqual([]);
    expect(pairHalvesAfterBackendCollapse("codex+codex", "codex")).toEqual([]);
  });

  it("drops the half whose provider duplicates the backend (asymmetric pair)", () => {
    // Backend=claude already shows "CC" — the CLAUDE pair-half adds no signal.
    expect(pairHalvesAfterBackendCollapse("claude+codex", "claude")).toEqual(["codex"]);
    // Backend=codex already shows "CX" — the CODEX pair-half adds no signal.
    expect(pairHalvesAfterBackendCollapse("claude+codex", "codex")).toEqual(["claude"]);
  });

  it("preserves orchestrator-then-observer order when the backend matches the OBSERVER half", () => {
    // Hypothetical `codex+claude` pair on a Codex backend — observer ("claude")
    // is what remains. Order is preserved because the helper filters; the
    // caller can rely on index 0 being the surviving half regardless of which
    // pair position it occupied.
    expect(pairHalvesAfterBackendCollapse("codex+claude", "codex")).toEqual(["claude"]);
  });

  it("normalises pair halves to lowercase (matches parsePairing)", () => {
    expect(pairHalvesAfterBackendCollapse("Claude+CODEX", "claude")).toEqual(["codex"]);
  });

  it.each([
    ["empty", ""],
    ["single half", "claude"],
    ["three parts", "claude+codex+extra"],
    ["empty left", "+codex"],
    ["empty right", "claude+"],
  ])("returns [] for malformed input (%s) — SessionItem renders nothing", (_label, raw) => {
    expect(pairHalvesAfterBackendCollapse(raw, "claude")).toEqual([]);
  });

  it("returns both halves when neither matches the backend (defensive — impossible today, future-proof)", () => {
    // Today server-side validation only permits backends `claude` / `codex`
    // and pairings whose halves come from the same set, so this branch is
    // structurally unreachable. The test exists so the helper's contract
    // stays sound if a new backend or pairing type is added.
    const halves = pairHalvesAfterBackendCollapse("claude+codex", "unknown" as "claude");
    expect(halves).toEqual(["claude", "codex"]);
  });
});

// ── ProviderBadges rendering ────────────────────────────────────────────────

describe("ProviderBadges", () => {
  it("renders two chips for a claude+claude pair", () => {
    render(<ProviderBadges pairing="claude+claude" />);
    const chips = screen.getAllByText("claude");
    // One per half; the separator `+` is aria-hidden so it shouldn't add count.
    expect(chips).toHaveLength(2);
  });

  // Asymmetric tinting is the affordance — PLAN T15.5. Tests assert the
  // claude chip carries the cc-primary class and the codex chip carries
  // cc-codex; that's how a user reads the pairing without parsing a label.
  it("renders distinct chips for claude+codex with distinct provider classes", () => {
    render(<ProviderBadges pairing="claude+codex" />);
    const claudeChip = screen.getByTestId("provider-chip-orchestrator");
    const codexChip = screen.getByTestId("provider-chip-observer");
    expect(claudeChip).toHaveTextContent("claude");
    expect(codexChip).toHaveTextContent("codex");
    expect(claudeChip.className).toMatch(/cc-primary/);
    expect(codexChip.className).toMatch(/cc-codex/);
  });

  // Fallback for unknown / malformed pairing: render neutral chips rather
  // than crash. A future provider added server-side without UI updates
  // produces a degraded-but-readable label, not a blank slot.
  it("renders neutral 'unknown' chips for malformed pairing input", () => {
    render(<ProviderBadges pairing="weird-non-pairing" />);
    const chips = screen.getAllByText("unknown");
    expect(chips).toHaveLength(2);
  });

  // Aria contract: the wrapper carries a default semantic label that
  // screen readers can announce. Components should consume the
  // discriminated union name, not parse the visual chip colour.
  it("exposes an accessible default aria-label naming both halves", () => {
    render(<ProviderBadges pairing="claude+codex" />);
    expect(screen.getByLabelText(/orchestrator claude/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/observer codex/i)).toBeInTheDocument();
  });

  it("respects a caller-supplied aria-label override", () => {
    render(<ProviderBadges pairing="claude+claude" ariaLabel="Council pair" />);
    expect(screen.getByLabelText("Council pair")).toBeInTheDocument();
  });

  it("size='default' uses the larger chip class", () => {
    const { rerender } = render(<ProviderBadges pairing="claude+claude" size="compact" />);
    const compactChip = screen.getByTestId("provider-chip-orchestrator");
    const compactClass = compactChip.className;
    rerender(<ProviderBadges pairing="claude+claude" size="default" />);
    const defaultChip = screen.getByTestId("provider-chip-orchestrator");
    expect(defaultChip.className).not.toBe(compactClass);
    expect(defaultChip.className).toMatch(/text-\[11px\]/);
  });

  it("passes accessibility scan (claude+claude)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ProviderBadges pairing="claude+claude" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan (claude+codex)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ProviderBadges pairing="claude+codex" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
