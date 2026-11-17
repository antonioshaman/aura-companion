// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { axe } from "vitest-axe";
import { CopyButton } from "./CopyButton.js";

/**
 * The shared copy button (abramov A4). Pins the three states — copied,
 * refused, and no clipboard at all (plain-HTTP remote server: not a secure
 * context) — and that the idle button keeps an accessible name.
 */
const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (original) Object.defineProperty(navigator, "clipboard", original);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});
const setClipboard = (value: unknown) => Object.defineProperty(navigator, "clipboard", { value, configurable: true });

describe("CopyButton", () => {
  it("renders with its label / aria-label and is axe-clean", async () => {
    const { container } = render(<CopyButton value="npm i -g x" label="Copy" ariaLabel="Copy command" />);
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("copies and says Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<CopyButton value="the-value" label="Copy link" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("the-value");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("no clipboard (plain-HTTP remote server) → tells the user to select it by hand, no throw", () => {
    setClipboard(undefined);
    render(<CopyButton value="v" label="Copy" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button", { name: "Copy failed — select it by hand" })).toBeInTheDocument();
  });

  it("a refused write says so too", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    render(<CopyButton value="v" label="Copy" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copy failed — select it by hand" })).toBeInTheDocument();
  });
});
