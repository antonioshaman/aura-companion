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
    expect(codexOpt).toBeDisabled();
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
});
