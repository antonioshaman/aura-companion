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
vi.mock("../../api.js", () => ({ api: { relaunchSession: (...a: unknown[]) => mockRelaunch(...a) } }));

const mockSend = vi.fn();
vi.mock("../../ws.js", () => ({
  sendToSession: (...a: unknown[]) => mockSend(...a),
  createClientMessageId: () => "cm-1",
}));

const appendMessage = vi.fn();
const storeState: { messages: Map<string, ChatMessage[]>; cliConnected: Map<string, boolean>; appendMessage: typeof appendMessage } = {
  messages: new Map(),
  cliConnected: new Map(),
  appendMessage,
};
vi.mock("../../store.js", () => {
  const useStore = (selector: (s: typeof storeState) => unknown) => selector(storeState);
  useStore.getState = () => storeState;
  return { useStore };
});

import { TurnFailureCard, TurnFailureNotice } from "./TurnFailureCard.js";
import { describeTurnFailure } from "../../../server/auth-status/auth-catalog.js";
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
    // auth_rejected → relogin instruction with the Codex command.
    expect(screen.getByText(/codex login --device-auth/)).toBeInTheDocument();
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
