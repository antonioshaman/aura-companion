// Resume-history banner that lives at the top of the message feed when the
// current session was started by resuming/forking an existing Claude thread.
//
// Two mutually-exclusive variants, gated by `resumeHistoryLoaded`:
//   - "cta"      → before the user has loaded any prior transcript. Renders
//                  a card with the source-session id, cwd, a Load button,
//                  and inline error surfacing.
//   - "progress" → after the user clicked Load. Renders a compact line
//                  describing whether more is pageable, currently loading,
//                  or fully exhausted.
//
// Pre-extraction both blocks lived inline in MessageFeed.tsx within ~50 LOC
// of JSX; the helper `formatResumeSourcePath` moved with the component.

export interface ResumeIndicatorProps {
  /**
   * Top-level gate. When false the component renders nothing — the caller is
   * not in a resume/fork session and the banner should not appear at all.
   */
  canLoadResumeHistory: boolean;
  /** Has the user already triggered at least one Load successfully? */
  resumeHistoryLoaded: boolean;
  /** Human-friendly verb shown on the CTA card ("Resuming" or "Forking"). */
  resumeModeLabel: string;
  /** Source Claude session id displayed in the CTA card. */
  resumeSourceSessionId: string;
  /** Optional cwd of the resumed session — last two path segments are shown. */
  sdkSessionCwd?: string;
  /** True while a Load call is in flight (disables button, swaps copy). */
  resumeHistoryLoading: boolean;
  /** Last error message from a failed Load (cleared on success). */
  resumeHistoryError: string;
  /** Whether more prior pages remain after the most recent Load. */
  resumeHistoryHasMore: boolean;
  /** Fired when the Load button is clicked. */
  onLoadResumeHistory: () => void;
}

function formatResumeSourcePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return path;
  return parts.slice(-2).join("/");
}

export function ResumeIndicator({
  canLoadResumeHistory,
  resumeHistoryLoaded,
  resumeModeLabel,
  resumeSourceSessionId,
  sdkSessionCwd,
  resumeHistoryLoading,
  resumeHistoryError,
  resumeHistoryHasMore,
  onLoadResumeHistory,
}: ResumeIndicatorProps) {
  if (!canLoadResumeHistory) return null;

  if (!resumeHistoryLoaded) {
    return (
      <div className="rounded-xl border border-cc-border bg-cc-card p-3" data-testid="resume-indicator-cta">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-cc-fg">
              {resumeModeLabel} existing Claude thread
            </p>
            <p className="text-[11px] text-cc-muted mt-1">
              {resumeSourceSessionId}{" "}
              {sdkSessionCwd ? `· ${formatResumeSourcePath(sdkSessionCwd)}` : ""}
            </p>
          </div>
          <button
            onClick={onLoadResumeHistory}
            disabled={resumeHistoryLoading}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-cc-fg bg-cc-card border border-cc-border rounded-lg hover:bg-cc-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          >
            {resumeHistoryLoading ? "Loading..." : "Load previous history"}
          </button>
        </div>
        {resumeHistoryError && (
          <p className="text-xs text-cc-error mt-2" role="alert">
            {resumeHistoryError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex justify-center" data-testid="resume-indicator-progress">
      <p className="text-[11px] text-cc-muted">
        {resumeHistoryHasMore
          ? resumeHistoryLoading
            ? "Loading older transcript..."
            : "Scroll to top to load older transcript"
          : "Loaded all available prior transcript"}
      </p>
    </div>
  );
}
