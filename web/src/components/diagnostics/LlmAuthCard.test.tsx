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
 * - invalid → sign-in instruction; verifiedBy "login" reads "by sign-in" (phase 2 D8);
 * - (phase 1) no_network → keeps last success (S1-AC2/AC3);
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
  llmLoginGet: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("../../api.js", () => ({ api: mocks }));

import { LlmAuthCard, LlmAuthView } from "./LlmAuthCard.js";
import { doctorReport, LLM_AUTH_NOW, statusSnapshot } from "./llm-auth-fixtures.js";
import { describeAuthState } from "../../../server/auth-status/auth-catalog.js";
import { PROVIDER_AUTH_STATES, PROVIDER_IDS, knownField } from "../../../server/auth-status/auth-types.js";
import { useStore } from "../../store.js";
import { loginAttempt } from "../llm-login/login-fixtures.js";

beforeEach(() => {
  mocks.llmAuthStatus.mockReset().mockResolvedValue({ status: null });
  mocks.llmAuthDoctor.mockReset().mockResolvedValue({ report: null });
  mocks.llmAuthRecheck.mockReset();
  mocks.llmAuthDoctorRecheck.mockReset();
  mocks.llmLoginGet.mockReset().mockResolvedValue({ status: 200, body: { attempt: null } });
  mocks.updateSettings.mockReset().mockResolvedValue({});
  useStore.getState().reset();
});

describe("LlmAuthView", () => {
  it("S1-AC1: shows state, account, plan, sign-in, expiry, last success for both providers; unknown is a word", () => {
    render(<LlmAuthView status={{ tag: "ready", data: statusSnapshot() }} doctor={{ tag: "ready", data: null }} now={LLM_AUTH_NOW} />);
    const claude = screen.getByTestId("llm-auth-status-claude");
    expect(within(claude).getByText("Claude: working")).toBeInTheDocument();
    expect(within(claude).getByText("owner@example.com")).toBeInTheDocument();
    // (selector: the expected-plan list also has a "max" option since phase 2c)
    expect(within(claude).getByText("max", { selector: "dd" })).toBeInTheDocument();
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
    // Phase 2c: the relogin action is the sign-in window (was the manual command).
    expect(within(screen.getByTestId("llm-auth-status-claude")).getByRole("button", { name: "Sign in to Claude again" })).toBeInTheDocument();
    const codex = screen.getByTestId("llm-auth-status-codex");
    expect(within(codex).getByText("Codex: no connection")).toBeInTheDocument();
    // Its retry action is the Check button, not a stray "Retry" line.
    expect(within(codex).queryByText("Retry")).toBeNull();
    expect(within(codex).getByText(/1m ago/)).toBeInTheDocument();
  });

  it("phase 2 D8: a status confirmed by a just-completed sign-in says so, not 'local only'", () => {
    render(
      <LlmAuthView
        status={{ tag: "ready", data: statusSnapshot({}, { verifiedBy: "login" }) }}
        doctor={{ tag: "ready", data: null }}
        now={LLM_AUTH_NOW}
      />,
    );
    expect(within(screen.getByTestId("llm-auth-status-codex")).getByText(/\(by sign-in\)/)).toBeInTheDocument();
    expect(within(screen.getByTestId("llm-auth-status-claude")).getByText(/\(with the provider\)/)).toBeInTheDocument();
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

  // Observer review 200: the mount-time GET may answer AFTER a Check/Run
  // doctor POST. The late (empty-cache) GET must not overwrite the fresh result.
  it("a late mount-time GET does not overwrite a newer Check / Run doctor result", async () => {
    let resolveStatus!: (v: unknown) => void;
    let resolveDoctor!: (v: unknown) => void;
    mocks.llmAuthStatus.mockReturnValue(new Promise((r) => { resolveStatus = r; }));
    mocks.llmAuthDoctor.mockReturnValue(new Promise((r) => { resolveDoctor = r; }));
    mocks.llmAuthRecheck.mockResolvedValue({ status: 200, body: { status: statusSnapshot() } });
    mocks.llmAuthDoctorRecheck.mockResolvedValue({ status: 200, body: { report: doctorReport(false) } });
    render(<LlmAuthCard />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Claude: working")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run doctor" }));
    expect(await screen.findByText("Claude: no problems found")).toBeInTheDocument();
    resolveStatus({ status: null });
    resolveDoctor({ report: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("Claude: working")).toBeInTheDocument();
    expect(screen.getByText("Claude: no problems found")).toBeInTheDocument();
    expect(screen.queryByText(/Not checked yet/)).toBeNull();
    expect(screen.queryByText(/No doctor report yet/)).toBeNull();
  });
});

/**
 * Phase 2c task 12 (S1 entry point, S2-AC1…AC4): the card is an entry point
 * to the one sign-in window, holds the expected plan, and warns about the
 * plan and the method sessions really use — before and after a sign-in.
 */
describe("LlmAuthView — sign-in, plan and method (phase 2c)", () => {
  const view = (claude = {}, codex = {}, extra: Partial<Parameters<typeof LlmAuthView>[0]> = {}) =>
    render(<LlmAuthView status={{ tag: "ready", data: statusSnapshot(claude, codex) }} doctor={{ tag: "ready", data: null }} now={LLM_AUTH_NOW} {...extra} />);

  it("sign-in button per state: Sign in / Sign in again / Continue sign-in, opening the window", () => {
    view({ state: "not_signed_in" }, {}, { attempts: { codex: loginAttempt("codex", "awaiting_user") } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" }));
    expect(useStore.getState().loginDialog).toEqual({ provider: "claude", intent: "start", collapsed: false });
    fireEvent.click(screen.getByRole("button", { name: "Continue Codex sign-in" }));
    expect(useStore.getState().loginDialog).toEqual({ provider: "codex", intent: "resume", collapsed: false });
  });

  // saarinen S-4: when sign-in is broken, signing in is THE action (primary
  // weight); on a working provider it stays secondary.
  it("the sign-in button is primary only when the provider is not working", () => {
    view({ state: "not_signed_in" }, { state: "working" });
    expect(screen.getByRole("button", { name: "Sign in to Claude" }).className).toContain("btn-primary-aa");
    const codexButton = within(screen.getByTestId("llm-auth-status-codex")).getByRole("button");
    expect(codexButton.className).not.toContain("btn-primary-aa");
  });

  // saarinen S-5: the version has its own row and never breaks mid-number.
  it("shows the CLI path and version on separate rows; the version does not wrap", () => {
    view();
    const claude = screen.getByTestId("llm-auth-status-claude");
    const version = within(claude).getByText("Version").nextElementSibling as HTMLElement;
    expect(version.className).toContain("whitespace-nowrap");
    expect(version.className).not.toContain("break-all");
  });

  it("a finished attempt does not turn the button into Continue", () => {
    view({}, {}, { attempts: { claude: loginAttempt("claude", "succeeded") } });
    expect(screen.getByRole("button", { name: "Sign in to Claude again" })).toBeInTheDocument();
  });

  it("an empty status cache still offers sign-in for both providers", () => {
    render(<LlmAuthView status={{ tag: "ready", data: null }} doctor={{ tag: "ready", data: null }} now={LLM_AUTH_NOW} />);
    expect(screen.getByRole("button", { name: "Sign in to Claude" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to Codex" })).toBeInTheDocument();
  });

  it("S2-AC1: mismatch names both plans, offers another account and removing the expectation", () => {
    const onExpectedPlan = vi.fn();
    view({ plan: knownField("pro"), planCheck: "mismatch", expectedPlan: "max" }, {}, { onExpectedPlan });
    const block = screen.getByTestId("llm-auth-plan-claude");
    expect(block).toHaveTextContent("Expected max, signed in with pro");
    expect(within(block).getByRole("button", { name: "Sign in with another account" })).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("button", { name: "Remove the expectation" }));
    expect(onExpectedPlan).toHaveBeenCalledWith("claude", null);
  });

  it("S2-AC2/AC3: no expectation → no plan block; unknown → neutral 'not determined'", () => {
    view({ planCheck: "unset", expectedPlan: null }, { plan: { known: false }, planCheck: "unknown", expectedPlan: "plus" });
    expect(screen.queryByTestId("llm-auth-plan-claude")).toBeNull();
    const codex = screen.getByTestId("llm-auth-plan-codex");
    expect(codex).toHaveTextContent("plan not determined");
    expect(codex.className).not.toContain("text-cc-warning");
  });

  it("the expected plan is a closed list per provider with 'Any'; choosing calls back", () => {
    const onExpectedPlan = vi.fn();
    view({ expectedPlan: null, planCheck: "unset" }, { expectedPlan: "plus", planCheck: "unknown" }, { onExpectedPlan });
    const [claudeSel, codexSel] = screen.getAllByLabelText("Expected plan") as HTMLSelectElement[];
    expect([...claudeSel.options].map((o) => o.value)).toEqual(["", "pro", "max", "team", "enterprise"]);
    expect(codexSel.value).toBe("plus");
    fireEvent.change(claudeSel, { target: { value: "max" } });
    expect(onExpectedPlan).toHaveBeenCalledWith("claude", "max");
    fireEvent.change(codexSel, { target: { value: "" } });
    expect(onExpectedPlan).toHaveBeenCalledWith("codex", null);
  });

  it("S2-AC4: an overriding method is a warning before any sign-in; Codex alsoSet is a neutral note", () => {
    view(
      { effectiveMethod: { method: "env_token", source: "environment", variable: "CLAUDE_CODE_OAUTH_TOKEN" } },
      { effectiveMethod: { method: "subscription", source: "sign_in", alsoSet: { source: "settings", variable: "OPENAI_API_KEY" } } },
    );
    const claude = screen.getByTestId("llm-auth-method-claude");
    expect(claude).toHaveTextContent("CLAUDE_CODE_OAUTH_TOKEN");
    expect(claude.className).toContain("text-cc-warning");
    const codex = screen.getByTestId("llm-auth-method-codex");
    expect(codex).toHaveTextContent("OPENAI_API_KEY");
    expect(codex.className).not.toContain("text-cc-warning");
  });

  it("no axe violations with plan mismatch, method warning and a running attempt", async () => {
    const { container } = view(
      { plan: knownField("pro"), planCheck: "mismatch", expectedPlan: "max", effectiveMethod: { method: "env_token", source: "environment", variable: "ANTHROPIC_API_KEY" } },
      { planCheck: "unknown", expectedPlan: "pro" },
      { attempts: { codex: loginAttempt("codex", "awaiting_user") }, onExpectedPlan: () => {} },
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("LlmAuthCard — phase 2c wiring", () => {
  it("reads both sign-in attempts on mount: a running one shows Continue", async () => {
    mocks.llmAuthStatus.mockResolvedValue({ status: statusSnapshot() });
    mocks.llmLoginGet.mockImplementation((p: string) =>
      Promise.resolve({ status: 200, body: { attempt: p === "codex" ? loginAttempt("codex", "awaiting_user") : null } }),
    );
    render(<LlmAuthCard />);
    expect(await screen.findByRole("button", { name: "Continue Codex sign-in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to Claude again" })).toBeInTheDocument();
    expect(mocks.llmLoginGet).toHaveBeenCalledWith("claude");
    expect(mocks.llmLoginGet).toHaveBeenCalledWith("codex");
  });

  it("changing the expected plan PUTs settings and re-reads the status (warning clears by itself)", async () => {
    mocks.llmAuthStatus
      .mockResolvedValueOnce({ status: statusSnapshot({ plan: knownField("pro"), planCheck: "mismatch", expectedPlan: "max" }) })
      .mockResolvedValueOnce({ status: statusSnapshot({ plan: knownField("pro"), planCheck: "unset", expectedPlan: null }) });
    render(<LlmAuthCard />);
    const block = await screen.findByTestId("llm-auth-plan-claude");
    fireEvent.click(within(block).getByRole("button", { name: "Remove the expectation" }));
    expect(mocks.updateSettings).toHaveBeenCalledWith({ expectedPlans: { claude: null } });
    await waitFor(() => expect(screen.queryByTestId("llm-auth-plan-claude")).toBeNull());
  });

  it("records lastPromotedAt from the status for the 'sign-in restored' cards", async () => {
    mocks.llmAuthStatus.mockResolvedValue({ status: statusSnapshot({ lastPromotedAt: 777 }) });
    render(<LlmAuthCard />);
    await waitFor(() => expect(useStore.getState().llmAuthPromotedAt).toEqual({ claude: 777 }));
  });
});
