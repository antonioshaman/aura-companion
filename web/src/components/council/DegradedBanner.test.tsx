// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DegradedBanner } from "./DegradedBanner.js";

describe("DegradedBanner", () => {
  // Different copy per deadRole — observer dying is the common case; an
  // orchestrator-only death is an unusual state that the UI calls out
  // separately.
  it("renders observer-specific copy when deadRole='observer'", () => {
    render(<DegradedBanner deadRole="observer" onRespawn={() => {}} />);
    expect(screen.getByText(/Observer offline/i)).toBeInTheDocument();
    expect(screen.getByText(/continues running solo/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Respawn observer/i })).toBeInTheDocument();
  });

  it("renders orchestrator-specific copy when deadRole='orchestrator'", () => {
    render(<DegradedBanner deadRole="orchestrator" onRespawn={() => {}} />);
    expect(screen.getByText(/Orchestrator offline/i)).toBeInTheDocument();
    expect(screen.getByText(/unusual state/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Respawn orchestrator/i })).toBeInTheDocument();
  });

  // PLAN T15.4: warning palette + status role + polite live region —
  // distinct from BlockerBanner which is alert + assertive.
  it("uses role=status with aria-live=polite (channel-separated from blocker)", () => {
    render(<DegradedBanner deadRole="observer" onRespawn={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("calls onRespawn when the Respawn button is clicked", () => {
    const onRespawn = vi.fn();
    render(<DegradedBanner deadRole="observer" onRespawn={onRespawn} />);
    fireEvent.click(screen.getByRole("button", { name: /Respawn observer/i }));
    expect(onRespawn).toHaveBeenCalledOnce();
  });

  it("renders 'Continue solo' only when onContinueSolo is supplied", () => {
    const { rerender } = render(<DegradedBanner deadRole="observer" onRespawn={() => {}} />);
    expect(screen.queryByText(/Continue solo/i)).toBeNull();
    rerender(<DegradedBanner deadRole="observer" onRespawn={() => {}} onContinueSolo={() => {}} />);
    expect(screen.getByText(/Continue solo/i)).toBeInTheDocument();
  });

  it("calls onContinueSolo when the secondary button is clicked", () => {
    const onContinueSolo = vi.fn();
    render(
      <DegradedBanner deadRole="observer" onRespawn={() => {}} onContinueSolo={onContinueSolo} />,
    );
    fireEvent.click(screen.getByText(/Continue solo/i));
    expect(onContinueSolo).toHaveBeenCalledOnce();
  });

  // Uncontrolled mode: clicking Respawn flips to the in-flight view with
  // spinner + cancel; the local state resets when the promise resolves
  // (so the button is re-enabled on failure).
  it("uncontrolled mode: shows spinner during respawn promise, then resets", async () => {
    let resolveRespawn!: () => void;
    const respawnPromise = new Promise<void>((r) => { resolveRespawn = r; });
    render(<DegradedBanner deadRole="observer" onRespawn={() => respawnPromise} />);
    fireEvent.click(screen.getByRole("button", { name: /Respawn observer/i }));
    expect(screen.getByText(/Respawning…/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeInTheDocument();
    resolveRespawn();
    await waitFor(() => {
      expect(screen.queryByText(/Respawning…/i)).toBeNull();
    });
  });

  it("uncontrolled mode: Cancel button returns to the idle banner", () => {
    let resolveRespawn!: () => void;
    const respawnPromise = new Promise<void>((r) => { resolveRespawn = r; });
    render(<DegradedBanner deadRole="observer" onRespawn={() => respawnPromise} />);
    fireEvent.click(screen.getByRole("button", { name: /Respawn observer/i }));
    expect(screen.getByText(/Respawning…/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.queryByText(/Respawning…/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Respawn observer/i })).toBeInTheDocument();
    // Resolve the still-pending promise so the test doesn't leak.
    resolveRespawn();
  });

  // Controlled mode: parent owns the spinner state. The component does
  // NOT render its own Cancel button — the parent is expected to provide
  // cancel semantics via the backend ack.
  it("controlled mode: respects isRespawning prop and omits internal Cancel", () => {
    const { rerender } = render(
      <DegradedBanner deadRole="observer" onRespawn={() => {}} isRespawning={true} />,
    );
    expect(screen.getByText(/Respawning…/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel/i })).toBeNull();
    rerender(<DegradedBanner deadRole="observer" onRespawn={() => {}} isRespawning={false} />);
    expect(screen.queryByText(/Respawning…/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Respawn observer/i })).toBeInTheDocument();
  });

  it("passes accessibility scan (idle)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <DegradedBanner deadRole="observer" onRespawn={() => {}} onContinueSolo={() => {}} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan (respawning)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <DegradedBanner deadRole="observer" onRespawn={() => {}} isRespawning={true} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
