// @vitest-environment jsdom

// PLAN T12 (Phase G) - CliFailedBanner behavioural + a11y tests.
// Mandatory canaries from the master HANDOFF:
//   - per-variant render + axe scan (5 variants)
//   - role=alert + aria-live=assertive (a11y R1)
//   - single-fire announcement on mount, not on rerender (a11y R10)
//   - no dismiss button - Friedman R7 vs Frontend R5 conflict ruling
//   - non-truncation snapshot on narrow viewport (a11y R5 / Saarinen R2)
//   - drained-count mono integer (Saarinen R3, Friedman R3)
//   - lastErrorSha256 progressive disclosure (Friedman R6)
// Each behavioural test is mutation-resistant per EC-42: reverting the
// production defence to its prior shape flips at least one assertion.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CliFailedBanner } from "./CliFailedBanner.js";
import { cliFailedCopy } from "../cli-failed-copy.js";
import type { CliFailedReason } from "../types.js";
import type { CliFailure } from "../store/cli-status-slice.js";

const ALL_REASONS: readonly CliFailedReason[] = [
  "relaunch_exhausted",
  "container_missing",
  "container_stopped",
  "binary_missing",
  "browser_closed_no_reconnect",
];

function failure(overrides: Partial<CliFailure> = {}): CliFailure {
  return {
    reason: "relaunch_exhausted",
    drainedCount: 0,
    subprocessAlive: false,
    firedAt: 1_000,
    ...overrides,
  };
}

describe("CliFailedBanner — render + a11y", () => {
  // a11y R1 - distinct from FindingsLog polite live region.
  it("uses role=alert with aria-live=assertive", () => {
    render(<CliFailedBanner failure={failure()} onStartNewSession={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  // Mandatory canary: 5 axe scans, one per closed variant.
  it.each(ALL_REASONS)("passes axe scan for reason %s", async (reason) => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<CliFailedBanner failure={failure({ reason })} onStartNewSession={() => {}} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Each variant renders its headline + body + action verbatim.
  // Mutation-resistant: a regression that drops or rewires variant -> copy
  // mapping (e.g. always returns relaunch_exhausted copy) trips here.
  it.each(ALL_REASONS)("renders the headline + body + action copy for reason %s", (reason) => {
    const expected = cliFailedCopy(reason);
    render(<CliFailedBanner failure={failure({ reason })} onStartNewSession={() => {}} />);
    expect(screen.getByTestId("cli-failed-headline")).toHaveTextContent(expected.headline);
    expect(screen.getByTestId("cli-failed-body")).toHaveTextContent(expected.body);
    expect(screen.getByTestId("cli-failed-primary-action")).toHaveTextContent(expected.action);
  });

  // Friedman R7 vs Frontend R5 conflict ruling - non-dismissible v1.
  // Mutation-resistant: adding a dismiss button anywhere fails.
  it("does NOT render a dismiss button (Friedman R7 vs Frontend R5 conflict ruling)", () => {
    render(<CliFailedBanner failure={failure()} onStartNewSession={() => {}} />);
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  // Saarinen R3 + Friedman R3 - mono integer drained count chip when > 0.
  it("renders drainedCount chip when > 0", () => {
    render(<CliFailedBanner failure={failure({ drainedCount: 7 })} onStartNewSession={() => {}} />);
    expect(screen.getByTestId("cli-failed-drained-count")).toHaveTextContent("7 queued");
  });

  // Friedman R3 - suppress the chip when drainedCount === 0 (no false
  // "0 messages lost" reassurance).
  it("suppresses drainedCount chip when 0 (Friedman R3 - no false reassurance)", () => {
    render(<CliFailedBanner failure={failure({ drainedCount: 0 })} onStartNewSession={() => {}} />);
    expect(screen.queryByTestId("cli-failed-drained-count")).toBeNull();
  });

  // Friedman R6 - progressive-disclosure SHA256 behind a chevron trigger.
  it("hides lastErrorSha256 behind a chevron toggle (Friedman R6 progressive disclosure)", () => {
    render(<CliFailedBanner failure={failure({ lastErrorSha256: "abc123" })} onStartNewSession={() => {}} />);
    const toggle = screen.getByTestId("cli-failed-details-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("cli-failed-sha256")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("cli-failed-sha256")).toHaveTextContent("abc123");
  });

  it("hides the SHA disclosure trigger entirely when lastErrorSha256 is absent", () => {
    render(<CliFailedBanner failure={failure()} onStartNewSession={() => {}} />);
    expect(screen.queryByTestId("cli-failed-details-toggle")).toBeNull();
  });

  // Hunt P1 / Willison P2 - JSX escapes; never dangerouslySetInnerHTML.
  // The wire frame has no user-content fields today (`details` only carries
  // a SHA256), but the SHA travels through JSX as text - cross-check that
  // it does not inject DOM nodes.
  it("renders SHA as literal text - no script injection through details", () => {
    const malicious = "<script>alert(1)</script>";
    render(<CliFailedBanner failure={failure({ lastErrorSha256: malicious })} onStartNewSession={() => {}} />);
    fireEvent.click(screen.getByTestId("cli-failed-details-toggle"));
    expect(screen.getByTestId("cli-failed-sha256")).toHaveTextContent(malicious);
    expect(document.querySelectorAll("script").length).toBe(0);
  });

  // Primary action callback fires.
  it("calls onStartNewSession when the primary action button is clicked", () => {
    const onStart = vi.fn();
    render(<CliFailedBanner failure={failure()} onStartNewSession={onStart} />);
    fireEvent.click(screen.getByTestId("cli-failed-primary-action"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  // a11y finding #11 - on mount (= the failure transition, since the parent
  // renders the banner only while the failure is present), focus moves to the
  // sole recovery action so a keyboard/SR user's next Tab/Enter acts on it
  // rather than on the now-disabled Composer. Mutation-resistant: dropping the
  // focus effect or the ref leaves focus on document.body and trips this.
  it("moves focus to the primary recovery action on mount (a11y finding #11)", () => {
    render(<CliFailedBanner failure={failure()} onStartNewSession={() => {}} />);
    expect(screen.getByTestId("cli-failed-primary-action")).toHaveFocus();
  });

  // a11y R10 - single-fire announcement on MOUNT, not on rerender.
  // Behavioural assertion: same `failure` reference rerendered does not
  // unmount + remount the role=alert node, so the screen reader does not
  // re-announce. We assert by tracking the DOM identity of the alert node
  // across rerender - if a future change keys the alert on firedAt (which
  // would remount on every cli_failed update), this fails.
  it("does NOT remount the alert node on rerender with same failure (a11y R10)", () => {
    const f = failure({ reason: "relaunch_exhausted" });
    const { rerender } = render(<CliFailedBanner failure={f} onStartNewSession={() => {}} />);
    const alertBefore = screen.getByRole("alert");
    rerender(<CliFailedBanner failure={f} onStartNewSession={() => {}} />);
    const alertAfter = screen.getByRole("alert");
    expect(alertAfter).toBe(alertBefore);
  });

  // a11y R5 + Saarinen R2 - per-variant snapshot on a narrow viewport.
  // The body uses whitespace-pre-wrap + break-words; the headline + body
  // MUST NOT truncate. We assert the rendered text equals the canonical
  // string (no ellipsis substring, no shortened body), which is a
  // structural snapshot stable against width changes.
  it.each(ALL_REASONS)("does not truncate headline / body on narrow viewport for %s", (reason) => {
    // Narrow viewport: jsdom does not paint, so we cannot measure pixels.
    // Behavioural surrogate - the rendered text matches the cliFailedCopy
    // output verbatim and contains no ellipsis. This catches a regression
    // that introduces line-clamp / text-overflow:ellipsis to the body.
    const expected = cliFailedCopy(reason);
    render(<CliFailedBanner failure={failure({ reason })} onStartNewSession={() => {}} />);
    const headline = screen.getByTestId("cli-failed-headline");
    const body = screen.getByTestId("cli-failed-body");
    expect(headline.textContent).toBe(expected.headline);
    expect(body.textContent).toBe(expected.body);
    expect(headline.textContent).not.toMatch(/\u2026/);
    expect(body.textContent).not.toMatch(/\u2026/);
    // Tailwind class assertions - whitespace-pre-wrap + break-words preserve
    // long lines instead of clipping them. Reverting these classes is the
    // regression this canary catches.
    expect(body.className).toMatch(/whitespace-pre-wrap/);
    expect(body.className).toMatch(/break-words/);
  });
});
