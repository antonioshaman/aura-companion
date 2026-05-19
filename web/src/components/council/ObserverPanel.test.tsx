// @vitest-environment jsdom

vi.hoisted(() => {
  Object.defineProperty(globalThis.window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  if (typeof globalThis.localStorage === "undefined" || typeof globalThis.localStorage.getItem !== "function") {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
        get length() { return store.size; },
        key: (i: number) => [...store.keys()][i] ?? null,
      },
      writable: true,
      configurable: true,
    });
  }
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useStore } from "../../store.js";
import { ObserverPanel } from "./ObserverPanel.js";
import type { GroupRecord } from "../../types.js";

const SESSION = "sess_orch_panel_test";
const GROUP: GroupRecord = {
  sessionGroupId: "grp_panel_test",
  primarySessionId: SESSION,
  observerSessionId: "sess_obs_panel_test",
  status: "active",
  pairing: "claude+codex",
};

beforeEach(() => {
  useStore.getState().reset();
  // Reset persisted preferences too — these survive `reset()` by design.
  act(() => {
    useStore.getState().setObserverPanelOpen(SESSION, true);
  });
  localStorage.clear();
});

function seedGroup() {
  act(() => {
    useStore.getState().upsertGroup(GROUP);
  });
}

function seedCheckpoint(opts: { sequence?: number; phase?: string; timestamp?: number } = {}) {
  act(() => {
    useStore.getState().recordCheckpoint({
      sessionGroupId: GROUP.sessionGroupId,
      checkpointId: `chk_${opts.sequence ?? 1}`,
      phase: opts.phase ?? "council-plan",
      sequence: opts.sequence ?? 1,
      timestamp: opts.timestamp ?? 1_000,
    });
  });
}

function seedReview(opts: { stopIds?: string[]; phase?: string; downgradedStopId?: string } = {}) {
  const { stopIds = ["f1"], phase = "council-plan", downgradedStopId } = opts;
  act(() => {
    useStore.getState().appendObserverReview({
      sessionGroupId: GROUP.sessionGroupId,
      checkpointId: "chk_1",
      phase,
      findings: stopIds.map((id) => ({
        id,
        severity: "STOP",
        claim: `STOP ${id}`,
        evidence_path: "src/foo.ts",
        ...(id === downgradedStopId ? { wasDowngraded: true, downgradeReason: "evidence_missing_on_disk" as const } : {}),
      })),
      downgrades: [],
      observerModel: "gpt-5-codex",
      observerProvider: "codex",
      timestamp: 2_000,
    });
  });
}

describe("ObserverPanel — empty / no-group state", () => {
  it("renders nothing when the session is not in a Council group", () => {
    const { container } = render(<ObserverPanel sessionId="not-in-any-group" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ObserverPanel — state pills (5 explicit states)", () => {
  it("renders never-checkpointed-yet status when a group exists but no checkpoint yet", () => {
    seedGroup();
    render(<ObserverPanel sessionId={SESSION} />);
    expect(screen.getByTestId("status-pill")).toHaveAttribute("data-state", "never-checkpointed-yet");
    expect(screen.getByText(/Awaiting first checkpoint/i)).toBeInTheDocument();
  });

  it("renders sleeping status once a review lands without live STOPs", () => {
    seedGroup();
    seedCheckpoint();
    seedReview({ stopIds: [] });
    render(<ObserverPanel sessionId={SESSION} nowMs={3_000} />);
    expect(screen.getByTestId("status-pill")).toHaveAttribute("data-state", "sleeping");
  });

  it("renders reviewing status when observer is reviewing the latest checkpoint", () => {
    seedGroup();
    seedCheckpoint(); // observerReviewing flips on (timestamp: 1_000)
    // Task 11 bounded `reviewing` by lastCheckpointAt + wakeTimeoutMs.
    // Pass nowMs within that window so we don't lapse into `reviewing-
    // stalled` (the seed timestamp is epoch-1s, the default wallclock
    // wallops past the 90s deadline).
    render(<ObserverPanel sessionId={SESSION} nowMs={3_000} />);
    expect(screen.getByTestId("status-pill")).toHaveAttribute("data-state", "reviewing");
    // aria-busy="true" so SR users know an async task is in flight.
    expect(screen.getByTestId("status-pill")).toHaveAttribute("aria-busy", "true");
  });

  it("renders blocker-found status when an undismissed STOP exists", () => {
    seedGroup();
    seedCheckpoint();
    seedReview({ stopIds: ["f1", "f2"] });
    render(<ObserverPanel sessionId={SESSION} />);
    expect(screen.getByTestId("status-pill")).toHaveAttribute("data-state", "blocker-found");
    expect(screen.getByText(/2 unresolved/i)).toBeInTheDocument();
  });

  // PLAN Task 13 (a11y): the `reconnecting` branch was previously
  // unreachable in production; PLAN Task 9 wired the ws.ts dispatch so
  // a `group_reconnecting` server frame now sets `GroupRecord.status =
  // "reconnecting"`. Verify the pill renders with the polite live-region
  // role + aria-atomic, uses the `cc-info` token (Task 14, distinct from
  // `cc-warning` which is degraded), and keeps the spinner decorative.
  it("renders reconnecting pill with polite live-region role and cc-info token", async () => {
    seedGroup();
    act(() => {
      useStore.getState().setGroupStatus(GROUP.sessionGroupId, "reconnecting");
    });
    const { container } = render(<ObserverPanel sessionId={SESSION} />);
    const pill = screen.getByTestId("status-pill");
    expect(pill).toHaveAttribute("data-state", "reconnecting");
    // Live-region semantics: status role + atomic so a SR reads the full
    // pill text on transition, not per-render fragments.
    expect(pill).toHaveAttribute("role", "status");
    expect(pill).toHaveAttribute("aria-atomic", "true");
    expect(pill).toHaveAttribute("aria-busy", "true");
    // Visible name is the accessible name — no aria-label duplication.
    expect(pill).toHaveTextContent(/Observer reconnecting/i);
    // Spinner is decorative; otherwise a SR would loop "loading loading…".
    const spinner = pill.querySelector("span[aria-hidden=\"true\"]");
    expect(spinner).not.toBeNull();
    // Color token: cc-info distinguishes transient-in-progress from
    // settled-error (cc-warning). Asserting the className substring rather
    // than the computed hex keeps the test resilient to token-value tweaks.
    expect(pill.className).toContain("text-cc-info");
    expect(pill.className).not.toContain("text-cc-warning");
    // axe scan — every component test per CLAUDE.md.
    const { axe } = await import("vitest-axe");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // PLAN T15.2: degraded wins over blocker-found regardless of findings.
  it("renders degraded status (highest priority) when the group is degraded", () => {
    seedGroup();
    seedCheckpoint();
    seedReview({ stopIds: ["f1"] });
    act(() => {
      useStore.getState().setGroupStatus(GROUP.sessionGroupId, "degraded", { deadRole: "observer" });
    });
    render(<ObserverPanel sessionId={SESSION} onRespawnHalf={vi.fn()} />);
    expect(screen.getByTestId("status-pill")).toHaveAttribute("data-state", "degraded");
    expect(screen.getByTestId("degraded-banner")).toBeInTheDocument();
  });

  // Bidirectional pipeline Story 4.1.5 — convergence pill variants.
  // Each variant gets one named test asserting the data-state attribute,
  // accessible label, and color token. Axe scan is the global mandate
  // (CLAUDE.md) — kept brief here since the surrounding tests in this
  // describe block already lock the broader a11y posture.

  it("renders cycle-progress pill with 🔄 Cycle N/T copy and aria-label", async () => {
    seedGroup();
    act(() => {
      useStore.getState().applyConvergence({
        sessionGroupId: GROUP.sessionGroupId,
        cycleNumber: 2,
        convergenceThreshold: 3,
        convergenceState: "in-progress",
      });
    });
    const { container } = render(<ObserverPanel sessionId={SESSION} />);
    const pill = screen.getByTestId("status-pill");
    expect(pill).toHaveAttribute("data-state", "cycle-progress");
    expect(pill).toHaveAttribute("role", "status");
    expect(pill).toHaveAttribute("aria-atomic", "true");
    // Accessible name carries the readable "Cycle 2 of 3" form — emoji is
    // aria-hidden so AT doesn't double-read.
    expect(pill).toHaveAttribute("aria-label", "Cycle 2 of 3");
    expect(pill).toHaveTextContent(/Cycle 2\/3/);
    const emoji = pill.querySelector("span[aria-hidden=\"true\"]");
    expect(emoji).not.toBeNull();
    const { axe } = await import("vitest-axe");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("renders converged pill with ✅ ready-to-ship copy + emerald token", async () => {
    seedGroup();
    act(() => {
      useStore.getState().applyConvergence({
        sessionGroupId: GROUP.sessionGroupId,
        cycleNumber: 3,
        convergenceThreshold: 3,
        convergenceState: "converged",
      });
    });
    const { container } = render(<ObserverPanel sessionId={SESSION} />);
    const pill = screen.getByTestId("status-pill");
    expect(pill).toHaveAttribute("data-state", "converged");
    expect(pill).toHaveAttribute("role", "status");
    expect(pill).toHaveAttribute("aria-label", "Converged — ready to ship after 3 clean cycles");
    expect(pill).toHaveTextContent(/Converged — ready to ship/);
    // Emerald token signals "ship-ready" per Story 4.1.5
    expect(pill.className).toContain("text-emerald-500");
    const { axe } = await import("vitest-axe");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("degraded short-circuits over converged (Story 4.1.5 freeze precedence in UI)", () => {
    seedGroup();
    act(() => {
      useStore.getState().applyConvergence({
        sessionGroupId: GROUP.sessionGroupId,
        cycleNumber: 3,
        convergenceThreshold: 3,
        convergenceState: "converged",
      });
      useStore.getState().setGroupStatus(GROUP.sessionGroupId, "degraded", { deadRole: "observer" });
    });
    render(<ObserverPanel sessionId={SESSION} onRespawnHalf={vi.fn()} />);
    // Degraded MUST win — the convergence counter freezes (does not
    // advance during degraded state) and the warning takes the pill.
    expect(screen.getByTestId("status-pill")).toHaveAttribute("data-state", "degraded");
  });
});

describe("ObserverPanel — collapse / expand", () => {
  // PLAN T15.2: "Collapsible without losing alert channel — collapsed
  // rail still shows unread-findings count."
  it("renders the rail with unread STOP count when collapsed and there are live STOPs", () => {
    seedGroup();
    seedCheckpoint();
    seedReview({ stopIds: ["f1", "f2"] });
    act(() => {
      useStore.getState().setObserverPanelOpen(SESSION, false);
    });
    render(<ObserverPanel sessionId={SESSION} />);
    expect(screen.getByTestId("observer-panel-rail")).toBeInTheDocument();
    expect(screen.getByTestId("observer-panel-rail-counter")).toHaveTextContent("2");
  });

  it("does not render the rail counter when collapsed and no live STOPs", () => {
    seedGroup();
    seedCheckpoint();
    seedReview({ stopIds: [] });
    act(() => {
      useStore.getState().setObserverPanelOpen(SESSION, false);
    });
    render(<ObserverPanel sessionId={SESSION} />);
    expect(screen.queryByTestId("observer-panel-rail-counter")).toBeNull();
  });

  it("collapses the panel when the header collapse button is clicked", () => {
    seedGroup();
    render(<ObserverPanel sessionId={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: /Collapse observer panel/i }));
    expect(useStore.getState().observerPanelOpen.get(SESSION)).toBe(false);
  });

  it("expands the panel when the rail is clicked", () => {
    seedGroup();
    act(() => {
      useStore.getState().setObserverPanelOpen(SESSION, false);
    });
    render(<ObserverPanel sessionId={SESSION} />);
    fireEvent.click(screen.getByTestId("observer-panel-rail"));
    expect(useStore.getState().observerPanelOpen.get(SESSION)).toBe(true);
  });
});

describe("ObserverPanel — provider badges + width", () => {
  it("renders the pairing's ProviderBadges in the header", () => {
    seedGroup();
    render(<ObserverPanel sessionId={SESSION} />);
    expect(screen.getByTestId("provider-badges")).toBeInTheDocument();
    expect(screen.getByTestId("provider-chip-orchestrator")).toHaveTextContent("claude");
    expect(screen.getByTestId("provider-chip-observer")).toHaveTextContent("codex");
  });

  it("applies the persisted width via inline style", () => {
    seedGroup();
    act(() => {
      useStore.getState().setObserverPanelWidth(SESSION, 420);
    });
    render(<ObserverPanel sessionId={SESSION} />);
    const panel = screen.getByTestId("observer-panel");
    expect(panel.style.width).toBe("420px");
  });
});

describe("ObserverPanel — first-run microcopy", () => {
  // PLAN T15: first-run microcopy lives in panel header; dismissable per-user.
  it("renders the microcopy by default", () => {
    seedGroup();
    render(<ObserverPanel sessionId={SESSION} />);
    expect(screen.getByText(/This panel shows a second AI reviewing/i)).toBeInTheDocument();
  });

  it("hides the microcopy after dismissal (and persists per-user)", () => {
    seedGroup();
    render(<ObserverPanel sessionId={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: /Got it/i }));
    expect(screen.queryByText(/This panel shows a second AI/i)).toBeNull();
    expect(useStore.getState().firstRunHintDismissed).toBe(true);
  });
});

describe("ObserverPanel — findings list", () => {
  it("delegates to FindingsLog and surfaces downgraded markers", () => {
    seedGroup();
    seedCheckpoint();
    seedReview({ stopIds: ["f1", "f2"], downgradedStopId: "f2" });
    render(<ObserverPanel sessionId={SESSION} />);
    // f1 = live STOP, f2 = server-downgraded STOP (rendered with downgraded chip).
    expect(screen.getByTestId("finding-row-f1")).toHaveAttribute("data-severity", "STOP");
    expect(screen.getByTestId("finding-row-f2")).toHaveAttribute("data-downgraded", "true");
    expect(screen.getByText(/downgraded/i)).toBeInTheDocument();
  });

  it("invokes dismissStop on the council slice when a STOP is dismissed", () => {
    seedGroup();
    seedCheckpoint();
    seedReview({ stopIds: ["f1"] });
    render(<ObserverPanel sessionId={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss STOP/i }));
    expect(useStore.getState().dismissedStopIds.has("f1")).toBe(true);
  });
});

describe("ObserverPanel — degraded → respawn", () => {
  it("calls onRespawnHalf with the sessionGroupId when Respawn is clicked", () => {
    seedGroup();
    act(() => {
      useStore.getState().setGroupStatus(GROUP.sessionGroupId, "degraded", { deadRole: "observer" });
    });
    const onRespawnHalf = vi.fn().mockResolvedValue(undefined);
    render(<ObserverPanel sessionId={SESSION} onRespawnHalf={onRespawnHalf} />);
    fireEvent.click(screen.getByRole("button", { name: /Respawn observer/i }));
    expect(onRespawnHalf).toHaveBeenCalledWith(GROUP.sessionGroupId);
  });
});

describe("ObserverPanel — accessibility", () => {
  it("passes accessibility scan in sleeping state", async () => {
    const { axe } = await import("vitest-axe");
    seedGroup();
    seedCheckpoint();
    seedReview({ stopIds: [] });
    const { container } = render(<ObserverPanel sessionId={SESSION} nowMs={3_000} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan in blocker-found state", async () => {
    const { axe } = await import("vitest-axe");
    seedGroup();
    seedCheckpoint();
    seedReview({ stopIds: ["f1", "f2"] });
    const { container } = render(<ObserverPanel sessionId={SESSION} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan in degraded state", async () => {
    const { axe } = await import("vitest-axe");
    seedGroup();
    act(() => {
      useStore.getState().setGroupStatus(GROUP.sessionGroupId, "degraded", { deadRole: "observer" });
    });
    const { container } = render(<ObserverPanel sessionId={SESSION} onRespawnHalf={() => Promise.resolve()} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan in collapsed rail", async () => {
    const { axe } = await import("vitest-axe");
    seedGroup();
    seedCheckpoint();
    seedReview({ stopIds: ["f1"] });
    act(() => {
      useStore.getState().setObserverPanelOpen(SESSION, false);
    });
    const { container } = render(<ObserverPanel sessionId={SESSION} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
