// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";

import { CollapsedSystemMarkers, type CollapsedSystemMarkerItem } from "./CollapsedSystemMarkers.js";

const ITEMS: CollapsedSystemMarkerItem[] = [
  {
    id: "m1",
    content: "Error: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
    timestamp: new Date("2026-10-15T10:00:00Z").getTime(),
    systemVariant: "resume-interrupted",
  },
  {
    id: "m2",
    content: "Backend transcript 1813s behind CLI's jsonl — relaunching to recover.",
    timestamp: new Date("2026-10-15T10:05:00Z").getTime(),
    systemVariant: "drift-recovery",
  },
  {
    id: "m3",
    content: "Error: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
    timestamp: new Date("2026-10-15T10:06:00Z").getTime(),
    systemVariant: "resume-interrupted",
  },
];

describe("CollapsedSystemMarkers", () => {
  it("renders collapsed by default with a count in the summary row", () => {
    render(<CollapsedSystemMarkers items={ITEMS} />);
    expect(screen.getByTestId("collapsed-system-markers")).toBeInTheDocument();
    expect(screen.getByText(/Interrupted/)).toHaveTextContent("Interrupted ×3");
    // The expanded list is not in the DOM at all while collapsed.
    expect(screen.queryByTestId("collapsed-system-markers-list")).not.toBeInTheDocument();
  });

  it("exposes the toggle as a button with aria-expanded reflecting the collapsed/open state", () => {
    render(<CollapsedSystemMarkers items={ITEMS} />);
    const toggle = screen.getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("expands to show every individual marker with its own timestamp on click", () => {
    render(<CollapsedSystemMarkers items={ITEMS} />);
    fireEvent.click(screen.getByRole("button"));

    const toggle = screen.getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByTestId("collapsed-system-markers-list");
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(3);
    // resume-interrupted items show the friendly label, not the raw diagnostic.
    expect(rows[0]).toHaveTextContent("Turn interrupted (stopped or restarted)");
    expect(rows[0]).not.toHaveTextContent("ede_diagnostic");
    // drift-recovery items show their own (already human-readable) content.
    expect(rows[1]).toHaveTextContent("Backend transcript 1813s behind CLI's jsonl — relaunching to recover.");
    // Each row carries a rendered timestamp.
    rows.forEach((row) => expect(row.textContent?.trim().length).toBeGreaterThan(0));
  });

  it("collapses again on a second click (toggle, not one-way expand)", () => {
    render(<CollapsedSystemMarkers items={ITEMS} />);
    const toggle = screen.getByRole("button");
    fireEvent.click(toggle);
    expect(screen.getByTestId("collapsed-system-markers-list")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("collapsed-system-markers-list")).not.toBeInTheDocument();
  });

  it("toggles via the keyboard (Tab to focus, then Enter) since the toggle is a real button", async () => {
    const user = userEvent.setup();
    render(<CollapsedSystemMarkers items={ITEMS} />);
    const toggle = screen.getByRole("button");

    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("collapsed-system-markers-list")).toBeInTheDocument();

    // Space also activates a native button.
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("passes axe both collapsed and expanded", async () => {
    const { container } = render(<CollapsedSystemMarkers items={ITEMS} />);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByRole("button"));
    expect(await axe(container)).toHaveNoViolations();
  });
});
