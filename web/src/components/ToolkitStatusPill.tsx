/**
 * ToolkitStatusPill — TopBar label for a session that wanted the UI/UX toolkit
 * but could not get it (PLAN Task 7: "visibly labelled 'toolkit unavailable'").
 * Renders nothing for `on` / `off` / unknown: only the failure is worth a label.
 */

import type { SdkSessionInfo } from "../types.js";

export function ToolkitStatusPill({ exposure }: { exposure: SdkSessionInfo["skillExposure"] }) {
  if (exposure?.status !== "unavailable") return null;
  return (
    <span
      data-testid="toolkit-status-pill"
      className="hidden md:inline-flex items-center rounded-full border border-cc-border bg-cc-card px-2.5 py-1 text-[11px] text-cc-muted"
      title={exposure.reason}
    >
      Toolkit unavailable
      {exposure.reason && <span className="sr-only">: {exposure.reason}</span>}
    </span>
  );
}
