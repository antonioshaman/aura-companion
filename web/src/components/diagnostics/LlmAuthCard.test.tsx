// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { axe } from "vitest-axe";

/**
 * LLM sign-in card (LLM auth phase 1, task 14; spec stories 1–2). Pins:
 * - both providers render their catalog state title, account / plan /
 *   sign-in / token expiry / last success, and "unknown" (never blank) for
 *   fields the provider does not report (Codex plan) — S1-AC1, Boundaries;
 * - invalid → relogin instruction; no_network → keeps last success (S1-AC2/AC3);
 * - every ProviderAuthState renders for both providers (Codex parity);
 * - the doctor report: findings, a not-checked location (never "nothing
 *   found"), the all-clear line;
 * - "Check" / "Run doctor" are POSTs fired only by the button; a 429 keeps
 *   the cached result and says "checked recently"; an empty cache asks to check;
 * - axe is clean.
 */

const mocks = vi.hoisted(() => ({
  llmAuthStatus: vi.fn(),
  llmAuthDoctor: vi.fn(),
  llmAuthRecheck: vi.fn(),
  llmAuthDoctorRecheck: vi.fn(),
}));
vi.mock("../../api.js", () => ({ api: mocks }));

import { LlmAuthCard, LlmAuthView } from "./LlmAuthCard.js";
import { doctorReport, LLM_AUTH_NOW, statusSnapshot } from "./llm-auth-fixtures.js";
import { describeAuthState } from "../../../server/auth-status/auth-catalog.js";
import { PROVIDER_AUTH_STATES, PROVIDER_IDS } from "../../../server/auth-status/auth-types.js";

beforeEach(() => {
  mocks.llmAuthStatus.mockReset().mockResolvedValue({ status: null });
  mocks.llmAuthDoctor.mockReset().mockResolvedValue({ report: null });
  mocks.llmAuthRecheck.mockReset();
  mocks.llmAuthDoctorRecheck.mockReset();
});

describe("LlmAuthView", () => {
  it("S1-AC1: shows state, account, plan, sign-in, expiry, last success for both providers; unknown is a word", () => {
    render(<LlmAuthView status={{ tag: "ready", data: statusSnapshot() }} doctor={{ tag: "ready", data: null }} now={LLM_AUTH_NOW} />);
    const claude = screen.getByTestId("llm-auth-status-claude");
    expect(within(claude).getByText("Claude: working")).toBeInTheDocument();
    expect(within(claude).getByText("owner@example.com")).toBeInTheDocument();
    expect(within(claude).getByText("max")).toBeInTheDocument();
    expect(within(claude).getByText("subscription")).toBeInTheDocument();
    expect(within(claude).getByText(/1m ago/)).toBeInTheDocument();
    const codex = screen.getByTestId("llm-auth-status-codex");
    expect(within(codex).getByText("Codex: working")).toBeInTheDocument();
    // Codex reports no plan / expiry here → "unknown", not an empty cell.
    expect(within(codex).getAllByText("unknown").length).toBeGreaterThanOrEqual(2);
  });

  it("S1-AC2/AC3: invalid carries the relogin instruction; no_network keeps the last success", () => {
    render(
      <LlmAuthView
        status={{ tag: "ready", data: statusSnapshot({ state: "invalid" }, { state: "no_network" }) }}
        doctor={{ tag: "ready", data: null }}
        now={LLM_AUTH_NOW}
      />,
    );
    expect(within(screen.getByTestId("llm-auth-status-claude")).getByText(/claude auth login/)).toBeInTheDocument();
    const codex = screen.getByTestId("llm-auth-status-codex");
    expect(within(codex).getByText("Codex: no connection")).toBeInTheDocument();
    expect(within(codex).getByText(/1m ago/)).toBeInTheDocument();
  });

  it("renders every state for both providers (Codex parity)", () => {
    for (const state of PROVIDER_AUTH_STATES) {
      const reason = state === "not_verified" ? ("cli_version_unproven" as const) : null;
      const { unmount } = render(
        <LlmAuthView
          status={{ tag: "ready", data: statusSnapshot({ state, reason }, { state, reason }) }}
          doctor={{ tag: "ready", data: null }}
          now={LLM_AUTH_NOW}
        />,
      );
      for (const id of PROVIDER_IDS) {
        expect(within(screen.getByTestId(`llm-auth-status-${id}`)).getByText(describeAuthState(state, id, reason).title)).toBeInTheDocument();
      }
      unmount();
    }
  });

  it("renders doctor findings, a not-checked place, and the all-clear line", () => {
    render(<LlmAuthView status={{ tag: "ready", data: null }} doctor={{ tag: "ready", data: doctorReport() }} now={LLM_AUTH_NOW} />);
    const claude = screen.getByTestId("llm-auth-doctor-claude");
    expect(within(claude).getByText("Claude: outdated CLI")).toBeInTheDocument();
    expect(within(claude).getByText("Claude: independent credential copy")).toBeInTheDocument();
    expect(within(claude).getByText(/~root\/.claude\/.credentials.json \(root's home\)/)).toBeInTheDocument();
    expect(within(claude).getByText("Claude: credential copies not checked")).toBeInTheDocument();
    expect(within(screen.getByTestId("llm-auth-doctor-codex")).getByText("Codex: no problems found")).toBeInTheDocument();
    // Empty status cache → asks for a check instead of rendering nothing.
    expect(screen.getByText(/Not checked yet/)).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <LlmAuthView
        status={{ tag: "ready", data: statusSnapshot({ state: "invalid" }) }}
        doctor={{ tag: "ready", data: doctorReport() }}
        now={LLM_AUTH_NOW}
        notice="Checked recently — showing that result. You can check again in 20s."
        onCheck={() => {}}
        onDoctor={() => {}}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("LlmAuthCard", () => {
  it("loads the caches once and POSTs only on Check", async () => {
    mocks.llmAuthRecheck.mockResolvedValue({ status: 200, body: { status: statusSnapshot() } });
    render(<LlmAuthCard />);
    expect(await screen.findByText(/Not checked yet/)).toBeInTheDocument();
    expect(mocks.llmAuthRecheck).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Claude: working")).toBeInTheDocument();
    expect(mocks.llmAuthRecheck).toHaveBeenCalledTimes(1);
    expect(mocks.llmAuthStatus).toHaveBeenCalledTimes(1);
  });

  it("a 429 keeps the returned cached status and says it was checked recently", async () => {
    mocks.llmAuthRecheck.mockResolvedValue({
      status: 429,
      body: { error: "too_soon", retryAfterMs: 20_000, status: statusSnapshot({ state: "invalid" }) },
    });
    render(<LlmAuthCard />);
    await screen.findByText(/Not checked yet/);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/Checked recently.*again in 20s/)).toBeInTheDocument();
    expect(screen.getByText("Claude: credentials invalid")).toBeInTheDocument();
  });

  it("Run doctor POSTs and renders the report; a failed request is said, not blank", async () => {
    mocks.llmAuthDoctorRecheck.mockResolvedValue({ status: 200, body: { report: doctorReport(false) } });
    mocks.llmAuthStatus.mockRejectedValue(new Error("offline"));
    render(<LlmAuthCard />);
    expect(await screen.findByText(/the status request failed \(offline\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run doctor" }));
    await waitFor(() => expect(screen.getByText("Claude: no problems found")).toBeInTheDocument());
    expect(mocks.llmAuthDoctorRecheck).toHaveBeenCalledTimes(1);
  });
});
