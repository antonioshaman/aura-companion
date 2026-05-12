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
    seedCheckpoint(); // observerReviewing flips on
    render(<ObserverPanel sessionId={SESSION} />);
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
