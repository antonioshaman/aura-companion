// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { axe } from "vitest-axe";
import { UsageLimitsReasonNote } from "./UsageLimitsReasonNote.js";
import { describeLimitsPending, describeUsageLimitsReason } from "../../server/auth-status/auth-catalog.js";
import { USAGE_LIMITS_REASONS } from "../../server/auth-status/auth-types.js";

/**
 * The usage-limits panel's "why there is no data" note (LLM auth task 14,
 * S4). Pins: every UsageLimitsReason renders its catalog title (never an
 * empty panel), `open_status` is the constant #/diagnostics link, `retry`
 * calls back once per click and is hidden without a handler, the Codex
 * "no data yet" entry renders, and axe is clean.
 */
describe("UsageLimitsReasonNote", () => {
  it("renders the catalog title and detail for every reason", () => {
    for (const reason of USAGE_LIMITS_REASONS) {
      const entry = describeUsageLimitsReason(reason);
      const { unmount } = render(<UsageLimitsReasonNote entry={entry} onRetry={() => {}} />);
      expect(screen.getByText(entry.title)).toBeInTheDocument();
      expect(screen.getByText(entry.detail)).toBeInTheDocument();
      unmount();
    }
  });

  it("open_status is a link to the Diagnostics page", () => {
    render(<UsageLimitsReasonNote entry={describeUsageLimitsReason("no_credentials")} />);
    expect(screen.getByRole("link", { name: "Open provider status" })).toHaveAttribute("href", "#/diagnostics");
  });

  it("retry calls back on click and is absent without a handler", () => {
    const onRetry = vi.fn();
    const { unmount } = render(<UsageLimitsReasonNote entry={describeUsageLimitsReason("network")} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
    render(<UsageLimitsReasonNote entry={describeUsageLimitsReason("network")} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the Codex 'no data yet' entry (no action)", () => {
    render(<UsageLimitsReasonNote entry={describeLimitsPending("codex")} />);
    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <div>
        <UsageLimitsReasonNote entry={describeUsageLimitsReason("auth_invalid")} />
        <UsageLimitsReasonNote entry={describeUsageLimitsReason("unknown")} onRetry={() => {}} />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
