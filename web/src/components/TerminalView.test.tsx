// @vitest-environment jsdom
/**
 * TerminalView: render, axe and interaction triad (CLAUDE.md). The terminal
 * itself (xterm, the PTY spawn, the WebSocket) is mocked: these tests cover the
 * frame around it, in particular the icon-only close button, which had no
 * accessible name (aura-check uiux.icon-button-no-name, baseline 2026-10-28).
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Shared handles so tests can drive the mocked xterm instance and the WS connection.
const h = vi.hoisted(() => ({
  xterms: [] as Array<{ written: string[]; lines: string[]; input?: (d: string) => void; disposed: boolean; options: Record<string, unknown> }>,
  conn: { sendInput: vi.fn(), sendResize: vi.fn(), disconnect: vi.fn() },
  handlers: null as null | { onData: (d: string) => void; onExit: (c: number) => void; onError: (m: string) => void; onOpen: () => void },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    written: string[] = [];
    lines: string[] = [];
    input?: (d: string) => void;
    disposed = false;
    constructor() { h.xterms.push(this); }
    loadAddon() {}
    open() {}
    write(d: string) { this.written.push(d); }
    writeln(l: string) { this.lines.push(l); }
    onData(cb: (d: string) => void) { this.input = cb; return { dispose() {} }; }
    dispose() { this.disposed = true; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../api.js", () => ({
  api: {
    spawnTerminal: vi.fn(() => new Promise(() => {})), // default: never resolves, no PTY in tests
    killTerminal: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("../terminal-ws.js", () => ({
  createTerminalConnection: vi.fn((_id: string, handlers: NonNullable<typeof h.handlers>) => {
    h.handlers = handlers;
    return h.conn;
  }),
}));
vi.mock("../store.js", () => {
  const state = { darkMode: false, setTerminalId: vi.fn() };
  const useStore = (sel: (s: typeof state) => unknown) => sel(state);
  useStore.getState = () => state;
  return { useStore };
});

import { TerminalView } from "./TerminalView.js";
import { api } from "../api.js";

beforeAll(() => {
  // jsdom has no FontFaceSet; TerminalView waits on it before creating xterm.
  Object.defineProperty(document, "fonts", { value: { load: () => Promise.resolve([]) }, configurable: true });
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
});

describe("TerminalView", () => {
  // A PTY can arrive after unmount (including StrictMode's initial cleanup).
  it("kills a terminal whose spawn resolves after unmount", async () => {
    let finish!: (value: { terminalId: string }) => void;
    vi.mocked(api.spawnTerminal).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { unmount } = render(<TerminalView cwd="/repo" onClose={() => {}} embedded />);
    await waitFor(() => expect(finish).toBeDefined());
    unmount();
    finish({ terminalId: "late-pty" });
    await waitFor(() => expect(api.killTerminal).toHaveBeenCalledWith("late-pty"));
  });

  it("renders the header with the title", () => {
    render(<TerminalView cwd="/repo" title="build shell" onClose={() => {}} />);
    expect(screen.getByText("build shell")).toBeInTheDocument();
  });

  it.each([false, true])("passes axe with the header and close button (embedded=%s)", async (embedded) => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<TerminalView cwd="/repo" title="build shell" onClose={() => {}} embedded={embedded} />);
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

  // The PTY lifecycle: spawn → WS connection → data/exit/error frames reach
  // xterm, typed input goes to the socket, unmount disconnects and kills the PTY.
  it("connects to the spawned terminal, relays I/O and kills the PTY on unmount", async () => {
    h.handlers = null;
    vi.mocked(api.spawnTerminal).mockResolvedValueOnce({ terminalId: "t1" } as never);
    const { unmount } = render(<TerminalView cwd="/repo" onClose={() => {}} embedded />);
    await waitFor(() => expect(h.handlers).not.toBeNull());
    const xterm = h.xterms[h.xterms.length - 1];

    h.handlers!.onOpen();
    expect(h.conn.sendResize).toHaveBeenCalledWith(80, 24);
    h.handlers!.onData("hello");
    expect(xterm.written).toContain("hello");
    h.handlers!.onExit(2);
    h.handlers!.onError("socket closed");
    expect(xterm.lines.join("")).toContain("[Process exited with code 2]");
    expect(xterm.lines.join("")).toContain("[socket closed]");
    xterm.input!("ls\r");
    expect(h.conn.sendInput).toHaveBeenCalledWith("ls\r");

    unmount();
    expect(h.conn.disconnect).toHaveBeenCalled();
    expect(xterm.disposed).toBe(true);
    expect(api.killTerminal).toHaveBeenCalledWith("t1");
  });

  // A failed spawn is shown inside the terminal instead of failing silently.
  it("writes the spawn error into the terminal", async () => {
    vi.mocked(api.spawnTerminal).mockRejectedValueOnce(new Error("no pty"));
    render(<TerminalView cwd="/repo" embedded />);
    await waitFor(() => {
      const xterm = h.xterms[h.xterms.length - 1];
      expect(xterm?.lines.join("")).toContain("[Failed to start terminal: no pty]");
    });
  });

  // The non-embedded variant is a centered overlay; its frame stops click propagation.
  it("renders as an overlay when not embedded", () => {
    const { container } = render(<TerminalView cwd="/repo" onClose={() => {}} />);
    expect(container.firstElementChild?.className).toContain("fixed inset-0");
    expect(screen.getByText("/repo")).toBeInTheDocument(); // falls back to cwd without a title
  });
});
