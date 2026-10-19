// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { UpdateAvailableBanner } from "./UpdateAvailableBanner.js";

describe("UpdateAvailableBanner", () => {
  it("renders the update notice", () => {
    render(<UpdateAvailableBanner onUpdate={() => {}} />);
    expect(screen.getByText(/A new version is available/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Update/i })).toBeInTheDocument();
  });

  // Info channel (not blocker): a fresh deploy is neutral, so it uses the
  // role=status + aria-live=polite recipe, never alert/assertive.
  it("uses role=status with aria-live=polite (info channel)", () => {
    render(<UpdateAvailableBanner onUpdate={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("fires onUpdate when Update is clicked", () => {
    const onUpdate = vi.fn();
    render(<UpdateAvailableBanner onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole("button", { name: /Update/i }));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("renders a Dismiss action only when onDismiss is supplied", () => {
    const { rerender } = render(<UpdateAvailableBanner onUpdate={() => {}} />);
    expect(screen.queryByRole("button", { name: /Dismiss/i })).not.toBeInTheDocument();

    const onDismiss = vi.fn();
    rerender(<UpdateAvailableBanner onUpdate={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  // Both actions are native <button>s, so Tab reaches them and Enter fires
  // their onClick — pins the keyboard-operability contract.
  it("updates via keyboard: focus Update and press Enter", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<UpdateAvailableBanner onUpdate={onUpdate} />);
    const update = screen.getByRole("button", { name: /Update/i });
    update.focus();
    expect(update).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<UpdateAvailableBanner onUpdate={() => {}} onDismiss={() => {}} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
