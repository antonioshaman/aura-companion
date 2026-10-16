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
    // resume-interrupted items show the friendly label via the same
    // ResumeInterruptedNote a lone marker uses (council review, PR #370
    // P-WARN) — its own nested disclosure, collapsed by default.
    expect(rows[0]).toHaveTextContent("Turn interrupted (stopped or restarted)");
    expect(rows[0].querySelector('[data-testid="resume-interrupted-note"]')).toBeInTheDocument();
    // drift-recovery items show their own (already human-readable) content.
    expect(rows[1]).toHaveTextContent("Backend transcript 1813s behind CLI's jsonl — relaunching to recover.");
    expect(rows[1].querySelector('[data-testid="resume-interrupted-note"]')).toBeNull();
    // Each row carries a rendered timestamp.
    rows.forEach((row) => expect(row.textContent?.trim().length).toBeGreaterThan(0));
  });

  // Council review on PR #370 (P-WARN): collapsing a run of markers must not
  // throw away a resume-interrupted marker's own diagnostic (result_type,
  // stop_reason, …) — a lone marker lets you drill into it via
  // ResumeInterruptedNote, and the group must preserve that per-item.
  it("keeps each resume-interrupted marker's raw diagnostic reachable inside an expanded group (click)", () => {
    render(<CollapsedSystemMarkers items={ITEMS} />);
    fireEvent.click(screen.getByRole("button", { name: /Interrupted ×3/ }));

    const list = screen.getByTestId("collapsed-system-markers-list");
    const rows = list.querySelectorAll('[data-testid="collapsed-system-marker-item"]');
    const firstMarkerNote = rows[0].querySelector('[data-testid="resume-interrupted-note"]') as HTMLDetailsElement;
    expect(firstMarkerNote).toBeInTheDocument();
    expect(firstMarkerNote.open).toBe(false);

    fireEvent.click(firstMarkerNote.querySelector("summary")!);
    expect(firstMarkerNote.open).toBe(true);
    // The exact raw diagnostic for THIS marker (not a generic placeholder).
    expect(firstMarkerNote).toHaveTextContent(
      "Error: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
    );

    // The second resume-interrupted marker (rows[2]) stays independently
    // collapsed — expanding one marker's diagnostic must not expand siblings.
    const thirdMarkerNote = rows[2].querySelector('[data-testid="resume-interrupted-note"]') as HTMLDetailsElement;
    expect(thirdMarkerNote.open).toBe(false);
  });

  it("keeps a resume-interrupted marker's diagnostic keyboard-reachable inside an expanded group", async () => {
    // A native <summary> is keyboard-operable (Enter/Space) in every real
    // browser per the HTML spec — jsdom does not implement that UA-level
    // activation behaviour (verified empirically: userEvent.keyboard("{Enter}")
    // on a focused <summary> never flips jsdom's `details.open`, unlike a
    // real <button>). This test asserts what jsdom *can* prove about
    // keyboard access: the nested diagnostic toggle is not removed from the
    // tab order (no tabindex=-1 / inert) and is a genuinely focusable
    // element once the group is expanded — then, using the same
    // native-activation mechanism ResumeInterruptedNote's own single-marker
    // tests rely on, confirms activating it flips `open`.
    const user = userEvent.setup();
    render(<CollapsedSystemMarkers items={ITEMS} />);

    await user.click(screen.getByRole("button", { name: /Interrupted ×3/ }));
    const list = screen.getByTestId("collapsed-system-markers-list");
    const firstMarkerNote = list
      .querySelectorAll('[data-testid="collapsed-system-marker-item"]')[0]
      .querySelector('[data-testid="resume-interrupted-note"]') as HTMLDetailsElement;
    const innerSummary = firstMarkerNote.querySelector("summary") as HTMLElement;

    expect(innerSummary.getAttribute("tabindex")).not.toBe("-1");
    innerSummary.focus();
    expect(innerSummary).toHaveFocus();
    expect(firstMarkerNote.open).toBe(false);

    fireEvent.click(innerSummary);
    expect(firstMarkerNote.open).toBe(true);
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

  it("passes axe collapsed, group-expanded, and with a nested marker diagnostic expanded", async () => {
    const { container } = render(<CollapsedSystemMarkers items={ITEMS} />);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByRole("button", { name: /Interrupted ×3/ }));
    expect(await axe(container)).toHaveNoViolations();

    // Also expand one marker's own diagnostic disclosure — the nested
    // interactive structure (button containing a details/summary) must
    // still be axe-clean once the diagnostic itself is reachable.
    const firstMarkerNote = screen.getAllByTestId("resume-interrupted-note")[0] as HTMLDetailsElement;
    fireEvent.click(firstMarkerNote.querySelector("summary")!);
    expect(firstMarkerNote.open).toBe(true);
    expect(await axe(container)).toHaveNoViolations();
  });
});
