// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";

// The announcer reads a single per-session entry from the store. Mock the
// store module so the test drives the announcement state directly.
let mockState: Record<string, unknown> = {};
vi.mock("../store.js", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
}));

import { ModelAvailabilityAnnouncer } from "./ModelAvailabilityAnnouncer.js";

function setup(entry?: { text: string; firedAt: number }) {
  const modelAvailabilityAnnouncements = new Map<string, { text: string; firedAt: number }>();
  if (entry) modelAvailabilityAnnouncements.set("s1", entry);
  mockState = { modelAvailabilityAnnouncements };
}

describe("ModelAvailabilityAnnouncer", () => {
  // Render test (mandatory triad): the live region exists with the polite,
  // non-atomic semantics the plan requires (role="log" aria-live="polite"
  // aria-atomic="false" — NOT assertive, an infra failover is not an emergency).
  it("renders an empty polite, non-atomic log region when there is no announcement", () => {
    setup();
    render(<ModelAvailabilityAnnouncer sessionId="s1" />);
    const region = screen.getByTestId("model-availability-announcer");
    expect(region).toHaveAttribute("role", "log");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "false");
    expect(region.textContent).toBe("");
  });

  // Live-region content (plan: "behavioural tests for ... live-region content").
  it("speaks the announcement text when the store has an entry for the session", () => {
    setup({ text: 'Model "claude-opus-4-7" is unavailable for this session — keeping the current model. Pick a different model from the selector.', firedAt: 1 });
    render(<ModelAvailabilityAnnouncer sessionId="s1" />);
    expect(screen.getByTestId("model-availability-announcer").textContent).toContain(
      "is unavailable for this session",
    );
  });

  // Per-session isolation: an announcement for a different session must not
  // leak into this session's region.
  it("shows nothing when the only announcement belongs to a different session", () => {
    const modelAvailabilityAnnouncements = new Map([["other", { text: "reverted", firedAt: 1 }]]);
    mockState = { modelAvailabilityAnnouncements };
    render(<ModelAvailabilityAnnouncer sessionId="s1" />);
    expect(screen.getByTestId("model-availability-announcer").textContent).toBe("");
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    setup({ text: "Model reverted to a working model.", firedAt: 1 });
    const { container } = render(<ModelAvailabilityAnnouncer sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
