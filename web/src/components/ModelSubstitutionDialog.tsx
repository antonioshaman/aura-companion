/**
 * ModelSubstitutionDialog — APG modal confirmation for a CROSS-TIER model
 * substitution (Model Registry Task 9). When the user's chosen model is
 * `retired`/`blocked` and its only registry replacement lands on a DIFFERENT
 * cost tier, the server refuses to swap silently (`needs-user-action`, no frame
 * sent). This dialog asks before spending differently: Confirm re-runs the
 * switch toward the replacement; Cancel keeps the current model.
 *
 * a11y (quality-a11y.md P4): `role="dialog"` + `aria-modal`, focus moves INTO
 * the dialog on open, Tab is trapped to the dialog's focusables, Escape
 * cancels, and focus RETURNS to whatever was focused before open (the model
 * trigger) on unmount. Deeper behavioural coverage (open/close focus assertion)
 * is Task 10; this component ships the mechanism + a render/axe/interaction test.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ModelSubstitutionDialogProps {
  /** Human label of the model the user picked (now unavailable). */
  fromModel: string;
  /** Human label of the proposed cross-tier replacement. */
  toModel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ModelSubstitutionDialog({
  fromModel,
  toModel,
  onConfirm,
  onCancel,
}: ModelSubstitutionDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Capture the pre-open focus owner ONCE and restore it on unmount so focus
  // returns to the model trigger (APG modal contract). Reading it in the same
  // effect that runs the focus-in keeps the order deterministic.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => confirmRef.current?.focus());
    return () => previouslyFocused?.focus?.();
  }, []);

  // Escape cancels; Tab is trapped to the dialog's focusable elements.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-substitution-dialog-title"
        className="mx-4 w-full max-w-sm bg-cc-card border border-cc-border rounded-xl shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h3
          id="model-substitution-dialog-title"
          className="text-sm font-semibold text-cc-fg mb-2"
        >
          Switch to a different tier?
        </h3>
        <p className="text-xs text-cc-fg/80 leading-snug mb-4">
          {fromModel} is unavailable. The only replacement, {toModel}, runs on a
          different cost tier. Switch to {toModel}?
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
          >
            Keep current model
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
          >
            Switch to {toModel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
