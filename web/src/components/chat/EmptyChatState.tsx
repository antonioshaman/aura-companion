/**
 * Empty-state hero for an active session with no merged messages yet.
 *
 * Two rendering branches:
 *  - Resume-available: prior Claude thread exists (sdkSession carries a
 *    resume source ID). Surfaces a "Load previous history" CTA gated on
 *    `resumeHistoryLoading` and conditionally surfacing `resumeHistoryError`.
 *  - Fresh: no prior context — generic "send a message to begin" prompt.
 *
 * Extracted from MessageFeed.tsx (lines 849-913 pre-extraction) to:
 *  - shrink the MessageFeed module (1100 LOC god-component)
 *  - make the empty-state independently snapshot/axe-testable
 *  - isolate the sparkle-icon JSX so future styling tweaks don't touch
 *    the feed's mounting logic
 *
 * Coupling kept narrow: receives the resume-derivations as props rather
 * than reading from store directly. MessageFeed remains the owner of the
 * derivation logic.
 */

interface EmptyChatStateProps {
  /** True when the session has a Claude resume source available. */
  canLoadResumeHistory: boolean;
  /** Verb prefix for the resume description — "Resuming" or "Forking". */
  resumeModeLabel: string;
  /** Full Claude session ID of the resume source (first 8 chars rendered). */
  resumeSourceSessionId: string;
  /** True while the resume-history fetch is in flight. */
  resumeHistoryLoading: boolean;
  /** Error message from the last resume-history fetch — empty string when no
   * error. Producer (MessageFeed) initialises with `useState("")` and only
   * assigns strings; narrowed from `string | null` per observer review of
   * the extraction commit. */
  resumeHistoryError: string;
  /** Click handler for the resume-history CTA. */
  onLoadResumeHistory: () => void;
}

export function EmptyChatState({
  canLoadResumeHistory,
  resumeModeLabel,
  resumeSourceSessionId,
  resumeHistoryLoading,
  resumeHistoryError,
  onLoadResumeHistory,
}: EmptyChatStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 select-none px-6">
      {/* Animated sparkle icon */}
      <div className="relative">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cc-primary/10 to-cc-primary/5 border border-cc-primary/15 flex items-center justify-center shadow-[0_4px_20px_rgba(217,119,87,0.08)]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-7 h-7 text-cc-primary"
            aria-hidden="true"
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </div>
        <div className="absolute -top-1 -right-1 w-3 h-3">
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className="w-3 h-3 text-cc-primary/40 animate-[gentle-bounce_2s_ease-in-out_infinite]"
            aria-hidden="true"
          >
            <path d="M8 2L10.5 6.5L15 8L10.5 9.5L8 14L5.5 9.5L1 8L5.5 6.5L8 2Z" />
          </svg>
        </div>
      </div>
      <div className="text-center max-w-xs">
        {canLoadResumeHistory ? (
          <>
            <p className="text-sm text-cc-fg font-medium mb-1.5">
              This session has prior context
            </p>
            <p className="text-xs text-cc-muted leading-relaxed mb-4">
              {resumeModeLabel}{" "}
              <span className="font-mono-code text-cc-fg/70">{resumeSourceSessionId.slice(0, 8)}</span>.
              Load earlier messages when needed.
            </p>
            <button
              onClick={onLoadResumeHistory}
              disabled={resumeHistoryLoading}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-cc-fg bg-cc-card border border-cc-border rounded-xl hover:bg-cc-hover hover:border-cc-primary/20 transition-all disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="w-3.5 h-3.5"
                aria-hidden="true"
              >
                <path d="M8 2v12M3 9l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {resumeHistoryLoading ? "Loading..." : "Load previous history"}
            </button>
            {resumeHistoryError && (
              <p className="text-xs text-cc-error mt-2" role="alert">
                {resumeHistoryError}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-[15px] text-cc-fg font-medium mb-1.5">
              Start a conversation
            </p>
            <p className="text-xs text-cc-muted leading-relaxed">
              Send a message to begin working with Aura Companion.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
