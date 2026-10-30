import { useEffect, useRef } from "react";

// Only the top dialog owns keyboard focus, including nested pickers/editors.
const dialogs: HTMLElement[] = [];
const focusableSelector = 'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]';

export function useModalDialog<T extends HTMLElement>(open: boolean, onClose?: () => void) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  const openerRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  closeRef.current = onClose;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) {
      const rememberOpener = (event: FocusEvent) => {
        // React autofocus can run before the next effect's setup; never mistake
        // the new dialog's input for the opener we must eventually restore.
        if (!openRef.current && event.target instanceof HTMLElement && !ref.current?.contains(event.target)) openerRef.current = event.target;
      };
      document.addEventListener("focusin", rememberOpener);
      return () => document.removeEventListener("focusin", rememberOpener);
    }
    const previous = openerRef.current;
    dialogs.push(dialog);
    const isTop = () => dialogs.at(-1) === dialog;
    const visible = (element: HTMLElement) => {
      for (let node: HTMLElement | null = element; node && node !== dialog; node = node.parentElement) {
        if (getComputedStyle(node).display === "none" || getComputedStyle(node).visibility === "hidden") return false;
      }
      return true;
    };
    const controls = () => [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter((el) =>
      (el.tabIndex >= 0 || (el.getAttribute("contenteditable") === "true" && !el.hasAttribute("tabindex"))) && !el.matches(":disabled") && !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
      visible(el),
    );
    const initial = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? controls()[0] ?? dialog;
    // Keep an explicit autofocus already placed inside the dialog.
    if (!dialog.contains(document.activeElement)) initial.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop() || event.defaultPrevented) return;
      if (event.key === "Escape") {
        // Escape is a shell keystroke (vim, readline), not consent to destroy a PTY.
        if (event.target instanceof Element && event.target.closest("[data-terminal-input]")) return;
        if (closeRef.current) {
          event.preventDefault();
          event.stopPropagation();
          closeRef.current();
        }
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0] ?? dialog;
      const last = items.at(-1) ?? dialog;
      if (!items.length || !dialog.contains(document.activeElement) ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last) || document.activeElement === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (isTop() && event.target instanceof Node && !dialog.contains(event.target)) (controls()[0] ?? dialog).focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocus);
    return () => {
      const wasTop = isTop();
      dialogs.splice(dialogs.indexOf(dialog), 1);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocus);
      if (wasTop && previous?.isConnected) previous.focus();
    };
  }, [open]);
  return ref;
}
