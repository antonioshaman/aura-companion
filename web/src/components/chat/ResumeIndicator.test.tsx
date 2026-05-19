// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";

import { ResumeIndicator } from "./ResumeIndicator.js";

const baseProps = {
  canLoadResumeHistory: true,
  resumeHistoryLoaded: false,
  resumeModeLabel: "Resuming",
  resumeSourceSessionId: "abc12345-9c80-4f5e-91b3-deadbeef0000",
  sdkSessionCwd: "/Users/skolte/repo/aura-companion",
  resumeHistoryLoading: false,
  resumeHistoryError: "",
  resumeHistoryHasMore: false,
  onLoadResumeHistory: vi.fn(),
};

describe("ResumeIndicator", () => {
  it("renders nothing when canLoadResumeHistory is false", () => {
    // Top-level gate — when the session isn't a resume/fork the banner must
    // not occupy any DOM slot at all (no empty wrapper, no aria-hidden div).
    const { container } = render(<ResumeIndicator {...baseProps} canLoadResumeHistory={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the CTA card with mode label, source id, and last-two-segments cwd before load", () => {
    // Pre-load variant: shows the source identity + clickable Load button.
    // The cwd display is the last two path segments — guards against a
    // regression where the full absolute path leaks into the UI.
    render(<ResumeIndicator {...baseProps} />);
    expect(screen.getByTestId("resume-indicator-cta")).toBeInTheDocument();
    expect(screen.getByText(/Resuming existing Claude thread/)).toBeInTheDocument();
    expect(screen.getByText(/abc12345-9c80-4f5e-91b3-deadbeef0000/)).toBeInTheDocument();
    expect(screen.getByText(/repo\/aura-companion/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Load previous history/ })).toBeEnabled();
  });

  it("disables the Load button and swaps label while loading", () => {
    // The button must be disabled mid-flight to prevent double-Load races
    // and the copy must reflect the loading state.
    render(<ResumeIndicator {...baseProps} resumeHistoryLoading={true} />);
    const btn = screen.getByRole("button", { name: /Loading\.\.\./ });
    expect(btn).toBeDisabled();
  });

  it("surfaces the resume history error with role=alert", () => {
    // Error text must be exposed to assistive tech (role=alert) — silent
    // error rendering was a previous a11y gap.
    render(<ResumeIndicator {...baseProps} resumeHistoryError="Network failed" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Network failed");
  });

  it("fires onLoadResumeHistory exactly once when the button is clicked", () => {
    // Behavioural assertion paired with the disabled-while-loading guard
    // above: a single click yields a single dispatch.
    const onLoad = vi.fn();
    render(<ResumeIndicator {...baseProps} onLoadResumeHistory={onLoad} />);
    fireEvent.click(screen.getByRole("button", { name: /Load previous history/ }));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("renders the progress text after load, distinguishing has-more vs exhausted vs loading-older", () => {
    // Post-load variant has three distinct copy strings; each maps to a
    // different (resumeHistoryHasMore, resumeHistoryLoading) pair.
    const { rerender } = render(
      <ResumeIndicator
        {...baseProps}
        resumeHistoryLoaded={true}
        resumeHistoryHasMore={true}
        resumeHistoryLoading={false}
      />,
    );
    expect(screen.getByTestId("resume-indicator-progress")).toHaveTextContent(
      /Scroll to top to load older transcript/,
    );

    rerender(
      <ResumeIndicator
        {...baseProps}
        resumeHistoryLoaded={true}
        resumeHistoryHasMore={true}
        resumeHistoryLoading={true}
      />,
    );
    expect(screen.getByTestId("resume-indicator-progress")).toHaveTextContent(
      /Loading older transcript\.\.\./,
    );

    rerender(
      <ResumeIndicator
        {...baseProps}
        resumeHistoryLoaded={true}
        resumeHistoryHasMore={false}
        resumeHistoryLoading={false}
      />,
    );
    expect(screen.getByTestId("resume-indicator-progress")).toHaveTextContent(
      /Loaded all available prior transcript/,
    );
  });

  it("omits the cwd separator when sdkSessionCwd is undefined", () => {
    // No cwd → just the session id, no trailing "·". Avoids a stray glyph.
    render(<ResumeIndicator {...baseProps} sdkSessionCwd={undefined} />);
    const idLine = screen.getByText(/abc12345-9c80-4f5e-91b3-deadbeef0000/);
    expect(idLine.textContent ?? "").not.toMatch(/·/);
  });

  it("passes axe accessibility checks in CTA, error, and progress states", async () => {
    const cta = render(<ResumeIndicator {...baseProps} />);
    expect(await axe(cta.container)).toHaveNoViolations();
    cta.unmount();

    const err = render(<ResumeIndicator {...baseProps} resumeHistoryError="Network failed" />);
    expect(await axe(err.container)).toHaveNoViolations();
    err.unmount();

    const prog = render(
      <ResumeIndicator
        {...baseProps}
        resumeHistoryLoaded={true}
        resumeHistoryHasMore={true}
      />,
    );
    expect(await axe(prog.container)).toHaveNoViolations();
  });
});
