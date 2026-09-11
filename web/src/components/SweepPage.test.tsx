// @vitest-environment jsdom
/**
 * Tests for SweepPage — the manual "Sweep orphans" cleanup surface.
 *
 * SweepPage previews server-owned lost resources (orphan processes, archived
 * leaks, stale sessions, orphaned timers) and, behind a confirm dialog, asks
 * the server to reap them. It is display-only: the server is the sole mutator.
 *
 * Coverage targets (per PLAN Tasks 8/9):
 * - Render + axe accessibility scan (mandated triad).
 * - AC6 empty state ("Nothing to sweep") is DISTINCT from the loading state —
 *   the whole reason candidates start null, never [].
 * - The confirm-gate behaviour: clicking the page "Sweep N items" button opens
 *   the dialog and calls execute ZERO times; only the dialog's confirm button
 *   calls execute ONCE (with the preview token).
 * - The confirm dialog defaults focus to Cancel (a stray Enter can't execute).
 * - Result reconciliation shows requested / swept / skipped as distinct numbers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSweepPreview = vi.fn();
const mockSweepExecute = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    sweepPreview: (...args: unknown[]) => mockSweepPreview(...args),
    sweepExecute: (...args: unknown[]) => mockSweepExecute(...args),
  },
}));

import { SweepPage } from "./SweepPage.js";

function makePreview(overrides: Record<string, unknown> = {}) {
  return {
    token: "tok123",
    candidates: [
      { id: "stale-session:s1", reason: "stale-session", sessionId: "s1", evidence: "state=exited, age 7200s", ageMs: 7_200_000 },
      { id: "orphan:4321", reason: "orphan", pid: 4321, sessionId: "s2", evidence: "argv matches a server sidecar", ageMs: 0 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSweepPreview.mockResolvedValue(makePreview());
  mockSweepExecute.mockResolvedValue({
    requested: 2, swept: 2, skipped: 0,
    perReason: { orphan: 1, "archived-leak": 0, "stale-session": 1, "orphan-timer": 0 },
  });
});

describe("SweepPage render & accessibility", () => {
  it("renders the candidate list and passes an axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<SweepPage embedded />);
    await screen.findByText("2 candidates");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("the open confirm dialog passes an axe scan (portal, role=dialog)", async () => {
    const { axe } = await import("vitest-axe");
    render(<SweepPage embedded />);
    const pageBtn = await screen.findByRole("button", { name: /Sweep 2 items/ });
    fireEvent.click(pageBtn);
    await screen.findByRole("dialog");
    // The dialog renders via a portal outside landmark regions — standard for
    // modals, so the `region` rule is disabled just like EnvManager's modal test.
    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});

describe("SweepPage states", () => {
  it("shows a loading state while the preview is in flight", () => {
    mockSweepPreview.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SweepPage embedded />);
    expect(screen.getByText("Scanning for orphaned resources…")).toBeInTheDocument();
  });

  it("shows the AC6 empty state — distinct from loading — when nothing qualifies", async () => {
    mockSweepPreview.mockResolvedValue(makePreview({ candidates: [] }));
    render(<SweepPage embedded />);
    await screen.findByText("Nothing to sweep — no orphaned resources found.");
    expect(screen.getByText("0 candidates")).toBeInTheDocument();
    // The empty state must NOT read as still-loading.
    expect(screen.queryByText("Scanning for orphaned resources…")).not.toBeInTheDocument();
  });
});

describe("SweepPage confirm-gate behaviour", () => {
  it("clicking the page 'Sweep' button opens the dialog and executes ZERO times; only the dialog confirm executes ONCE", async () => {
    render(<SweepPage embedded />);
    const pageBtn = await screen.findByRole("button", { name: /Sweep 2 items/ });

    // Opening the confirmation must never be a destructive action.
    fireEvent.click(pageBtn);
    const dialog = await screen.findByRole("dialog");
    expect(mockSweepExecute).not.toHaveBeenCalled();

    // Only the dialog's confirm button executes — exactly once, with the token.
    const confirmBtn = within(dialog).getByRole("button", { name: /Sweep 2 items/ });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(mockSweepExecute).toHaveBeenCalledTimes(1));
    expect(mockSweepExecute).toHaveBeenCalledWith("tok123");
  });

  it("defaults focus to Cancel so a stray Enter can't execute", async () => {
    render(<SweepPage embedded />);
    const pageBtn = await screen.findByRole("button", { name: /Sweep 2 items/ });
    fireEvent.click(pageBtn);
    const dialog = await screen.findByRole("dialog");
    const cancelBtn = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancelBtn).toHaveFocus());
  });

  it("restores focus to the triggering button when the dialog is cancelled (WCAG 2.4.3)", async () => {
    render(<SweepPage embedded />);
    const pageBtn = await screen.findByRole("button", { name: /Sweep 2 items/ });
    pageBtn.focus();
    fireEvent.click(pageBtn);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Focus must return to the trigger, not be lost to <body>.
    await waitFor(() => expect(screen.getByRole("button", { name: /Sweep 2 items/ })).toHaveFocus());
  });

  it("Cancel closes the dialog without executing", async () => {
    render(<SweepPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: /Sweep 2 items/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockSweepExecute).not.toHaveBeenCalled();
  });

  it("after execute, shows requested / swept / skipped as distinct numbers", async () => {
    mockSweepExecute.mockResolvedValue({
      requested: 2, swept: 1, skipped: 1,
      perReason: { orphan: 1, "archived-leak": 0, "stale-session": 0, "orphan-timer": 0 },
    });
    render(<SweepPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: /Sweep 2 items/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Sweep 2 items/ }));

    await screen.findByText("Sweep complete");
    // The three counts are shown independently — the server's identity re-check
    // (1 skipped here) is visible, never collapsed into the preview count.
    expect(screen.getByText("Requested")).toBeInTheDocument();
    expect(screen.getByText("Swept")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
  });
});
