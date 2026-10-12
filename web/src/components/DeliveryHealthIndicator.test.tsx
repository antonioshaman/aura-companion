// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { DeliveryMetricsSnapshot } from "../api.js";

// The component's default loader is the API client; tests inject `load`, but
// the module still imports api.js, so stub it to keep the test hermetic.
vi.mock("../api.js", () => ({ api: { getDeliveryMetrics: vi.fn() } }));

import { DeliveryHealthIndicator, formatBucket } from "./DeliveryHealthIndicator.js";

function snapshot(over: Partial<DeliveryMetricsSnapshot["global"]> = {}, ttfoCount = 3): DeliveryMetricsSnapshot {
  return {
    stallThresholdMs: 60_000,
    global: {
      userMessages: 10,
      firstOutputs: 9,
      stalledMessages: 0,
      noResponseRequestedReplies: 0,
      driftRecoveries: 1,
      nudges: 2,
      backgroundTasksKilled: 0,
      awaitingReply: 0,
      ...over,
    },
    timeToFirstOutputMs: { count: ttfoCount, avg: 3000, p50Bucket: 2500, p95Bucket: 10_000, max: 9000 },
    sessions: {},
  };
}

describe("formatBucket", () => {
  // Bucket bounds come from the server histogram; the +Infinity bucket is
  // serialized by JSON as null and must not render as "≤ null s".
  it("formats seconds, minutes, the open-ended bucket and the empty case", () => {
    expect(formatBucket(2500, true)).toBe("≤ 2.5 s");
    expect(formatBucket(120_000, true)).toBe("≤ 2 min");
    expect(formatBucket(null, true)).toBe("> 5 min");
    expect(formatBucket(2500, false)).toBe("—");
  });
});

describe("DeliveryHealthIndicator", () => {
  it("renders the counters and a healthy status", async () => {
    // Validates the compact panel shows every metric the server exposes.
    render(<DeliveryHealthIndicator load={() => Promise.resolve(snapshot())} />);
    expect(await screen.findByText("All messages answered")).toBeInTheDocument();
    expect(screen.getByText("10 / 9")).toBeInTheDocument();
    expect(screen.getByText("≤ 2.5 s · ≤ 10 s")).toBeInTheDocument();
    expect(screen.getByText("No reply within 60 s")).toBeInTheDocument();
    expect(screen.getByText(/Claude Code only/)).toBeInTheDocument();
    expect(screen.getByText(/\(proxy\)/)).toBeInTheDocument();
  });

  it("flags stalled and \"No response requested.\" messages as problems", async () => {
    render(
      <DeliveryHealthIndicator
        load={() => Promise.resolve(snapshot({ stalledMessages: 2, noResponseRequestedReplies: 1, awaitingReply: 1 }))}
      />,
    );
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("3 messages without a proper answer · 1 waiting now");
    expect(status.className).toContain("text-cc-warning");
  });

  it("shows the background tasks a drift recovery killed, only when there were any", async () => {
    // A recovery kills the whole Claude CLI, including its background
    // subagents; that collateral is shown next to the recovery count.
    const { unmount } = render(
      <DeliveryHealthIndicator load={() => Promise.resolve(snapshot({ driftRecoveries: 2, backgroundTasksKilled: 5 }))} />,
    );
    expect(await screen.findByText("2 · 5 background tasks killed")).toBeInTheDocument();
    unmount();
    render(<DeliveryHealthIndicator load={() => Promise.resolve(snapshot())} />);
    await screen.findByText("All messages answered");
    expect(screen.queryByText(/background tasks killed/)).not.toBeInTheDocument();
  });

  it("shows an empty state before any message", async () => {
    render(<DeliveryHealthIndicator load={() => Promise.resolve(snapshot({ userMessages: 0, firstOutputs: 0 }, 0))} />);
    expect(await screen.findByText("No messages yet")).toBeInTheDocument();
    expect(screen.getByText("— · —")).toBeInTheDocument();
  });

  it("Refresh button reloads the snapshot", async () => {
    // Interaction: clicking Refresh calls the loader again and shows new data.
    const load = vi
      .fn<() => Promise<DeliveryMetricsSnapshot>>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ userMessages: 11, firstOutputs: 11 }));
    render(<DeliveryHealthIndicator load={load} />);
    await screen.findByText("10 / 9");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("11 / 11")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shows the load error as an alert", async () => {
    render(<DeliveryHealthIndicator load={() => Promise.reject(new Error("metrics unavailable"))} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("metrics unavailable");
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<DeliveryHealthIndicator load={() => Promise.resolve(snapshot({ stalledMessages: 1 }))} />);
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
