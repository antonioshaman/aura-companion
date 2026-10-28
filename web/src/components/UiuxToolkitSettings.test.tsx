// @vitest-environment jsdom
/**
 * UiuxToolkitSettings — the Settings "UI/UX toolkit" row (PLAN Task 8).
 * Validates: the switch renders and toggles through the controlled callback;
 * the skill list shows what a new Claude Code / Codex session would get,
 * including the user's own skill winning and the muted "Requires Claude Code"
 * tag for Codex; the loading / error / not-installed states; axe on each.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";
import * as matchers from "vitest-axe/matchers";
import { UiuxToolkitSettings } from "./UiuxToolkitSettings.js";
import type { ToolkitView } from "../api.js";

expect.extend(matchers);

const item = (name: string, outcome: ToolkitView["rows"][number]["claude"]["outcome"], reasons: string[] = []) => ({ name, outcome, reasons });

const VIEW: ToolkitView = {
  installed: true,
  version: "0123456789abcdef",
  rows: [
    { name: "taste-skill", kind: "skill", claude: item("taste-skill", "provide"), codex: item("taste-skill", "provide") },
    { name: "council-plan", kind: "skill", claude: item("council-plan", "skip-user-owns", ["the user's skill \"council-plan\" has this name"]), codex: item("council-plan", "requires-claude", ["Task tool; not verified under Codex."]) },
    { name: "ui-ux-pro-max", kind: "skill", claude: item("ui-ux-pro-max", "blocked-by-gate", ["knownIssues: CLAUDE_PLUGIN_ROOT"]), codex: item("ui-ux-pro-max", "blocked-by-gate") },
  ],
};

function setup(overrides: Partial<Parameters<typeof UiuxToolkitSettings>[0]> = {}) {
  const props = { enabled: true, onEnabledChange: vi.fn(), view: VIEW as Parameters<typeof UiuxToolkitSettings>[0]["view"], ...overrides };
  return { ...render(<UiuxToolkitSettings {...props} />), props };
}

describe("UiuxToolkitSettings", () => {
  it("renders the switch on and says it applies to new sessions", () => {
    setup();
    const sw = screen.getByRole("switch", { name: "UI/UX toolkit" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(sw).toHaveTextContent("On");
    expect(screen.getByText(/Applies to new sessions/)).toBeInTheDocument();
  });

  it("toggling calls back with the inverted value (component owns no state)", () => {
    const { props } = setup({ enabled: false });
    fireEvent.click(screen.getByRole("switch", { name: "UI/UX toolkit" }));
    expect(props.onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("the switch is inert while disabled", () => {
    const { props } = setup({ disabled: true });
    const sw = screen.getByRole("switch", { name: "UI/UX toolkit" });
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(props.onEnabledChange).not.toHaveBeenCalled();
  });

  it("lists every skill with its per-CLI outcome, incl. user override and the Codex label", () => {
    setup();
    const list = screen.getByRole("list", { name: "Toolkit skills" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    const council = rows[1];
    expect(council).toHaveTextContent("council-plan");
    expect(council).toHaveTextContent("Your skill is used");
    // Muted information tag, with the manifest's reason on hover.
    const tag = within(council).getByText("Requires Claude Code");
    expect(tag).toHaveAttribute("title", "Task tool; not verified under Codex.");
    expect(rows[2]).toHaveTextContent("Not shipped");
    // Screen readers hear which CLI each status belongs to.
    expect(within(rows[0]).getByText(/Claude Code:/)).toHaveClass("sr-only");
  });

  it("shows loading, load-error and not-installed states instead of an empty list", () => {
    const { rerender } = setup({ view: null });
    expect(screen.getByText(/Loading the skill list/)).toBeInTheDocument();
    rerender(<UiuxToolkitSettings enabled onEnabledChange={vi.fn()} view={{ loadError: "HTTP 500" }} />);
    expect(screen.getByText(/Could not load the skill list: HTTP 500/)).toBeInTheDocument();
    rerender(<UiuxToolkitSettings enabled onEnabledChange={vi.fn()} view={{ installed: false, error: "no valid current.json", rows: [] }} />);
    expect(screen.getByText(/not installed on this server \(no valid current.json\)/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("names why Claude sessions cannot get it when the CLI lacks --plugin-dir", () => {
    setup({ view: { ...VIEW, claudeUnavailable: "the installed Claude Code CLI does not support --plugin-dir" } });
    expect(screen.getByText(/Claude Code sessions: unavailable/)).toBeInTheDocument();
  });

  it("has no axe violations (list, on)", async () => {
    const { container } = setup();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations (off, not installed)", async () => {
    const { container } = setup({ enabled: false, view: { installed: false, error: "x", rows: [] } });
    expect(await axe(container)).toHaveNoViolations();
  });
});
