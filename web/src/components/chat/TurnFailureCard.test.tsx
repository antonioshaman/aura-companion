// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { axe } from "vitest-axe";

/**
 * Turn-failure card (LLM auth phase 1, task 14; spec story 3 S3-AC1…AC6).
 * Pins: every TurnFailureKind × provider renders its catalog title + ONE
 * action (Codex parity); window + reset and the other facts are shown; the
 * provider text is plain text (markup is not interpreted); axe is clean;
 * Retry sends the last user message exactly once and disappears; Retry is
 * not offered once a newer user message exists or the CLI is down; Restart
 * only calls the relaunch REST on click and reports a failure.
 */

const mockRelaunch = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockStatus = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("../../api.js", () => ({
  api: { relaunchSession: (...a: unknown[]) => mockRelaunch(...a), llmAuthStatus: (...a: unknown[]) => mockStatus(...a) },
}));

const mockSend = vi.fn();
vi.mock("../../ws.js", () => ({
  sendToSession: (...a: unknown[]) => mockSend(...a),
  createClientMessageId: () => "cm-1",
}));

const appendMessage = vi.fn();
const openLoginDialog = vi.fn();
const noteLlmAuthPromotedAt = vi.fn();
const storeState: {
  messages: Map<string, ChatMessage[]>;
  cliConnected: Map<string, boolean>;
  sessions: Map<string, { sessionGroupRole?: "orchestrator" | "observer" }>;
  llmAuthPromotedAt: Partial<Record<"claude" | "codex", number>>;
  appendMessage: typeof appendMessage;
  openLoginDialog: typeof openLoginDialog;
  noteLlmAuthPromotedAt: typeof noteLlmAuthPromotedAt;
} = {
  messages: new Map(),
  cliConnected: new Map(),
  sessions: new Map(),
  llmAuthPromotedAt: {},
  appendMessage,
  openLoginDialog,
  noteLlmAuthPromotedAt,
};
vi.mock("../../store.js", () => {
  const useStore = (selector: (s: typeof storeState) => unknown) => selector(storeState);
  useStore.getState = () => storeState;
  return { useStore };
});

import { TurnFailureCard, TurnFailureNotice } from "./TurnFailureCard.js";
import { describeSignInRestored, describeTurnFailure, describeTurnNeedsRetry } from "../../../server/auth-status/auth-catalog.js";
import { _resetPromotedAtLoaderForTest } from "../llm-login/sign-in-restored.js";
import { PROVIDER_IDS, TURN_FAILURE_KINDS, type TurnFailure } from "../../../server/auth-status/auth-types.js";
import type { ChatMessage } from "../../types.js";

const SID = "s1";

function failureMsg(failure: TurnFailure, id = "f1"): ChatMessage {
  return { id, role: "system", content: "x", timestamp: 1, systemVariant: "turn-failure", turnFailure: failure };
}

beforeEach(() => {
  vi.clearAllMocks();
  storeState.messages = new Map();
  storeState.cliConnected = new Map([[SID, true]]);
  storeState.sessions = new Map();
  storeState.llmAuthPromotedAt = {};
  mockStatus.mockResolvedValue({ status: null });
  _resetPromotedAtLoaderForTest();
});

describe("TurnFailureCard", () => {
  it("renders the catalog title for every kind × provider (Codex parity)", () => {
    for (const provider of PROVIDER_IDS) {
      for (const kind of TURN_FAILURE_KINDS) {
        const { unmount } = render(<TurnFailureCard failure={{ kind, provider, providerMessage: "p" }} />);
        expect(screen.getByRole("group", { name: describeTurnFailure(kind, provider).title })).toBeInTheDocument();
        unmount();
      }
    }
  });

  it("shows the window, reset time and the likely cause for extra usage", () => {
    render(
      <TurnFailureCard
        failure={{ kind: "extra_usage_exhausted", provider: "claude", providerMessage: "out of extra usage", window: "extra_usage", resetAt: Date.UTC(2026, 10, 14, 12), likelyCause: "model_outside_plan" }}
      />,
    );
    expect(screen.getByText(/Window: extra usage · resets/)).toBeInTheDocument();
    expect(screen.getByText(/selected model is not included in the plan/)).toBeInTheDocument();
  });

  it("says when credentials could not be compared and names the required CLI version", () => {
    const { unmount } = render(
      <TurnFailureCard failure={{ kind: "auth_rejected", provider: "codex", providerMessage: "401", credentialsCompared: false }} />,
    );
    expect(screen.getByText(/Could not compare this session's credentials/)).toBeInTheDocument();
    // auth_rejected → the sign-in window (phase 2c; was the manual command).
    expect(screen.getByRole("button", { name: "Sign in to Codex again" })).toBeInTheDocument();
    unmount();
    render(<TurnFailureCard failure={{ kind: "cli_outdated", provider: "claude", providerMessage: "version 2.1.280 required", requiredVersion: "2.1.280" }} />);
    expect(screen.getByText("Required CLI version: 2.1.280 or newer")).toBeInTheDocument();
  });

  it("renders the provider message as plain text, never markup or links", () => {
    const evil = '<a href="https://evil.example">click</a> **bold**';
    const { container } = render(<TurnFailureCard failure={{ kind: "network", provider: "claude", providerMessage: evil }} />);
    expect(screen.getByTestId("turn-failure-provider-message").textContent).toBe(evil);
    expect(container.querySelector('a[href^="https://"]')).toBeNull();
  });

  it("has no axe violations (limit window and restart variants)", async () => {
    const { container } = render(
      <div>
        <TurnFailureCard failure={{ kind: "limit_window", provider: "claude", providerMessage: "limit", window: "five_hour", resetAt: 1 }} />
        <TurnFailureCard failure={{ kind: "stale_session_credentials", provider: "codex", providerMessage: "401" }} onRestart={() => {}} />
        <TurnFailureCard failure={{ kind: "network", provider: "codex", providerMessage: "down" }} retry="ready" onRetry={() => {}} />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("TurnFailureNotice (store-connected)", () => {
  const network: TurnFailure = { kind: "network", provider: "claude", providerMessage: "Connection error." };

  it("Retry resends the last user message exactly once, then the button is gone", () => {
    const fm = failureMsg(network);
    storeState.messages.set(SID, [
      { id: "u0", role: "user", content: "older", timestamp: 0 },
      { id: "u1", role: "user", content: "do the thing", timestamp: 0 },
      fm,
    ]);
    render(<TurnFailureNotice sessionId={SID} message={fm} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(SID, expect.objectContaining({ type: "user_message", content: "do the thing", client_msg_id: "cm-1" }));
    expect(appendMessage).toHaveBeenCalledWith(SID, expect.objectContaining({ role: "user", content: "do the thing" }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByText("Sent again.")).toBeInTheDocument();
  });

  it("does not offer Retry once a newer user message exists, or while the CLI is disconnected", () => {
    const fm = failureMsg(network);
    storeState.messages.set(SID, [{ id: "u1", role: "user", content: "a", timestamp: 0 }, fm, { id: "u2", role: "user", content: "b", timestamp: 0 }]);
    const { unmount } = render(<TurnFailureNotice sessionId={SID} message={fm} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    unmount();
    storeState.messages.set(SID, [{ id: "u1", role: "user", content: "a", timestamp: 0 }, fm]);
    storeState.cliConnected = new Map([[SID, false]]);
    render(<TurnFailureNotice sessionId={SID} message={fm} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("Restart calls the relaunch REST only on click and surfaces a failure", async () => {
    const fm = failureMsg({ kind: "stale_session_credentials", provider: "codex", providerMessage: "401" });
    storeState.messages.set(SID, [fm]);
    mockRelaunch.mockRejectedValueOnce(new Error("boom"));
    render(<TurnFailureNotice sessionId={SID} message={fm} />);
    expect(mockRelaunch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restart the session" }));
    expect(mockRelaunch).toHaveBeenCalledWith(SID);
    await waitFor(() => expect(screen.getByText("Restart failed: boom")).toBeInTheDocument());
    mockRelaunch.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole("button", { name: "Restart the session" }));
    await waitFor(() => expect(screen.getByText("Restart requested.")).toBeInTheDocument());
    expect(mockRelaunch).toHaveBeenCalledTimes(2);
  });
});

/**
 * Phase 2c task 12 (S3-AC1/AC3/AC4/AC5): the sign-in action opens the
 * window; after a later successful sign-in the card reads "sign-in restored"
 * with Retry as the main action — selected from the card time vs the
 * provider's last promotion, never by rewriting the failure, and nothing is
 * sent without a click. The observer of a pair is labelled.
 */
describe("sign-in recovery (phase 2c)", () => {
  const authFail: TurnFailure = { kind: "auth_rejected", provider: "claude", providerMessage: "401 Unauthorized" };
  const withUser = (fm: ChatMessage) => storeState.messages.set(SID, [{ id: "u1", role: "user", content: "do it", timestamp: 0 }, fm]);

  it("the sign_in action opens the sign-in window for that provider", () => {
    render(<TurnFailureCard failure={authFail} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude again" }));
    expect(openLoginDialog).toHaveBeenCalledWith("claude", "start");
  });

  it("S3-AC1/AC5: promoted after the failure → 'sign-in restored' + Retry; nothing sent until the click", () => {
    const fm = { ...failureMsg(authFail), timestamp: 1000 };
    withUser(fm);
    storeState.llmAuthPromotedAt = { claude: 2000 };
    render(<TurnFailureNotice sessionId={SID} message={fm} />);
    expect(screen.getByRole("group", { name: describeSignInRestored("claude").title })).toHaveAttribute("data-recovery", "restored");
    expect(screen.queryByRole("button", { name: "Sign in to Claude again" })).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(SID, expect.objectContaining({ type: "user_message", content: "do it" }));
  });

  it("S3-AC4: no promotion for this provider (failed / cancelled sign-in, or the other provider) → card unchanged", () => {
    const fm = { ...failureMsg(authFail), timestamp: 1000 };
    withUser(fm);
    storeState.llmAuthPromotedAt = { codex: 5000 };
    render(<TurnFailureNotice sessionId={SID} message={fm} />);
    expect(screen.getByRole("group", { name: describeTurnFailure("auth_rejected", "claude").title })).toHaveAttribute("data-recovery", "none");
    expect(screen.getByRole("button", { name: "Sign in to Claude again" })).toBeInTheDocument();
  });

  it("a failure AFTER the last sign-in is not restored (it failed on the new sign-in)", () => {
    const fm = { ...failureMsg(authFail), timestamp: 3000 };
    withUser(fm);
    storeState.llmAuthPromotedAt = { claude: 2000 };
    render(<TurnFailureNotice sessionId={SID} message={fm} />);
    expect(screen.getByTestId("turn-failure-card")).toHaveAttribute("data-recovery", "none");
  });

  it("S3-AC3 (phase 2d): a stale-credentials failure at/after the sign-in → 'this turn needs to be repeated' + Retry, both providers", () => {
    // The server tags a failure of a session still on the old sign-in epoch
    // `stale_session_credentials`. When it fired after the promotion the turn
    // ran on the old sign-in while it changed: the card asks to repeat it,
    // and nothing is sent until the click.
    for (const provider of ["claude", "codex"] as const) {
      const fm = { ...failureMsg({ kind: "stale_session_credentials", provider, providerMessage: "401" }), timestamp: 3000 };
      withUser(fm);
      storeState.llmAuthPromotedAt = { [provider]: 2000 };
      const { unmount } = render(<TurnFailureNotice sessionId={SID} message={fm} />);
      expect(screen.getByTestId("turn-failure-card")).toHaveAttribute("data-recovery", "retry_needed");
      expect(screen.getByText(describeTurnNeedsRetry(provider).title)).toBeInTheDocument();
      expect(mockSend).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("a limit failure is never 'sign-in restored'", () => {
    const fm = { ...failureMsg({ kind: "limit_window", provider: "claude", providerMessage: "limit", window: "five_hour", resetAt: null }), timestamp: 1 };
    withUser(fm);
    storeState.llmAuthPromotedAt = { claude: 2000 };
    render(<TurnFailureNotice sessionId={SID} message={fm} />);
    expect(screen.getByTestId("turn-failure-card")).toHaveAttribute("data-recovery", "none");
    // Not a sign-in card: no status read for it.
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("a sign-in failure card reads the last promotion once (status), for both providers", async () => {
    const fm = { ...failureMsg({ kind: "auth_rejected", provider: "codex", providerMessage: "401" }), timestamp: 1 };
    withUser(fm);
    render(<TurnFailureNotice sessionId={SID} message={fm} />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
  });

  it("labels the observer of a Council pair", () => {
    const fm = { ...failureMsg(authFail), timestamp: 1 };
    withUser(fm);
    storeState.sessions = new Map([[SID, { sessionGroupRole: "observer" }]]);
    render(<TurnFailureNotice sessionId={SID} message={fm} />);
    expect(screen.getByText("observer")).toBeInTheDocument();
  });

  it("retry_needed variant (S3-AC3) and restored are axe-clean for both providers", async () => {
    const { container } = render(
      <div>
        {(["claude", "codex"] as const).flatMap((provider) => [
          <TurnFailureCard key={`${provider}-r`} failure={{ ...authFail, provider }} recovery="restored" retry="ready" onRetry={() => {}} observer />,
          <TurnFailureCard key={`${provider}-n`} failure={{ ...authFail, provider }} recovery="retry_needed" retry="ready" onRetry={() => {}} />,
        ])}
      </div>,
    );
    expect(screen.getAllByText(describeTurnNeedsRetry("claude").title).length).toBe(2);
    expect(await axe(container)).toHaveNoViolations();
  });
});
