// @vitest-environment jsdom
/** Keyboard behaviour, focus restoration and nested dialogs share one policy. */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useModalDialog } from "./use-modal-dialog.js";

function Dialog({ open = true, close, empty = false, label = "Example" }: { open?: boolean; close?: () => void; empty?: boolean; label?: string }) {
  const ref = useModalDialog<HTMLDivElement>(open, close);
  return open ? <div role="dialog" aria-label={label} tabIndex={-1} ref={ref}>{!empty && <><button>First {label}</button><button disabled>Disabled</button><button style={{ display: "none" }}>Hidden</button><button>Last {label}</button><div data-terminal-input><textarea aria-label={`Shell ${label}`} tabIndex={-1} /></div></>}</div> : null;
}

describe("modal focus", () => {
  it("moves focus inside, cycles Tab both ways, and restores the opener", async () => {
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const close = vi.fn(); const { unmount } = render(<Dialog close={close} />);
    const first = screen.getByText("First Example"), last = screen.getByText("Last Example");
    expect(document.activeElement).toBe(first);
    const user = userEvent.setup(); await user.tab(); expect(document.activeElement).toBe(last);
    await user.tab(); expect(document.activeElement).toBe(first);
    await user.tab({ shift: true }); expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Escape" }); expect(close).toHaveBeenCalledOnce();
    unmount(); expect(document.activeElement).toBe(opener); opener.remove();
  });

  it("contains programmatic focus and supports dialogs with no controls", () => {
    const outside = document.createElement("button"); document.body.append(outside);
    const { unmount } = render(<Dialog empty />);
    const dialog = screen.getByRole("dialog"); expect(document.activeElement).toBe(dialog);
    outside.focus(); expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab" }); expect(document.activeElement).toBe(dialog);
    unmount(); outside.remove();
  });

  it("gives only the top dialog Escape and returns focus to its parent", () => {
    const outerClose = vi.fn(), innerClose = vi.fn();
    const outer = render(<Dialog close={outerClose} label="Outer" />);
    const inner = render(<Dialog close={innerClose} label="Inner" />);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(innerClose).toHaveBeenCalledOnce(); expect(outerClose).not.toHaveBeenCalled();
    inner.unmount(); expect(document.activeElement).toBe(screen.getByText("First Outer")); outer.unmount();
  });

  it("preserves terminal Escape, uses the latest callback, and tolerates absent openers", () => {
    const stale = vi.fn(), latest = vi.fn();
    const view = render(<Dialog close={stale} />); view.rerender(<Dialog close={latest} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" }); expect(latest).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByText("First Example"), { key: "Escape" }); expect(latest).toHaveBeenCalledOnce(); expect(stale).not.toHaveBeenCalled();
    view.rerender(<Dialog open={false} />); expect(screen.queryByRole("dialog")).toBeNull();
  });
});
