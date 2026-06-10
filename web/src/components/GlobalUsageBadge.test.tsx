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
  it("renders active + total counts once stats resolve", async () => {
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue({
      activeInstances30d: 1234,
      totalInstances: 5678,
      generatedAt: Date.now(),
    });

    render(<GlobalUsageBadge />);

    expect(await screen.findByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("5,678")).toBeInTheDocument();
    expect(screen.getByText(/active/)).toBeInTheDocument();
    expect(screen.getByText(/total/)).toBeInTheDocument();
  });

  it("renders nothing when stats are unavailable", async () => {
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue(null);
    const { container } = render(<GlobalUsageBadge />);
    // Give the resolved promise a tick; component should stay empty.
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("renders only active when total is null", async () => {
    vi.spyOn(apiModule, "fetchGlobalStats").mockResolvedValue({
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
