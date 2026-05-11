/**
 * useBrowserTitleAlert — mutates `document.title` to prepend `(N)` when
 * one or more Council Mode groups have unresolved STOP findings, so the
 * user catches blockers even when the tab is in the background.
 *
 * The hook reads from the council slice (groups, findings, dismissedStopIds)
 * and computes the aggregate via the pure
 * {@link countUnresolvedStopsAcrossGroups} helper. On unmount and on count
 * transitions to 0, the original title is restored.
 *
 * Mount as a single global instance in App — multiple instances would
 * fight over `document.title` and race each other.
 */

import { useEffect, useRef } from "react";
import { useStore } from "./store.js";
import { countUnresolvedStopsAcrossGroups } from "./observer-panel-state.js";

/**
 * Pure helper: prefix a title with `(N) ` while N > 0; otherwise strip
 * any existing `(M) ` prefix and return the bare title.
 *
 * Exported so tests can exercise both the add-prefix and strip-prefix
 * branches independently (Beck F4) without touching `document.title`.
 */
export function applyTitleAlertPrefix(currentTitle: string, unresolvedCount: number): string {
  // Strip any existing `(\d+) ` prefix the hook may have applied on a previous tick.
  const stripped = currentTitle.replace(/^\(\d+\)\s+/, "");
  if (unresolvedCount <= 0) return stripped;
  return `(${unresolvedCount}) ${stripped}`;
}

export function useBrowserTitleAlert(): void {
  const findings = useStore((s) => s.findings);
  const dismissedStopIds = useStore((s) => s.dismissedStopIds);

  // Capture the title that existed before this hook ever ran so we can
  // restore it on unmount. The captured value is the "true" title that
  // routing / page changes set; the hook only ever decorates it.
  const baseTitleRef = useRef<string | null>(null);
  if (baseTitleRef.current === null && typeof document !== "undefined") {
    baseTitleRef.current = document.title.replace(/^\(\d+\)\s+/, "");
  }

  useEffect(() => {
    if (typeof document === "undefined") return;
    const count = countUnresolvedStopsAcrossGroups(findings, dismissedStopIds);
    // The "current base" may have changed mid-session (routing updated
    // document.title without going through this hook). Re-strip a prefix
    // before re-applying so we never accumulate `(2) (1) Title`.
    const base = document.title.replace(/^\(\d+\)\s+/, "");
    document.title = applyTitleAlertPrefix(base, count);
  }, [findings, dismissedStopIds]);

  // Restore the captured base title on unmount so a remount doesn't
  // start with a stale `(N) ` prefix.
  useEffect(() => {
    return () => {
      if (typeof document === "undefined") return;
      if (baseTitleRef.current !== null) {
        document.title = baseTitleRef.current;
      }
    };
  }, []);
}
