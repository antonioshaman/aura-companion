// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";

import { AssistantAvatar } from "./AssistantAvatar.js";

describe("AssistantAvatar", () => {
  it("renders the default md size with the expected container + glyph classes", () => {
    // Default size has historically matched the MessageFeed clustering header
    // (28px container, 14px glyph). Anchor the contract with data-size + the
    // sized utility classes so a silent size regression is caught.
    const { container } = render(<AssistantAvatar />);
    const root = container.querySelector('[data-testid="assistant-avatar"]');
    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute("data-size", "md");
    expect(root?.className).toContain("w-7");
    expect(root?.className).toContain("h-7");
    const svg = root?.querySelector("svg");
    expect(svg?.getAttribute("class") ?? "").toContain("w-3.5");
    expect(svg?.getAttribute("class") ?? "").toContain("h-3.5");
  });

  it("renders the compact sm size when requested", () => {
    // sm is the MessageBubble usage — 24px container, 12px glyph. Tested
    // explicitly because the consumers diverge only on these two utilities.
    const { container } = render(<AssistantAvatar size="sm" />);
    const root = container.querySelector('[data-testid="assistant-avatar"]');
    expect(root).toHaveAttribute("data-size", "sm");
    expect(root?.className).toContain("w-6");
    expect(root?.className).toContain("h-6");
    const svg = root?.querySelector("svg");
    expect(svg?.getAttribute("class") ?? "").toContain("w-3 ");
    expect(svg?.getAttribute("class") ?? "").toContain("h-3 ");
  });

  it("emits the canonical star-glyph path so the icon is stable across consumers", () => {
    // The legacy duplicated AssistantAvatar in both MessageFeed and
    // MessageBubble shipped the same SVG path; the extraction must not
    // silently drift the artwork.
    const { container } = render(<AssistantAvatar />);
    const path = container.querySelector("svg path");
    expect(path?.getAttribute("d")).toBe("M8 2L10.5 6.5L15 8L10.5 9.5L8 14L5.5 9.5L1 8L5.5 6.5L8 2Z");
  });

  it("passes axe accessibility checks at both sizes", async () => {
    // The avatar is decorative — no interactive element, no label. axe should
    // not flag the SVG (no role, no name). Guards against a future regression
    // that adds an a11y-affecting attribute (e.g. unintended role="button").
    const md = render(<AssistantAvatar />);
    expect(await axe(md.container)).toHaveNoViolations();
    md.unmount();

    const sm = render(<AssistantAvatar size="sm" />);
    expect(await axe(sm.container)).toHaveNoViolations();
  });
});
