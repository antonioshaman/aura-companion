// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";

/**
 * Context-overflow handoff banner. When the session transcript crosses 5/10 MB
 * the server records `session.context_advisory`; the chat shows this banner
 * with "Continue in a new session" (handoff brief + fresh session + pickup
 * draft) instead of the old plain-text "archive this session" line. These
 * tests pin: render, a11y, click → API (reason context_too_large) → pickup
 * draft + navigation, visible error state, per-milestone dismissal.
 */

const mockContinue = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("../api.js", () => ({
  api: { continueInNewSession: (...args: unknown[]) => mockContinue(...args) },
}));
const mockNavigate = vi.fn();
vi.mock("../utils/routing.js", () => ({
  navigateToSession: (...args: unknown[]) => mockNavigate(...args),
}));

const actions = { setPickupDraft: vi.fn(), setSidebarOpen: vi.fn() };
let mockState: Record<string, unknown> = {};
vi.mock("../store.js", () => {
  const useStore = (selector: (s: Record<string, unknown>) => unknown) => selector(mockState);
  useStore.getState = () => mockState;
  return { useStore };
});

import { ContextAdvisoryBanner, ContextAdvisoryNotice } from "./ContextAdvisoryBanner.js";

function seed(advisory: Record<string, unknown> | null) {
  mockState = {
    ...actions,
    sessions: new Map([["s1", { session_id: "s1", context_advisory: advisory }]]),
  };
}

const ADVISORY = {
  milestoneBytes: 10_000_000,
  message: "Session context is >10 MB. Compaction alone may not be enough — continue in a new session with a handoff of the current task.",
  action: "continue_in_new",
  at: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ContextAdvisoryBanner (presentational)", () => {
  it("renders the size, the advisory copy and the primary action", () => {
    render(<ContextAdvisoryBanner milestoneBytes={5_000_000} message="advice" onContinue={() => {}} />);
    expect(screen.getByText("Session context is over 5 MB")).toBeInTheDocument();
    expect(screen.getByText("advice")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue in a new session" })).toBeEnabled();
    // No dismiss action unless the caller supplies one.
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  // Codex sessions are measured by compaction count, not transcript bytes
  // (council plan + review 2026-10-17, AC1): the header must say so and never
  // format a count as megabytes.
  it("renders the compactions headline for a Codex codex_compactions advisory", () => {
    render(<ContextAdvisoryBanner signal="codex_compactions" milestone={2} message="codex advice" onContinue={() => {}} />);
    expect(screen.getByText("Codex compacted the context 2 times")).toBeInTheDocument();
    expect(screen.queryByText(/MB/)).not.toBeInTheDocument();
  });

  it("legacy callers that only pass milestoneBytes still get the MB headline", () => {
    render(<ContextAdvisoryBanner milestoneBytes={10_000_000} message="advice" onContinue={() => {}} />);
    expect(screen.getByText("Session context is over 10 MB")).toBeInTheDocument();
  });

  it("passes axe accessibility checks for the Codex variant", async () => {
    const { container } = render(
      <ContextAdvisoryBanner signal="codex_compactions" milestone={2} message="codex advice" onContinue={() => {}} onDismiss={() => {}} />,
    );
    const { axe } = await import("vitest-axe");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("passes axe accessibility checks (incl. the error state)", async () => {
    const { container } = render(
      <ContextAdvisoryBanner milestoneBytes={10_000_000} message="advice" onContinue={() => {}} onDismiss={() => {}} error="boom" />,
    );
    const { axe } = await import("vitest-axe");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("disables the primary action and shows progress while pending", () => {
    render(<ContextAdvisoryBanner milestoneBytes={10_000_000} message="m" onContinue={() => {}} pending />);
    expect(screen.getByRole("button", { name: "Preparing handoff…" })).toBeDisabled();
  });
});

describe("ContextAdvisoryNotice (wired)", () => {
  it("renders nothing without a continue_in_new advisory", () => {
    seed(null);
    const { container } = render(<ContextAdvisoryNotice sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("click → API with reason context_too_large → pickup draft + navigate to the new session", async () => {
    seed(ADVISORY);
    mockContinue.mockResolvedValue({ newSessionId: "new-1", draft: "Pickup …" });
    render(<ContextAdvisoryNotice sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue in a new session" }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("new-1"));
    expect(mockContinue).toHaveBeenCalledWith("s1", { reason: "context_too_large" });
    expect(actions.setPickupDraft).toHaveBeenCalledWith("new-1", "Pickup …");
  });

  it("shows the server error in the banner (not console-only) and allows retry", async () => {
    seed(ADVISORY);
    mockContinue.mockRejectedValueOnce(new Error("Cannot write handoff file: EACCES"));
    render(<ContextAdvisoryNotice sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue in a new session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot write handoff file: EACCES");
    expect(mockNavigate).not.toHaveBeenCalled();
    // Button is re-enabled for a retry.
    expect(screen.getByRole("button", { name: "Continue in a new session" })).toBeEnabled();
  });

  it("a persisted Codex compactions record renders the Codex banner and dismisses by `milestone`", () => {
    seed({ signal: "codex_compactions", milestone: 2, message: "codex advice", action: "continue_in_new", at: 1 });
    const { unmount } = render(<ContextAdvisoryNotice sessionId="s1" />);
    expect(screen.getByText("Codex compacted the context 2 times")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("context-advisory-banner")).not.toBeInTheDocument();
    expect(localStorage.getItem("cc-context-advisory-dismissed:s1")).toBe("2");
    unmount();
    // Remembered across mounts.
    render(<ContextAdvisoryNotice sessionId="s1" />);
    expect(screen.queryByTestId("context-advisory-banner")).not.toBeInTheDocument();
  });

  it("dismiss hides this milestone (remembered) but a higher milestone shows again", () => {
    seed({ ...ADVISORY, milestoneBytes: 5_000_000 });
    const { unmount } = render(<ContextAdvisoryNotice sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("context-advisory-banner")).not.toBeInTheDocument();
    unmount();
    // Survives a remount (reload).
    const second = render(<ContextAdvisoryNotice sessionId="s1" />);
    expect(screen.queryByTestId("context-advisory-banner")).not.toBeInTheDocument();
    second.unmount();
    seed(ADVISORY); // 10 MB
    render(<ContextAdvisoryNotice sessionId="s1" />);
    expect(screen.getByTestId("context-advisory-banner")).toBeInTheDocument();
  });
});
