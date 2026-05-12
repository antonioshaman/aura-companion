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
        onOpenEvidence={() => {}}
        onMarkAddressed={() => {}}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
