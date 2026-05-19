// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EmptyChatState } from "./EmptyChatState.js";

// vitest-axe matchers (`toHaveNoViolations`) are registered globally in
// `src/test-setup.ts`. `axe` itself is dynamically imported per-test so
// the heavy axe-core module only loads inside the jsdom environment.

/**
 * Covers both rendering branches of the extracted EmptyChatState component
 * (extracted from MessageFeed.tsx Phase 2). The two branches are mutually
 * exclusive — `canLoadResumeHistory` toggles between the resume CTA card
 * and the generic "start a conversation" prompt. Tests verify content
 * presence, button gating, error surfacing, and a11y for each branch.
 */
describe("EmptyChatState", () => {
  const baseProps = {
    canLoadResumeHistory: false,
    resumeModeLabel: "Resuming",
    resumeSourceSessionId: "",
    resumeHistoryLoading: false,
    resumeHistoryError: null,
    onLoadResumeHistory: vi.fn(),
  };

  describe("fresh branch (no resume source)", () => {
    it("renders the generic 'start a conversation' prompt", () => {
      render(<EmptyChatState {...baseProps} />);
      expect(screen.getByText("Start a conversation")).toBeInTheDocument();
      expect(
        screen.getByText("Send a message to begin working with Aura Companion."),
      ).toBeInTheDocument();
      // No CTA button when no resume source is available.
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("has no a11y violations", async () => {
      const { container } = render(<EmptyChatState {...baseProps} />);
      const { axe } = await import("vitest-axe");
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  describe("resume-available branch", () => {
    const resumeProps = {
      ...baseProps,
      canLoadResumeHistory: true,
      resumeSourceSessionId: "abc12345-deadbeef",
      resumeModeLabel: "Resuming",
    };

    it("renders the prior-context message + first 8 chars of source ID", () => {
      render(<EmptyChatState {...resumeProps} />);
      expect(screen.getByText("This session has prior context")).toBeInTheDocument();
      // Source ID is truncated to first 8 chars at render time.
      expect(screen.getByText("abc12345")).toBeInTheDocument();
      // Verb prefix is rendered.
      expect(screen.getByText(/Resuming/)).toBeInTheDocument();
    });

    it("invokes onLoadResumeHistory when the CTA is clicked", () => {
      const onLoadResumeHistory = vi.fn();
      render(<EmptyChatState {...resumeProps} onLoadResumeHistory={onLoadResumeHistory} />);
      fireEvent.click(screen.getByRole("button", { name: /Load previous history/i }));
      expect(onLoadResumeHistory).toHaveBeenCalledOnce();
    });

    it("disables the CTA and changes label while loading", () => {
      render(<EmptyChatState {...resumeProps} resumeHistoryLoading={true} />);
      const button = screen.getByRole("button", { name: /Loading\.\.\./i });
      expect(button).toBeDisabled();
    });

    it("surfaces the resume error via role=alert when present", () => {
      render(
        <EmptyChatState
          {...resumeProps}
          resumeHistoryError="Network failed mid-fetch"
        />,
      );
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Network failed mid-fetch");
    });

    it("has no a11y violations (resume branch)", async () => {
      const { container } = render(<EmptyChatState {...resumeProps} />);
      const { axe } = await import("vitest-axe");
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
