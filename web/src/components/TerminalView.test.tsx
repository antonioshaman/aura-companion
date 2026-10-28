// @vitest-environment jsdom
/**
 * TerminalView: render, axe and interaction triad (CLAUDE.md). The terminal
 * itself (xterm, the PTY spawn, the WebSocket) is mocked: these tests cover the
 * frame around it, in particular the icon-only close button, which had no
 * accessible name (aura-check uiux.icon-button-no-name, baseline 2026-10-28).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    write() {}
    writeln() {}
    onData() { return { dispose() {} }; }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../api.js", () => ({
  api: {
    spawnTerminal: vi.fn(() => new Promise(() => {})), // never resolves: no PTY in tests
    killTerminal: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("../terminal-ws.js", () => ({ createTerminalConnection: vi.fn() }));
vi.mock("../store.js", () => {
  const state = { darkMode: false, setTerminalId: vi.fn() };
  const useStore = (sel: (s: typeof state) => unknown) => sel(state);
  useStore.getState = () => state;
  return { useStore };
});

import { TerminalView } from "./TerminalView.js";

beforeAll(() => {
  // jsdom has no FontFaceSet; TerminalView waits on it before creating xterm.
  Object.defineProperty(document, "fonts", { value: { load: () => Promise.resolve([]) }, configurable: true });
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
});

describe("TerminalView", () => {
  it("renders the header with the title", () => {
    render(<TerminalView cwd="/repo" title="build shell" onClose={() => {}} />);
    expect(screen.getByText("build shell")).toBeInTheDocument();
  });

  it("passes axe with the header and close button", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<TerminalView cwd="/repo" title="build shell" onClose={() => {}} embedded />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("the close button has an accessible name and calls onClose", () => {
    const onClose = vi.fn();
    render(<TerminalView cwd="/repo" onClose={onClose} embedded />);
    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hides the header (and the close button) with hideHeader", () => {
    render(<TerminalView cwd="/repo" onClose={() => {}} embedded hideHeader />);
    expect(screen.queryByRole("button", { name: "Close terminal" })).toBeNull();
  });
});
