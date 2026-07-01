// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import * as apiModule from "../api.js";
import { TelemetryNudge } from "./TelemetryNudge.js";

const DISMISS_KEY = "aura.telemetryNudgeDismissed";

// Minimal AppSettings stub — the nudge only reads telemetryEnabled.
function settings(telemetryEnabled: boolean): apiModule.AppSettings {
  return { telemetryEnabled } as unknown as apiModule.AppSettings;
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("TelemetryNudge", () => {
  it("renders the prompt with the current server value reflected (On)", async () => {
    vi.spyOn(apiModule.api, "getSettings").mockResolvedValue(settings(true));
    render(<TelemetryNudge />);
    expect(await screen.findByText("Join the global usage counter?")).toBeInTheDocument();
    // The toggle mirrors the server state: enabled → "On" + aria-pressed=true.
    const toggle = screen.getByRole("button", { name: /Global usage counter/i });
    expect(toggle).toHaveTextContent("On");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles the server telemetryEnabled setting both ways", async () => {
    vi.spyOn(apiModule.api, "getSettings").mockResolvedValue(settings(true));
    const update = vi
      .spyOn(apiModule.api, "updateSettings")
      .mockResolvedValue(settings(false));
    render(<TelemetryNudge />);
    const toggle = await screen.findByRole("button", { name: /Global usage counter/i });

    // On → Off persists telemetryEnabled:false and flips the label.
    fireEvent.click(toggle);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ telemetryEnabled: false }));
    expect(toggle).toHaveTextContent("Off");

    // Off → On persists telemetryEnabled:true (the "туда-сюда" round trip).
    update.mockResolvedValue(settings(true));
    fireEvent.click(toggle);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ telemetryEnabled: true }));
    expect(toggle).toHaveTextContent("On");
  });

  it("reverts the toggle when the server update fails", async () => {
    vi.spyOn(apiModule.api, "getSettings").mockResolvedValue(settings(false));
    vi.spyOn(apiModule.api, "updateSettings").mockRejectedValue(new Error("boom"));
    render(<TelemetryNudge />);
    const toggle = await screen.findByRole("button", { name: /Global usage counter/i });
    expect(toggle).toHaveTextContent("Off");
    fireEvent.click(toggle);
    // Optimistic flip to On, then revert to Off after the rejection settles.
    await waitFor(() => expect(toggle).toHaveTextContent("Off"));
  });

  it("dismisses and persists so it never nags again", async () => {
    vi.spyOn(apiModule.api, "getSettings").mockResolvedValue(settings(true));
    const { container } = render(<TelemetryNudge />);
    await screen.findByText("Join the global usage counter?");
    fireEvent.click(screen.getByRole("button", { name: /Dismiss usage counter prompt/i }));
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  it("renders nothing when already dismissed (no settings fetch)", async () => {
    localStorage.setItem(DISMISS_KEY, "1");
    const getSettings = vi.spyOn(apiModule.api, "getSettings").mockResolvedValue(settings(true));
    const { container } = render(<TelemetryNudge />);
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(getSettings).not.toHaveBeenCalled();
  });

  it("stays invisible when the settings fetch fails", async () => {
    vi.spyOn(apiModule.api, "getSettings").mockRejectedValue(new Error("offline"));
    const { container } = render(<TelemetryNudge />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("passes axe accessibility checks", async () => {
    vi.spyOn(apiModule.api, "getSettings").mockResolvedValue(settings(true));
    const { axe } = await import("vitest-axe");
    const { container } = render(<TelemetryNudge />);
    await screen.findByText("Join the global usage counter?");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
