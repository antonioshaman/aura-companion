// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "vitest-axe/extend-expect";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

const mockRelaunchSession = vi.fn();
const mockSetCliReconnecting = vi.fn();

// Model Registry Task 9 — action spies asserted by the substitution tests.
const mockClearModelSubstitutionNotice = vi.fn();
const mockClearPendingCrossTierSwitch = vi.fn();
const mockSetPendingClaudeModelSwitch = vi.fn();
const mockUpdateSession = vi.fn();
const mockSetSdkSessions = vi.fn();

let mockStoreState: Record<string, unknown> = {};

vi.mock("../store.js", () => {
  const useStore = (selector: (state: Record<string, unknown>) => unknown) => {
    return selector(mockStoreState);
  };
  useStore.getState = () => mockStoreState;
  return { useStore };
});

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: (...args: unknown[]) => mockRelaunchSession(...args),
  },
}));

vi.mock("../analytics.js", () => ({
  captureException: vi.fn(),
}));

const mockSendToSession = vi.fn();
vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

// Stub child components to isolate ChatView logic
vi.mock("./MessageFeed.js", () => ({
  MessageFeed: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="message-feed">{sessionId}</div>
  ),
}));

vi.mock("./Composer.js", () => ({
  Composer: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="composer">{sessionId}</div>
  ),
}));

vi.mock("./PermissionBanner.js", () => ({
  PermissionBanner: () => <div data-testid="permission-banner" />,
}));

// PLAN T12 (Phase G) - mock CliFailedBanner so the priority chain
// test can assert which banner occupies the slot without rendering
// the full component implementation.
vi.mock("./CliFailedBanner.js", () => ({
  CliFailedBanner: ({ failure }: { failure: { reason: string } }) => (
    <div data-testid="cli-failed-banner" data-reason={failure.reason} />
  ),
}));

vi.mock("./AiValidationBadge.js", () => ({
  AiValidationBadge: () => <div data-testid="ai-validation-badge" />,
}));

// Model Registry Task 9 — stub the two substitution surfaces so ChatView's
// wiring (which slot, which labels, which callback) is asserted without
// pulling in the portal/focus-trap machinery (covered in their own tests).
vi.mock("./ModelFallbackBanner.js", () => ({
  ModelFallbackBanner: ({
    fromModel,
    toModel,
    reason,
    onDismiss,
  }: {
    fromModel: string;
    toModel: string;
    reason?: string;
    onDismiss?: () => void;
  }) => (
    <div
      data-testid="model-fallback-banner"
      data-from={fromModel}
      data-to={toModel}
      data-reason={reason}
    >
      <button data-testid="model-fallback-dismiss" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  ),
}));

vi.mock("./ModelSubstitutionDialog.js", () => ({
  ModelSubstitutionDialog: ({
    fromModel,
    toModel,
    onConfirm,
    onCancel,
  }: {
    fromModel: string;
    toModel: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) => (
    <div data-testid="model-substitution-dialog" data-from={fromModel} data-to={toModel}>
      <button data-testid="model-substitution-confirm" onClick={onConfirm}>
        confirm
      </button>
      <button data-testid="model-substitution-cancel" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}));

import { ChatView } from "./ChatView.js";

function setupStore(overrides: {
  connectionStatus?: "connecting" | "connected" | "disconnected";
  cliConnected?: boolean;
  cliReconnecting?: boolean;
  hasPendingPerms?: boolean;
  hasAiResolved?: boolean;
  sessionGroupRole?: "orchestrator" | "observer";
  cliFailureReason?: "relaunch_exhausted" | "container_missing" | "container_stopped" | "binary_missing" | "browser_closed_no_reconnect";
  substitutionNotice?: { requested: string; applied: string; reason: "retired" | "blocked" | "overloaded" };
  crossTierSwitch?: { requested: string; replacement: string; previousModel: string };
} = {}) {
  const {
    connectionStatus = "connected",
    cliConnected = true,
    cliReconnecting = false,
    hasPendingPerms = false,
    hasAiResolved = false,
    sessionGroupRole,
    cliFailureReason,
    substitutionNotice,
    crossTierSwitch,
  } = overrides;

  const connMap = new Map<string, string>();
  connMap.set("s1", connectionStatus);

  const cliMap = new Map<string, boolean>();
  cliMap.set("s1", cliConnected);

  const reconnMap = new Map<string, boolean>();
  if (cliReconnecting) reconnMap.set("s1", true);

  const pendingPerms = new Map();
  if (hasPendingPerms) {
    const permsForSession = new Map();
    permsForSession.set("perm1", { request_id: "perm1", tool: "Bash", command: "ls" });
    pendingPerms.set("s1", permsForSession);
  }

  const aiResolved = new Map();
  if (hasAiResolved) {
    aiResolved.set("s1", [{ tool: "Read", decision: "approved" }]);
  }

  // Sessions map — ChatView reads `sessions.get(sessionId)?.sessionGroupRole`
  // to decide whether to mount Composer (observer half: NO composer).
  const sessionsMap = new Map<string, { sessionGroupRole?: "orchestrator" | "observer" }>();
  sessionsMap.set("s1", sessionGroupRole !== undefined ? { sessionGroupRole } : {});

  mockStoreState = {
    connectionStatus: connMap,
    cliConnected: cliMap,
    cliReconnecting: reconnMap,
    pendingPermissions: pendingPerms,
    aiResolvedPermissions: aiResolved,
    clearAiResolvedPermissions: vi.fn(),
    setCliReconnecting: mockSetCliReconnecting,
    sessions: sessionsMap,
    // Council Mode slice — ChatView reads `groupBySessionId`, `findings`,
    // `dismissedStopIds`, and `dismissStop` to render the BlockerBanner
    // in the permission slot. Empty maps mean no blocker is shown.
    groupBySessionId: new Map(),
    findings: new Map(),
    dismissedStopIds: new Set(),
    dismissStop: vi.fn(),
    // PLAN T12 (Phase G) - cli-status-slice state + draft-stash actions
    // that the cli-failed primary action wires.
    cliFailures: cliFailureReason
      ? new Map([["s1", { reason: cliFailureReason, drainedCount: 0, subprocessAlive: false, firedAt: 1_000 }]])
      : new Map(),
    setPendingDraftForNextSession: vi.fn(),
    newSession: vi.fn(),
    // Model Registry Task 9 — substitution surfaces. The catalog gives the
    // human labels ChatView resolves model ids against; the two maps drive
    // the additive notice banner and the cross-tier confirmation dialog.
    modelSubstitutionNotices: substitutionNotice
      ? new Map([["s1", { ...substitutionNotice, firedAt: 1_000 }]])
      : new Map(),
    pendingCrossTierSwitches: crossTierSwitch
      ? new Map([["s1", { ...crossTierSwitch, firedAt: 1_000 }]])
      : new Map(),
    // Task 10 — the announcer live region reads this map; ChatView mounts it
    // unconditionally, so the mock store must provide it even when empty.
    modelAvailabilityAnnouncements: new Map(),
    clearModelSubstitutionNotice: mockClearModelSubstitutionNotice,
    clearPendingCrossTierSwitch: mockClearPendingCrossTierSwitch,
    setPendingClaudeModelSwitch: mockSetPendingClaudeModelSwitch,
    updateSession: mockUpdateSession,
    setSdkSessions: mockSetSdkSessions,
    sdkSessions: [],
    dynamicBackendModels: {
      claude: [
        { value: "claude-opus-4-7", label: "Opus 4.7" },
        { value: "claude-haiku-4-5", label: "Haiku 4.5" },
        { value: "claude-opus-4-8", label: "Opus 4.8" },
      ],
      codex: [],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  setupStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatView", () => {
  // Renders core children (MessageFeed + Composer)
  it("renders MessageFeed and Composer", () => {
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("message-feed")).toBeTruthy();
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  // Accessibility scan — needs real timers for async axe import
  it("has no axe violations", { timeout: 15000 }, async () => {
    vi.useRealTimers();
    const { axe } = await import("vitest-axe");
    const { container } = render(<ChatView sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Banner visibility: no banner when CLI is connected
  it("does not show CLI banner when cliConnected=true", () => {
    setupStore({ cliConnected: true });
    render(<ChatView sessionId="s1" />);
    expect(screen.queryByText("CLI disconnected")).toBeNull();
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
  });

  // Banner: shows disconnected state with Reconnect button
  it("shows 'CLI disconnected' banner with Reconnect button when CLI is disconnected", () => {
    setupStore({ cliConnected: false });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByText("CLI disconnected")).toBeTruthy();
    expect(screen.getByText("Reconnect")).toBeTruthy();
  });

  // Banner: shows reconnecting state with spinner, no button
  it("shows spinner and 'Reconnecting' text when cliReconnecting=true", () => {
    setupStore({ cliConnected: false, cliReconnecting: true });
    render(<ChatView sessionId="s1" />);
    // Should show reconnecting text (uses &hellip; entity, rendered as "Reconnecting…")
    expect(screen.getByText(/Reconnecting/)).toBeTruthy();
    // The Reconnect button should NOT be visible during reconnecting
    expect(screen.queryByText("Reconnect")).toBeNull();
    // Spinner element should be present (identified by animate-spin class)
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeTruthy();
  });

  // Click handler: calls api.relaunchSession and sets reconnecting state
  it("calls api.relaunchSession and sets reconnecting state on click", async () => {
    setupStore({ cliConnected: false });
    mockRelaunchSession.mockResolvedValue({ ok: true });

    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByText("Reconnect"));

    // Should set reconnecting state immediately
    expect(mockSetCliReconnecting).toHaveBeenCalledWith("s1", true);
    // Should call the API
    expect(mockRelaunchSession).toHaveBeenCalledWith("s1");
  });

  // Error: shows error message when relaunch fails
  it("shows error message and Retry button when relaunch fails", async () => {
    vi.useRealTimers();
    setupStore({ cliConnected: false });
    mockRelaunchSession.mockRejectedValue(new Error("Server error"));

    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByText("Reconnect"));

    // Wait for the error to appear
    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeTruthy();
    });
    // Should show Retry button
    expect(screen.getByText("Retry")).toBeTruthy();
    // Should have cleared reconnecting state
    expect(mockSetCliReconnecting).toHaveBeenCalledWith("s1", false);
  });

  // Error auto-clears after 4 seconds
  it("auto-clears error after 4 seconds", async () => {
    setupStore({ cliConnected: false });
    mockRelaunchSession.mockRejectedValue(new Error("Timeout"));

    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByText("Reconnect"));

    // Wait for error to show up
    await vi.waitFor(() => {
      expect(screen.getByText("Timeout")).toBeTruthy();
    });

    // Advance timers past the 4-second auto-clear
    vi.advanceTimersByTime(4100);

    // Error should be cleared, back to disconnected state
    await vi.waitFor(() => {
      expect(screen.queryByText("Timeout")).toBeNull();
      expect(screen.getByText("CLI disconnected")).toBeTruthy();
    });
  });

  // WebSocket disconnected banner
  it("shows 'Reconnecting to session...' when browser WS is disconnected", () => {
    setupStore({ connectionStatus: "disconnected", cliConnected: false });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByText("Reconnecting to session...")).toBeTruthy();
  });

  // Permission banners render when present
  it("renders permission banners when pending permissions exist", () => {
    setupStore({ hasPendingPerms: true });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("permission-banner")).toBeTruthy();
  });

  // AI validation badge renders when present
  it("renders AI validation badge when ai-resolved permissions exist", () => {
    setupStore({ hasAiResolved: true });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("ai-validation-badge")).toBeTruthy();
  });

  // ─── Council Mode: observer Composer suppression ────────────────────────
  // EC-1 server-side enforcement is the boundary; the ChatView guard is the
  // affordance. Mounting Composer under the observer half would expose a
  // toggle whose set_permission_mode the server rejects anyway — better not
  // to render. These tests anchor the structural invariant.

  it("does NOT mount Composer when sessionGroupRole is 'observer'", () => {
    setupStore({ sessionGroupRole: "observer" });
    render(<ChatView sessionId="s1" />);
    // Composer is mocked with data-testid="composer"; assert it's absent.
    expect(screen.queryByTestId("composer")).toBeNull();
    // Negative-control: MessageFeed (and the rest of chat surface) IS
    // rendered for the observer — only Composer is suppressed.
    expect(screen.getByTestId("message-feed")).toBeTruthy();
  });

  it("DOES mount Composer when sessionGroupRole is 'orchestrator'", () => {
    setupStore({ sessionGroupRole: "orchestrator" });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  it("DOES mount Composer when sessionGroupRole is undefined (non-council solo session)", () => {
    // Critical: undefined must not collapse to "observer". Strict equality
    // on the guard prevents accidentally suppressing Composer for every
    // non-council session.
    setupStore({ sessionGroupRole: undefined });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  // ─── PLAN T12 (Phase G) — banner priority chain ─────────────────────
  //
  // Priority ladder: permission > cliFailed > blocker. Only ONE banner
  // occupies the slot at a time. Mutation-resistant: reordering the
  // chain or dropping the cliFailed branch flips these.

  it("renders CliFailedBanner when cliFailures.has(sessionId) and no permissions pending", () => {
    setupStore({ cliFailureReason: "relaunch_exhausted" });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("cli-failed-banner")).toBeTruthy();
    expect(screen.queryByTestId("permission-banner")).toBeNull();
  });

  // Phase G observer STOP regression: a terminal cli_failed drains cliConnected
  // to false (ws.ts atomic indicator drain). Without the !cliFailure guard on
  // showCliBanner, the transient yellow "CLI disconnected / Reconnect" banner
  // renders SIMULTANEOUSLY with the red terminal CliFailedBanner, re-offering
  // the futile Reconnect affordance the cliFailed axis exists to suppress.
  // This test pins the PRODUCTION pairing (cliFailureReason set AND
  // cliConnected:false — the inverse of setupStore's cliConnected=true default)
  // and asserts the yellow reconnect banner is absent. Mutation-resistant:
  // reverting line-95 to drop `&& !cliFailure` makes both assertions fail.
  it("does NOT render the yellow CLI-disconnected/Reconnect banner alongside the terminal CliFailedBanner (production pairing: cliConnected=false + cliFailure set)", () => {
    setupStore({ cliFailureReason: "relaunch_exhausted", cliConnected: false });
    render(<ChatView sessionId="s1" />);
    // Terminal banner present...
    expect(screen.getByTestId("cli-failed-banner")).toBeTruthy();
    // ...and the transient yellow recovery banner is NOT.
    expect(screen.queryByText("CLI disconnected")).toBeNull();
    expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("permission banner WINS over cliFailed when both are present (Friedman R8 stacking)", () => {
    setupStore({ cliFailureReason: "relaunch_exhausted", hasPendingPerms: true });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("permission-banner")).toBeTruthy();
    expect(screen.queryByTestId("cli-failed-banner")).toBeNull();
  });

  it("does NOT render CliFailedBanner when cliFailures is empty (default state)", () => {
    setupStore();
    render(<ChatView sessionId="s1" />);
    expect(screen.queryByTestId("cli-failed-banner")).toBeNull();
  });

  // ─── Model Registry Task 9 — substitution UX (inform-vs-ask) ──────────
  //
  // Same-tier auto-swap surfaces an additive, dismissible notice banner;
  // cross-tier swap surfaces an explicit confirmation dialog. Neither is
  // priority-gated like the permission/cliFailed/blocker slot — a model
  // fallback is infrastructure info, not a tool-call decision.

  it("renders the ModelFallbackBanner notice with resolved labels when a substitution notice exists", () => {
    setupStore({ substitutionNotice: { requested: "claude-opus-4-7", applied: "claude-opus-4-8", reason: "retired" } });
    render(<ChatView sessionId="s1" />);
    const banner = screen.getByTestId("model-fallback-banner");
    // ids are resolved to human labels via the dynamic catalog.
    expect(banner.getAttribute("data-from")).toBe("Opus 4.7");
    expect(banner.getAttribute("data-to")).toBe("Opus 4.8");
    expect(banner.getAttribute("data-reason")).toBe("retired");
  });

  it("notice banner coexists with the chat (additive, not priority-gated) and Composer still mounts", () => {
    setupStore({ substitutionNotice: { requested: "claude-opus-4-7", applied: "claude-opus-4-8", reason: "blocked" } });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("model-fallback-banner")).toBeTruthy();
    // Not gated behind the permission/cliFailed/blocker slot.
    expect(screen.getByTestId("composer")).toBeTruthy();
    expect(screen.getByTestId("message-feed")).toBeTruthy();
  });

  it("dismissing the notice calls clearModelSubstitutionNotice for this session", () => {
    setupStore({ substitutionNotice: { requested: "claude-opus-4-7", applied: "claude-opus-4-8", reason: "retired" } });
    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByTestId("model-fallback-dismiss"));
    expect(mockClearModelSubstitutionNotice).toHaveBeenCalledWith("s1");
  });

  it("does NOT render the notice banner when no substitution notice exists", () => {
    setupStore();
    render(<ChatView sessionId="s1" />);
    expect(screen.queryByTestId("model-fallback-banner")).toBeNull();
  });

  it("renders the cross-tier confirmation dialog with resolved labels when a pending cross-tier switch exists", () => {
    setupStore({ crossTierSwitch: { requested: "claude-opus-4-7", replacement: "claude-haiku-4-5", previousModel: "claude-opus-4-8" } });
    render(<ChatView sessionId="s1" />);
    const dialog = screen.getByTestId("model-substitution-dialog");
    expect(dialog.getAttribute("data-from")).toBe("Opus 4.7");
    expect(dialog.getAttribute("data-to")).toBe("Haiku 4.5");
  });

  it("confirming the cross-tier dialog clears the pending switch, re-seeds the marker, and re-sends set_model toward the replacement", () => {
    setupStore({ crossTierSwitch: { requested: "claude-opus-4-7", replacement: "claude-haiku-4-5", previousModel: "claude-opus-4-8" } });
    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByTestId("model-substitution-confirm"));
    expect(mockClearPendingCrossTierSwitch).toHaveBeenCalledWith("s1");
    // Re-points the SINGLE pending marker toward the replacement (EC-41) — no
    // bespoke second in-flight marker.
    expect(mockSetPendingClaudeModelSwitch).toHaveBeenCalledWith("s1", "claude-haiku-4-5", "claude-opus-4-8");
    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "set_model", model: "claude-haiku-4-5" });
    expect(mockUpdateSession).toHaveBeenCalledWith("s1", { model: "claude-haiku-4-5" });
  });

  it("cancelling the cross-tier dialog clears the pending switch and sends nothing", () => {
    setupStore({ crossTierSwitch: { requested: "claude-opus-4-7", replacement: "claude-haiku-4-5", previousModel: "claude-opus-4-8" } });
    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByTestId("model-substitution-cancel"));
    expect(mockClearPendingCrossTierSwitch).toHaveBeenCalledWith("s1");
    expect(mockSendToSession).not.toHaveBeenCalled();
    expect(mockSetPendingClaudeModelSwitch).not.toHaveBeenCalled();
  });

  it("does NOT render the cross-tier dialog when no pending switch exists", () => {
    setupStore();
    render(<ChatView sessionId="s1" />);
    expect(screen.queryByTestId("model-substitution-dialog")).toBeNull();
  });
});
