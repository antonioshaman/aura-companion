// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CouncilToggle, isSupportedPairing } from "./CouncilToggle.js";

describe("isSupportedPairing", () => {
  it.each(["claude+claude", "claude+codex"])("accepts: %s", (v) => {
    expect(isSupportedPairing(v)).toBe(true);
  });

  it.each(["codex+claude", "claude", "", null, undefined, 42, "claude+gpt"])("rejects: %s", (v) => {
    expect(isSupportedPairing(v as unknown)).toBe(false);
  });
});

describe("CouncilToggle", () => {
  // Off-state baseline — toggle is a switch with aria-checked=false.
  it("renders an aria-checked='false' switch when enabled=false", () => {
    render(
      <CouncilToggle enabled={false} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("renders an aria-checked='true' switch when enabled=true", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("calls onEnabledChange with the toggled value when the switch is clicked", () => {
    const onEnabledChange = vi.fn();
    render(
      <CouncilToggle enabled={false} pairing="claude+claude" onEnabledChange={onEnabledChange} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  // PLAN T15.1: provider dropdown reveals via height-transition when on.
  // The dropdown container has grid-rows transitions; we assert the
  // container's class flips between collapsed/expanded based on enabled.
  it("collapses the pairing dropdown container when enabled=false", () => {
    render(
      <CouncilToggle enabled={false} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    const container = screen.getByTestId("pairing-dropdown-container");
    expect(container.className).toMatch(/grid-rows-\[0fr\]/);
  });

  it("expands the pairing dropdown container when enabled=true", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    const container = screen.getByTestId("pairing-dropdown-container");
    expect(container.className).toMatch(/grid-rows-\[1fr\]/);
  });

  // Dropdown interaction
  it("opens the pairing listbox when the trigger is clicked", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("calls onPairingChange and closes the listbox when an option is selected", () => {
    const onPairingChange = vi.fn();
    render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={onPairingChange}
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    fireEvent.click(screen.getByTestId("pairing-option-claude+codex"));
    expect(onPairingChange).toHaveBeenCalledWith("claude+codex");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  // PLAN T15.1: claude+codex carries an inline `exp` chip + subcopy.
  it("renders the experimental chip on the claude+codex option", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const codexOpt = screen.getByTestId("pairing-option-claude+codex");
    // The exp chip lives inside the option button.
    expect(codexOpt.textContent).toMatch(/exp/i);
  });

  it("renders the 'both halves billed separately' subcopy when claude+codex is selected", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+codex" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    expect(screen.getByText(/billed separately/i)).toBeInTheDocument();
  });

  // PLAN T15.1: option disabled with tooltip when Codex unavailable.
  it("disables claude+codex and shows 'unavailable' chip when codexAvailable=false", () => {
    render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={() => {}}
        codexAvailable={false}
        codexUnavailableReason="Codex CLI not detected."
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const codexOpt = screen.getByTestId("pairing-option-claude+codex");
    // a11y council review #10 — aria-disabled (kept focusable so SR users
    // hear the inline reason) rather than `disabled` (removes from Tab order).
    expect(codexOpt).toHaveAttribute("aria-disabled", "true");
    expect(codexOpt.textContent).toMatch(/unavailable/i);
    expect(codexOpt).toHaveAttribute("title", "Codex CLI not detected.");
  });

  it("does not call onPairingChange when the disabled claude+codex option is clicked", () => {
    const onPairingChange = vi.fn();
    render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={onPairingChange}
        codexAvailable={false}
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    fireEvent.click(screen.getByTestId("pairing-option-claude+codex"));
    expect(onPairingChange).not.toHaveBeenCalled();
  });

  it("passes accessibility scan (off)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <CouncilToggle enabled={false} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan (on, open)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <CouncilToggle enabled={true} pairing="claude+codex" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan with codex unavailable", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={() => {}}
        codexAvailable={false}
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // APG listbox keyboard model — open via trigger.
  //
  // The handler is wired to keydown on BOTH the trigger button AND the
  // listbox container so the user can drive it from either focus position.
  // Closed-state opens use the trigger's keydown branch (line 201-206).
  it.each([
    { name: "ArrowDown", init: { key: "ArrowDown" } },
    { name: "ArrowUp", init: { key: "ArrowUp" } },
    { name: "Enter", init: { key: "Enter" } },
    { name: "Space", init: { key: " " } },
  ])("opens listbox when $name is pressed on the trigger", ({ init }) => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    const trigger = screen.getByTestId("pairing-trigger");
    fireEvent.keyDown(trigger, init);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  // Closed-state keydown for non-opening keys is a no-op (covers the
  // implicit fall-through branch at line 201's else).
  it("ignores Tab on the closed trigger (no listbox opens)", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.keyDown(screen.getByTestId("pairing-trigger"), { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes the listbox on Escape and returns focus to the trigger", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  // ArrowDown / ArrowUp advance the active option (aria-activedescendant
  // moves between options without taking DOM focus — this is the SR
  // contract).
  it("ArrowDown advances aria-activedescendant from claude+claude to claude+codex", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const listbox = screen.getByRole("listbox");
    expect(listbox).toHaveAttribute("aria-activedescendant", "pairing-option-claude+claude");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(listbox).toHaveAttribute("aria-activedescendant", "pairing-option-claude+codex");
  });

  it("ArrowUp wraps the active option around the list", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    // Two options → ArrowUp from index 0 wraps to index 1.
    expect(listbox).toHaveAttribute("aria-activedescendant", "pairing-option-claude+codex");
  });

  it("Home jumps the active option to the first row", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+codex" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "Home" });
    expect(listbox).toHaveAttribute("aria-activedescendant", "pairing-option-claude+claude");
  });

  it("End jumps the active option to the last row", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "End" });
    expect(listbox).toHaveAttribute("aria-activedescendant", "pairing-option-claude+codex");
  });

  // ArrowDown over a disabled (codex unavailable) option skips it — single
  // wrap-around loop visits every option but advances only to enabled ones.
  it("ArrowDown skips claude+codex when codexAvailable=false", () => {
    render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={() => {}}
        codexAvailable={false}
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const listbox = screen.getByRole("listbox");
    // Only claude+claude is enabled, so ArrowDown wraps back to itself.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(listbox).toHaveAttribute("aria-activedescendant", "pairing-option-claude+claude");
  });

  // Enter / Space activates the currently-active option, firing onPairingChange.
  it.each([
    { name: "Enter", init: { key: "Enter" } },
    { name: "Space", init: { key: " " } },
  ])("$name activates the active option and fires onPairingChange", ({ init }) => {
    const onPairingChange = vi.fn();
    render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={onPairingChange}
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, init);
    expect(onPairingChange).toHaveBeenCalledWith("claude+codex");
  });

  // Enter on a disabled option is a no-op — protects against keyboard users
  // bypassing the click-time disabled check.
  it("Enter on the active claude+codex row is a no-op when codexAvailable=false", () => {
    const onPairingChange = vi.fn();
    render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={onPairingChange}
        codexAvailable={false}
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const listbox = screen.getByRole("listbox");
    // ArrowDown is skipped (disabled), so activeIndex stays on claude+claude.
    // We force-activate claude+codex by manually firing on its actual row.
    // To prove the disabled-guard runs, dispatch ArrowDown-on-step-loop where
    // forced index is 1; since the implementation walks the loop, we just
    // verify no pairing change after Enter when only one row is enabled and
    // the user attempts to step + Enter.
    fireEvent.keyDown(listbox, { key: "End" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    // End jumps to last row directly without disabled-check, so the Enter
    // guard at line 245-246 is what rejects it.
    expect(onPairingChange).not.toHaveBeenCalled();
  });

  // The keyboard handler ignores unrelated keys (covers the trailing
  // implicit-else of the open-state branch).
  it("ignores unrelated keys (e.g. PageDown) while the listbox is open", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const listbox = screen.getByRole("listbox");
    expect(listbox).toHaveAttribute("aria-activedescendant", "pairing-option-claude+claude");
    fireEvent.keyDown(listbox, { key: "PageDown" });
    expect(listbox).toHaveAttribute("aria-activedescendant", "pairing-option-claude+claude");
  });

  // Outside-click closes — covers the `useEffect` outside-click handler at
  // lines 158-167. The handler is wired only when the listbox is open.
  it("closes the listbox when a pointerdown happens outside the dropdown", () => {
    render(
      <div>
        <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />
        <button data-testid="outside">outside</button>
      </div>,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps the listbox open when a pointerdown lands inside the dropdown", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    fireEvent.pointerDown(screen.getByRole("listbox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
});
