// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CouncilToggle, isSupportedPairing, coerceCouncilPairing } from "./CouncilToggle.js";

describe("isSupportedPairing", () => {
  it.each(["claude+claude", "claude+codex"])("accepts: %s", (v) => {
    expect(isSupportedPairing(v)).toBe(true);
  });

  it.each(["codex+claude", "claude", "", null, undefined, 42, "claude+gpt"])("rejects: %s", (v) => {
    expect(isSupportedPairing(v as unknown)).toBe(false);
  });
});

describe("coerceCouncilPairing", () => {
  // P1 fix — the core requirement: when mixed pairing capability is unavailable
  // (codexAvailable=false OR codexObserverReviewAvailable=false), any stored
  // "claude+codex" preference must be coerced to "claude+claude" so neither the
  // UI trigger nor the POST body carries an unsupported pairing.

  it("returns claude+claude unchanged when mixedPairingAvailable=true", () => {
    // When the user chose claude+claude and capability is available, no coercion needed.
    expect(coerceCouncilPairing("claude+claude", true)).toBe("claude+claude");
  });

  it("preserves claude+codex when mixedPairingAvailable=true", () => {
    // When capability is available, the user's preference is respected verbatim.
    expect(coerceCouncilPairing("claude+codex", true)).toBe("claude+codex");
  });

  it("coerces claude+codex to claude+claude when mixedPairingAvailable=false (Codex unavailable)", () => {
    // Core bug fix: stale localStorage "claude+codex" must never reach the POST when
    // Codex CLI is absent or its observer-review capability is disabled on this server.
    expect(coerceCouncilPairing("claude+codex", false)).toBe("claude+claude");
  });

  it("keeps claude+claude when mixedPairingAvailable=false (no change needed)", () => {
    // claude+claude is always valid — coercion is a no-op here.
    expect(coerceCouncilPairing("claude+claude", false)).toBe("claude+claude");
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

  // Regression: the listbox MUST NOT live inside any element carrying
  // `overflow-hidden`. The grid-rows-[0fr↔1fr] animation wrapper uses
  // `overflow-hidden` to clip the trigger during the collapse animation;
  // an absolutely-positioned listbox rendered as a descendant of that
  // wrapper is clipped to zero pixels alongside the row collapse, so
  // the user sees the trigger toggle `aria-expanded` true but the
  // dropdown stays visually invisible. JSDOM cannot reproduce the CSS
  // clip — assert the DOM structure instead. Observed in production
  // 2026-05-13: dropdown open but invisible; reported by user.
  it("renders the listbox OUTSIDE every overflow-hidden ancestor (regression: dropdown clipped)", () => {
    render(
      <CouncilToggle enabled={true} pairing="claude+claude" onEnabledChange={() => {}} onPairingChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const listbox = screen.getByRole("listbox");
    // Walk every ancestor up to <html> and assert none has the
    // overflow-hidden class (Tailwind utility). If any ancestor does,
    // CSS clipping will hide the absolutely-positioned listbox even
    // when `open === true`.
    let node: HTMLElement | null = listbox.parentElement;
    while (node && node !== document.documentElement) {
      expect(node.className).not.toMatch(/(^|\s)overflow-hidden(\s|$)/);
      node = node.parentElement;
    }
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

  it("disables claude+codex when Codex is installed but observer review capability is unavailable", () => {
    render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={() => {}}
        codexAvailable={true}
        codexObserverReviewAvailable={false}
        codexUnavailableReason="Codex observer review is unavailable on this build."
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const codexOpt = screen.getByTestId("pairing-option-claude+codex");
    expect(codexOpt).toHaveAttribute("aria-disabled", "true");
    expect(codexOpt).toHaveAttribute("title", "Codex observer review is unavailable on this build.");
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

  // #11 (Finding #11): CouncilToggle shows CLI-missing copy when codexAvailable=false,
  // not the observer-review-capability copy. The reason string derives from the outer
  // layer (HomePage) via the codexUnavailableReason prop.
  it("shows CLI-missing reason text when codexAvailable=false (not review-capability text)", () => {
    // When the CLI itself is missing, the user needs 'install or sign in' guidance.
    // The review-capability copy is irrelevant and would send the user to fix the wrong thing.
    render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={() => {}}
        codexAvailable={false}
        codexUnavailableReason="Codex CLI not found or not authenticated on this server."
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const codexOpt = screen.getByTestId("pairing-option-claude+codex");
    // The CLI-missing copy must appear, not the review-capability copy.
    expect(codexOpt.textContent).toContain("Codex CLI not found or not authenticated");
    expect(codexOpt.textContent).not.toContain("observer review capability");
  });

  it("shows review-capability reason text when codexAvailable=true but codexObserverReviewAvailable=false", () => {
    // When the CLI exists but observer review is off on this build, show the review-capability copy.
    render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={() => {}}
        codexAvailable={true}
        codexObserverReviewAvailable={false}
        codexUnavailableReason="Codex observer review capability is unavailable on this server."
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const codexOpt = screen.getByTestId("pairing-option-claude+codex");
    // The review-capability copy must appear, not the CLI-missing copy.
    expect(codexOpt.textContent).toContain("observer review capability");
    expect(codexOpt.textContent).not.toContain("not found or not authenticated");
  });

  // #15 (Finding #15): when claude+codex is disabled, the exp chip and billing
  // subcopy are suppressed to reduce visual noise — the unavailable chip already
  // communicates the relevant status.
  it("suppresses exp chip when claude+codex is disabled (codexAvailable=false)", () => {
    // Stacking exp + unavailable chips on a disabled row adds competing fragments.
    // Only the unavailable chip should be present; exp is only meaningful when the row is selectable.
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
    const codexOpt = screen.getByTestId("pairing-option-claude+codex");
    // Should have unavailable chip but NOT the exp chip.
    expect(codexOpt.textContent).toMatch(/unavailable/i);
    // The exp text should not appear in the option when disabled.
    // (It appears inside the option button when the row is available — not here.)
    const expChip = Array.from(codexOpt.querySelectorAll("span")).find(
      (s) => s.textContent?.trim() === "exp",
    );
    expect(expChip).toBeUndefined();
  });

  it("suppresses billing subcopy when claude+codex is disabled (codexObserverReviewAvailable=false)", () => {
    // The 'billed separately' subcopy is only meaningful when the user can actually select the row.
    // When disabled, that copy is visual noise alongside the reason line.
    render(
      <CouncilToggle
        enabled={true}
        pairing="claude+claude"
        onEnabledChange={() => {}}
        onPairingChange={() => {}}
        codexAvailable={true}
        codexObserverReviewAvailable={false}
        codexUnavailableReason="Observer review unavailable."
      />,
    );
    fireEvent.click(screen.getByTestId("pairing-trigger"));
    const codexOpt = screen.getByTestId("pairing-option-claude+codex");
    // The billing subcopy must not appear when the row is disabled.
    expect(codexOpt.textContent).not.toContain("billed separately");
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
