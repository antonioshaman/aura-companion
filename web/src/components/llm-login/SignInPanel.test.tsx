// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { axe } from "vitest-axe";

/**
 * The sign-in window (LLM auth phase 2c, task 11; spec story 1, S2-AC3/AC4).
 * Pins:
 * - every LoginAttemptState × provider renders its catalog title and is axe-clean;
 * - Claude: link (new tab, noopener) + reply-code field + expiry, NO device
 *   code; Codex: link + device code + expiry + "checked N s ago", NO reply
 *   field (S1-AC1, Codex parity: a step the provider lacks is not shown);
 * - the reply code goes out as typed (with "#"), a refused code keeps the input;
 * - "Close" hides (chip stays, nothing cancelled) ≠ "Cancel sign-in" (POST cancel);
 * - a second tab / the CLI: start answers `existing` → "already in progress"
 *   with Continue / Cancel, no second attempt (S1-AC4);
 * - success: plan mismatch shows both values + "Sign in with another
 *   account"; "plan not determined" is neutral (S2-AC1/AC3); an overriding
 *   method is a warning (S2-AC4);
 * - failures: one recovery action; macOS-Claude (unsupported_platform) is a
 *   Terminal instruction, not a button (D6);
 * - focus returns to the opener on every close path (EC-39);
 * - late answers never roll the attempt back and a failed poll keeps it (EC-41);
 * - the link/code never reach document.title or the store.
 */

const mocks = vi.hoisted(() => ({
  llmLoginStart: vi.fn(),
  llmLoginGet: vi.fn(),
  llmLoginCode: vi.fn(),
  llmLoginCancel: vi.fn(),
  llmAuthStatus: vi.fn(),
}));
vi.mock("../../api.js", () => ({ api: mocks }));

import { SignInChip, SignInHost, SignInPanel, SLOW_START_MS, expiryText } from "./SignInPanel.js";
import { acceptAttempt, LOGIN_POLL_MS } from "./useLoginAttempt.js";
import { FAKE_CLAUDE_URL, FAKE_DEVICE_CODE, LOGIN_NOW, loginAttempt, loginView } from "./login-fixtures.js";
import { providerStatus } from "../diagnostics/llm-auth-fixtures.js";
import { useStore } from "../../store.js";
import { describeLoginAttempt, describeLoginFailure, manualSignInCommand } from "../../../server/auth-status/auth-catalog.js";
import { LOGIN_ATTEMPT_STATES, LOGIN_FAILURE_REASONS, PROVIDER_IDS, knownField } from "../../../server/auth-status/auth-types.js";

const ok = (body: object, status = 200) => Promise.resolve({ status, body });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.llmAuthStatus.mockResolvedValue({ status: null });
  useStore.getState().closeLoginDialog();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SignInPanel (presentational)", () => {
  it("renders every attempt state for both providers with the catalog title, axe-clean", async () => {
    for (const provider of PROVIDER_IDS) {
      for (const state of LOGIN_ATTEMPT_STATES) {
        const a = loginAttempt(provider, state);
        const { container, unmount } = render(<SignInPanel provider={provider} view={loginView(a)} now={LOGIN_NOW} onClose={() => {}} />);
        const title = state === "failed" ? describeLoginFailure("code_rejected", provider).title : describeLoginAttempt(state, provider).title;
        expect(screen.getByText(title)).toBeInTheDocument();
        expect(screen.getByTestId("sign-in-panel")).toHaveAttribute("data-state", state);
        expect(await axe(container)).toHaveNoViolations();
        unmount();
      }
    }
  });

  it("S1-AC1 Claude: link in a new tab without opener, reply-code field, expiry; no device code", () => {
    render(<SignInPanel provider="claude" view={loginView(loginAttempt("claude", "awaiting_user"))} now={LOGIN_NOW} />);
    const link = screen.getByRole("link", { name: "Open the sign-in page" });
    expect(link).toHaveAttribute("href", FAKE_CLAUDE_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByLabelText("Code from the sign-in page")).toBeInTheDocument();
    expect(screen.queryByTestId("sign-in-device-code")).toBeNull();
    expect(screen.getByTestId("sign-in-expiry")).toHaveTextContent("12 min left");
    // Claude has a code to submit: no "checked N s ago" polling line.
    expect(screen.getByTestId("sign-in-expiry")).not.toHaveTextContent("checked");
  });

  it("S1-AC1 Codex: device code large with copy, expiry + checked-ago; no reply-code field", () => {
    render(<SignInPanel provider="codex" view={loginView(loginAttempt("codex", "awaiting_user"))} now={LOGIN_NOW} />);
    expect(within(screen.getByTestId("sign-in-device-code")).getByText(FAKE_DEVICE_CODE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Code from the sign-in page")).toBeNull();
    expect(screen.queryByTestId("sign-in-reply-code")).toBeNull();
    expect(screen.getByTestId("sign-in-expiry")).toHaveTextContent(/12 min left · checked 3 s ago/);
  });

  it("copy buttons write the link / code to the clipboard and say so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SignInPanel provider="codex" view={loginView(loginAttempt("codex", "awaiting_user"))} now={LOGIN_NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith(FAKE_DEVICE_CODE);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("submits the reply code as typed (with #), by button and by Enter", () => {
    const onSubmitCode = vi.fn();
    render(<SignInPanel provider="claude" view={loginView(loginAttempt("claude", "awaiting_user"))} now={LOGIN_NOW} onSubmitCode={onSubmitCode} />);
    const input = screen.getByLabelText("Code from the sign-in page");
    const submit = screen.getByRole("button", { name: "Submit code" });
    expect(submit).toBeDisabled(); // empty input
    fireEvent.change(input, { target: { value: "  abc#def  " } });
    fireEvent.click(submit);
    expect(onSubmitCode).toHaveBeenLastCalledWith("abc#def");
    fireEvent.submit(input.closest("form")!);
    expect(onSubmitCode).toHaveBeenCalledTimes(2);
  });

  it("S1-AC3: a refused code shows the catalog text and tries left; the typed code stays", () => {
    const onSubmitCode = vi.fn();
    const { rerender } = render(
      <SignInPanel provider="claude" view={loginView(loginAttempt("claude", "awaiting_user"))} now={LOGIN_NOW} onSubmitCode={onSubmitCode} />,
    );
    const input = screen.getByLabelText("Code from the sign-in page");
    fireEvent.change(input, { target: { value: "not-a-code" } });
    rerender(
      <SignInPanel
        provider="claude"
        view={loginView(loginAttempt("claude", "awaiting_user", { codeError: "code_format", submissionsLeft: 4, version: 4 }))}
        now={LOGIN_NOW}
        onSubmitCode={onSubmitCode}
      />,
    );
    expect(screen.getByText(describeLoginFailure("code_format", "claude").title)).toBeInTheDocument();
    expect(screen.getByText(/4 tries left/)).toBeInTheDocument();
    expect(screen.getByLabelText("Code from the sign-in page")).toHaveValue("not-a-code");
    expect(screen.getByLabelText("Code from the sign-in page")).toHaveAttribute("aria-invalid", "true");
  });

  it("while the code is checked the submit button says so and is disabled", () => {
    render(<SignInPanel provider="claude" view={loginView(loginAttempt("claude", "awaiting_user", { submitting: true }))} now={LOGIN_NOW} />);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
  });

  it("starting: quiet for 10 s, then 'still starting' with Cancel", () => {
    const a = loginAttempt("codex", "starting", { startedAt: LOGIN_NOW });
    const { rerender } = render(<SignInPanel provider="codex" view={loginView(a)} now={LOGIN_NOW + 1000} onCancel={() => {}} />);
    expect(screen.queryByText(/Still starting/)).toBeNull();
    rerender(<SignInPanel provider="codex" view={loginView(a)} now={LOGIN_NOW + SLOW_START_MS + 1} onCancel={() => {}} />);
    expect(screen.getByText(/Still starting/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  });

  it("verifying offers no cancel (the new credentials are being moved in place)", () => {
    render(<SignInPanel provider="claude" view={loginView(loginAttempt("claude", "verifying"))} now={LOGIN_NOW} onCancel={() => {}} />);
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  });

  it("every failure reason renders for both providers; sign_in recovery is one 'Start again' button", async () => {
    for (const provider of PROVIDER_IDS) {
      for (const reason of LOGIN_FAILURE_REASONS) {
        const onStartAgain = vi.fn();
        const { unmount } = render(
          <SignInPanel provider={provider} view={loginView(loginAttempt(provider, "failed", { failure: reason }))} now={LOGIN_NOW} onStartAgain={onStartAgain} />,
        );
        const e = describeLoginFailure(reason, provider);
        expect(screen.getByText(e.title)).toBeInTheDocument();
        const again = screen.queryAllByRole("button", { name: "Start again" });
        expect(again).toHaveLength(e.action.kind === "sign_in" ? 1 : 0);
        if (again[0]) {
          fireEvent.click(again[0]);
          expect(onStartAgain).toHaveBeenCalledTimes(1);
        }
        unmount();
      }
    }
  });

  it("D6: macOS Claude (unsupported_platform) shows the Terminal command, no button", () => {
    render(<SignInPanel provider="claude" view={loginView(loginAttempt("claude", "failed", { failure: "unsupported_platform" }))} now={LOGIN_NOW} onStartAgain={() => {}} />);
    expect(screen.getByText(new RegExp(manualSignInCommand("claude")))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start again" })).toBeNull();
  });

  it("cancelled / expired offer 'Start again'", () => {
    for (const state of ["cancelled", "expired"] as const) {
      const { unmount } = render(<SignInPanel provider="codex" view={loginView(loginAttempt("codex", state))} now={LOGIN_NOW} onStartAgain={() => {}} />);
      expect(screen.getByRole("button", { name: "Start again" })).toBeInTheDocument();
      unmount();
    }
  });

  it("S1-AC2: success shows account and plan, and the status 'working · checked by sign-in'", () => {
    const status = providerStatus({ provider: "claude", verifiedBy: "login", planCheck: "unset", expectedPlan: null });
    render(<SignInPanel provider="claude" view={loginView(loginAttempt("claude", "succeeded"))} now={LOGIN_NOW} status={status} />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.getByText("max")).toBeInTheDocument();
    expect(screen.getByText("working · checked by sign-in")).toBeInTheDocument();
    // S2-AC2: no expectation → no plan warning at all.
    expect(screen.queryByTestId("sign-in-plan-check")).toBeNull();
  });

  it("S2-AC1: plan mismatch names both plans and offers another account", () => {
    const onStartAgain = vi.fn();
    const status = providerStatus({ provider: "claude", plan: knownField("pro"), planCheck: "mismatch", expectedPlan: "max" });
    render(
      <SignInPanel
        provider="claude"
        view={loginView(loginAttempt("claude", "succeeded", { result: { account: knownField("a@example.com"), plan: knownField("pro") } }))}
        now={LOGIN_NOW}
        status={status}
        onStartAgain={onStartAgain}
      />,
    );
    const block = screen.getByTestId("sign-in-plan-check");
    expect(block).toHaveTextContent(/Expected max, signed in with pro/);
    fireEvent.click(within(block).getByRole("button", { name: "Sign in with another account" }));
    expect(onStartAgain).toHaveBeenCalledTimes(1);
  });

  it("S2-AC3: plan not determined is neutral — no warning colour, no button, never 'as expected'", () => {
    const status = providerStatus({ provider: "codex", plan: { known: false }, planCheck: "unknown", expectedPlan: "pro" });
    render(<SignInPanel provider="codex" view={loginView(loginAttempt("codex", "succeeded"))} now={LOGIN_NOW} status={status} />);
    const block = screen.getByTestId("sign-in-plan-check");
    expect(block).toHaveTextContent("plan not determined");
    expect(block).not.toHaveTextContent("as expected");
    expect(block.className).not.toContain("text-cc-warning");
    expect(within(block).queryByRole("button")).toBeNull();
  });

  it("S2-AC4: a method that overrides the sign-in is a warning naming the variable; Codex alsoSet is a neutral note", () => {
    const claude = providerStatus({ provider: "claude", planCheck: "unset", effectiveMethod: { method: "env_token", source: "environment", variable: "ANTHROPIC_API_KEY" } });
    const { unmount } = render(<SignInPanel provider="claude" view={loginView(loginAttempt("claude", "succeeded"))} now={LOGIN_NOW} status={claude} />);
    const warn = screen.getByTestId("sign-in-effective-method");
    expect(warn).toHaveTextContent("ANTHROPIC_API_KEY");
    expect(warn.className).toContain("text-cc-warning");
    unmount();
    const codex = providerStatus({
      provider: "codex",
      planCheck: "unset",
      effectiveMethod: { method: "subscription", source: "sign_in", alsoSet: { source: "settings", variable: "OPENAI_API_KEY" } },
    });
    render(<SignInPanel provider="codex" view={loginView(loginAttempt("codex", "succeeded"))} now={LOGIN_NOW} status={codex} />);
    const note = screen.getByTestId("sign-in-effective-method");
    expect(note).toHaveTextContent("OPENAI_API_KEY");
    expect(note.className).not.toContain("text-cc-warning");
  });

  it("transport notices: no Aura token, foreign origin, cooldown", () => {
    const cases = [
      [{ kind: "unauthorized" }, /no Aura access token/],
      [{ kind: "forbidden" }, /COMPANION_ALLOWED_ORIGIN/],
      [{ kind: "cooldown", retryAfterMs: 4200 }, /in 5 s/],
    ] as const;
    for (const [notice, text] of cases) {
      const { unmount } = render(<SignInPanel provider="claude" view={loginView(null, { notice })} now={LOGIN_NOW} />);
      expect(screen.getByRole("status")).toHaveTextContent(text);
      unmount();
    }
  });

  it("Escape and Close call onClose", () => {
    const onClose = vi.fn();
    render(<SignInPanel provider="claude" view={loginView(loginAttempt("claude", "awaiting_user"))} now={LOGIN_NOW} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(screen.getByTestId("sign-in-panel"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("expiryText rounds minutes up and says when time is up", () => {
    expect(expiryText(LOGIN_NOW + 61_000, LOGIN_NOW)).toMatch(/2 min left$/);
    expect(expiryText(LOGIN_NOW - 1, LOGIN_NOW)).toMatch(/time is up$/);
  });
});

describe("SignInChip", () => {
  it("running: Continue + Cancel; finished: Show + Dismiss; axe-clean", async () => {
    const onOpen = vi.fn();
    const onCancel = vi.fn();
    const { container, rerender } = render(
      <SignInChip provider="codex" attempt={loginAttempt("codex", "awaiting_user")} onOpen={onOpen} onCancel={onCancel} />,
    );
    expect(screen.getByTestId("sign-in-chip")).toHaveTextContent(/Codex sign-in in progress · until/);
    // The chip never carries the link or the code.
    expect(screen.getByTestId("sign-in-chip")).not.toHaveTextContent(FAKE_DEVICE_CODE);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(await axe(container)).toHaveNoViolations();
    rerender(<SignInChip provider="codex" attempt={loginAttempt("codex", "succeeded")} />);
    expect(screen.getByRole("button", { name: "Show" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});

describe("SignInHost (store + REST)", () => {
  function opener() {
    render(
      <>
        <button type="button" onClick={() => useStore.getState().openLoginDialog("codex")}>
          Sign in
        </button>
        <SignInHost />
      </>,
    );
    const btn = screen.getByRole("button", { name: "Sign in" });
    btn.focus();
    fireEvent.click(btn);
    return btn;
  }

  it("nothing while no window is open", () => {
    const { container } = render(<SignInHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it("'Close' hides the window, keeps a chip and cancels nothing; focus returns to the opener (EC-39)", async () => {
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user"), existing: false }, 201));
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user") }));
    const btn = opener();
    expect(await screen.findByText(FAKE_DEVICE_CODE)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in to Codex" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("sign-in-panel")).toBeNull();
    expect(screen.getByTestId("sign-in-chip")).toBeInTheDocument();
    expect(mocks.llmLoginCancel).not.toHaveBeenCalled();
    expect(useStore.getState().loginDialog).toEqual({ provider: "codex", intent: "start", collapsed: true });
    await waitFor(() => expect(btn).toHaveFocus());
    // Continue re-opens the same attempt without a second start.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(FAKE_DEVICE_CODE)).toBeInTheDocument();
    expect(mocks.llmLoginStart).toHaveBeenCalledTimes(1);
  });

  it("Escape closes too and restores focus to the opener (EC-39)", async () => {
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user"), existing: false }, 201));
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user") }));
    const btn = opener();
    await screen.findByText(FAKE_DEVICE_CODE);
    fireEvent.keyDown(screen.getByTestId("sign-in-panel"), { key: "Escape" });
    expect(screen.getByTestId("sign-in-chip")).toBeInTheDocument();
    await waitFor(() => expect(btn).toHaveFocus());
  });

  it("'Cancel sign-in' POSTs cancel for the shown attempt", async () => {
    const a = loginAttempt("codex", "awaiting_user");
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: a, existing: false }, 201));
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: a }));
    mocks.llmLoginCancel.mockReturnValue(ok({ attempt: loginAttempt("codex", "cancelled", { version: 9 }) }));
    opener();
    await screen.findByText(FAKE_DEVICE_CODE);
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(mocks.llmLoginCancel).toHaveBeenCalledWith("codex", a.id);
    expect(await screen.findByText(describeLoginAttempt("cancelled", "codex").title)).toBeInTheDocument();
    // The link / code are gone with the finished attempt.
    expect(screen.queryByText(FAKE_DEVICE_CODE)).toBeNull();
  });

  it("finished attempt: Done closes the window and returns focus to the opener", async () => {
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: loginAttempt("codex", "succeeded"), existing: false }, 201));
    const btn = opener();
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(useStore.getState().loginDialog).toBeNull();
    await waitFor(() => expect(btn).toHaveFocus());
  });

  it("S1-AC4: a sign-in already running elsewhere is shown with Continue / Cancel, not started twice", async () => {
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user"), existing: true }));
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user") }));
    opener();
    const banner = await screen.findByTestId("sign-in-elsewhere");
    expect(banner).toHaveTextContent("already in progress");
    expect(within(banner).getByRole("button", { name: "Cancel sign-in" })).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole("button", { name: "Continue here" }));
    expect(screen.queryByTestId("sign-in-elsewhere")).toBeNull();
    expect(screen.getByText(FAKE_DEVICE_CODE)).toBeInTheDocument();
  });

  it("resume reads the attempt with GET and never starts one", async () => {
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: loginAttempt("claude", "awaiting_user") }));
    render(<SignInHost />);
    act(() => useStore.getState().openLoginDialog("claude", "resume"));
    expect(await screen.findByLabelText("Code from the sign-in page")).toBeInTheDocument();
    expect(mocks.llmLoginStart).not.toHaveBeenCalled();
  });

  it("the reply code is POSTed to the current attempt", async () => {
    const a = loginAttempt("claude", "awaiting_user");
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: a, existing: false }, 201));
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: a }));
    mocks.llmLoginCode.mockReturnValue(ok({ attempt: loginAttempt("claude", "verifying", { version: 5 }) }));
    render(<SignInHost />);
    act(() => useStore.getState().openLoginDialog("claude"));
    fireEvent.change(await screen.findByLabelText("Code from the sign-in page"), { target: { value: "abc#xyz" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    expect(mocks.llmLoginCode).toHaveBeenCalledWith("claude", a.id, "abc#xyz");
    expect(await screen.findByText(describeLoginAttempt("verifying", "claude").title)).toBeInTheDocument();
  });

  it("polls every 1.5 s while running, ignores a failed poll (EC-41) and stops when finished", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user"), existing: false }, 201));
    mocks.llmLoginGet
      .mockImplementationOnce(() => Promise.reject(new Error("offline")))
      .mockReturnValueOnce(ok({ attempt: loginAttempt("codex", "succeeded", { version: 7 }) }));
    render(<SignInHost />);
    act(() => useStore.getState().openLoginDialog("codex"));
    await screen.findByText(FAKE_DEVICE_CODE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_MS);
    });
    // The failed poll is a notice, not a result: the attempt stays on screen.
    expect(screen.getByText(FAKE_DEVICE_CODE)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/No connection to Aura/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_MS);
    });
    expect(await screen.findByText(describeLoginAttempt("succeeded", "codex").title)).toBeInTheDocument();
    const calls = mocks.llmLoginGet.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_MS * 3);
    });
    expect(mocks.llmLoginGet.mock.calls.length).toBe(calls);
    // After success the status is read once for the plan check.
    expect(mocks.llmAuthStatus).toHaveBeenCalledTimes(1);
  });

  it("no secrets outside the window: not in the title, not in the store", async () => {
    mocks.llmLoginStart.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user"), existing: false }, 201));
    mocks.llmLoginGet.mockReturnValue(ok({ attempt: loginAttempt("codex", "awaiting_user") }));
    render(<SignInHost />);
    act(() => useStore.getState().openLoginDialog("codex"));
    await screen.findByText(FAKE_DEVICE_CODE);
    expect(document.title).not.toContain(FAKE_DEVICE_CODE);
    expect(JSON.stringify(useStore.getState().loginDialog)).not.toMatch(/ABCD|example\.test/);
  });
});

describe("acceptAttempt (EC-41)", () => {
  it("same attempt: never goes back in version; another attempt or null replaces", () => {
    const v3 = loginAttempt("claude", "awaiting_user", { version: 3 });
    expect(acceptAttempt(v3, { ...v3, version: 2 })).toBe(false);
    expect(acceptAttempt(v3, { ...v3, version: 4 })).toBe(true);
    expect(acceptAttempt(v3, { ...v3, id: "f".repeat(32), version: 1 })).toBe(true);
    expect(acceptAttempt(null, v3)).toBe(true);
  });
});
