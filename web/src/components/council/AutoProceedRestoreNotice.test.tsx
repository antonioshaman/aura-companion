// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AutoProceedRestoreNotice } from "./AutoProceedRestoreNotice.js";

// FIX-AP-4: auto-proceed paused by an incomplete STOP-hold restore used to be
// invisible (no finding, no banner). The notice names the problem, lists each
// gap with its reason, and offers "Ignore this file" only where the server
// said the gap is ignorable (a review file with a content fingerprint).

const fileGap = {
  gap: "review_unparseable:phase-3-claude-observer.md",
  reason: "review file is not a valid review for this pair (unparseable or legacy format)",
  file: "phase-3-claude-observer.md",
  fingerprint: "0".repeat(64),
};
const verdictsGap = { gap: "verdicts_invalid-json", reason: "the review verdicts file is not valid JSON" };

describe("AutoProceedRestoreNotice", () => {
  it("renders nothing without gaps", () => {
    const { container } = render(<AutoProceedRestoreNotice gaps={[]} onIgnore={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the pause and lists every gap with its reason", () => {
    render(<AutoProceedRestoreNotice gaps={[fileGap, verdictsGap]} onIgnore={() => {}} />);
    expect(screen.getByRole("region", { name: "Auto-proceed paused: restore incomplete" })).toBeInTheDocument();
    expect(screen.getAllByTestId("auto-proceed-restore-gap")).toHaveLength(2);
    expect(screen.getByText("phase-3-claude-observer.md")).toBeInTheDocument();
    expect(screen.getByText(/legacy format/)).toBeInTheDocument();
    expect(screen.getByText("the review verdicts file is not valid JSON")).toBeInTheDocument();
  });

  it("offers Ignore only for ignorable gaps and passes the gap back on click", () => {
    const onIgnore = vi.fn();
    render(<AutoProceedRestoreNotice gaps={[fileGap, verdictsGap]} onIgnore={onIgnore} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Ignore phase-3-claude-observer.md for auto-proceed" }));
    expect(onIgnore).toHaveBeenCalledWith(fileGap);
  });

  it("a file gap without a fingerprint is shown but not ignorable", () => {
    const { fingerprint: _fp, ...unknownContent } = fileGap;
    render(<AutoProceedRestoreNotice gaps={[unknownContent]} onIgnore={() => {}} />);
    expect(screen.getByText("phase-3-claude-observer.md")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AutoProceedRestoreNotice gaps={[fileGap, verdictsGap]} onIgnore={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
