// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Mock markdown renderer used by MessageBubble/PermissionBanner
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({
  default: {},
}));

import { Playground } from "./Playground.js";

describe("Playground", () => {
  it("renders the real chat stack section with integrated chat components", () => {
    render(<Playground />);

    expect(screen.getByText("Component Playground")).toBeTruthy();
    expect(screen.getByText("Real Chat Stack")).toBeTruthy();

    const realChat = screen.getByTestId("playground-real-chat-stack");
    expect(realChat).toBeTruthy();

    // Dynamic tool permission should be visible inside the integrated ChatView.
    expect(within(realChat).getByText("dynamic:code_interpreter")).toBeTruthy();

    // Subagent playground demo should show Codex-specific metadata presentation.
    expect(screen.getByText("sender: thr_main")).toBeTruthy();
    expect(screen.getByText("thr_sub_1")).toBeTruthy();

    // Interesting event states should be represented in the playground.
    expect(screen.getByText("Interesting Events")).toBeTruthy();
    expect(screen.getByText("Context compacted (auto, pre-tokens: 182344).")).toBeTruthy();
    expect(screen.getByText("Hook success: lint (post_tool_use) (exit 0).")).toBeTruthy();
  });
});

// The rendered a11y scan of #/playground (2026-10-28) found unnamed switches in
// the panel-settings mock and unlabelled textareas in the composer mocks.
// Agents copy these mocks, so every switch and text field must carry a name.
describe("Playground accessible names", () => {
  it("every switch and text field has an accessible name", () => {
    render(<Playground />);
    const unnamed = [...screen.getAllByRole("switch"), ...screen.getAllByRole("textbox")]
      .filter((el) => {
        // aria-labelledby counts only when every referenced element exists and has text.
        const by = el.getAttribute("aria-labelledby");
        const byOk = !!by && by.split(/\s+/).every((id) => (document.getElementById(id)?.textContent ?? "").trim() !== "");
        return !(el.getAttribute("aria-label")?.trim() || byOk || el.getAttribute("title")?.trim()
          || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest("label"));
      })
      .map((el) => el.outerHTML.slice(0, 80));
    expect(unnamed).toEqual([]);
  });

  // Observer WARN (checkpoint council-implement-191): a modified component needs
  // an axe scan, not only a name check (CLAUDE.md triad). jsdom has no layout,
  // so layout rules (contrast, scrollable regions) are covered by the rendered
  // scan (web/scripts/a11y-scan.ts), not here.
  it("passes axe", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<Playground />);
    // landmark-unique is off because the Playground shows several states of the
    // same component side by side (ObserverPanel, checkpoint coverage, budget
    // notice), so their landmarks repeat; in the app each renders once. It is a
    // best-practice rule, not a WCAG criterion.
    expect(await axe(container, { rules: { "landmark-unique": { enabled: false } } })).toHaveNoViolations();
  }, 60_000);
});

// aura-check uiux.native-alert (baseline 2026-10-28, ruling accepted → fixed):
// demo actions report in an on-page status line instead of a blocking
// window.alert, which steals focus and cannot be styled or announced politely.
describe("Playground demo actions", () => {
  it("suggestion chips and badge dismiss report in a status line, never window.alert", () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Playground />);
    fireEvent.click(screen.getByRole("button", { name: "Fix the failing test" }));
    expect(screen.getByText("Selected: Fix the failing test")).toBeTruthy();
    expect(screen.getByText("Selected: Fix the failing test").closest('[role="status"]')).not.toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /dismiss/i })[0]);
    expect(screen.getByText("Dismissed")).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  }, 60_000); // the full Playground renders in ~6s under jsdom
});
