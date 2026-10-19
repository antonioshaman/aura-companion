// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SecondReviewerSettings, secondReviewerFromChoice } from "./SecondReviewerSettings.js";

// W15 multi-model review — the second-opinion picker used for the global
// default (Settings) and per pair (ObserverPanel). Controlled: every change is
// reported through onChange; the model field commits on blur/Enter only.

describe("secondReviewerFromChoice", () => {
  it("maps choices to the wire setting; an empty model means the CLI default", () => {
    expect(secondReviewerFromChoice("off", "x")).toBe("off");
    expect(secondReviewerFromChoice("auto", "x")).toBe("auto");
    expect(secondReviewerFromChoice("claude", "  ")).toEqual({ backend: "claude" });
    expect(secondReviewerFromChoice("codex", " gpt-6.1-sol ")).toEqual({ backend: "codex", model: "gpt-6.1-sol" });
  });
});

describe("SecondReviewerSettings", () => {
  it("renders the current choice; scope and model are hidden while off", () => {
    render(<SecondReviewerSettings value={{ reviewer: "off", scope: "review-implement" }} onChange={() => {}} />);
    expect(screen.getByLabelText("Council second opinion")).toHaveValue("off");
    expect(screen.queryByText("Which checkpoints")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Model/)).not.toBeInTheDocument();
  });

  it("switching to Auto reports the new setting", () => {
    const onChange = vi.fn();
    render(<SecondReviewerSettings value={{ reviewer: "off", scope: "review-implement" }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Council second opinion"), { target: { value: "auto" } });
    expect(onChange).toHaveBeenCalledWith({ reviewer: "auto", scope: "review-implement" });
  });

  it("an explicit backend shows a model field that commits on blur, not per keystroke", () => {
    const onChange = vi.fn();
    render(<SecondReviewerSettings value={{ reviewer: { backend: "claude" }, scope: "review-implement" }} onChange={onChange} />);
    const model = screen.getByLabelText(/Model/);
    fireEvent.change(model, { target: { value: "sonnet" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(model);
    expect(onChange).toHaveBeenCalledWith({ reviewer: { backend: "claude", model: "sonnet" }, scope: "review-implement" });
  });

  it("changing the scope reports it", () => {
    const onChange = vi.fn();
    render(<SecondReviewerSettings value={{ reviewer: "auto", scope: "review-implement" }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/Every checkpoint/));
    expect(onChange).toHaveBeenCalledWith({ reviewer: "auto", scope: "all" });
  });

  it("passes accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <SecondReviewerSettings value={{ reviewer: { backend: "codex", model: "gpt-6.1-sol" }, scope: "all" }} onChange={() => {}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
