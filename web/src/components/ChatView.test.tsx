// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "vitest-axe/extend-expect";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

const mockRelaunchSession = vi.fn();
const mockSetCliReconnecting = vi.fn();

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

vi.mock("./AiValidationBadge.js", () => ({
  AiValidationBadge: () => <div data-testid="ai-validation-badge" />,
}));

import { ChatView } from "./ChatView.js";

function setupStore(overrides: {
  connectionStatus?: "connecting" | "connected" | "disconnected";
  cliConnected?: boolean;
  cliReconnecting?: boolean;
  hasPendingPerms?: boolean;
  hasAiResolved?: boolean;
  sessionGroupRole?: "orchestrator" | "observer";
} = {}) {
  const {
    connectionStatus = "connected",
    cliConnected = true,
    cliReconnecting = false,
    hasPendingPerms = false,
    hasAiResolved = false,
    sessionGroupRole,
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
});
