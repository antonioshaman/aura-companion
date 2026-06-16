/**
 * ModelFallbackBanner — warning-tone notice shown when a session is running on
 * a fallback model because the preferred one became unavailable (registry
 * `retired`/`blocked`, or a reactive runtime revert after a 404/403/overload).
 *
 * Task 8 (Model Registry + Graceful Failover): the visual recipe is reused
 * VERBATIM from `council/DegradedBanner.tsx` — same warning palette
 * (`bg-cc-warning/10`, `border-cc-warning/25`, triangle chip, `text-cc-fg`
 * label/body, `fadeSlideIn` entrance). A model fallback is an infrastructure
 * downgrade, not a content blocker, so it must NOT borrow the destructive/red
 * BlockerBanner token. Mounting is wired in Task 9 (substitution UX); this
 * component only renders the notice.
 *
 * The proactive (validate-before-switch) and reactive (runtime revert) paths
 * MUST produce identical copy here — the user shouldn't be able to tell which
 * mechanism caught the unavailable model.
 */

interface ModelFallbackBannerProps {
  /** Human label of the model the session WANTED but can't use. */
  fromModel: string;
  /** Human label of the model the session is actually running on now. */
  toModel: string;
  /**
   * Why the preferred model is unavailable. Drives one clause of the copy;
   * omit for a generic "unavailable".
   */
  reason?: "retired" | "blocked" | "overloaded";
  /** Dismiss the notice. The fallback stays in effect; this only hides the banner. */
  onDismiss?: () => void;
}

function reasonClause(reason: ModelFallbackBannerProps["reason"]): string {
  switch (reason) {
    case "retired":
      return "is no longer available";
    case "blocked":
      return "is blocked for this session (region or policy)";
    case "overloaded":
      return "is temporarily overloaded";
    default:
      return "is unavailable";
  }
}

export function ModelFallbackBanner({ fromModel, toModel, reason, onDismiss }: ModelFallbackBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="model-fallback-banner"
      className="px-3 py-3 border-b border-cc-warning/25 bg-cc-warning/10 animate-[fadeSlideIn_0.2s_ease-out]"
    >
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 bg-cc-warning/15 border border-cc-warning/30">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning" aria-hidden="true">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-cc-fg mb-0.5">Running on a fallback model</div>
          <p className="text-xs text-cc-fg/80 leading-snug mb-2">
            {fromModel} {reasonClause(reason)}. This session is running on {toModel} instead.
          </p>
          {onDismiss && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onDismiss}
                className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
