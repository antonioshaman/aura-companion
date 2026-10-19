// @vitest-environment jsdom
/**
 * Tests for KnowledgeAnalysisSettings (diagnostics spec §3.2; plan Task 15).
 *
 * - Render + axe; inputs are found by their visible labels.
 * - Validation on blur, not per keystroke: clearing a field shows no error
 *   until it loses focus; an out-of-range value marks the field invalid with
 *   a message linked as its description, and calls nothing.
 * - A valid change calls back ONCE with the full trio (the server patches the
 *   object as a whole); an unchanged value calls nothing.
 * - The memory-report switch toggles via its switch role and states it is
 *   report-only.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KnowledgeAnalysisSettings } from "./KnowledgeAnalysisSettings.js";

const T = { newEntriesThreshold: 10, sessionsThreshold: 25, maxAgeDays: 14 };

function setup(over: Partial<Parameters<typeof KnowledgeAnalysisSettings>[0]> = {}) {
  const onThresholdsChange = vi.fn();
  const onMemoryReportChange = vi.fn();
  const r = render(
    <KnowledgeAnalysisSettings thresholds={T} memoryReport={false} onThresholdsChange={onThresholdsChange} onMemoryReportChange={onMemoryReportChange} {...over} />,
  );
  return { ...r, onThresholdsChange, onMemoryReportChange };
}

describe("KnowledgeAnalysisSettings", () => {
  it("renders labelled inputs and passes an axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = setup();
    expect(screen.getByLabelText("Finished sessions since the last run")).toHaveValue(25);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("validates on blur, not per keystroke, and links the message", async () => {
    const { onThresholdsChange, container } = setup();
    const input = screen.getByLabelText("Finished sessions since the last run");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText(/whole number/)).toBeNull();
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/Enter a whole number from 1 to 10000/);
    expect(onThresholdsChange).not.toHaveBeenCalled();
    const { axe } = await import("vitest-axe");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("a valid change sends the full trio once; an unchanged value sends nothing", () => {
    const { onThresholdsChange } = setup();
    const input = screen.getByLabelText("Maximum days between analyses");
    fireEvent.blur(input);
    expect(onThresholdsChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.blur(input);
    expect(onThresholdsChange).toHaveBeenCalledTimes(1);
    expect(onThresholdsChange).toHaveBeenCalledWith({ newEntriesThreshold: 10, sessionsThreshold: 25, maxAgeDays: 7 });
  });

  // Review abramov P2-3: another field's save must not clobber a half-typed value.
  it("keeps a half-typed field when another field's confirmed value changes", () => {
    const onThresholdsChange = vi.fn();
    const { rerender } = render(
      <KnowledgeAnalysisSettings thresholds={T} memoryReport={false} onThresholdsChange={onThresholdsChange} onMemoryReportChange={vi.fn()} />,
    );
    const sessions = screen.getByLabelText("Finished sessions since the last run");
    fireEvent.change(sessions, { target: { value: "4" } }); // typing, not blurred
    rerender(
      <KnowledgeAnalysisSettings
        thresholds={{ ...T, maxAgeDays: 7 }}
        memoryReport={false}
        onThresholdsChange={onThresholdsChange}
        onMemoryReportChange={vi.fn()}
      />,
    );
    expect(sessions).toHaveValue(4);
    expect(screen.getByLabelText("Maximum days between analyses")).toHaveValue(7);
  });

  it("toggles the report-only memory switch", () => {
    const { onMemoryReportChange } = setup();
    const sw = screen.getByRole("switch", { name: "Memory report on the Diagnostics page" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveAccessibleDescription(/nothing under the memory directory is ever written/);
    fireEvent.click(sw);
    expect(onMemoryReportChange).toHaveBeenCalledWith(true);
  });
});
