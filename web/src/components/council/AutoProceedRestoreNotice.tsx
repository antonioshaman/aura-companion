/**
 * AutoProceedRestoreNotice — FIX-AP-4. After a server restart the pair's
 * auto-proceed hold is restored from `.council/reviews/`. When a review file
 * cannot be read or parsed, the restore stays incomplete and auto-proceed
 * stays paused (fail-closed) — with no STOP to show for it. This notice makes
 * that pause visible: which files, why, and (for review files) an
 * "Ignore this file" action the server persists for that exact content.
 *
 * Renders nothing when there is no gap.
 */

import type { AutoProceedRestoreGap } from "../../types.js";

export interface AutoProceedRestoreNoticeProps {
  gaps: readonly AutoProceedRestoreGap[];
  onIgnore: (gap: AutoProceedRestoreGap) => void;
}

export function AutoProceedRestoreNotice({ gaps, onIgnore }: AutoProceedRestoreNoticeProps) {
  if (gaps.length === 0) return null;
  return (
    <section
      data-testid="auto-proceed-restore-notice"
      aria-labelledby="auto-proceed-restore-notice-title"
      className="shrink-0 px-3 py-2.5 border-b border-cc-warning/25 bg-cc-warning/10"
    >
      <h2 id="auto-proceed-restore-notice-title" className="text-xs font-medium text-cc-fg">
        Auto-proceed paused: restore incomplete
      </h2>
      <p className="mt-0.5 text-[11px] text-cc-muted leading-snug">
        After a restart the server could not check every past review for unresolved blockers, so
        auto-proceed stays off until these are fixed or ignored.
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {gaps.map((g) => (
          <li key={g.gap} data-testid="auto-proceed-restore-gap" className="flex items-start gap-2">
            <div className="flex-1 min-w-0 text-[11px] leading-snug">
              {g.file && <div className="font-mono-code text-cc-fg break-all">{g.file}</div>}
              <div className="text-cc-muted">{g.reason}</div>
            </div>
            {g.file && g.fingerprint && (
              <button
                type="button"
                onClick={() => onIgnore(g)}
                aria-label={`Ignore ${g.file} for auto-proceed`}
                className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-md bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-fg border border-cc-warning/30 transition-colors cursor-pointer"
              >
                Ignore this file
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
