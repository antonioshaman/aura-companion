/**
 * DegradedBanner — warning-tone banner shown in the ObserverPanel HEADER
 * when one half of the pair is dead.
 *
 * PLAN T15.4: Lives in the Observer panel header, NOT in the composer
 * blocker slot. Channel separation: infrastructure problems
 * (observer offline) are distinct from content problems (observer found
 * a STOP). Warning palette (desaturated cc-warning), Respawn as primary,
 * "Continue solo" as secondary.
 *
 * Clicking Respawn flips local state to a `respawning` view with spinner
 * and Cancel — the actual respawn is fired through the supplied callback;
 * the parent is responsible for awaiting the backend ack.
 */

import { useState } from "react";
import type { SessionRole } from "../../types.js";

export interface DegradedBannerProps {
  /** Which half of the pair died. The label changes accordingly. */
  deadRole: SessionRole;
  /** Optional degraded reason from the server for more truthful copy. */
  reason?: "observer_exited" | "wake_send_failed" | "reconnect_failed" | "wake_produced_no_review";
  /** Respawn the missing half. Returns a promise so the spinner reflects in-flight state. */
  onRespawn: () => void | Promise<void>;
  /** Continue solo — dismisses the degraded banner but keeps the panel visible. */
  onContinueSolo?: () => void;
  /**
   * Whether a respawn is currently in flight. When omitted, the component
   * tracks its own state from the onRespawn promise; passing a value
   * forces controlled mode (used by parent integration with backend ack).
   */
  isRespawning?: boolean;
}

export function DegradedBanner({
  deadRole,
  reason,
  onRespawn,
  onContinueSolo,
  isRespawning: controlledRespawning,
}: DegradedBannerProps) {
  const [localRespawning, setLocalRespawning] = useState(false);
  const respawning = typeof controlledRespawning === "boolean" ? controlledRespawning : localRespawning;

  const handleRespawn = async () => {
    if (typeof controlledRespawning === "boolean") {
      // Controlled mode — caller manages spinner state.
      await onRespawn();
      return;
    }
    setLocalRespawning(true);
    try {
      await onRespawn();
    } finally {
      // The parent will swap the banner out once the group leaves
      // `degraded`, but reset locally too so a still-mounted instance
      // re-enables the button if the respawn failed.
      setLocalRespawning(false);
    }
  };

  const handleCancel = () => {
    if (typeof controlledRespawning === "boolean") return;
    setLocalRespawning(false);
  };

  const label = deadRole === "observer" ? "Observer offline" : "Orchestrator offline";
  const detail = (() => {
    if (deadRole === "observer" && reason === "wake_send_failed") {
      return "The observer session is up, but the server could not wake it for review. Respawn the observer to restore checkpoint-driven review.";
    }
    if (deadRole === "observer" && reason === "reconnect_failed") {
      return "The observer failed to reconnect after a transport interruption. Respawn it to resume independent review.";
    }
    if (deadRole === "observer" && reason === "wake_produced_no_review") {
      return "The observer accepted a checkpoint but did not produce a review in time. Respawn it to resume independent review.";
    }
    if (deadRole === "observer") {
      return "The orchestrator continues running solo. Respawn the observer to resume independent review.";
    }
    return "The observer is alive but the orchestrator died. This is an unusual state — respawn or end the group.";
  })();

  // a11y council review #10 (P2#10 — A11Y-P1-3 + Saarinen P2-1/3): the
  // label and button text previously rendered as `text-cc-warning` over a
  // tinted background — fails WCAG AA at 4.5:1 in light mode. Switching
  // label + button text to `text-cc-fg` keeps the warning identity in
  // the icon + border + button background, where contrast is fine; the
  // accessible text now meets AA. Also: bg alpha snapped to /10 (was /8,
  // off the project's 5/10/15/25 scale per Saarinen P2-3).
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="degraded-banner"
      className="px-3 py-3 border-b border-cc-warning/25 bg-cc-warning/10 animate-[fadeSlideIn_0.2s_ease-out]"
    >
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 bg-cc-warning/15 border border-cc-warning/30">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning" aria-hidden="true">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-cc-fg mb-0.5">{label}</div>
          <p className="text-xs text-cc-fg/80 leading-snug mb-2">{detail}</p>
          <div className="flex items-center gap-2">
            {respawning ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-xs text-cc-fg font-medium px-2.5 py-1 rounded-md bg-cc-warning/15">
                  <span className="w-3 h-3 rounded-full border-2 border-cc-muted/20 border-t-cc-warning animate-spin" aria-hidden="true" />
                  Respawning…
                </span>
                {typeof controlledRespawning !== "boolean" && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
                  >
                    Cancel
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleRespawn}
                  className="text-xs font-medium px-3 py-1.5 rounded-md bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-fg border border-cc-warning/30 transition-colors cursor-pointer"
                >
                  Respawn {deadRole}
                </button>
                {onContinueSolo && (
                  <button
                    type="button"
                    onClick={onContinueSolo}
                    className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
                  >
                    Continue solo
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
