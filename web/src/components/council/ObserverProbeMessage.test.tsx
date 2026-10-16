// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ObserverProbeMessage } from "./ObserverProbeMessage.js";

// Observer rigor (2026-10-16): prod 2026-10-15 — the observer's reply to a
// liveness probe ("Я Observer…") showed up as prose between its findings
// cards. Probe traffic renders as this collapsed row instead.
const REPLY = "Я Observer, независимый ревьюер Council; содержимое .council/ после перезапуска ещё не видел.";

describe("ObserverProbeMessage", () => {
  it("renders a collapsed, labelled probe row with a one-line preview", () => {
    render(<ObserverProbeMessage role="assistant" text={REPLY} />);
    const row = screen.getByTestId("observer-probe-message");
    expect(row).toHaveAttribute("data-role", "assistant");
    expect(row).toHaveTextContent("Ответ на пробу");
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("labels the probe itself differently", () => {
    render(<ObserverProbeMessage role="user" text="[liveness probe] кто ты?" />);
    expect(screen.getByTestId("observer-probe-message")).toHaveTextContent("Проба связи");
  });

  it("expands to the full text on click and collapses again", () => {
    const long = `${REPLY} ${"ещё текст ".repeat(20)}конец`;
    render(<ObserverProbeMessage role="assistant" text={long} />);
    expect(screen.queryByText(/конец$/)).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/конец$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("passes axe accessibility scan (collapsed and expanded)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ObserverProbeMessage role="assistant" text={REPLY} />);
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button"));
    expect(await axe(container)).toHaveNoViolations();
  });
});
