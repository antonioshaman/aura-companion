// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { axe } from "vitest-axe";

/**
 * Guards-pack denial card (Claude-only). In Aura agent mode the CLI auto-denies
 * a guards hook "ask" without prompting; the server turns that into a
 * `guard_denied` message and this card lets the user approve exactly the
 * recorded command once, or dismiss it. These tests pin: render (rule,
 * command, reason without the agent-facing footer), axe, click → API with the
 * session + toolUseId (never a command string), store update on success, an
 * error stays visible, and the non-actionable states (allowed, dismissed,
 * deny-level, expired, no command) hide "Allow once".
 */

const mockAllow = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockDismiss = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("../api.js", () => ({
  api: {
    guardAllowOnce: (...args: unknown[]) => mockAllow(...args),
    guardDismiss: (...args: unknown[]) => mockDismiss(...args),
  },
}));

const resolveGuardDenial = vi.fn();
vi.mock("../store.js", () => {
  const state = { resolveGuardDenial: (...a: unknown[]) => resolveGuardDenial(...a) };
  const useStore = (selector: (s: typeof state) => unknown) => selector(state);
  useStore.getState = () => state;
  return { useStore };
});

import { GuardDenialBanner, GuardDenialCard, displayReason } from "./GuardDenialBanner.js";
import type { GuardDenial } from "../types.js";

const NOW = 1_800_000_000_000;

function denial(over: Partial<GuardDenial> = {}): GuardDenial {
  return {
    sessionId: "s1",
    toolUseId: "toolu_1",
    toolName: "Bash",
    rule: "service-restart",
    rules: ["service-restart"],
    level: "ask",
    reason:
      "[guards:service-restart] `systemctl restart bot.service` on remote host 'prod'.\n(guards decision: ask. Do not retry - ask the user.)",
    command: "ssh prod 'systemctl restart bot.service'",
    deniedAt: NOW - 30_000,
    status: "pending",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GuardDenialBanner (presentational)", () => {
  it("renders rule, exact command and the reason without the agent guidance footer", () => {
    render(<GuardDenialBanner denial={denial()} now={NOW} onAllowOnce={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("Guard blocked a command")).toBeInTheDocument();
    expect(screen.getByText("[service-restart]")).toBeInTheDocument();
    expect(screen.getByTestId("guard-denial-command")).toHaveTextContent("ssh prod 'systemctl restart bot.service'");
    expect(screen.getByText(/on remote host 'prod'/)).toBeInTheDocument();
    expect(screen.queryByText(/guards decision/)).not.toBeInTheDocument();
    // Pending + actionable is an alert (the agent is blocked waiting on the user).
    expect(screen.getByRole("alert")).toHaveAttribute("data-state", "actionable");
    expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });

  it("has no axe violations (actionable and resolved)", async () => {
    const { container, rerender } = render(
      <GuardDenialBanner denial={denial()} now={NOW} onAllowOnce={() => {}} onDismiss={() => {}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
    rerender(<GuardDenialBanner denial={denial({ status: "allowed", resolvedAt: NOW })} now={NOW} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("disables both actions while a request is in flight", () => {
    render(<GuardDenialBanner denial={denial()} now={NOW} pending onAllowOnce={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  });

  it.each([
    ["allowed", denial({ status: "allowed", resolvedAt: NOW }), /Allowed once/],
    ["dismissed", denial({ status: "dismissed", resolvedAt: NOW }), /Dismissed/],
  ])("resolved state %s shows a note and no buttons", (_name, d, note) => {
    render(<GuardDenialBanner denial={d} now={NOW} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByTestId("guard-denial-note")).toHaveTextContent(note);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    // deny-level rules (pkill) can never be allowed once — the hook ignores approvals for them too.
    ["deny", denial({ level: "deny", rule: "pkill", rules: ["pkill"] }), /cannot be allowed once/],
    // Past the server's 10-minute window the button would only produce a 409.
    ["expired", denial({ deniedAt: NOW - 11 * 60_000 }), /approval window/],
    // Without the server-recorded command there is nothing safe to approve.
    ["no-command", denial({ command: null }), /not recorded/],
  ])("%s state hides Allow once but keeps Dismiss", (_name, d, note) => {
    render(<GuardDenialBanner denial={d} now={NOW} onAllowOnce={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByTestId("guard-denial-note")).toHaveTextContent(note);
  });

  it("displayReason strips rule tags, the new footer and the legacy GUARDS_DISABLE hint", () => {
    expect(
      displayReason("[guards:a] one\n[guards:b] two\n(guards decision: ask. x)\n(Disable with GUARDS_DISABLE=a if this is a false positive.)"),
    ).toBe("one\ntwo");
  });
});

describe("GuardDenialCard (wired)", () => {
  it("Allow once calls the API with session + toolUseId only and resolves the store", async () => {
    mockAllow.mockResolvedValue({ ok: true, status: "allowed" });
    render(<GuardDenialCard denial={denial({ deniedAt: Date.now() })} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(resolveGuardDenial).toHaveBeenCalledWith("s1", "toolu_1", "allowed"));
    expect(mockAllow).toHaveBeenCalledWith("s1", "toolu_1");
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it("Dismiss calls the dismiss API and resolves the store", async () => {
    mockDismiss.mockResolvedValue({ ok: true, status: "dismissed" });
    render(<GuardDenialCard denial={denial({ deniedAt: Date.now() })} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(resolveGuardDenial).toHaveBeenCalledWith("s1", "toolu_1", "dismissed"));
    expect(mockDismiss).toHaveBeenCalledWith("s1", "toolu_1");
  });

  it("shows the server error and keeps the card actionable", async () => {
    mockAllow.mockRejectedValue(new Error("Cannot allow once: already_resolved"));
    render(<GuardDenialCard denial={denial({ deniedAt: Date.now() })} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByText("Cannot allow once: already_resolved")).toBeInTheDocument();
    expect(resolveGuardDenial).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled();
  });
});
