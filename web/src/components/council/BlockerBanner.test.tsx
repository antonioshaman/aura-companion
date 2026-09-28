// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BlockerBanner } from "./BlockerBanner.js";
import type { ObserverFinding } from "../../types.js";

function finding(overrides: Partial<ObserverFinding> = {}): ObserverFinding {
  return {
    id: "fnd_1",
    severity: "STOP",
    claim: "Race condition in session-orchestrator.ts",
    evidence_path: "web/server/session-orchestrator.ts",
    evidence_lines: [412, 425],
    confidence: "high",
    receivedAt: 1_000,
    checkpointId: "chk_1",
    phase: "council-implement",
    observerModel: "gpt-5-codex",
    observerProvider: "codex",
    ...overrides,
  };
}

describe("BlockerBanner", () => {
  // PLAN T15.3: "Reasoning visible — banner shows what evidence triggered
  // the STOP (file/line/symbol), not just verdict."
  it("renders the claim, evidence path with line range, and observer attribution", () => {
    render(<BlockerBanner finding={finding()} nowMs={2_000} onDismiss={() => {}} />);
    expect(screen.getByText(/Race condition/i)).toBeInTheDocument();
    expect(screen.getByTestId("blocker-evidence")).toHaveTextContent(
      "web/server/session-orchestrator.ts:412-425",
    );
    // Provider chip — pinned exact-match (avoids substring-collision with "gpt-5-codex").
    expect(screen.getByText("codex", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("gpt-5-codex")).toBeInTheDocument();
    expect(screen.getByText("council-implement")).toBeInTheDocument();
  });

  it("formats evidence as just the path when no line range is present", () => {
    const f = finding();
    delete f.evidence_lines;
    render(<BlockerBanner finding={f} onDismiss={() => {}} />);
    expect(screen.getByTestId("blocker-evidence")).toHaveTextContent("web/server/session-orchestrator.ts");
    expect(screen.getByTestId("blocker-evidence").textContent).not.toMatch(/:\d/);
  });

  // PLAN T15.3: assertive role + alert semantics so screen readers
  // announce immediately. Distinct from polite findings log.
  it("uses role=alert with aria-live=assertive (distinct from polite findings log)", () => {
    render(<BlockerBanner finding={finding()} onDismiss={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  // Action wiring
  it("calls onDismiss with the finding id when 'Dismiss for now' is clicked", () => {
    const onDismiss = vi.fn();
    render(<BlockerBanner finding={finding({ id: "x" })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText(/Dismiss for now/i));
    expect(onDismiss).toHaveBeenCalledWith("x");
  });

  it("renders 'Open evidence' only when onOpenEvidence is supplied", () => {
    const { rerender } = render(<BlockerBanner finding={finding()} onDismiss={() => {}} />);
    expect(screen.queryByText(/Open evidence/i)).toBeNull();
    rerender(<BlockerBanner finding={finding()} onDismiss={() => {}} onOpenEvidence={() => {}} />);
    expect(screen.getByText(/Open evidence/i)).toBeInTheDocument();
  });

  it("calls onOpenEvidence with the finding when 'Open evidence' is clicked", () => {
    const onOpenEvidence = vi.fn();
    const f = finding();
    render(<BlockerBanner finding={f} onDismiss={() => {}} onOpenEvidence={onOpenEvidence} />);
    fireEvent.click(screen.getByText(/Open evidence/i));
    expect(onOpenEvidence).toHaveBeenCalledWith(f);
  });

  it("renders 'Mark addressed' only when onMarkAddressed is supplied", () => {
    const { rerender } = render(<BlockerBanner finding={finding()} onDismiss={() => {}} />);
    expect(screen.queryByText(/Mark addressed/i)).toBeNull();
    rerender(<BlockerBanner finding={finding()} onDismiss={() => {}} onMarkAddressed={() => {}} />);
    expect(screen.getByText(/Mark addressed/i)).toBeInTheDocument();
  });

  // Hunt P1 / Willison P2 — the renderer must escape content. JSX text
  // content does this automatically; we verify by asserting an injected
  // script tag is rendered as literal text, not as a DOM element.
  // FIX-B2b-1: "Dismiss for now" and "Dispute" are separate actions. Dismiss
  // is local and temporary; only Dispute says "this claim is wrong" and is
  // persisted server-side. A click on one must never fire the other.
  it("keeps Dismiss and Dispute separate: each click fires only its own callback", () => {
    const onDismiss = vi.fn();
    const onDispute = vi.fn();
    render(<BlockerBanner finding={finding({ id: "x" })} onDismiss={onDismiss} onDispute={onDispute} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss for now" }));
    expect(onDismiss).toHaveBeenCalledWith("x");
    expect(onDispute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dispute" }));
    expect(onDispute).toHaveBeenCalledWith("x");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // The Dispute button's consequence (scoped to the evidence file) is spelled
  // out for assistive tech; with no onDispute the button is absent.
  it("describes what Dispute does, scoped to the evidence file, and hides it without onDispute", () => {
    const { unmount } = render(<BlockerBanner finding={finding()} onDismiss={() => {}} onDispute={() => {}} />);
    expect(screen.getByRole("button", { name: "Dispute" })).toHaveAccessibleDescription(
      /about web\/server\/session-orchestrator\.ts will not raise a blocker again/,
    );
    unmount();
    render(<BlockerBanner finding={finding()} onDismiss={() => {}} />);
    expect(screen.queryByRole("button", { name: "Dispute" })).toBeNull();
  });

  // Dispute suppresses future blockers, so the Cmd/Ctrl+Shift+B shortcut
  // (which focuses the primary action) must never land on it.
  it("never marks Dispute as the primary action", () => {
    render(<BlockerBanner finding={finding()} onDismiss={() => {}} onDispute={() => {}} />);
    expect(screen.getByRole("button", { name: "Dispute" })).not.toHaveAttribute("data-council-blocker-primary");
    expect(screen.getByRole("button", { name: "Dismiss for now" })).toHaveAttribute("data-council-blocker-primary");
  });

  it("escapes HTML in claim — script tags are rendered as literal text, not HTML", () => {
    const malicious = '<img src=x onerror="alert(1)"> &lt;b&gt;tagged&lt;/b&gt;';
    render(<BlockerBanner finding={finding({ claim: malicious })} onDismiss={() => {}} />);
    // Should appear as literal text in the document — no <img> node inserted.
    const literal = screen.getByText(malicious);
    expect(literal).toBeInTheDocument();
    // No injected <img> nodes from the malicious claim.
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  it("passes accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BlockerBanner finding={finding()} onDismiss={() => {}} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan with all action buttons present", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <BlockerBanner
        finding={finding()}
        onDismiss={() => {}}
        onDispute={() => {}}
        onOpenEvidence={() => {}}
        onMarkAddressed={() => {}}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // FIX-AP-3: a finding that holds auto-proceed (an unfrozen raw STOP the
  // server now re-grounds as NOTE / weak) is on the banner so the hold is
  // visible, labelled as holding auto-proceed with the reason, and the
  // Dismiss button that releases the hold is there.
  it("labels a held finding as holding auto-proceed, says why, and keeps Dismiss", () => {
    const onDismiss = vi.fn();
    render(
      <BlockerBanner
        finding={finding({ id: "held", severity: "NOTE", wasDowngraded: true, downgradeReason: "evidence_not_in_modified_set", holdsAutoProceed: true })}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText("Holding auto-proceed")).toBeInTheDocument();
    expect(screen.queryByText("Blocker from observer")).toBeNull();
    expect(screen.getByTestId("blocker-hold-reason")).toHaveTextContent(/Re-checked as a note now/);
    expect(screen.getByTestId("blocker-hold-reason")).toHaveTextContent(/Auto-proceed stays paused until you dismiss or dispute it/);
    fireEvent.click(screen.getByText(/Dismiss for now/i));
    expect(onDismiss).toHaveBeenCalledWith("held");
  });

  it("explains a held STOP whose evidence is now weak", () => {
    render(<BlockerBanner finding={finding({ weakEvidence: "no_cited_lines", holdsAutoProceed: true })} onDismiss={() => {}} />);
    expect(screen.getByTestId("blocker-hold-reason")).toHaveTextContent(/evidence is weak now/);
  });

  it("shows no hold reason on an ordinary blocker", () => {
    render(<BlockerBanner finding={finding()} onDismiss={() => {}} />);
    expect(screen.getByText("Blocker from observer")).toBeInTheDocument();
    expect(screen.queryByTestId("blocker-hold-reason")).toBeNull();
  });

  it("passes accessibility scan for a held finding", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <BlockerBanner finding={finding({ severity: "NOTE", wasDowngraded: true, holdsAutoProceed: true })} onDismiss={() => {}} onDispute={() => {}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
