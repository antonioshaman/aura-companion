// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// W15 multi-model review — per-pair second-opinion control in the
// ObserverPanel. It must not hit the network until opened, then load the
// pair's effective setting and save changes for THIS pair.

const getGroupSecondReviewer = vi.fn();
const setGroupSecondReviewer = vi.fn();
vi.mock("../../api.js", () => ({
  api: {
    getGroupSecondReviewer: (...a: unknown[]) => getGroupSecondReviewer(...a),
    setGroupSecondReviewer: (...a: unknown[]) => setGroupSecondReviewer(...a),
  },
}));

import { GroupSecondReviewerControl, summarizeSecondReviewer } from "./GroupSecondReviewerControl.js";

function open(container: HTMLElement) {
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

beforeEach(() => {
  getGroupSecondReviewer.mockReset();
  setGroupSecondReviewer.mockReset();
});

describe("GroupSecondReviewerControl", () => {
  it("renders collapsed without loading anything", () => {
    render(<GroupSecondReviewerControl sessionGroupId="grp_1" />);
    expect(screen.getByText("Second opinion")).toBeInTheDocument();
    expect(getGroupSecondReviewer).not.toHaveBeenCalled();
  });

  it("loads on open, shows the source, and saves a change for this pair", async () => {
    getGroupSecondReviewer.mockResolvedValue({ reviewer: "off", scope: "review-implement", source: "global" });
    setGroupSecondReviewer.mockResolvedValue({ reviewer: "auto", scope: "review-implement", source: "group" });
    const { container } = render(<GroupSecondReviewerControl sessionGroupId="grp_1" />);
    open(container);
    await waitFor(() => expect(screen.getByTestId("group-second-reviewer-summary")).toHaveTextContent("off (default)"));
    expect(getGroupSecondReviewer).toHaveBeenCalledWith("grp_1");

    fireEvent.change(screen.getByLabelText("Council second opinion"), { target: { value: "auto" } });
    await waitFor(() => expect(setGroupSecondReviewer).toHaveBeenCalledWith("grp_1", { reviewer: "auto", scope: "review-implement" }));
    await waitFor(() => expect(screen.getByTestId("group-second-reviewer-summary")).toHaveTextContent("auto"));
    expect(screen.getByTestId("group-second-reviewer-summary")).not.toHaveTextContent("(default)");
  });

  it("shows an error with a retry when loading fails", async () => {
    getGroupSecondReviewer.mockRejectedValueOnce(new Error("404"));
    const { container } = render(<GroupSecondReviewerControl sessionGroupId="grp_1" />);
    open(container);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("404"));
    getGroupSecondReviewer.mockResolvedValue({ reviewer: "auto", scope: "all", source: "group" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("group-second-reviewer-summary")).toHaveTextContent("auto"));
  });

  it("summarizes settings compactly", () => {
    expect(summarizeSecondReviewer({ reviewer: { backend: "claude", model: "sonnet" }, scope: "all" })).toBe("claude · sonnet");
    expect(summarizeSecondReviewer({ reviewer: { backend: "codex" }, scope: "all" })).toBe("codex · default model");
  });

  it("passes accessibility scan when open", async () => {
    getGroupSecondReviewer.mockResolvedValue({ reviewer: "auto", scope: "review-implement", source: "group" });
    const { axe } = await import("vitest-axe");
    const { container } = render(<GroupSecondReviewerControl sessionGroupId="grp_1" />);
    open(container);
    await waitFor(() => expect(screen.getByLabelText("Council second opinion")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});
