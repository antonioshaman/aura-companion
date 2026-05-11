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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStore } from "./store.js";
import {
  BLOCKER_PRIMARY_ACTION_ATTR,
  matchesCouncilShortcut,
  shouldIgnoreShortcut,
  useCouncilShortcuts,
} from "./use-council-shortcuts.js";

beforeEach(() => {
  useStore.getState().reset();
  // `observerPanelOpen` is a persisted preference Map and intentionally
  // survives `reset()` (parallels `collapsedProjects`). Hook tests in this
  // file need a clean slate every time — clear the map by hand so
  // cross-test contamination from sibling shortcut tests can't bleed in.
  useStore.setState({ observerPanelOpen: new Map() });
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ── shouldIgnoreShortcut (Beck F4) ──────────────────────────────────────────

describe("shouldIgnoreShortcut", () => {
  it("returns true for INPUT", () => {
    const el = document.createElement("input");
    expect(shouldIgnoreShortcut(el)).toBe(true);
  });

  it("returns true for TEXTAREA", () => {
    const el = document.createElement("textarea");
    expect(shouldIgnoreShortcut(el)).toBe(true);
  });

  it("returns true for contenteditable", () => {
    // JSDOM's `el.contentEditable = "true"` setter does not always
    // reflect to the `contenteditable` attribute (only to the read-only
    // `isContentEditable` getter when the element is in-document). Use
    // setAttribute directly so we exercise the attribute branch of the
    // helper — that's the branch that fires under real browsers too.
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "true");
    expect(shouldIgnoreShortcut(el)).toBe(true);
  });

  it.each([["DIV"], ["BUTTON"], ["SPAN"]])("returns false for non-editable %s", (tag) => {
    const el = document.createElement(tag);
    expect(shouldIgnoreShortcut(el)).toBe(false);
  });

  it("returns false for null target", () => {
    expect(shouldIgnoreShortcut(null)).toBe(false);
  });
});

// ── matchesCouncilShortcut (Beck F4) ────────────────────────────────────────

describe("matchesCouncilShortcut", () => {
  function ev(opts: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
    return new KeyboardEvent("keydown", opts);
  }

  it("matches Cmd+Shift+O on macOS-like input", () => {
    expect(matchesCouncilShortcut(ev({ key: "O", metaKey: true, shiftKey: true }), "o")).toBe(true);
  });

  it("matches Ctrl+Shift+O on Windows/Linux-like input", () => {
    expect(matchesCouncilShortcut(ev({ key: "O", ctrlKey: true, shiftKey: true }), "o")).toBe(true);
  });

  it("matches Cmd+Shift+B", () => {
    expect(matchesCouncilShortcut(ev({ key: "B", metaKey: true, shiftKey: true }), "b")).toBe(true);
  });

  // All required modifiers present? Each missing one rejects.
  it.each([
    ["no shift", { key: "O", metaKey: true }],
    ["no meta/ctrl", { key: "O", shiftKey: true }],
    ["wrong key", { key: "P", metaKey: true, shiftKey: true }],
    ["with alt", { key: "O", metaKey: true, shiftKey: true, altKey: true }],
  ])("does not match: %s", (_label, opts) => {
    expect(matchesCouncilShortcut(ev(opts as KeyboardEventInit & { key: string }), "o")).toBe(false);
  });

  it("is case-insensitive on the key", () => {
    expect(matchesCouncilShortcut(ev({ key: "o", metaKey: true, shiftKey: true }), "o")).toBe(true);
    expect(matchesCouncilShortcut(ev({ key: "O", metaKey: true, shiftKey: true }), "o")).toBe(true);
  });
});

// ── useCouncilShortcuts hook ────────────────────────────────────────────────

describe("useCouncilShortcuts", () => {
  it("toggles the Observer panel for the current session on Cmd+Shift+O", () => {
    useStore.getState().setCurrentSession("sess_orch");
    renderHook(() => useCouncilShortcuts());
    expect(useStore.getState().observerPanelOpen.get("sess_orch")).toBeUndefined();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "O", metaKey: true, shiftKey: true }));
    });
    // First toggle on an unset key flips the default (open=true) → false.
    expect(useStore.getState().observerPanelOpen.get("sess_orch")).toBe(false);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "O", ctrlKey: true, shiftKey: true }));
    });
    expect(useStore.getState().observerPanelOpen.get("sess_orch")).toBe(true);
  });

  it("does nothing when no session is current (no orchestrator to toggle for)", () => {
    renderHook(() => useCouncilShortcuts());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "O", metaKey: true, shiftKey: true }));
    });
    expect(useStore.getState().observerPanelOpen.size).toBe(0);
  });

  it("focuses the BlockerBanner primary action on Cmd+Shift+B", () => {
    renderHook(() => useCouncilShortcuts());
    const btn = document.createElement("button");
    btn.setAttribute(BLOCKER_PRIMARY_ACTION_ATTR, "");
    btn.textContent = "Open evidence";
    document.body.appendChild(btn);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "B", metaKey: true, shiftKey: true }));
    });
    expect(document.activeElement).toBe(btn);
  });

  it("does nothing when no BlockerBanner is mounted (graceful no-op)", () => {
    renderHook(() => useCouncilShortcuts());
    const before = document.activeElement;
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "B", metaKey: true, shiftKey: true }));
    });
    expect(document.activeElement).toBe(before);
  });

  // Critical: the shortcut must NOT fire when the user is typing in the
  // composer. Composer captures capital-O via shift naturally; we MUST
  // NOT preventDefault on those events.
  it("ignores the shortcut when focus is in a textarea (composer)", () => {
    useStore.getState().setCurrentSession("sess_orch");
    renderHook(() => useCouncilShortcuts());
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "O", metaKey: true, shiftKey: true, bubbles: true }));
    });
    expect(useStore.getState().observerPanelOpen.size).toBe(0);
  });

  it("ignores the shortcut when focus is in an input", () => {
    useStore.getState().setCurrentSession("sess_orch");
    renderHook(() => useCouncilShortcuts());
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "O", metaKey: true, shiftKey: true, bubbles: true }));
    });
    expect(useStore.getState().observerPanelOpen.size).toBe(0);
  });
});
