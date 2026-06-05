// AURA-LOCAL - PLAN T12 (Phase G, Story 2c).
//
// Destructive-tone banner shown above the Composer when the
// server emits a `cli_failed` wire frame for this session. This
// is the TERMINAL-FAILURE surface: the agent is permanently dead
// or the browser-close drain expired with messages still queued,
// and the only recovery is starting a fresh session. Reuses
// BlockerBanner cc-error/* destructive tokens + the
// `animate-[fadeSlideIn_0.2s_ease-out]` entrance to keep the
// visual hierarchy consistent (Saarinen R1 + R6); never the
// `cc-warning/*` palette - terminal-fail is not a recoverable
// state inside this session.
//
// === Design contract - Friedman R7 vs Frontend R5 ============
// Friedman R7 recommended dismissible-with-focus-restore so
// users can clear the banner while they read the chat history.
// Frontend R5 ruled non-dismissible v1 because the session is
// genuinely unusable - dismissing would suggest the user can
// keep typing, which they cannot. We ship non-dismissible v1
// and document the conflict here. A behavioural assertion in
// the test suite (`queryByRole("button", { name: /dismiss/i })`)
// catches a regression that re-introduces a dismiss button.
//
// === a11y R10 - single-fire announcement ====================
// `role="alert"` with `aria-live="assertive"` announces ON MOUNT.
// We deliberately do NOT remount on re-render (no key derived
// from `firedAt`), so a parent re-render does not re-announce.
// The test suite asserts mount-once semantics behaviourally:
// re-rendering with the same `failure` does not refire the
// `role="alert"` node entrance.
//
// === a11y R5 / Saarinen R2 - non-truncation =================
// Body copy wraps via `whitespace-pre-wrap break-words`. The
// banner header truncates ONLY the SHA-256 monospace token
// (operator-only), never the human-readable copy.
//
// === Saarinen R3 / Friedman R3 - drained-count typography ===
// `drainedCount` renders as a mono integer in a dedicated chip
// when > 0. Zero suppresses the chip entirely (avoids the false
// "0 messages lost" reassurance - when the server fires with
// drainedCount=0 there was no queue loss to mention).

import { useEffect, useMemo, useRef, useState } from "react";
import { cliFailedCopy } from "../cli-failed-copy.js";
import type { CliFailure } from "../store/cli-status-slice.js";

export interface CliFailedBannerProps {
  /** Terminal-failure record from the cli-status-slice. */
  failure: CliFailure;
  /** Click handler for the primary "Start new session with this draft"
   *  affordance. The parent (ChatView) owns the draft-carryover wiring
   *  via the existing pickup-draft channel. */
  onStartNewSession: () => void;
}

export function CliFailedBanner({ failure, onStartNewSession }: CliFailedBannerProps) {
  const copy = useMemo(() => cliFailedCopy(failure.reason), [failure.reason]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const sha = failure.lastErrorSha256;

  // a11y finding #11 — the banner is the terminal surface with a single
  // recovery action, but `role="alert"` only ANNOUNCES; keyboard/SR focus is
  // left wherever it was (typically the now-disabled Composer). Move focus to
  // the sole recovery button on mount so the next Tab/Enter acts on recovery.
  // The banner mounts exactly on the failure transition (parent renders it
  // only while `cliFailure` is truthy), so mount === transition.
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="cli-failed-banner"
      data-reason={failure.reason}
      className="px-2 sm:px-4 py-3 border-b border-cc-error/20 bg-cc-error/5 animate-[fadeSlideIn_0.2s_ease-out]"
    >
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start gap-2 sm:gap-3">
          {/* Destructive icon - same shape as BlockerBanner so the slot
              reads visually consistent when the banner replaces a blocker. */}
          <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-cc-error/10 border border-cc-error/25">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-cc-error" aria-hidden="true">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
            </svg>
          </div>

          {/* Body */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-[10px] uppercase tracking-wide font-mono-code text-cc-error font-semibold">
                Session can’t continue
              </span>
              {failure.drainedCount > 0 && (
                <span
                  data-testid="cli-failed-drained-count"
                  title="Number of queued messages that did not reach the agent"
                  className="text-[10px] font-semibold leading-none px-1.5 py-0.5 rounded bg-cc-error/15 text-cc-error border border-cc-error/25 font-mono-code tabular-nums"
                >
                  {failure.drainedCount} queued
                </span>
              )}
            </div>
            <p
              data-testid="cli-failed-headline"
              className="text-sm text-cc-fg leading-relaxed font-medium mb-1 whitespace-pre-wrap break-words"
            >
              {copy.headline}
            </p>
            <p
              data-testid="cli-failed-body"
              className="text-sm text-cc-fg/85 leading-relaxed whitespace-pre-wrap break-words"
            >
              {copy.body}
            </p>

            {/* Friedman R6 progressive disclosure - operators can
                copy the SHA for cross-reference with server logs;
                end-users never see it. Chevron-style trigger. */}
            {sha && (
              <div className="mt-2">
                <button
                  type="button"
                  data-testid="cli-failed-details-toggle"
                  aria-expanded={detailsOpen}
                  onClick={() => setDetailsOpen((v) => !v)}
                  className="text-[10px] font-mono-code text-cc-muted hover:text-cc-fg transition-colors cursor-pointer inline-flex items-center gap-1"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2.5 h-2.5 transition-transform duration-150 ${detailsOpen ? "rotate-90" : ""}`} aria-hidden="true">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  Details for support
                </button>
                {detailsOpen && (
                  <div className="mt-1 text-[10px] text-cc-muted font-mono-code break-all">
                    error sha256: <span data-testid="cli-failed-sha256">{sha}</span>
                  </div>
                )}
              </div>
            )}

            {/* Primary action - single button. Friedman P5: every variant
                resolves to the same affordance ("Start a new session with
                this draft"). Marked data-cli-failed-primary so ChatView
                can focus / keyboard-shortcut it later if needed. */}
            <div className="mt-3">
              <button
                ref={primaryRef}
                type="button"
                data-cli-failed-primary=""
                data-testid="cli-failed-primary-action"
                onClick={onStartNewSession}
                className="text-xs font-medium px-3 py-1.5 rounded-md bg-cc-error/15 hover:bg-cc-error/25 text-cc-error transition-colors cursor-pointer"
              >
                {copy.action}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
