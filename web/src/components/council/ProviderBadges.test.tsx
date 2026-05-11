// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ProviderBadges, parsePairing } from "./ProviderBadges.js";

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
