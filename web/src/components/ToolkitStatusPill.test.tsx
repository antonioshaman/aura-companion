// @vitest-environment jsdom
/**
 * ToolkitStatusPill — the TopBar label for a session that wanted the UI/UX
 * toolkit but could not get it (PLAN Task 7). Only "unavailable" renders; the
 * reason is on hover and read to screen readers. Also axe.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";
import * as matchers from "vitest-axe/matchers";
import { ToolkitStatusPill } from "./ToolkitStatusPill.js";

expect.extend(matchers);

describe("ToolkitStatusPill", () => {
  it("renders the label with its reason when the toolkit is unavailable", () => {
    render(<ToolkitStatusPill exposure={{ status: "unavailable", reason: "the installed Claude Code CLI does not support --plugin-dir" }} />);
    const pill = screen.getByTestId("toolkit-status-pill");
    expect(pill).toHaveTextContent("Toolkit unavailable");
    expect(pill).toHaveAttribute("title", "the installed Claude Code CLI does not support --plugin-dir");
    expect(screen.getByText(/does not support --plugin-dir/)).toHaveClass("sr-only");
  });

  // Observer STOP: decided "on" but the spawn could not deliver it → still labelled.
  it("labels a session whose toolkit delivery failed even though the decision was on", () => {
    render(<ToolkitStatusPill exposure={{ status: "on", deliveryError: "version 0123: SKILL.md differs" }} />);
    expect(screen.getByTestId("toolkit-status-pill")).toHaveAttribute("title", "version 0123: SKILL.md differs");
  });

  // Observer WARN: the label must not be hidden on narrow (mobile) screens.
  it("is visible at every breakpoint", () => {
    render(<ToolkitStatusPill exposure={{ status: "unavailable", reason: "container" }} />);
    expect(screen.getByTestId("toolkit-status-pill").className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("renders nothing for on, off, or a session without a decision", () => {
    for (const exposure of [{ status: "on" as const }, { status: "off" as const }, undefined]) {
      const { container, unmount } = render(<ToolkitStatusPill exposure={exposure} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("has no axe violations", async () => {
    const { container } = render(<ToolkitStatusPill exposure={{ status: "unavailable", reason: "container" }} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
