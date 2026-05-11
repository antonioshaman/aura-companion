/**
 * BlockerBanner — destructive-tone banner shown above the Composer when
 * the observer flagged a STOP for the orchestrator's most recent work.
 *
 * PLAN T15.3:
 *  - Lives in the SAME DOM slot as PermissionBanner (same shell, same
 *    animation), but with a DISTINCT destructive colour token and distinct
 *    icon so users don't confuse blockers with permission prompts.
 *  - Only one of {PermissionBanner, BlockerBanner} occupies the slot at a
 *    time — caller stacks them permission-first (handled in ChatView).
 *  - Reasoning visible — evidence path + line range + observer attribution
 *    are spelled out. Not a verdict in isolation.
 *  - Dismissable but not snoozable; dismissed STOPs remain in the
 *    FindingsLog permanently.
 *  - Renders ONLY through JSX text content; never `dangerouslySetInnerHTML`.
 */

import type { ObserverFinding } from "../../types.js";
import { formatRelativeTime } from "./FindingsLog.js";

export interface BlockerBannerProps {
  finding: ObserverFinding;
  /** Wallclock (ms) used for the relative-time stamp; defaults to Date.now(). */
  nowMs?: number;
  /** Dismiss this STOP from the banner. Finding remains in FindingsLog. */
  onDismiss: (findingId: string) => void;
  /** Optional callback when user clicks "Open evidence" (route to editor or file panel). */
  onOpenEvidence?: (finding: ObserverFinding) => void;
  /** Optional callback when user marks the STOP addressed (same as dismiss in v1; reserved for future status). */
  onMarkAddressed?: (finding: ObserverFinding) => void;
}

function formatEvidenceLine(finding: ObserverFinding): string {
  if (finding.evidence_lines) {
    return `${finding.evidence_path}:${finding.evidence_lines[0]}-${finding.evidence_lines[1]}`;
  }
  return finding.evidence_path;
}

export function BlockerBanner({
  finding,
  nowMs,
  onDismiss,
  onOpenEvidence,
  onMarkAddressed,
}: BlockerBannerProps) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="blocker-banner"
      className="px-2 sm:px-4 py-3 border-b border-cc-error/20 bg-cc-error/5 animate-[fadeSlideIn_0.2s_ease-out]"
    >
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start gap-2 sm:gap-3">
          {/* Destructive icon — distinct from PermissionBanner's warning ⚠ */}
          <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-cc-error/10 border border-cc-error/25">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-cc-error" aria-hidden="true">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
            </svg>
          </div>

          {/* Body */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] uppercase tracking-wide font-mono-code text-cc-error font-semibold">
                Blocker from observer
              </span>
              <span className="text-[10px] text-cc-muted font-mono-code">
                · {formatRelativeTime(finding.receivedAt, now)}
              </span>
            </div>
            <p className="text-sm text-cc-fg leading-relaxed mb-2 whitespace-pre-wrap break-words">
              {finding.claim}
            </p>
            <div className="text-xs text-cc-muted font-mono-code mb-2">
              Evidence: <span data-testid="blocker-evidence" className="text-cc-fg">{formatEvidenceLine(finding)}</span>
            </div>
            <div className="text-[10px] text-cc-muted">
              Observer: <span className="font-mono-code">{finding.observerProvider}</span>
              <span> · model </span>
              <span className="font-mono-code">{finding.observerModel}</span>
              <span> · phase </span>
              <span className="font-mono-code">{finding.phase}</span>
            </div>

            {/* Actions */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onOpenEvidence && (
                <button
                  type="button"
                  onClick={() => onOpenEvidence(finding)}
                  className="text-xs font-medium px-3 py-1.5 rounded-md bg-cc-error/15 hover:bg-cc-error/25 text-cc-error transition-colors cursor-pointer"
                >
                  Open evidence
                </button>
              )}
              {onMarkAddressed && (
                <button
                  type="button"
                  onClick={() => onMarkAddressed(finding)}
                  className="text-xs font-medium px-3 py-1.5 rounded-md bg-cc-card hover:bg-cc-hover text-cc-fg border border-cc-border transition-colors cursor-pointer"
                >
                  Mark addressed
                </button>
              )}
              <button
                type="button"
                onClick={() => onDismiss(finding.id)}
                className="text-xs text-cc-muted hover:text-cc-fg transition-colors cursor-pointer ml-auto"
              >
                Dismiss for now
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
