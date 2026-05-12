/**
 * Council Mode keyboard shortcuts.
 *
 * - `Cmd/Ctrl+Shift+O` — toggle the Observer panel for the current session.
 * - `Cmd/Ctrl+Shift+B` — focus the BlockerBanner's primary action when one
 *   is mounted, so a screen-reader or keyboard-only user can jump to the
 *   blocker without scrolling.
 *
 * Both shortcuts are ignored when the user is typing in a textarea, input,
 * or contenteditable element — they would otherwise eat capital letters
 * inside the composer.
 *
 * Mount as a single global instance in App.
 */

import { useEffect } from "react";
import { useStore } from "./store.js";

/**
 * Pure helper: should this keyboard event be ignored because the user is
 * typing in an editable element? Exported so tests assert both branches.
 */
export function shouldIgnoreShortcut(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return true;
  // `isContentEditable` is a read-only computed property that requires the
  // element to be inserted into the document; check the attribute directly
  // so an un-attached editor (rare but possible) and JSDOM both behave.
  if (target.isContentEditable) return true;
  const contentEditableAttr = target.getAttribute("contenteditable");
  if (contentEditableAttr === "" || contentEditableAttr === "true" || contentEditableAttr === "plaintext-only") {
    return true;
  }
  return false;
}

/**
 * Pure helper: does this `KeyboardEvent` match the Council shortcut pattern
 * (Cmd OR Ctrl + Shift + given key, case-insensitive)?
 */
export function matchesCouncilShortcut(event: KeyboardEvent, key: "o" | "b"): boolean {
  if (!event.shiftKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.altKey) return false; // disambiguate from window-manager shortcuts
  return event.key.toLowerCase() === key;
}

/** DOM attribute used to mark the BlockerBanner's primary action for focus. */
export const BLOCKER_PRIMARY_ACTION_ATTR = "data-council-blocker-primary";

export function useCouncilShortcuts(): void {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const toggleObserverPanel = useStore((s) => s.toggleObserverPanel);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (shouldIgnoreShortcut(event.target)) return;
      if (matchesCouncilShortcut(event, "o")) {
        if (!currentSessionId) return;
        event.preventDefault();
        toggleObserverPanel(currentSessionId);
        return;
      }
      if (matchesCouncilShortcut(event, "b")) {
        event.preventDefault();
        const el = document.querySelector<HTMLElement>(`[${BLOCKER_PRIMARY_ACTION_ATTR}]`);
        if (el) el.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentSessionId, toggleObserverPanel]);
}
