// @vitest-environment jsdom
/**
 * Tests for ModelListFallbackHint + useModelListAutoRefresh.
 *
 * Context (owner bug 2026-10-16): when the Claude /v1/models fetch failed,
 * the New Session dropdown silently fell back to a stale static list with no
 * way to recover short of a page reload. The hint tells the user the list is
 * the fallback and offers a retry; the hook re-fetches on tab focus.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { DynamicModelsStatus } from "../store/settings-slice.js";
import type { ModelOption } from "../utils/backends.js";

const mockLoadBackendModels = vi.fn(async () => {});
const storeState: {
  dynamicBackendModels: { claude?: ModelOption[]; codex?: ModelOption[] };
  dynamicBackendModelsStatus: { claude: DynamicModelsStatus; codex: DynamicModelsStatus };
  loadBackendModels: typeof mockLoadBackendModels;
} = {
  dynamicBackendModels: {},
  dynamicBackendModelsStatus: { claude: "rejected", codex: "idle" },
  loadBackendModels: mockLoadBackendModels,
};

vi.mock("../store.js", () => ({
  useStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}));

import { ModelListFallbackHint, useModelListAutoRefresh } from "./ModelListFallbackHint.js";

function HookHost({ backend }: { backend: "claude" | "codex" }) {
  useModelListAutoRefresh(backend);
  return null;
}

beforeEach(() => {
  mockLoadBackendModels.mockClear();
  storeState.dynamicBackendModels = {};
  storeState.dynamicBackendModelsStatus = { claude: "rejected", codex: "idle" };
});

describe("ModelListFallbackHint", () => {
  // Hard reject + no dynamic list → hint with a working retry button.
  it("renders the fallback hint with a retry button after a failed fetch", () => {
    render(<ModelListFallbackHint backend="claude" />);
    expect(screen.getByRole("status")).toHaveTextContent("Список моделей не загрузился — показан базовый.");
    expect(screen.getByRole("button", { name: "Обновить" })).toBeEnabled();
  });

  it("clicking Обновить re-fetches the Claude model list", () => {
    render(<ModelListFallbackHint backend="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    expect(mockLoadBackendModels).toHaveBeenCalledWith("claude");
  });

  // While a retry after a failure is in flight the hint stays (no flicker)
  // and the button is disabled.
  it("keeps the hint with a disabled button while a retry is pending", () => {
    const { rerender } = render(<ModelListFallbackHint backend="claude" />);
    storeState.dynamicBackendModelsStatus = { claude: "pending", codex: "idle" };
    rerender(<ModelListFallbackHint backend="claude" />);
    expect(screen.getByRole("button", { name: "Обновляю…" })).toBeDisabled();
  });

  // The initial page-load fetch (pending without a prior failure) is silent.
  it("renders nothing during the initial pending fetch", () => {
    storeState.dynamicBackendModelsStatus = { claude: "pending", codex: "idle" };
    const { container } = render(<ModelListFallbackHint backend="claude" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once the dynamic list is loaded", () => {
    storeState.dynamicBackendModels = { claude: [{ value: "claude-opus-5-5", label: "Opus 5.5", icon: "" }] };
    storeState.dynamicBackendModelsStatus = { claude: "resolved", codex: "idle" };
    const { container } = render(<ModelListFallbackHint backend="claude" />);
    expect(container).toBeEmptyDOMElement();
  });

  // No API key → static IS the list; not a failure, no hint.
  it("renders nothing when no API key is configured", () => {
    storeState.dynamicBackendModelsStatus = { claude: "unconfigured", codex: "idle" };
    const { container } = render(<ModelListFallbackHint backend="claude" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for the codex backend (it has its own empty-state copy)", () => {
    storeState.dynamicBackendModelsStatus = { claude: "idle", codex: "rejected" };
    const { container } = render(<ModelListFallbackHint backend="codex" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ModelListFallbackHint backend="claude" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("useModelListAutoRefresh", () => {
  // Coming back to the tab after all automatic retries were exhausted
  // re-fetches instead of leaving the dropdown on the fallback forever.
  it("re-fetches on window focus while the last fetch was rejected", () => {
    render(<HookHost backend="claude" />);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(mockLoadBackendModels).toHaveBeenCalledWith("claude");
  });

  it("re-fetches when the document becomes visible while rejected", () => {
    render(<HookHost backend="claude" />);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(mockLoadBackendModels).toHaveBeenCalledTimes(1);
  });

  // A healthy list must not be re-fetched on every focus.
  it("does nothing on focus when the list is resolved", () => {
    storeState.dynamicBackendModelsStatus = { claude: "resolved", codex: "idle" };
    render(<HookHost backend="claude" />);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(mockLoadBackendModels).not.toHaveBeenCalled();
  });

  it("removes its listeners on unmount", () => {
    const { unmount } = render(<HookHost backend="claude" />);
    unmount();
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(mockLoadBackendModels).not.toHaveBeenCalled();
  });
});
