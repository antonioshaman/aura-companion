// @vitest-environment jsdom

// Polyfill localStorage + matchMedia (store import triggers reads).
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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStore } from "./store.js";
import { applyTitleAlertPrefix, useBrowserTitleAlert } from "./use-browser-title-alert.js";
import type { GroupRecord, ObserverFinding } from "./types.js";

function group(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    sessionGroupId: "grp_abc",
    primarySessionId: "sess_orch",
    observerSessionId: "sess_obs",
    status: "active",
    pairing: "claude+claude",
    ...overrides,
  };
}

function finding(overrides: Partial<ObserverFinding> = {}): ObserverFinding {
  return {
    id: "fnd_1",
    severity: "STOP",
    claim: "test claim",
    evidence_path: "src/foo.ts",
    receivedAt: 1_000,
    checkpointId: "chk_1",
    phase: "council-plan",
    observerModel: "claude-opus-4-7",
    observerProvider: "claude",
    ...overrides,
  };
}

beforeEach(() => {
  useStore.getState().reset();
  document.title = "Aura Companion";
});

afterEach(() => {
  document.title = "Aura Companion";
});

// ── applyTitleAlertPrefix (pure, Beck F4) ──────────────────────────────────

describe("applyTitleAlertPrefix", () => {
  it("prepends `(N) ` when count > 0", () => {
    expect(applyTitleAlertPrefix("Aura Companion", 3)).toBe("(3) Aura Companion");
  });

  it("returns the bare title when count is 0", () => {
    expect(applyTitleAlertPrefix("Aura Companion", 0)).toBe("Aura Companion");
  });

  it("strips an existing `(M) ` prefix before deciding whether to add a new one", () => {
    // Whether the new count is positive or zero, the existing prefix is
    // gone — no `(2) (1) Title` accumulation possible.
    expect(applyTitleAlertPrefix("(2) Aura Companion", 5)).toBe("(5) Aura Companion");
    expect(applyTitleAlertPrefix("(2) Aura Companion", 0)).toBe("Aura Companion");
  });

  it("treats negative count as 0", () => {
    expect(applyTitleAlertPrefix("Aura Companion", -1)).toBe("Aura Companion");
  });
});

// ── useBrowserTitleAlert hook ───────────────────────────────────────────────

describe("useBrowserTitleAlert", () => {
  it("does not modify title when no findings exist", () => {
    renderHook(() => useBrowserTitleAlert());
    expect(document.title).toBe("Aura Companion");
  });

  it("prepends `(N) ` once a STOP appears in a group", () => {
    renderHook(() => useBrowserTitleAlert());
    act(() => {
      useStore.getState().upsertGroup(group());
      useStore.getState().appendObserverReview({
        sessionGroupId: "grp_abc",
        checkpointId: "chk_1",
        phase: "council-plan",
        findings: [{ id: "f1", severity: "STOP", claim: "boom", evidence_path: "src/foo.ts" }],
        downgrades: [],
        observerModel: "claude",
        observerProvider: "claude",
        timestamp: 1_000,
      });
    });
    expect(document.title).toBe("(1) Aura Companion");
  });

  it("aggregates STOPs across multiple groups", () => {
    renderHook(() => useBrowserTitleAlert());
    act(() => {
      useStore.getState().upsertGroup(group({ sessionGroupId: "grp_a", primarySessionId: "sess_a_o", observerSessionId: "sess_a_b" }));
      useStore.getState().upsertGroup(group({ sessionGroupId: "grp_b", primarySessionId: "sess_b_o", observerSessionId: "sess_b_b" }));
      useStore.getState().appendObserverReview({
        sessionGroupId: "grp_a",
        checkpointId: "chk_1",
        phase: "council-plan",
        findings: [
          { id: "a1", severity: "STOP", claim: "x", evidence_path: "src/x.ts" },
          { id: "a2", severity: "NOTE", claim: "y", evidence_path: "src/x.ts" },
        ],
        downgrades: [],
        observerModel: "claude",
        observerProvider: "claude",
        timestamp: 1_000,
      });
      useStore.getState().appendObserverReview({
        sessionGroupId: "grp_b",
        checkpointId: "chk_1",
        phase: "council-plan",
        findings: [
          { id: "b1", severity: "STOP", claim: "z", evidence_path: "src/x.ts" },
        ],
        downgrades: [],
        observerModel: "codex",
        observerProvider: "codex",
        timestamp: 1_000,
      });
    });
    expect(document.title).toBe("(2) Aura Companion");
  });

  it("removes the prefix when every STOP is dismissed", () => {
    renderHook(() => useBrowserTitleAlert());
    act(() => {
      useStore.getState().upsertGroup(group());
      useStore.getState().appendObserverReview({
        sessionGroupId: "grp_abc",
        checkpointId: "chk_1",
        phase: "council-plan",
        findings: [{ id: "f1", severity: "STOP", claim: "boom", evidence_path: "src/foo.ts" }],
        downgrades: [],
        observerModel: "claude",
        observerProvider: "claude",
        timestamp: 1_000,
      });
    });
    expect(document.title).toBe("(1) Aura Companion");
    act(() => {
      useStore.getState().dismissStop("f1");
    });
    expect(document.title).toBe("Aura Companion");
  });

  it("survives an external title update (routing changed document.title) — no `(M) (N)` accumulation", () => {
    renderHook(() => useBrowserTitleAlert());
    act(() => {
      useStore.getState().upsertGroup(group());
      useStore.getState().appendObserverReview({
        sessionGroupId: "grp_abc",
        checkpointId: "chk_1",
        phase: "council-plan",
        findings: [{ id: "f1", severity: "STOP", claim: "boom", evidence_path: "src/foo.ts" }],
        downgrades: [],
        observerModel: "claude",
        observerProvider: "claude",
        timestamp: 1_000,
      });
    });
    expect(document.title).toBe("(1) Aura Companion");
    // Simulate routing update — page replaced document.title directly.
    act(() => {
      document.title = "Diff View — Aura Companion";
    });
    // Trigger a re-run by dismissing+undismissing equivalent. The hook
    // reapplies prefix on next state change; check the strip-then-prefix
    // logic does not produce `(1) (1) Title`.
    act(() => {
      useStore.getState().dismissStop("does-not-exist");
    });
    // Even though dismissStop didn't change the unresolved count, the
    // effect re-ran. The title should now show the prefix against the
    // NEW base ("Diff View — Aura Companion"), with no accumulation.
    expect(document.title).toBe("(1) Diff View — Aura Companion");
  });
});
