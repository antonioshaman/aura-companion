// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ObserverFindingsBlock, parseObserverFindingsMessage } from "./ObserverFindingsBlock.js";

// vitest-axe matchers (`toHaveNoViolations`) are registered globally in
// `src/test-setup.ts`; `axe` is imported per-test inside jsdom.

const FINDING = {
  severity: "STOP",
  claim: "handler swallows the error",
  evidence_path: "src/a.ts",
  evidence_lines: [4, 9],
  confidence: "high",
};

/**
 * The parser is the false-positive guard for the chat feed: ONLY a strict
 * observer findings array may flip a message from markdown to cards, so
 * every rejection branch matters as much as the accept branch.
 */
describe("parseObserverFindingsMessage", () => {
  it("accepts a contract-shaped findings array (and an empty array = clean review)", () => {
    expect(parseObserverFindingsMessage(JSON.stringify([FINDING]))).toEqual([FINDING]);
    expect(parseObserverFindingsMessage(" [] ")).toEqual([]);
  });

  it("accepts optional fields being absent", () => {
    expect(parseObserverFindingsMessage(JSON.stringify([{ severity: "NOTE", claim: "c" }])))
      .toEqual([{ severity: "NOTE", claim: "c" }]);
  });

  it.each([
    ["ordinary prose", "looks fine to me"],
    ["markdown starting with a bracket-like link", "[link](https://x) and text"],
    ["JSON object, not array", JSON.stringify({ severity: "STOP", claim: "c" })],
    ["unknown severity", JSON.stringify([{ severity: "HIGH", claim: "c" }])],
    ["missing claim", JSON.stringify([{ severity: "STOP" }])],
    ["empty claim", JSON.stringify([{ severity: "STOP", claim: "  " }])],
    ["non-object element", JSON.stringify([FINDING, 42])],
    ["bad evidence_lines shape", JSON.stringify([{ severity: "WARN", claim: "c", evidence_lines: [1] }])],
    ["bad confidence", JSON.stringify([{ severity: "WARN", claim: "c", confidence: "certain" }])],
    ["truncated JSON (mid-stream)", JSON.stringify([FINDING]).slice(0, 20)],
  ])("rejects: %s", (_label, text) => {
    expect(parseObserverFindingsMessage(text)).toBeNull();
  });

  it("one bad element rejects the whole array (no truncated card list)", () => {
    expect(parseObserverFindingsMessage(JSON.stringify([FINDING, { severity: "STOP" }]))).toBeNull();
  });
});

describe("ObserverFindingsBlock", () => {
  it("renders severity label, claim, evidence path:lines and confidence", () => {
    render(<ObserverFindingsBlock findings={[FINDING as never]} />);
    expect(screen.getByText("STOP")).toBeInTheDocument();
    expect(screen.getByText("handler swallows the error")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts:4–9")).toBeInTheDocument();
    expect(screen.getByText("confidence: high")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Observer findings" })).toBeInTheDocument();
  });

  it("renders the clean-review status line for an empty findings array", () => {
    render(<ObserverFindingsBlock findings={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("no findings — clean");
  });

  it("renders a path-only evidence label when lines are absent", () => {
    render(<ObserverFindingsBlock findings={[{ severity: "INFO", claim: "ctx", evidence_path: "docs/x.md" } as never]} />);
    expect(screen.getByText("docs/x.md")).toBeInTheDocument();
  });

  it("has no axe violations (cards and clean states)", async () => {
    const { axe } = await import("vitest-axe");
    const cards = render(
      <ObserverFindingsBlock
        findings={[
          FINDING as never,
          { severity: "WARN", claim: "w" } as never,
          { severity: "NOTE", claim: "n" } as never,
          { severity: "INFO", claim: "i" } as never,
        ]}
      />,
    );
    expect(await axe(cards.container)).toHaveNoViolations();
    cards.unmount();
    const clean = render(<ObserverFindingsBlock findings={[]} />);
    expect(await axe(clean.container)).toHaveNoViolations();
  });
});
