/**
 * FindingsLog — the chronological list of observer findings inside the
 * ObserverPanel. PLAN T15.2:
 *  - `role="log"` + `aria-live="polite"` so screen readers announce new findings
 *    without yanking focus away from the composer.
 *  - Fixed-height row per finding (1-line claim + relative-time stamp).
 *  - React keys are server-assigned stable ids so reconciliation does not
 *    re-mount existing rows when a new review arrives.
 *  - Severity dot drives the visual hierarchy; downgraded STOPs render as
 *    a half-dot + inline "downgraded" chip so the grounding outcome is
 *    transparent to the user.
 */

import type { ObserverFinding } from "../../types.js";

export interface FindingsLogProps {
  findings: readonly ObserverFinding[];
  /** Wallclock (ms) used for "x ago" rendering. Defaults to Date.now() — pass-through for deterministic tests. */
  nowMs?: number;
  /** Optional callback when the user clicks a finding row (e.g. open evidence in editor). */
  onSelect?: (finding: ObserverFinding) => void;
  /** Optional callback to dismiss a STOP finding from this row. Hidden when omitted. */
  onDismissStop?: (findingId: string) => void;
  /** Set of STOP ids already dismissed. Drives the per-row dismiss-button visibility. */
  dismissedStopIds?: ReadonlySet<string>;
}

/**
 * Pure helper: render relative time like "just now", "2m ago", "1h ago".
 * Exported so the same labels appear in BlockerBanner without drift.
 * Beck F4: each branch (recent / minutes / hours / days) has its own test.
 */
export function formatRelativeTime(toMs: number, fromMs: number): string {
  const delta = Math.max(0, fromMs - toMs);
  if (delta < 30_000) return "just now";
  const seconds = Math.floor(delta / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Pure helper: map severity to its design-token colour class. Single
 * source of truth for severity hues — BlockerBanner uses this too so the
 * "STOP" dot in the log matches the banner icon.
 */
export function severityClass(severity: ObserverFinding["severity"]): {
  dot: string;
  text: string;
  label: string;
} {
  switch (severity) {
    case "STOP":
      return { dot: "bg-cc-error", text: "text-cc-error", label: "STOP" };
    case "WARN":
      return { dot: "bg-cc-warning", text: "text-cc-warning", label: "WARN" };
    case "NOTE":
      return { dot: "bg-cc-muted", text: "text-cc-muted", label: "NOTE" };
    case "INFO":
      return { dot: "bg-cc-info", text: "text-cc-info", label: "INFO" };
  }
}

function SeverityDot({ finding }: { finding: ObserverFinding }) {
  const cls = severityClass(finding.severity);
  // Downgraded STOP renders as a "half-tone" muted dot so the user can
  // see at a glance that this row used to be a STOP. Saarinen P3-1:
  // use outline rather than border so layout extent stays at 2×2 — a
  // border would push the row 2px wider than the regular dot column.
  if (finding.wasDowngraded) {
    return (
      <span
        aria-hidden="true"
        className="shrink-0 w-2 h-2 rounded-full outline outline-1 outline-cc-muted/40 outline-offset-0 bg-cc-muted/20"
      />
    );
  }
  return <span aria-hidden="true" className={`shrink-0 w-2 h-2 rounded-full ${cls.dot}`} />;
}

function DowngradedChip({ reason }: { reason: NonNullable<ObserverFinding["downgradeReason"]> }) {
  const human = reason === "evidence_missing_on_disk"
    ? "evidence not on disk"
    : "not in modified files";
  return (
    <span
      className="ml-1 inline-flex items-center text-[9px] uppercase tracking-wide font-mono-code px-1.5 py-0.5 rounded bg-cc-muted/10 text-cc-muted border border-cc-border"
      title={`Server downgraded this STOP — ${human}`}
    >
      downgraded
    </span>
  );
}

function FindingRow({
  finding,
  nowMs,
  onSelect,
  onDismissStop,
  isDismissed,
}: {
  finding: ObserverFinding;
  nowMs: number;
  onSelect?: (finding: ObserverFinding) => void;
  onDismissStop?: (findingId: string) => void;
  isDismissed: boolean;
}) {
  const cls = severityClass(finding.wasDowngraded ? "NOTE" : finding.severity);
  const canDismiss = onDismissStop && finding.severity === "STOP" && !finding.wasDowngraded && !isDismissed;
  const rowClass = isDismissed ? "opacity-60" : "";
  return (
    <li
      data-testid={`finding-row-${finding.id}`}
      data-severity={finding.severity}
      data-downgraded={finding.wasDowngraded ? "true" : "false"}
      className={`group flex items-center gap-2 px-3 py-2 border-b border-cc-border last:border-b-0 hover:bg-cc-hover transition-colors ${rowClass}`}
    >
      <SeverityDot finding={finding} />
      <span className={`text-[10px] uppercase tracking-wide font-mono-code shrink-0 ${cls.text}`}>
        {cls.label}
      </span>
      <button
        type="button"
        onClick={onSelect ? () => onSelect(finding) : undefined}
        disabled={!onSelect}
        className="flex-1 min-w-0 text-left text-xs text-cc-fg truncate disabled:cursor-default cursor-pointer"
        title={finding.claim}
      >
        <span className="truncate">{finding.claim}</span>
      </button>
      {finding.wasDowngraded && finding.downgradeReason && <DowngradedChip reason={finding.downgradeReason} />}
      <span className="text-[10px] text-cc-muted shrink-0 font-mono-code">
        {formatRelativeTime(finding.receivedAt, nowMs)}
      </span>
      {canDismiss && (
        <button
          type="button"
          onClick={() => onDismissStop(finding.id)}
          aria-label={`Dismiss STOP: ${finding.claim}`}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-cc-muted hover:text-cc-fg text-xs leading-none cursor-pointer"
        >
          ×
        </button>
      )}
    </li>
  );
}

export function FindingsLog({
  findings,
  nowMs,
  onSelect,
  onDismissStop,
  dismissedStopIds,
}: FindingsLogProps) {
  // Capture `Date.now()` at render time so tests can pass a fixed reference.
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  if (findings.length === 0) {
    return (
      <div
        role="log"
        aria-live="polite"
        aria-label="Observer findings"
        className="px-3 py-4 text-xs text-cc-muted"
      >
        No findings yet.
      </div>
    );
  }
  // role="log" must live on a generic container (axe aria-allowed-role —
  // role=log on <ul> is rejected). Wrap the list in a div that owns the
  // log semantics; the inner <ul> retains its native list semantics.
  return (
    <div
      role="log"
      aria-live="polite"
      aria-label={`Observer findings (${findings.length})`}
    >
      <ul className="border-t border-cc-border bg-cc-card list-none">
        {findings.map((f) => (
          <FindingRow
            key={f.id}
            finding={f}
            nowMs={now}
            onSelect={onSelect}
            onDismissStop={onDismissStop}
            isDismissed={dismissedStopIds?.has(f.id) ?? false}
          />
        ))}
      </ul>
    </div>
  );
}
