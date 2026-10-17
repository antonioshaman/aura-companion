/**
 * ContextAdvisoryBanner — the context-overflow handoff offer.
 *
 * When a session's CLI transcript crosses 5 MB / 10 MB the server records a
 * `context_advisory` on the session state. Instead of the old plain text line
 * ("archive this session and start a fresh one") the chat shows this banner
 * with ONE primary action: "Continue in a new session" — the server writes a
 * handoff brief (current task + capped transcript) into the workspace, spawns
 * a fresh session and the composer there is pre-filled with a pickup prompt.
 * It only reads the persisted message history, so it works even when the old
 * CLI no longer answers.
 *
 * `ContextAdvisoryBanner` is presentational (Playground renders it with mock
 * props); `ContextAdvisoryNotice` wires it to the store, the shared
 * continue-in-new flow and a per-milestone dismissal kept in localStorage
 * (dismissing 5 MB still shows the 10 MB offer).
 */
import { useCallback, useState } from "react";
import { useStore } from "../store.js";
import { useContinueInNewSession } from "../use-continue-in-new-session.js";

interface ContextAdvisoryBannerProps {
  /** Transcript milestone crossed, in bytes. */
  milestoneBytes: number;
  /** Server advisory copy. */
  message: string;
  onContinue: () => void;
  onDismiss?: () => void;
  /** Handoff request in flight — primary action disabled. */
  pending?: boolean;
  /** Why the last attempt failed; the banner stays so the user can retry. */
  error?: string | null;
}

function formatMb(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`;
}

export function ContextAdvisoryBanner({
  milestoneBytes,
  message,
  onContinue,
  onDismiss,
  pending = false,
  error,
}: ContextAdvisoryBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="context-advisory-banner"
      className="px-3 py-3 border-b border-cc-warning/25 bg-cc-warning/10 animate-[fadeSlideIn_0.2s_ease-out]"
    >
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 bg-cc-warning/15 border border-cc-warning/30">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning" aria-hidden="true">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-cc-fg mb-0.5">
            Session context is over {formatMb(milestoneBytes)}
          </div>
          <p className="text-xs text-cc-fg/80 leading-snug mb-1">{message}</p>
          <p className="text-[11px] text-cc-muted leading-snug mb-2">
            Aura writes a handoff of the current task into the workspace and opens a fresh session with a pickup prompt ready to send.
          </p>
          {error && (
            <p role="alert" className="text-[11px] text-cc-error leading-snug mb-2 break-words">
              Couldn't continue in a new session: {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onContinue}
              disabled={pending}
              className="px-2.5 py-1 rounded-md text-xs font-medium bg-cc-primary text-white hover:bg-cc-primary-hover cursor-pointer disabled:cursor-wait disabled:opacity-60"
            >
              {pending ? "Preparing handoff…" : "Continue in a new session"}
            </button>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function dismissKey(sessionId: string): string {
  return `cc-context-advisory-dismissed:${sessionId}`;
}

function readDismissed(sessionId: string): number {
  try {
    const n = Number(localStorage.getItem(dismissKey(sessionId)));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function ContextAdvisoryNotice({ sessionId }: { sessionId: string }) {
  const advisory = useStore((s) => s.sessions.get(sessionId)?.context_advisory);
  const [dismissedMilestone, setDismissedMilestone] = useState<number>(() => readDismissed(sessionId));
  const { run, pending, error } = useContinueInNewSession();

  const onContinue = useCallback(() => {
    void run(sessionId, { reason: "context_too_large" });
  }, [run, sessionId]);

  const onDismiss = useCallback(() => {
    if (!advisory) return;
    try {
      localStorage.setItem(dismissKey(sessionId), String(advisory.milestoneBytes));
    } catch {
      /* storage unavailable — dismissal lasts for this mount only */
    }
    setDismissedMilestone(advisory.milestoneBytes);
  }, [advisory, sessionId]);

  if (!advisory || advisory.action !== "continue_in_new") return null;
  if (advisory.milestoneBytes <= dismissedMilestone) return null;

  return (
    <div className="shrink-0 border-t border-cc-border bg-cc-card">
      <ContextAdvisoryBanner
        milestoneBytes={advisory.milestoneBytes}
        message={advisory.message}
        onContinue={onContinue}
        onDismiss={onDismiss}
        pending={pending}
        error={error}
      />
    </div>
  );
}
