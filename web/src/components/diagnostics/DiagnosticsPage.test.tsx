// @vitest-environment jsdom
/**
 * Tests for DiagnosticsPage — the orchestration around the cards (plan Task 14).
 *
 * - Render + axe on the loaded page; exactly ONE live region (the page
 *   announcer) — cards carry none.
 * - AC6: "Run analysis now" → the API answers 409 (another tab / the hourly
 *   check already started it) → the button shows "running…" with no error.
 * - A decision rejected with 409 (report changed) shows the reason on that
 *   card and refetches the status.
 * - An archive decision that succeeds refetches and announces "got-017: archived."
 * - A failed refresh keeps the last good data with a stale note instead of
 *   blanking the cards.
 * - Sequence guard: a slow response that arrives after a newer one is ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { kbStatus, NOW, overview } from "./fixtures.js";

const mocks = vi.hoisted(() => ({
  diagnosticsOverview: vi.fn(),
  kbAnalysisLatest: vi.fn(),
  kbAnalysisRun: vi.fn(),
  kbAnalysisDecide: vi.fn(),
}));
vi.mock("../../api.js", () => ({ api: mocks }));

import { DiagnosticsPage } from "./DiagnosticsPage.js";

beforeEach(() => {
  // Pin the clock to the fixtures' time (only Date — real timers keep findBy* working).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.diagnosticsOverview.mockReset().mockResolvedValue(overview());
  mocks.kbAnalysisLatest.mockReset().mockResolvedValue(kbStatus());
  mocks.kbAnalysisRun.mockReset();
  mocks.kbAnalysisDecide.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DiagnosticsPage", () => {
  it("renders all cards, has one page announcer, and passes an axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<DiagnosticsPage />);
    await screen.findByText(/1 with a silent observer/);
    await screen.findByText("3/10 entries · 7/25 sessions · due in ≤12 days");
    expect(screen.getByRole("heading", { level: 1, name: "Diagnostics" })).toBeInTheDocument();
    for (const name of ["Backend", "Council pairs", "Drift and relaunch (24h)", "Context advisory", "Usage upstream", "Knowledge base", "KB analysis — decisions"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("AC6: a 409 on run lands in the running state, not an error", async () => {
    render(<DiagnosticsPage />);
    const btn = await screen.findByRole("button", { name: "Run analysis now" });
    mocks.kbAnalysisRun.mockResolvedValue({ status: 409, body: { error: "conflict", runId: "r9", startedAt: Date.now() } });
    mocks.kbAnalysisLatest.mockResolvedValue(kbStatus({ inFlight: { runId: "r9", startedAt: Date.now(), trigger: "entries", includeMemory: false } }));
    fireEvent.click(btn);
    const running = await screen.findByRole("button", { name: "running…" });
    expect(running).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.kbAnalysisRun).toHaveBeenCalledWith(false);
  });

  // Review P1 (abramov) + beck #6: the run usually finishes before the next
  // poll, so the page never sees inFlight. The button must still come back.
  it("returns from 'running…' when the first status after 202 already shows the run finished", async () => {
    render(<DiagnosticsPage />);
    const btn = await screen.findByRole("button", { name: "Run analysis now" });
    mocks.kbAnalysisRun.mockResolvedValue({ status: 202, body: { runId: "r7", startedAt: NOW } });
    mocks.kbAnalysisLatest.mockResolvedValue(kbStatus({ inFlight: null, lastRun: { runId: "r7", at: NOW + 50, trigger: "manual" } }));
    fireEvent.click(btn);
    expect(await screen.findByRole("button", { name: "Run analysis now" })).not.toHaveAttribute("aria-disabled");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Analysis finished: 2 findings."));
  });

  it("stays 'running…' while the accepted run is still in flight, then settles", async () => {
    render(<DiagnosticsPage />);
    const btn = await screen.findByRole("button", { name: "Run analysis now" });
    mocks.kbAnalysisRun.mockResolvedValue({ status: 202, body: { runId: "r8", startedAt: NOW } });
    mocks.kbAnalysisLatest.mockResolvedValue(kbStatus({ inFlight: { runId: "r8", startedAt: NOW, trigger: "manual", includeMemory: false } }));
    fireEvent.click(btn);
    await screen.findByRole("button", { name: "running…" });
    mocks.kbAnalysisLatest.mockResolvedValue(kbStatus({ inFlight: null, lastRun: { runId: "r8", at: NOW + 10, trigger: "manual" } }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("button", { name: "Run analysis now" })).toBeInTheDocument();
  });

  it("a decision rejected with 409 shows the reason on that card and reloads the status", async () => {
    render(<DiagnosticsPage />);
    const archive = await screen.findByRole("button", { name: "Archive got-017" });
    mocks.kbAnalysisDecide.mockResolvedValue({ status: 409, body: { error: "conflict", message: "the report changed" } });
    const callsBefore = mocks.kbAnalysisLatest.mock.calls.length;
    fireEvent.click(archive);
    expect(await screen.findByRole("alert")).toHaveTextContent("the report changed — reloading.");
    expect(mocks.kbAnalysisDecide).toHaveBeenCalledWith("run-1", [{ entryId: "got-017", decision: "archive" }]);
    await waitFor(() => expect(mocks.kbAnalysisLatest.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("a successful archive refetches and announces it", async () => {
    render(<DiagnosticsPage />);
    const archive = await screen.findByRole("button", { name: "Archive got-017" });
    mocks.kbAnalysisDecide.mockResolvedValue({ status: 200, body: { applied: [{ entryId: "got-017", decision: "archive", archive: "archived" }] } });
    mocks.kbAnalysisLatest.mockResolvedValue(kbStatus({ decisions: { "got-017": { decision: "archive", ts: Date.now() } } }));
    fireEvent.click(archive);
    expect(await screen.findByText(/archived → \.agents\/knowledge\/archive\//)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("got-017: archived."));
  });

  it("a failed refresh keeps the last good data with a stale note", async () => {
    render(<DiagnosticsPage />);
    await screen.findByText(/1 with a silent observer/);
    mocks.diagnosticsOverview.mockRejectedValue(new Error("HTTP 502"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getAllByText(/Refresh failed — showing data from/).length).toBeGreaterThan(0));
    expect(screen.getByText(/1 with a silent observer/)).toBeInTheDocument();
  });

  it("ignores a slow response that arrives after a newer one", async () => {
    let resolveSlow: (v: unknown) => void = () => {};
    mocks.diagnosticsOverview
      .mockReset()
      .mockImplementationOnce(() => new Promise((r) => (resolveSlow = r)))
      .mockResolvedValue(overview({ pairs: { status: "available", fetchedAt: Date.now(), data: [] } }));
    render(<DiagnosticsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("No live council pairs.");
    await act(async () => {
      resolveSlow(overview());
    });
    expect(screen.getByText("No live council pairs.")).toBeInTheDocument();
    expect(screen.queryByText(/1 with a silent observer/)).toBeNull();
  });
});
