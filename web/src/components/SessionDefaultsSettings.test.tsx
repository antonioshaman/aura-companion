// @vitest-environment jsdom
/**
 * SessionDefaultsSettings — Settings block for the aura-diet defaults
 * (solo sessions by default, KB on demand). Validates render of both
 * controls, accessibility (axe), and that interactions call the controlled
 * callbacks with the right values — the component itself owns no state.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";
import * as matchers from "vitest-axe/matchers";
import { SessionDefaultsSettings } from "./SessionDefaultsSettings.js";

expect.extend(matchers);

function setup(overrides: Partial<Parameters<typeof SessionDefaultsSettings>[0]> = {}) {
  const props = {
    mode: "solo" as const,
    kbAutoPrime: false,
    onModeChange: vi.fn(),
    onKbAutoPrimeChange: vi.fn(),
    ...overrides,
  };
  const utils = render(<SessionDefaultsSettings {...props} />);
  return { ...utils, props };
}

describe("SessionDefaultsSettings", () => {
  it("renders the solo/off defaults", () => {
    // Defaults shipped by the server: solo + KB auto-load off.
    setup();
    expect(screen.getByRole("radio", { name: /Solo/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Council/ })).not.toBeChecked();
    const sw = screen.getByRole("switch", { name: "Load knowledge base at session start" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveTextContent("Off");
  });

  it("explains when council is worth it and its cost", () => {
    setup();
    expect(screen.getByRole("radio", { name: /Council/ }).closest("label")).toHaveTextContent(
      /payments, auth, DB migrations/,
    );
    expect(screen.getByRole("radio", { name: /Council/ }).closest("label")).toHaveTextContent(/2–3×/);
  });

  it("calls onModeChange with 'council' when the Council option is picked", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("radio", { name: /Council/ }));
    expect(props.onModeChange).toHaveBeenCalledWith("council");
  });

  it("calls onModeChange with 'solo' when switching back from council", () => {
    const { props } = setup({ mode: "council" });
    expect(screen.getByRole("radio", { name: /Council/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Solo/ }));
    expect(props.onModeChange).toHaveBeenCalledWith("solo");
  });

  it("toggles KB auto-load via the switch (off → on, on → off)", () => {
    const { props, rerender } = setup();
    const sw = screen.getByRole("switch", { name: "Load knowledge base at session start" });
    fireEvent.click(sw);
    expect(props.onKbAutoPrimeChange).toHaveBeenLastCalledWith(true);
    rerender(<SessionDefaultsSettings {...props} kbAutoPrime={true} />);
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(props.onKbAutoPrimeChange).toHaveBeenLastCalledWith(false);
  });

  it("disables all controls while loading", () => {
    // `disabled` must stop both inputs so a click during load can't race
    // the initial settings fetch.
    const { props } = setup({ disabled: true });
    expect(screen.getByRole("radio", { name: /Council/ })).toBeDisabled();
    const sw = screen.getByRole("switch", { name: "Load knowledge base at session start" });
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(props.onKbAutoPrimeChange).not.toHaveBeenCalled();
  });

  it("passes accessibility scan (defaults)", async () => {
    const { container } = setup();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("passes accessibility scan (council + KB on)", async () => {
    const { container } = setup({ mode: "council", kbAutoPrime: true });
    expect(await axe(container)).toHaveNoViolations();
  });
});
