// @vitest-environment jsdom
/**
 * BackendAuthBadge — the New Session "is the coding CLI signed in" indicator.
 *
 * States: authorized (reassurance, no action), expired (stale OAuth — the
 * recurring headless failure), unauthorized (never set up). Absent authState
 * must render nothing (old server / binary not installed). The fix CTA fires
 * only in the non-authorized states.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BackendAuthBadge } from "./BackendAuthBadge.js";

describe("BackendAuthBadge", () => {
  it("renders nothing when authState is absent", () => {
    const { container } = render(<BackendAuthBadge backendName="Claude Code" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a reassuring 'signed in' line when authorized, with no fix button", () => {
    const onFix = vi.fn();
    render(<BackendAuthBadge backendName="Claude Code" authState="authorized" onFix={onFix} />);
    expect(screen.getByText(/Claude Code signed in/i)).toBeInTheDocument();
    // Authorized is terminal — no call-to-action.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("flags an expired token and offers Re-authenticate", () => {
    const onFix = vi.fn();
    render(<BackendAuthBadge backendName="Claude Code" authState="expired" onFix={onFix} />);
    expect(screen.getByText(/token expired/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /re-authenticate/i }));
    expect(onFix).toHaveBeenCalledTimes(1);
  });

  it("flags not-signed-in and offers Set up access", () => {
    const onFix = vi.fn();
    render(<BackendAuthBadge backendName="Codex" authState="unauthorized" onFix={onFix} />);
    expect(screen.getByText(/not signed in/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /set up access/i }));
    expect(onFix).toHaveBeenCalledTimes(1);
  });

  it("omits the fix button when no onFix handler is provided", () => {
    render(<BackendAuthBadge backendName="Codex" authState="unauthorized" />);
    expect(screen.getByText(/not signed in/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("exposes status as a live region for screen readers", () => {
    render(<BackendAuthBadge backendName="Claude Code" authState="expired" onFix={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/token expired/i);
  });

  it("passes axe accessibility checks in each state", async () => {
    const { axe } = await import("vitest-axe");
    for (const state of ["authorized", "expired", "unauthorized"] as const) {
      const { container, unmount } = render(
        <BackendAuthBadge backendName="Claude Code" authState={state} onFix={vi.fn()} />,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
