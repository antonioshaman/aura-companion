// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CouncilBudgetNotice, formatTokenCount } from "./CouncilBudgetNotice.js";
import type { BrowserCouncilBudget } from "../../types.js";

// Council budget guard: a pair that crossed its token budget has its
// AUTOMATIC activity paused server-side (observer wakes, second opinion,
// auto-proceed). Without this notice the pair just goes quiet. It must say
// why, show where the tokens went (cache reads shown but not counted), and
// offer Continue — disabled while a request is in flight, with any failure
// announced.

const budget = (over: Partial<BrowserCouncilBudget> = {}): BrowserCouncilBudget => ({
  sessionGroupId: "grp_x",
  limitTokens: 20_000_000,
  limitSource: "env",
  spentTokens: 20_412_330,
  exceeded: true,
  exceededAt: 1,
  byRole: {
    orchestrator: { inputTokens: 2_000, outputTokens: 1_900_000, cacheCreationTokens: 11_200_000, cacheReadTokens: 800_000_000, turns: 214 },
    observer: { inputTokens: 1_880_000, outputTokens: 913_000, cacheCreationTokens: 4_510_000, cacheReadTokens: 200_000_000, turns: 187 },
  },
  ...over,
});

describe("formatTokenCount", () => {
  it("compacts counts", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(1_500)).toBe("1.5K");
    expect(formatTokenCount(12_345)).toBe("12K");
    expect(formatTokenCount(2_000_000)).toBe("2M");
    expect(formatTokenCount(20_412_330)).toBe("20M");
    expect(formatTokenCount(1_200_000_000)).toBe("1.2B");
  });
});

describe("CouncilBudgetNotice", () => {
  it("renders nothing without a budget or while under budget", () => {
    const { container, rerender } = render(<CouncilBudgetNotice budget={undefined} onContinue={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CouncilBudgetNotice budget={budget({ exceeded: false })} onContinue={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("explains the pause and shows the per-role breakdown", () => {
    render(<CouncilBudgetNotice budget={budget()} onContinue={() => {}} />);
    expect(screen.getByRole("region", { name: "Pair paused: token budget reached" })).toBeInTheDocument();
    expect(screen.getByText(/used 20M of its 20M token/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was stopped/)).toBeInTheDocument();
    expect(screen.getByText("13M · 214 turns")).toBeInTheDocument();
    expect(screen.getByText("7.3M · 187 turns")).toBeInTheDocument();
    expect(screen.getByText("1B (not counted)")).toBeInTheDocument();
  });

  it("calls onContinue on click", () => {
    const onContinue = vi.fn();
    render(<CouncilBudgetNotice budget={budget()} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("disables the button while continuing and announces an error", () => {
    const onContinue = vi.fn();
    render(<CouncilBudgetNotice budget={budget()} continuing error="Could not resume the pair. Try again." onContinue={onContinue} />);
    const button = screen.getByRole("button", { name: /^Continue/ });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Resuming…");
    fireEvent.click(button);
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not resume the pair. Try again.");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<CouncilBudgetNotice budget={budget()} error="Could not resume the pair. Try again." onContinue={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
