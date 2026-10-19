// @vitest-environment jsdom
/**
 * Tests for the Diagnostics status cards (plan Task 15).
 *
 * - Render + axe for every card, in the ready state AND the unavailable /
 *   loading / page-failed states (CardFrame never renders nothing).
 * - AC1: a pair whose observer's last frame is 20 min old reads "silent 20m"
 *   next to the frame time and the last checkpoint time.
 * - AC2: drift events from the last hour show sessionId, time and reason,
 *   newest first; older ones sit behind a counted toggle that expands in place.
 * - AC3: the usage card reads "KV quota exceeded … since <time>" instead of
 *   rendering nothing.
 * - Verify-by-absence: no card carries a live region (the page announcer
 *   speaks), so 30-second polls do not chatter.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BackendCard, ContextAdvisoryCard, DriftCard, PairsCard, UsageCard } from "./StatusCards.js";
import { NOW, overview } from "./fixtures.js";

const ready = <K extends "backend" | "pairs" | "drift" | "contextAdvisory" | "usage">(k: K) => ({ tag: "source" as const, source: overview()[k] }) as never;

describe("status cards", () => {
  it("render ready state and pass an axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <div>
        <BackendCard frame={ready("backend")} now={NOW} />
        <PairsCard frame={ready("pairs")} now={NOW} />
        <DriftCard frame={ready("drift")} now={NOW} />
        <ContextAdvisoryCard frame={ready("contextAdvisory")} now={NOW} />
        <UsageCard frame={ready("usage")} now={NOW} />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it.each([
    ["loading", { tag: "loading" }, /Loading/],
    ["page-failed", { tag: "page-failed", message: "HTTP 500" }, /Source unavailable: the diagnostics request failed \(HTTP 500\)/],
    ["unavailable", { tag: "source", source: { status: "unavailable", reason: "source-error", since: NOW } }, /Source unavailable since \d\d:\d\d: the source failed to answer/],
  ])("never renders nothing — %s state is explicit and passes an axe accessibility scan", async (_l, frame, text) => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<PairsCard frame={frame as never} now={NOW} />);
    expect(screen.getByRole("heading", { name: "Council pairs" })).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("AC1: a 20-minute-silent observer reads 'silent 20m' with its frame and checkpoint times", () => {
    render(<PairsCard frame={ready("pairs")} now={NOW} />);
    const row = screen.getByText("obs-1").closest("tr")!;
    expect(within(row).getByText("silent 20m")).toBeInTheDocument();
    expect(within(row).getByText(/last frame \d\d:\d\d/)).toBeInTheDocument();
    expect(screen.getByText(/1 with a silent observer/)).toBeInTheDocument();
    expect(screen.getByText(/\d\d:\d\d \(25m ago\)/)).toBeInTheDocument();
  });

  it("AC2: last-hour events newest first with session, time and reason; earlier ones behind a counted toggle", () => {
    render(<DriftCard frame={ready("drift")} now={NOW} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[1].textContent)).toEqual([
      "silent_stdio_drift.detected",
      "silent_stdio_drift.withheld_open_tool_call",
    ]);
    expect(within(rows[0]).getByText("s1")).toBeInTheDocument();
    expect(within(rows[0]).getByText("jsonl mtime 26s newer")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show 1 earlier event (1–24h)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Show only the last hour" })).toHaveAttribute("aria-expanded", "true");
  });

  it("AC3: the usage card names the KV quota failure and its onset instead of rendering nothing", () => {
    render(<UsageCard frame={ready("usage")} now={NOW} />);
    expect(screen.getByText(/^KV quota exceeded \(HTTP 429\) since 11:02$/)).toBeInTheDocument();
    expect(screen.getByText(/resets at 00:00 UTC/)).toBeInTheDocument();
  });

  it("decodes a legacy bytes-only context advisory", () => {
    render(<ContextAdvisoryCard frame={ready("contextAdvisory")} now={NOW} />);
    expect(screen.getByText("handoff · 12.0 MB transcript")).toBeInTheDocument();
  });
});
