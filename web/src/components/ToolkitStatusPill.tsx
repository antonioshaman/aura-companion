/**
 * ToolkitStatusPill — TopBar label for a session that wanted the UI/UX toolkit
 * but could not get it (PLAN Task 7: "visibly labelled 'toolkit unavailable'"):
 * either the spawn decision was "unavailable", or it was "on" and the last spawn
 * could not deliver it (`deliveryError`). Renders nothing otherwise. Visible at
 * every breakpoint — a phone user needs the label as much as a desktop one.
 */

import type { SdkSessionInfo } from "../types.js";

export function ToolkitStatusPill({ exposure }: { exposure: SdkSessionInfo["skillExposure"] }) {
  const reason = exposure?.status === "unavailable" ? exposure.reason : exposure?.status === "on" ? exposure.deliveryError : undefined;
  if (exposure?.status !== "unavailable" && !reason) return null;
  return (
    <span
      data-testid="toolkit-status-pill"
      className="inline-flex items-center whitespace-nowrap rounded-full border border-cc-border bg-cc-card px-2.5 py-1 text-[11px] text-cc-muted"
      title={reason}
    >
      Toolkit unavailable
      {reason && <span className="sr-only">: {reason}</span>}
    </span>
  );
}
