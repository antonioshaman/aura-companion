// @vitest-environment jsdom
/**
 * Tests for the OnboardingModal component (the first-run wizard).
 *
 * It appears on first launch when onboardingCompleted is false. Since the
 * 2026-11-15 council review (P1 #3) every provider step is built on the
 * in-browser sign-in (the same flow as Diagnostics → LLM sign-in):
 * - the wizard reads /api/llm-auth/status first and shows what is already
 *   signed in (a signed-in provider gets "Continue", no sign-in button);
 * - "Sign in to <provider>" embeds the sign-in panel inside the modal (the
 *   global SignInHost renders UNDER the modal, so it must not be used);
 * - a missing CLI shows the install command and "Check again";
 * - a token / API key is only an "Advanced" override;
 * - no terminal command the CLI does not have (the old `codex --login`);
 * - Escape = "set up later" (marks onboarding completed and closes);
 * - every step is axe-clean.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { axe } from "vitest-axe";

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  getSettings: vi.fn(),
  llmAuthStatus: vi.fn(),
  llmAuthRecheck: vi.fn(),
  llmLoginStart: vi.fn(),
  llmLoginGet: vi.fn(),
  llmLoginCode: vi.fn(),
  llmLoginCancel: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mocks }));

import { OnboardingModal, CLI_INSTALL_COMMAND } from "./OnboardingModal.js";
import { statusSnapshot } from "./diagnostics/llm-auth-fixtures.js";
import { loginAttempt } from "./llm-login/login-fixtures.js";

const ok = (body: object, status = 200) => Promise.resolve({ status, body });

/** Neither provider signed in (the common fresh-install state). */
const NOBODY = statusSnapshot({ state: "not_signed_in" }, { state: "not_signed_in" });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.updateSettings.mockResolvedValue({});
  mocks.getSettings.mockResolvedValue({});
  mocks.llmAuthStatus.mockResolvedValue({ status: NOBODY });
  mocks.llmAuthRecheck.mockResolvedValue({ status: 200, body: {} });
  mocks.llmLoginGet.mockReturnValue(ok({ attempt: null }));
  mocks.llmLoginCancel.mockReturnValue(ok({ attempt: null }));
});

/** Open a provider step and wait until its status has been read. */
async function openStep(name: "Claude Code" | "Codex") {
  fireEvent.click(screen.getByText(name));
  await waitFor(() => expect(screen.queryByText(/^Checking /)).not.toBeInTheDocument());
}

describe("OnboardingModal", () => {
  it("renders the welcome step with provider options", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    expect(screen.getByText("Welcome to Aura Companion")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    // Status badges appear once the server answered.
    await waitFor(() => expect(screen.getAllByText("Not signed in")).toHaveLength(2));
  });

  it("marks an already signed-in provider on the welcome step", async () => {
    mocks.llmAuthStatus.mockResolvedValue({ status: statusSnapshot({ state: "working" }, { state: "not_signed_in" }) });
    render(<OnboardingModal onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Signed in")).toBeInTheDocument());
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
  });

  it("navigates to Claude setup when Claude Code is clicked — sign-in button, no terminal command", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    expect(screen.getByText("Set up Claude Code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to Claude Code" })).toBeInTheDocument();
    // The token command lives only behind the Advanced override.
    expect(screen.queryByText("claude setup-token")).not.toBeInTheDocument();
  });

  it("navigates to Codex setup when Codex is clicked — never the non-existent `codex --login`", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Codex");
    expect(screen.getByText("Set up Codex")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to Codex" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("codex --login");
  });

  it("skips all setup when skip link is clicked", async () => {
    const onComplete = vi.fn();
    render(<OnboardingModal onComplete={onComplete} />);
    fireEvent.click(screen.getByText(/Skip setup/));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith({ onboardingCompleted: true }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it("Escape means 'set up later': completes onboarding and closes", async () => {
    const onComplete = vi.fn();
    render(<OnboardingModal onComplete={onComplete} />);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith({ onboardingCompleted: true }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it("saves an advanced Claude token and navigates to Codex step", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    fireEvent.click(screen.getByText(/Advanced: paste an OAuth token/));
    // The terminal hint for the headless token is part of the override.
    expect(screen.getByText("claude setup-token")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Claude OAuth token"), { target: { value: "test-oauth-token" } });
    fireEvent.click(screen.getByText("Save token"));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith({ claudeCodeOAuthToken: "test-oauth-token" }));
    await waitFor(() => expect(screen.getByText("Set up Codex")).toBeInTheDocument());
  });

  it("skips Claude step and goes to Codex", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    fireEvent.click(screen.getByText("Skip"));
    expect(screen.getByText("Set up Codex")).toBeInTheDocument();
  });

  it("saves an advanced Codex API key and completes onboarding", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Codex");
    fireEvent.click(screen.getByText(/Advanced: use an OpenAI API key/));
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-test-key" } });
    fireEvent.click(screen.getByText("Save API key"));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith({ openaiApiKey: "sk-test-key" }));
    await waitFor(() => expect(screen.getByText("Get Started")).toBeInTheDocument());
    expect(screen.getByText("Codex is ready.")).toBeInTheDocument();
  });

  it("navigates back from Codex to Claude step", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Codex");
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText("Set up Claude Code")).toBeInTheDocument();
  });

  it("shows done step with correct configured status", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    fireEvent.click(screen.getByText(/Advanced: paste an OAuth token/));
    fireEvent.change(screen.getByLabelText("Claude OAuth token"), { target: { value: "token" } });
    fireEvent.click(screen.getByText("Save token"));
    await waitFor(() => expect(screen.getByText("Set up Codex")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Skip"));
    await waitFor(() => {
      expect(screen.getByText("You're all set!")).toBeInTheDocument();
      expect(screen.getByText("Claude Code is ready.")).toBeInTheDocument();
    });
  });

  it("shows 'Setup Skipped' when no providers configured", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    fireEvent.click(screen.getByText("Skip"));
    fireEvent.click(screen.getByText("Skip"));
    await waitFor(() => expect(screen.getByText("Setup Skipped")).toBeInTheDocument());
  });

  it("calls onComplete when Get Started is clicked on done step", async () => {
    const onComplete = vi.fn();
    render(<OnboardingModal onComplete={onComplete} />);
    await openStep("Claude Code");
    fireEvent.click(screen.getByText("Skip"));
    fireEvent.click(screen.getByText("Skip"));
    await waitFor(() => expect(screen.getByText("Get Started")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Get Started"));
    expect(onComplete).toHaveBeenCalled();
  });

  it("displays error when save fails", async () => {
    mocks.updateSettings.mockRejectedValueOnce(new Error("Network error"));
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    fireEvent.click(screen.getByText(/Advanced: paste an OAuth token/));
    fireEvent.change(screen.getByLabelText("Claude OAuth token"), { target: { value: "bad-token" } });
    fireEvent.click(screen.getByText("Save token"));
    await waitFor(() => expect(screen.getByText("Network error")).toBeInTheDocument());
  });

  // Verifies the Codex save error branch is exercised
  it("displays error when Codex save fails", async () => {
    mocks.updateSettings.mockRejectedValueOnce(new Error("API key invalid"));
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Codex");
    fireEvent.click(screen.getByText(/Advanced: use an OpenAI API key/));
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "bad-key" } });
    fireEvent.click(screen.getByText("Save API key"));
    await waitFor(() => expect(screen.getByText("API key invalid")).toBeInTheDocument());
  });

  // Replaces the old "I've logged in" check: an already signed-in Codex is
  // read from the status endpoint and goes straight to "Continue".
  it("an already signed-in Codex shows its account and Continue finishes onboarding", async () => {
    mocks.llmAuthStatus.mockResolvedValue({ status: statusSnapshot({ state: "not_signed_in" }, { state: "working" }) });
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Codex");
    expect(screen.getByText("Codex is signed in as owner@example.com.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in to Codex" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(screen.getByText("You're all set!")).toBeInTheDocument());
    expect(screen.getByText("Codex is ready.")).toBeInTheDocument();
  });

  // Replaces the old "No Codex auth found. Run codex --login" error: the
  // sign-in now happens inside the wizard (embedded panel, real REST calls).
  it("'Sign in to Codex' starts the in-browser sign-in inside the modal and shows the device code", async () => {
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user"), existing: false }, 201));
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user") }));
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Codex");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex" }));
    await waitFor(() => expect(mocks.llmLoginStart).toHaveBeenCalledWith("codex"));
    const panel = await screen.findByTestId("sign-in-panel");
    // Inside the wizard's dialog, not the global host.
    // The dialog is named by the current step's heading (watson P2-7).
    expect(screen.getByRole("dialog", { name: "Set up Codex" })).toContainElement(panel);
    await waitFor(() => expect(screen.getByText("ABCD-12345")).toBeInTheDocument());
  });

  it("closing the embedded sign-in while it runs cancels the attempt", async () => {
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user"), existing: false }, 201));
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user") }));
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Codex");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex" }));
    await waitFor(() => expect(screen.getByTestId("sign-in-panel")).toHaveAttribute("data-state", "awaiting_user"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(mocks.llmLoginCancel).toHaveBeenCalled());
    expect(screen.queryByTestId("sign-in-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to Codex" })).toBeInTheDocument();
  });

  it("a successful embedded sign-in turns the step into 'signed in' with Continue", async () => {
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: loginAttempt("claude", "succeeded"), existing: false }, 201));
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: loginAttempt("claude", "succeeded") }));
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    // After success the status endpoint reports Claude working.
    mocks.llmAuthStatus.mockResolvedValue({ status: statusSnapshot({ state: "working" }, { state: "not_signed_in" }) });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude Code" }));
    await waitFor(() => expect(screen.getByText("Claude Code is signed in as owner@example.com.")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Set up Codex")).toBeInTheDocument();
  });

  it("a missing CLI shows the install command and 'Check again' re-reads the status", async () => {
    mocks.llmAuthStatus.mockResolvedValue({
      status: statusSnapshot({ state: "not_verified", reason: "cli_missing" }, { state: "not_signed_in" }),
    });
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    expect(screen.getByText(CLI_INSTALL_COMMAND.claude)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in to Claude Code" })).not.toBeInTheDocument();
    mocks.llmAuthStatus.mockResolvedValue({ status: NOBODY });
    fireEvent.click(screen.getByText("Check again"));
    await waitFor(() => expect(mocks.llmAuthRecheck).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in to Claude Code" })).toBeInTheDocument());
  });

  it("a failed status read still offers sign-in", async () => {
    mocks.llmAuthStatus.mockRejectedValue(new Error("offline"));
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    expect(screen.getByRole("button", { name: "Sign in to Claude Code" })).toBeInTheDocument();
  });

  // Verifies copy button works on the install command (CopyButton component)
  it("renders copy button on the install command", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    mocks.llmAuthStatus.mockResolvedValue({
      status: statusSnapshot({ state: "not_signed_in" }, { state: "not_verified", reason: "cli_missing" }),
    });
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Codex");
    fireEvent.click(screen.getByLabelText("Copy command"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CLI_INSTALL_COMMAND.codex);
  });

  // Verifies error is cleared when navigating between steps
  it("clears error when navigating between steps", async () => {
    mocks.updateSettings.mockRejectedValueOnce(new Error("Save failed"));
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    fireEvent.click(screen.getByText(/Advanced: paste an OAuth token/));
    fireEvent.change(screen.getByLabelText("Claude OAuth token"), { target: { value: "bad-token" } });
    fireEvent.click(screen.getByText("Save token"));
    await waitFor(() => expect(screen.getByText("Save failed")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Skip"));
    expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
  });

  // watson P2-7: a step change must tell a screen reader where the user is —
  // focus lands on the step heading (not mid-content on "Copy command"), the
  // dialog is named by it, and the step indicator speaks real text.
  it("each step change focuses the step heading, names the dialog by it and announces 'Step x of y'", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Welcome to Aura Companion" })).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Welcome to Aura Companion" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 3");
    await openStep("Claude Code");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Set up Claude Code" })).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Set up Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Step 2 of 3");
  });

  // watson P2-8: a control that disables itself while saving drops focus to
  // <body>; the next Tab must come back into the dialog, not reach the app
  // behind the overlay.
  it("Tab from outside the dialog (focus fell to <body>) is pulled back into the dialog", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("passes accessibility audit", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText("Not signed in")).toHaveLength(2));
    expect(await axe(document.body)).toHaveNoViolations();
  });

  // Per-step axe scans (review P1 #3): each screen a first-time user sees.
  it("every step is axe-clean (provider steps, advanced override, embedded sign-in, done)", async () => {
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: loginAttempt("claude", "awaiting_user"), existing: false }, 201));
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: loginAttempt("claude", "awaiting_user") }));
    render(<OnboardingModal onComplete={vi.fn()} />);
    await openStep("Claude Code");
    expect(await axe(document.body)).toHaveNoViolations();
    fireEvent.click(screen.getByText(/Advanced: paste an OAuth token/));
    expect(await axe(document.body)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude Code" }));
    await waitFor(() => expect(screen.getByTestId("sign-in-panel")).toHaveAttribute("data-state", "awaiting_user"));
    expect(await axe(document.body)).toHaveNoViolations();
    fireEvent.click(screen.getByText("Skip"));
    expect(await axe(document.body)).toHaveNoViolations();
    fireEvent.click(screen.getByText("Skip"));
    await waitFor(() => expect(screen.getByText("Setup Skipped")).toBeInTheDocument());
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
