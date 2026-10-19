// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import * as apiModule from "../api.js";
import { GlobalUsageBadge } from "./GlobalUsageBadge.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("GlobalUsageBadge", () => {
  it("renders online people + active/total installs once stats resolve", async () => {
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue({
      onlineNow: 3,
      activeInstances30d: 1234,
      totalInstances: 5678,
      generatedAt: Date.now(),
    });

    render(<GlobalUsageBadge />);

    expect(await screen.findByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("5,678")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(/online/)).toBeInTheDocument();
    expect(screen.getByText(/active/)).toBeInTheDocument();
    expect(screen.getByText(/total/)).toBeInTheDocument();
    // The "installs" noun disambiguates the unit: active/total count installs,
    // while "online" counts people — so the two groups are not the same unit.
    expect(screen.getByText(/installs/)).toBeInTheDocument();
  });

  // Regression guard for the reported confusion "can total be lower than online?".
  // After Variant-2 the online figure is a PEOPLE headcount while total counts
  // INSTALLS, so one install hosting several people makes online > total — and
  // that must render verbatim, never clamped down to look monotonic.
  it("renders an online headcount that exceeds the install counts, unclamped", async () => {
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue({
      onlineNow: 4,
      activeInstances30d: 3,
      totalInstances: 3,
      generatedAt: Date.now(),
    });

    render(<GlobalUsageBadge />);

    // 4 people online shown as-is despite only 3 installs total.
    expect(await screen.findByText("4")).toBeInTheDocument();
    expect(screen.getByText(/online/)).toBeInTheDocument();
    expect(screen.getByText(/installs/)).toBeInTheDocument();
  });

  it("omits the online segment when onlineNow is null", async () => {
    // A reachable aggregator that reports no one online yet still shows
    // active/total — the online segment simply hides rather than rendering 0.
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue({
      onlineNow: null,
      activeInstances30d: 9,
      totalInstances: 12,
      generatedAt: Date.now(),
    });
    render(<GlobalUsageBadge />);
    expect(await screen.findByText("9")).toBeInTheDocument();
    expect(screen.queryByText(/online/)).not.toBeInTheDocument();
  });

  it("renders nothing before the first stats answer arrives", () => {
    // A never-resolving fetch: no flash of "unavailable" while the first poll is in flight.
    vi.spyOn(apiModule, "fetchGlobalStats").mockReturnValue(new Promise(() => {}));
    const { container } = render(<GlobalUsageBadge />);
    expect(container.firstChild).toBeNull();
  });

  // Behaviour change (diagnostics plan, friedman 7): the badge used to render
  // nothing when stats were unavailable, so a broken stats Worker (e.g. its KV
  // quota) left no trace. It now shows a muted mark linking to Diagnostics.
  it("shows a muted 'Usage unavailable' link to Diagnostics when the fetch fails", async () => {
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue(null);
    render(<GlobalUsageBadge />);
    const link = await screen.findByRole("link", { name: /usage unavailable/i });
    expect(link).toHaveAttribute("href", "#/diagnostics");
  });

  it("shows the unavailable mark when the proxy answers with all-null counts", async () => {
    // The server proxy hides upstream failures as 200 + nulls, so an all-null
    // body is the failure signal the client actually sees.
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue({
      onlineNow: null,
      activeInstances30d: null,
      totalInstances: null,
      generatedAt: Date.now(),
    });
    render(<GlobalUsageBadge />);
    expect(await screen.findByRole("link", { name: /usage unavailable/i })).toBeInTheDocument();
  });

  it("replaces the unavailable mark with counts once a later poll succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(apiModule, "fetchGlobalStats")
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ onlineNow: 5, activeInstances30d: 6, totalInstances: 7, generatedAt: Date.now() });
      render(<GlobalUsageBadge />);
      await screen.findByRole("link", { name: /usage unavailable/i });
      // Next 60s poll recovers.
      await vi.advanceTimersByTimeAsync(60_000);
      await waitFor(() => expect(screen.getByText("6")).toBeInTheDocument());
      expect(screen.queryByRole("link", { name: /usage unavailable/i })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes axe accessibility checks in the unavailable state", async () => {
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue(null);
    const { axe } = await import("vitest-axe");
    const { container } = render(<GlobalUsageBadge />);
    await screen.findByRole("link", { name: /usage unavailable/i });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("renders only active when total is null", async () => {
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue({
      onlineNow: null,
      activeInstances30d: 7,
      totalInstances: null,
      generatedAt: Date.now(),
    });
    render(<GlobalUsageBadge />);
    expect(await screen.findByText("7")).toBeInTheDocument();
    expect(screen.queryByText(/total/)).not.toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue({
      onlineNow: 2,
      activeInstances30d: 10,
      totalInstances: 20,
      generatedAt: Date.now(),
    });
    const { axe } = await import("vitest-axe");
    const { container } = render(<GlobalUsageBadge />);
    await screen.findByText("10");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
