// @vitest-environment jsdom
/** A reproducible human-review fixture must itself preserve drafts and pass axe. */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { ChatAccessibilityDemo } from "./ChatAccessibilityDemo.js";
afterEach(() => vi.useRealTimers());
it("renders the idle review with all axe rules enabled", async () => {
  const { container } = render(<ChatAccessibilityDemo />);
  expect(screen.getByText("No reply yet.")).toBeTruthy();
  expect(await axe(container)).toHaveNoViolations();
});
it("streams a bounded demo while preserving the draft", () => {
  vi.useFakeTimers(); render(<ChatAccessibilityDemo />);
  fireEvent.change(screen.getByLabelText("Review draft"), { target: { value: "Keep me" } });
  fireEvent.click(screen.getByText("Simulate streamed reply"));
  act(() => vi.advanceTimersByTime(4000));
  expect(screen.getByText("A short streamed reply. Your draft keeps its focus.")).toBeTruthy();
  expect((screen.getByLabelText("Review draft") as HTMLInputElement).value).toBe("Keep me");
});
it("opens a named accessible dialog, traps Tab and restores focus on Escape", async () => {
  render(<ChatAccessibilityDemo />);
  const opener = screen.getByText("Test dialog keyboard"); opener.focus(); fireEvent.click(opener);
  const dialog = screen.getByRole("dialog"); expect(await axe(dialog)).toHaveNoViolations();
  const close = screen.getByText("Close review dialog"); close.focus(); fireEvent.keyDown(close, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByLabelText("Dialog test field"));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(opener);
  fireEvent.click(opener); fireEvent.click(screen.getByText("Close review dialog")); expect(screen.queryByRole("dialog")).toBeNull();
});
