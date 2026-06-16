// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ModelFallbackBanner } from "./ModelFallbackBanner.js";

describe("ModelFallbackBanner", () => {
  it("renders the from/to models in the notice", () => {
    render(<ModelFallbackBanner fromModel="Opus 4.7" toModel="Opus 4.8" />);
    expect(screen.getByText(/Running on a fallback model/i)).toBeInTheDocument();
    expect(screen.getByText(/Opus 4\.7/)).toBeInTheDocument();
    expect(screen.getByText(/Opus 4\.8/)).toBeInTheDocument();
  });

  // Each reason maps to its own clause; an omitted reason falls back to the
  // generic "is unavailable" so the banner never renders a dangling fragment.
  it.each([
    ["retired", /is no longer available/i],
    ["blocked", /blocked for this session/i],
    ["overloaded", /temporarily overloaded/i],
  ] as const)("renders reason-specific copy for %s", (reason, matcher) => {
    render(<ModelFallbackBanner fromModel="Opus 4.7" toModel="Opus 4.8" reason={reason} />);
    expect(screen.getByText(matcher)).toBeInTheDocument();
  });

  it("renders generic unavailable copy when no reason is supplied", () => {
    render(<ModelFallbackBanner fromModel="Opus 4.7" toModel="Opus 4.8" />);
    expect(screen.getByText(/is unavailable\./i)).toBeInTheDocument();
  });

  // Warning channel (not destructive): the fallback reuses DegradedBanner's
  // role=status + aria-live=polite recipe — an infra downgrade, not a content
  // blocker, so it must NOT borrow BlockerBanner's alert/assertive token.
  it("uses role=status with aria-live=polite (warning channel, not blocker)", () => {
    render(<ModelFallbackBanner fromModel="Opus 4.7" toModel="Opus 4.8" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("renders a Dismiss action only when onDismiss is supplied", () => {
    const { rerender } = render(<ModelFallbackBanner fromModel="Opus 4.7" toModel="Opus 4.8" />);
    expect(screen.queryByRole("button", { name: /Dismiss/i })).not.toBeInTheDocument();

    const onDismiss = vi.fn();
    rerender(<ModelFallbackBanner fromModel="Opus 4.7" toModel="Opus 4.8" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  // Task 10 (a11y P7): the Dismiss action must be operable by keyboard, not
  // mouse-only. It's a native <button>, so Tab reaches it and Enter/Space fire
  // its onClick — this test pins that contract (a regression to a <div onClick>
  // would break keyboard activation and fail here).
  it("dismisses via keyboard: Tab to the Dismiss button and press Enter", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<ModelFallbackBanner fromModel="Opus 4.7" toModel="Opus 4.8" onDismiss={onDismiss} />);
    const dismiss = screen.getByRole("button", { name: /Dismiss/i });
    dismiss.focus();
    expect(dismiss).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <ModelFallbackBanner fromModel="Opus 4.7" toModel="Opus 4.8" reason="retired" onDismiss={() => {}} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
