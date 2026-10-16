// @vitest-environment jsdom
/**
 * AutoResumeBanner — the in-session "Лимит до HH:MM — автопродолжение в HH:MM
 * [Отменить]" notice for a scheduled usage-limit auto-resume.
 *
 * Validates: the copy renders both times in local HH:MM; a date is added when
 * the moment is not today (weekly limits); the unknown-reset fallback copy
 * does not invent a reset time; the cancel button calls back and is disabled
 * while cancelling; axe accessibility scan.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";
import * as matchers from "vitest-axe/matchers";
import { AutoResumeBanner } from "./AutoResumeBanner.js";

expect.extend(matchers);

// Local-time anchors (the component formats in the browser's zone).
const NOW = new Date(2026, 9, 16, 10, 0).getTime();
const RESET = new Date(2026, 9, 16, 15, 0).getTime();
const FIRE = new Date(2026, 9, 16, 15, 1, 30).getTime();

describe("AutoResumeBanner", () => {
  it("renders 'Лимит до 15:00 — автопродолжение в 15:01'", () => {
    render(<AutoResumeBanner resetAt={RESET} fireAt={FIRE} onCancel={() => {}} now={NOW} />);
    expect(screen.getByTestId("auto-resume-banner")).toHaveTextContent("Лимит до 15:00 — автопродолжение в 15:01");
    expect(screen.getByRole("button", { name: "Отменить" })).toBeInTheDocument();
  });

  it("adds the date when the reset is not today (weekly limit)", () => {
    const reset = new Date(2026, 9, 21, 9, 0).getTime();
    const fire = new Date(2026, 9, 21, 9, 2).getTime();
    render(<AutoResumeBanner resetAt={reset} fireAt={fire} onCancel={() => {}} now={NOW} />);
    const text = screen.getByTestId("auto-resume-banner").textContent ?? "";
    expect(text).toContain("21");
    expect(text).toContain("09:00");
    expect(text).toContain("09:02");
  });

  it("fallback (reset time unknown) says so instead of showing a reset time", () => {
    render(<AutoResumeBanner resetAt={RESET} fireAt={FIRE} resetSource="fallback" onCancel={() => {}} now={NOW} />);
    const banner = screen.getByTestId("auto-resume-banner");
    expect(banner).toHaveTextContent("время сброса неизвестно — автопродолжение в 15:01");
    expect(banner).not.toHaveTextContent("Лимит до");
  });

  it("calls onCancel when 'Отменить' is clicked", () => {
    const onCancel = vi.fn();
    render(<AutoResumeBanner resetAt={RESET} fireAt={FIRE} onCancel={onCancel} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables the cancel button while cancelling", () => {
    const onCancel = vi.fn();
    render(<AutoResumeBanner resetAt={RESET} fireAt={FIRE} onCancel={onCancel} cancelling now={NOW} />);
    const btn = screen.getByRole("button", { name: "Отменить" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("passes accessibility scan", async () => {
    const { container } = render(<AutoResumeBanner resetAt={RESET} fireAt={FIRE} onCancel={() => {}} now={NOW} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
