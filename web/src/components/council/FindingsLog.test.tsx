// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  FindingsLog,
  formatRelativeTime,
  severityClass,
} from "./FindingsLog.js";
import type { ObserverFinding } from "../../types.js";

function finding(overrides: Partial<ObserverFinding> = {}): ObserverFinding {
  return {
    id: "fnd_1",
    severity: "NOTE",
    claim: "Test finding claim",
    evidence_path: "src/foo.ts",
    receivedAt: 1_000,
    checkpointId: "chk_1",
    phase: "council-plan",
    observerModel: "claude-opus-4-7",
    observerProvider: "claude",
    ...overrides,
  };
}

// ── formatRelativeTime (Beck F4: each bucket independently) ─────────────────

describe("formatRelativeTime", () => {
  it("returns 'just now' for delta < 30s", () => {
    expect(formatRelativeTime(1_000, 10_000)).toBe("just now");
  });

  it("returns Ns for delta < 60s and >= 30s", () => {
    expect(formatRelativeTime(0, 45_000)).toBe("45s ago");
  });

  it("returns Nm for delta < 1h", () => {
    expect(formatRelativeTime(0, 10 * 60_000)).toBe("10m ago");
  });

  it("returns Nh for delta < 24h", () => {
    expect(formatRelativeTime(0, 5 * 60 * 60_000)).toBe("5h ago");
  });

  it("returns Nd for delta >= 24h", () => {
    expect(formatRelativeTime(0, 3 * 24 * 60 * 60_000)).toBe("3d ago");
  });

  it("clamps negative deltas (future timestamps) to 'just now'", () => {
    expect(formatRelativeTime(10_000, 1_000)).toBe("just now");
  });
});

// ── severityClass ───────────────────────────────────────────────────────────

describe("severityClass", () => {
  // Beck F4 — every enum branch returns its own token bundle.
  it.each<[ObserverFinding["severity"], string]>([
    ["STOP", "cc-error"],
    ["WARN", "cc-warning"],
    ["NOTE", "cc-muted"],
    ["INFO", "cc-info"],
  ])("maps %s severity to a token containing %s", (sev, token) => {
    const out = severityClass(sev);
    expect(out.dot).toContain(token);
    expect(out.text).toContain(token);
    expect(out.label).toBe(sev);
  });
});

// ── FindingsLog rendering ───────────────────────────────────────────────────

describe("FindingsLog", () => {
  it("renders an empty-state message when no findings are supplied", () => {
    render(<FindingsLog findings={[]} />);
    expect(screen.getByText(/No findings yet/i)).toBeInTheDocument();
  });

  it("renders each finding as a row with severity label and claim", () => {
    const findings = [
      finding({ id: "a", severity: "STOP", claim: "Race condition in foo.ts" }),
      finding({ id: "b", severity: "NOTE", claim: "Consider renaming" }),
    ];
    render(<FindingsLog findings={findings} nowMs={2_000} />);
    expect(screen.getByText("Race condition in foo.ts")).toBeInTheDocument();
    expect(screen.getByText("Consider renaming")).toBeInTheDocument();
    expect(screen.getByTestId("finding-row-a")).toHaveAttribute("data-severity", "STOP");
    expect(screen.getByTestId("finding-row-b")).toHaveAttribute("data-severity", "NOTE");
  });

  // PLAN T15.2: `role="log"` + `aria-live="polite"` so screen readers
  // announce new findings without yanking focus from the composer.
  it("exposes role=log with aria-live=polite for screen-reader announcements", () => {
    render(<FindingsLog findings={[finding()]} />);
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
  });

  it("renders a downgraded STOP with the 'downgraded' chip and half-tone dot", () => {
    const f = finding({ id: "d", severity: "STOP", wasDowngraded: true, downgradeReason: "evidence_missing_on_disk" });
    render(<FindingsLog findings={[f]} />);
    expect(screen.getByText(/downgraded/i)).toBeInTheDocument();
    expect(screen.getByTestId("finding-row-d")).toHaveAttribute("data-downgraded", "true");
  });

  it("calls onSelect with the finding when the claim button is clicked", () => {
    const onSelect = vi.fn();
    const f = finding({ id: "x", claim: "click me" });
    render(<FindingsLog findings={[f]} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("click me"));
    expect(onSelect).toHaveBeenCalledWith(f);
  });

  // The dismiss button is only shown for live STOPs — not for NOTEs, not
  // for already-dismissed STOPs, and not for server-downgraded STOPs.
  it.each<[ObserverFinding["severity"], boolean]>([
    ["STOP", true],
    ["WARN", false],
    ["NOTE", false],
    ["INFO", false],
  ])("shows dismiss button only for live STOPs (severity=%s → expected=%s)", (severity, expected) => {
    const f = finding({ id: "y", severity });
    render(<FindingsLog findings={[f]} onDismissStop={() => {}} />);
    const btn = screen.queryByRole("button", { name: /dismiss STOP/i });
    expect(Boolean(btn)).toBe(expected);
  });

  it("hides the dismiss button when the finding id is already in dismissedStopIds", () => {
    const f = finding({ id: "y", severity: "STOP" });
    render(<FindingsLog findings={[f]} onDismissStop={() => {}} dismissedStopIds={new Set(["y"])} />);
    expect(screen.queryByRole("button", { name: /dismiss STOP/i })).toBeNull();
  });

  it("calls onDismissStop with the finding id when the dismiss button is clicked", () => {
    const onDismissStop = vi.fn();
    const f = finding({ id: "z", severity: "STOP" });
    render(<FindingsLog findings={[f]} onDismissStop={onDismissStop} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss STOP/i }));
    expect(onDismissStop).toHaveBeenCalledWith("z");
  });

  // PLAN T15.2 — stable server-assigned ids drive React reconciliation.
  // Test by re-rendering with the same id and asserting the DOM node is preserved.
  it("preserves DOM identity across re-renders when ids are stable (reconciliation by id)", () => {
    const f1 = finding({ id: "stable" });
    const { container, rerender } = render(<FindingsLog findings={[f1]} />);
    const first = container.querySelector('[data-testid="finding-row-stable"]');
    expect(first).not.toBeNull();
    rerender(<FindingsLog findings={[{ ...f1, claim: "claim updated" }]} />);
    const second = container.querySelector('[data-testid="finding-row-stable"]');
    expect(second).toBe(first); // same DOM node — reconciliation kept the row, only the text updated
  });

  it("passes accessibility scan with multiple severities", async () => {
    const { axe } = await import("vitest-axe");
    const findings = [
      finding({ id: "1", severity: "STOP", claim: "stop claim" }),
      finding({ id: "2", severity: "WARN", claim: "warn claim" }),
      finding({ id: "3", severity: "NOTE", claim: "note claim" }),
      finding({ id: "4", severity: "INFO", claim: "info claim" }),
    ];
    const { container } = render(<FindingsLog findings={findings} onDismissStop={() => {}} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan with empty state", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<FindingsLog findings={[]} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
