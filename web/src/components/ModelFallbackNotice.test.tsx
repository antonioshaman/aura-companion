// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";

/**
 * ModelFallbackNotice — Task A.2. The ONE persistent in-session notice that
 * the session is running on a different model than the user chose. Two
 * sources feed it:
 *   - client notices (`modelSubstitutionNotices`: set_model gate substitution,
 *     reactive revert after a runtime failure), and
 *   - the server-recorded `session.model_fallback` (spawn substitution, Codex
 *     rejection, chain fallback, silence rotation) which survives reloads.
 * It names from→to + why, offers "Switch back" only when retrying can work,
 * and remembers a dismissal per fallback event across reloads.
 */

const mockSendToSession = vi.fn();
const mockRelaunchSession = vi.fn(async () => ({ ok: true }));
vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));
vi.mock("../api.js", () => ({
  api: { relaunchSession: (...args: unknown[]) => mockRelaunchSession(...(args as [])) },
}));

const actions = {
  clearModelSubstitutionNotice: vi.fn(),
  setPendingClaudeModelSwitch: vi.fn(),
  setPendingCodexModelSwitch: vi.fn(),
  clearPendingCodexModelSwitch: vi.fn(),
  updateSession: vi.fn(),
  setSdkSessions: vi.fn(),
};
let mockState: Record<string, unknown> = {};
vi.mock("../store.js", () => {
  const useStore = (selector: (s: Record<string, unknown>) => unknown) => selector(mockState);
  useStore.getState = () => mockState;
  return { useStore };
});

import { ModelFallbackNotice } from "./ModelFallbackNotice.js";

interface SetupOpts {
  backend?: "claude" | "codex";
  model?: string;
  clientNotice?: { requested: string; applied: string; reason: string };
  serverFallback?: { from: string; to: string; reason: string; detail?: string; at: number };
  cliConnected?: boolean;
  catalog?: Array<{ value: string; label: string; icon: string; status?: string }>;
}

function setup(opts: SetupOpts = {}) {
  const backend = opts.backend ?? "claude";
  const model = opts.model ?? "claude-opus-4-8";
  mockState = {
    ...actions,
    modelSubstitutionNotices: opts.clientNotice
      ? new Map([["s1", { ...opts.clientNotice, firedAt: 1 }]])
      : new Map(),
    sessions: new Map([
      ["s1", { session_id: "s1", model, backend_type: backend, ...(opts.serverFallback ? { model_fallback: opts.serverFallback } : {}) }],
    ]),
    sdkSessions: [{ sessionId: "s1", backendType: backend, model, cwd: "/r" }],
    cliConnected: new Map([["s1", opts.cliConnected ?? true]]),
    dynamicBackendModels: {
      claude: opts.catalog ?? [
        { value: "claude-opus-5", label: "Opus 5", icon: "" },
        { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
        { value: "claude-opus-4-7", label: "Opus 4.7", icon: "" },
      ],
      codex: [
        { value: "gpt-6.1-sol", label: "GPT-6.1 Sol", icon: "" },
        { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", icon: "" },
      ],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  setup();
});

describe("ModelFallbackNotice", () => {
  it("renders nothing when the session runs on the chosen model", () => {
    const { container } = render(<ModelFallbackNotice sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a server-recorded fallback with resolved labels, reason and detail (survives reload)", () => {
    setup({
      serverFallback: { from: "claude-opus-4-8", to: "claude-opus-4-7", reason: "unresponsive", detail: "went silent", at: 100 },
      model: "claude-opus-4-7",
    });
    render(<ModelFallbackNotice sessionId="s1" />);
    expect(screen.getByText(/Opus 4\.8 stopped responding on this session/)).toBeInTheDocument();
    expect(screen.getByText(/running on Opus 4\.7 instead/)).toBeInTheDocument();
    expect(screen.getByText("went silent")).toBeInTheDocument();
  });

  it("a client notice wins over the server record (most recent, in-tab decision)", () => {
    setup({
      clientNotice: { requested: "claude-opus-5", applied: "claude-opus-4-8", reason: "overloaded" },
      serverFallback: { from: "claude-opus-4-8", to: "claude-opus-4-7", reason: "unresponsive", at: 100 },
    });
    render(<ModelFallbackNotice sessionId="s1" />);
    expect(screen.getByText(/Opus 5 is temporarily overloaded/)).toBeInTheDocument();
    expect(screen.queryByText(/stopped responding/)).not.toBeInTheDocument();
  });

  it("Switch back (Claude) re-runs the optimistic set_model path toward the original model and hides the notice", () => {
    setup({
      serverFallback: { from: "claude-opus-4-8", to: "claude-opus-4-7", reason: "unresponsive", at: 100 },
      model: "claude-opus-4-7",
    });
    render(<ModelFallbackNotice sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch back to Opus 4.8" }));
    // Same single-marker contract as ModelSwitcher (revert target = current).
    expect(actions.setPendingClaudeModelSwitch).toHaveBeenCalledWith("s1", "claude-opus-4-8", "claude-opus-4-7");
    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "set_model", model: "claude-opus-4-8" });
    expect(actions.updateSession).toHaveBeenCalledWith("s1", { model: "claude-opus-4-8" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("Switch back (Codex) relaunches the same session on the original model", () => {
    setup({
      backend: "codex",
      model: "gpt-5.3-codex",
      serverFallback: { from: "gpt-6.1-sol", to: "gpt-5.3-codex", reason: "overloaded", at: 100 },
    });
    render(<ModelFallbackNotice sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch back to GPT-6.1 Sol" }));
    expect(actions.setPendingCodexModelSwitch).toHaveBeenCalledWith("s1", "gpt-6.1-sol");
    expect(mockRelaunchSession).toHaveBeenCalledWith("s1", { model: "gpt-6.1-sol" });
  });

  it.each(["rejected", "retired", "blocked", "cli-incompatible", "unavailable"])(
    "does NOT offer Switch back when retrying %s cannot work (honest: pick another model)",
    (reason) => {
      setup({ serverFallback: { from: "claude-opus-5", to: "claude-opus-4-8", reason, at: 100 } });
      render(<ModelFallbackNotice sessionId="s1" />);
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Switch back/ })).not.toBeInTheDocument();
    },
  );

  it("does NOT offer Switch back when the original model is now blocked in the catalogue", () => {
    setup({
      serverFallback: { from: "claude-opus-5", to: "claude-opus-4-8", reason: "overloaded", at: 100 },
      catalog: [
        { value: "claude-opus-5", label: "Opus 5", icon: "", status: "blocked" },
        { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
      ],
    });
    render(<ModelFallbackNotice sessionId="s1" />);
    expect(screen.queryByRole("button", { name: /Switch back/ })).not.toBeInTheDocument();
  });

  it("dismissing a server fallback hides it and stays hidden after a remount (reload)", () => {
    setup({ serverFallback: { from: "claude-opus-5", to: "claude-opus-4-8", reason: "rejected", at: 100 } });
    const { unmount } = render(<ModelFallbackNotice sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    unmount();
    render(<ModelFallbackNotice sessionId="s1" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("a NEW fallback event (different timestamp) shows again after an earlier dismissal", () => {
    setup({ serverFallback: { from: "claude-opus-5", to: "claude-opus-4-8", reason: "rejected", at: 100 } });
    const { unmount } = render(<ModelFallbackNotice sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    unmount();
    setup({ serverFallback: { from: "claude-opus-5", to: "claude-opus-4-8", reason: "rejected", at: 200 } });
    render(<ModelFallbackNotice sessionId="s1" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("dismissing a client notice clears it from the store", () => {
    setup({ clientNotice: { requested: "claude-opus-5", applied: "claude-opus-4-8", reason: "overloaded" } });
    render(<ModelFallbackNotice sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(actions.clearModelSubstitutionNotice).toHaveBeenCalledWith("s1");
  });

  it("passes axe accessibility checks", async () => {
    setup({
      serverFallback: { from: "claude-opus-4-8", to: "claude-opus-4-7", reason: "unresponsive", detail: "x", at: 100 },
    });
    const { axe } = await import("vitest-axe");
    const { container } = render(<ModelFallbackNotice sessionId="s1" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
