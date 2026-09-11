// @vitest-environment jsdom
/**
 * Tests for SweepPage — the manual "Sweep orphans" cleanup surface.
 *
 * SweepPage previews server-owned lost resources (orphan processes, archived
 * leaks, stale session records, orphaned timers) and, behind a confirm dialog,
 * asks the server to reap them. The server is the sole mutator.
 *
 * Coverage targets:
 * - Render + axe accessibility scan (mandated triad), including the confirm
 *   dialog AND the executed receipt (new states).
 * - AC6 empty state ("Nothing to sweep") is DISTINCT from the loading state —
 *   the whole reason candidates start null, never [].
 * - The confirm-gate behaviour: clicking the page "Sweep N items" button opens
 *   the dialog and calls execute ZERO times; only the dialog's confirm button
 *   calls execute ONCE (with the preview token).
 * - The confirm dialog defaults focus to Cancel (a stray Enter can't execute).
 * - Per-candidate selection drives the confirm count (deselecting narrows it).
 * - Result reconciliation shows requested / swept / skipped as distinct VALUES.
 * - The executed receipt itemises the swept set (reason + pid + session id) and
 *   a per-reason breakdown, and offers an in-place Rescan when anything skipped.
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

  it("the executed receipt (with skipped>0) passes an axe scan", async () => {
    const { axe } = await import("vitest-axe");
    mockSweepExecute.mockResolvedValue({
      requested: 2, swept: 1, skipped: 1,
      perReason: { orphan: 1, "archived-leak": 0, "stale-session": 1, "orphan-timer": 0 },
    });
    const { container } = render(<SweepPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: /Sweep 2 items/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Sweep 2 items/ }));
    await screen.findByText("Sweep complete");
    const results = await axe(container);
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

  it("on a preview failure keeps a Retry action INSIDE the error block", async () => {
    mockSweepPreview.mockRejectedValueOnce(new Error("scan boom"));
    render(<SweepPage embedded />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("scan boom")).toBeInTheDocument();
    // Retry lives in the error block, not only the header Rescan control.
    const retry = within(alert).getByRole("button", { name: /Retry scan/ });
    mockSweepPreview.mockResolvedValueOnce(makePreview());
    fireEvent.click(retry);
    // A successful retry recovers the candidate list.
    await screen.findByText("2 candidates");
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

  it("Escape closes the dialog without executing", async () => {
    render(<SweepPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: /Sweep 2 items/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockSweepExecute).not.toHaveBeenCalled();
  });

  it("traps Tab within the dialog: Shift+Tab from Cancel wraps to the confirm button, Tab from confirm wraps back", async () => {
    render(<SweepPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: /Sweep 2 items/ }));
    const dialog = await screen.findByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", { name: /Sweep 2 items/ });

    // Cancel has initial focus (first focusable). Shift+Tab must wrap to last.
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();

    // Tab from the last focusable wraps back to the first.
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(cancel).toHaveFocus();
  });

  it("Cancel closes the dialog without executing", async () => {
    render(<SweepPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: /Sweep 2 items/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockSweepExecute).not.toHaveBeenCalled();
  });
});

describe("SweepPage per-candidate selection", () => {
  it("deselecting a candidate narrows the confirm count (page button + dialog follow the SELECTED subset)", async () => {
    render(<SweepPage embedded />);
    await screen.findByText("2 candidates");
    // Default: every candidate selected — the confirm count reflects the full set.
    expect(screen.getByRole("button", { name: /Sweep 2 items/ })).toBeInTheDocument();
    expect(screen.getByText(/2 selected/)).toBeInTheDocument();

    // Deselect the orphan process; the count follows selection, not the preview.
    const orphanBox = screen.getByRole("checkbox", { name: /Orphaned process \(pid 4321\)/ });
    fireEvent.click(orphanBox);
    expect(orphanBox).not.toBeChecked();
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();

    const pageBtn = screen.getByRole("button", { name: /Sweep 1 item/ });
    fireEvent.click(pageBtn);
    const dialog = await screen.findByRole("dialog");
    // The dialog confirm button reflects the selected subset, not the whole set.
    expect(within(dialog).getByRole("button", { name: /Sweep 1 item/ })).toBeInTheDocument();
    // ...and it is HONEST that the server reaps the whole token-bound set (the
    // execute API cannot accept a subset), so a partial selection is flagged.
    expect(within(dialog).getByText(/reaps the entire previewed set/)).toBeInTheDocument();
  });

  it("deselecting every candidate disables the page Sweep button (nothing to confirm)", async () => {
    render(<SweepPage embedded />);
    await screen.findByText("2 candidates");
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect(screen.getByText(/0 selected/)).toBeInTheDocument();
    const pageBtn = screen.getByRole("button", { name: /Sweep 0 items/ });
    expect(pageBtn).toBeDisabled();
    fireEvent.click(pageBtn);
    // A disabled trigger can never open the destructive gate.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("SweepPage receipt (executed state)", () => {
  it("after execute, shows requested / swept / skipped as distinct VALUES (2 / 1 / 1)", async () => {
    mockSweepExecute.mockResolvedValue({
      requested: 2, swept: 1, skipped: 1,
      perReason: { orphan: 1, "archived-leak": 0, "stale-session": 0, "orphan-timer": 0 },
    });
    render(<SweepPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: /Sweep 2 items/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Sweep 2 items/ }));

    await screen.findByText("Sweep complete");
    // Assert the NUMBERS, not just the labels: requested=2, swept=1, skipped=1.
    // Each value is scoped to its own stat tile so the two 1s (swept + skipped)
    // are verified independently and can't be satisfied by a single stray "1".
    const statTile = (label: string) => screen.getByText(label).parentElement as HTMLElement;
    expect(within(statTile("Requested")).getByText("2")).toBeInTheDocument();
    expect(within(statTile("Swept")).getByText("1")).toBeInTheDocument();
    expect(within(statTile("Skipped")).getByText("1")).toBeInTheDocument();
  });

  it("itemises the swept set (reason + pid + session id) and the per-reason breakdown", async () => {
    mockSweepExecute.mockResolvedValue({
      requested: 2, swept: 2, skipped: 0,
      perReason: { orphan: 1, "archived-leak": 0, "stale-session": 1, "orphan-timer": 0 },
    });
    render(<SweepPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: /Sweep 2 items/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Sweep 2 items/ }));

    await screen.findByText("Sweep complete");
    // The receipt does NOT discard candidate detail — reason + pid + session id survive.
    expect(screen.getByText("Candidates in this sweep")).toBeInTheDocument();
    expect(screen.getByText("pid 4321")).toBeInTheDocument();
    expect(screen.getByText("s2")).toBeInTheDocument();
    // Per-reason breakdown is rendered from the returned perReason map.
    expect(screen.getByText("Swept by reason")).toBeInTheDocument();
  });

  it("when skipped>0, explains the residual set and offers an in-place Rescan", async () => {
    mockSweepExecute.mockResolvedValue({
      requested: 2, swept: 1, skipped: 1,
      perReason: { orphan: 1, "archived-leak": 0, "stale-session": 0, "orphan-timer": 0 },
    });
    render(<SweepPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: /Sweep 2 items/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Sweep 2 items/ }));

    await screen.findByText("Sweep complete");
    expect(screen.getByText(/their identity change since preview/)).toBeInTheDocument();
    // The residual set is actionable — a Rescan lives inside the receipt.
    const rescan = screen.getByRole("button", { name: /Rescan for remaining/ });
    fireEvent.click(rescan);
    // mount preview (1) + receipt rescan (2)
    await waitFor(() => expect(mockSweepPreview).toHaveBeenCalledTimes(2));
  });
});
