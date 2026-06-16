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

import { useEffect, useState } from "react";
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
  /**
   * Council Review 2026-05-13 a11y #10: scope key for the SR
   * announcement-coalescer cross-mount memory. Pass a stable id
   * (typically `sessionGroupId`) and the FindingsLog will only
   * announce findings that haven't been announced under this key
   * before — even across panel collapse/expand cycles that re-mount
   * the component. When omitted, defaults to a module-level shared
   * key (legacy single-group behaviour kept for back-compat).
   */
  announcerScope?: string;
}

/**
 * Module-level coalescer for the SR summary announcer. Survives all
 * FindingsLog mount/unmount cycles so panel collapse/expand does not
 * re-announce existing findings. Keyed by `announcerScope` (typically
 * the sessionGroupId) so multiple Council groups in the same browser
 * tab maintain independent announcement state. Never freed —
 * accumulating ids are bounded by the lifetime of the page; future
 * cleanup belongs in the council slice's `removeGroup` if accumulation
 * becomes a concern.
 */
const ANNOUNCED_FINDING_IDS_BY_SCOPE = new Map<string, Set<string>>();
const DEFAULT_ANNOUNCER_SCOPE = "__default__";

/**
 * Council Review 2026-05-13-0150 React × Fowler #15: exposed for the
 * slice's `removeGroup` action to call so an exited group's announcer
 * state doesn't leak. Closes the JSDoc-only-contract concern from the
 * regression review.
 */
export function clearAnnouncerScope(scope: string): void {
  ANNOUNCED_FINDING_IDS_BY_SCOPE.delete(scope);
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

/**
 * Council Review 2026-05-13 Friedman #19: exhaustive switch — adding a
 * new downgrade reason without extending this map is a compile-time
 * error rather than a fall-through to "not in modified files".
 */
function downgradeReasonHuman(reason: NonNullable<ObserverFinding["downgradeReason"]>): string {
  switch (reason) {
    case "evidence_missing_on_disk":
      return "evidence not on disk";
    case "evidence_not_in_modified_set":
      return "not in modified files";
    case "wake_version_mismatch":
      return "schema mismatch — review may be stale";
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return "downgraded";
    }
  }
}

function DowngradedChip({ reason }: { reason: NonNullable<ObserverFinding["downgradeReason"]> }) {
  const human = downgradeReasonHuman(reason);
  // Council Review 2026-05-13-0150 a11y #8: render the reason inline as
  // visible text AND expose it via aria-label so the chip is not silent
  // to keyboard / screen-reader users. `title` stays for sighted-mouse
  // discoverability but is no longer the sole channel for the reason.
  return (
    <span
      className="ml-1 inline-flex items-center gap-1 text-[9px] uppercase tracking-wide font-mono-code px-1.5 py-0.5 rounded bg-cc-muted/10 text-cc-muted border border-cc-border"
      title={`Server downgraded this STOP — ${human}`}
      aria-label={`Server downgraded this STOP — ${human}`}
    >
      downgraded
      <span className="opacity-70 normal-case font-normal tracking-normal">· {human}</span>
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

/**
 * Pure: derive the one-line screen-reader summary for a review event.
 * Exported so the test pack (Task 13) can pin both the math and the
 * grammar without rendering a component. Singular/plural distinctions
 * matter — SR users hear this verbatim every checkpoint with findings.
 */
export function buildFindingsReviewSummary(args: {
  newBlockers: number;
  newWarnings: number;
  newNotes: number;
  newInfos: number;
}): string {
  const parts: string[] = [];
  if (args.newBlockers > 0) parts.push(`${args.newBlockers} blocker${args.newBlockers === 1 ? "" : "s"}`);
  if (args.newWarnings > 0) parts.push(`${args.newWarnings} warning${args.newWarnings === 1 ? "" : "s"}`);
  if (args.newNotes > 0) parts.push(`${args.newNotes} note${args.newNotes === 1 ? "" : "s"}`);
  if (args.newInfos > 0) parts.push(`${args.newInfos} info`);
  if (parts.length === 0) return "Observer review complete: no findings";
  return `Observer review complete: ${parts.join(", ")}`;
}

export function FindingsLog({
  findings,
  nowMs,
  onSelect,
  onDismissStop,
  dismissedStopIds,
  announcerScope,
}: FindingsLogProps) {
  // Capture `Date.now()` at render time so tests can pass a fixed reference.
  const now = typeof nowMs === "number" ? nowMs : Date.now();

  // Task 12: cadence-aware live-region pattern.
  //
  // The row container is `role="log" aria-live="off"` — `log` is kept
  // for screen-reader landmark navigation (JAWS/NVDA expose log
  // landmarks for jump-to), but `aria-live="off"` prevents the polite
  // queue from filling with per-row append events. With auto-wake firing
  // on every checkpoint, the previous `aria-live="polite"` on this
  // container produced 3–8 rapid-fire announcements per phase — an
  // unusable cadence for SR users running a Carmack-Council pipeline.
  //
  // The summary announcer below collapses each REVIEW event (one
  // checkpoint round-trip) into a single polite line.
  //
  // Council Review 2026-05-13 a11y #10: the announcement-coalescer
  // state lives in the module-level ANNOUNCED_FINDING_IDS_BY_SCOPE Map,
  // not in a per-mount useRef. Collapsing and re-expanding the panel
  // (which unmounts FindingsLog) no longer re-announces existing
  // findings. `aria-atomic="true"` ensures the announcer reads the
  // whole summary each time rather than diffing into a stream.
  const scope = announcerScope ?? DEFAULT_ANNOUNCER_SCOPE;
  const [announcement, setAnnouncement] = useState<string>("");
  useEffect(() => {
    const seen = ANNOUNCED_FINDING_IDS_BY_SCOPE.get(scope) ?? new Set<string>();
    const newOnes = findings.filter((f) => !seen.has(f.id));
    if (newOnes.length === 0) return;
    for (const f of newOnes) seen.add(f.id);
    ANNOUNCED_FINDING_IDS_BY_SCOPE.set(scope, seen);
    const summary = buildFindingsReviewSummary({
      newBlockers: newOnes.filter((f) => f.severity === "STOP" && f.wasDowngraded !== true).length,
      newWarnings: newOnes.filter((f) => f.severity === "WARN").length,
      newNotes: newOnes.filter((f) => f.severity === "NOTE" || (f.severity === "STOP" && f.wasDowngraded === true)).length,
      newInfos: newOnes.filter((f) => f.severity === "INFO").length,
    });
    setAnnouncement(summary);
  }, [findings, scope]);

  // Council Review 2026-05-13 a11y #20: only render the announcer once
  // it has content — empty `role="status"` mounts cause some SR
  // engines (VoiceOver historically) to announce "blank".
  const summaryAnnouncer = announcement.length > 0 ? (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="findings-review-announcer"
      className="sr-only"
    >
      {announcement}
    </div>
  ) : null;

  if (findings.length === 0) {
    return (
      <>
        <div
          role="log"
          aria-live="off"
          aria-label="Observer findings"
          className="px-3 py-4 text-xs text-cc-muted"
        >
          No findings yet.
        </div>
        {summaryAnnouncer}
      </>
    );
  }
  // Newest-first display: the source `findings` array is append-ordered
  // (each review batch pushed onto the end by the council slice), so the
  // most recent finding is last. Render a reversed copy so fresh findings
  // surface at the top of the rail. The reversal is display-only — the
  // announcer effect above still reads the original array (order-independent,
  // keyed by a Set of ids).
  const orderedFindings = [...findings].reverse();
  // role="log" must live on a generic container (axe aria-allowed-role —
  // role=log on <ul> is rejected). Wrap the list in a div that owns the
  // log semantics; the inner <ul> retains its native list semantics.
  return (
    <>
      <div
        role="log"
        aria-live="off"
        aria-label="Observer findings"
      >
        <ul className="border-t border-cc-border bg-cc-card list-none">
          {orderedFindings.map((f) => (
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
      {summaryAnnouncer}
    </>
  );
}
