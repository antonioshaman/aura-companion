/**
 * UpdateAvailableBanner — info-tone notice shown when a new Service Worker
 * version has installed and is waiting to activate (PWA "prompt" mode). Clicking
 * Update activates the waiting SW and reloads onto the fresh bundle; Dismiss
 * hides the notice for this page load without applying the update.
 *
 * Palette mirrors ModelFallbackBanner but uses the info token (`cc-info`) rather
 * than warning — a fresh deploy is neutral/positive, not a downgrade. Without
 * this prompt, an open tab silently keeps running the cached bundle after a
 * frontend deploy, which is confusing when the UI visibly lags the server.
 */

interface UpdateAvailableBannerProps {
  /** Activate the waiting SW and reload onto the new bundle. */
  onUpdate: () => void;
  /** Hide the notice for this page load without updating. */
  onDismiss?: () => void;
}

export function UpdateAvailableBanner({ onUpdate, onDismiss }: UpdateAvailableBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-available-banner"
      className="px-3 py-3 border-b border-cc-info/25 bg-cc-info/10 animate-[fadeSlideIn_0.2s_ease-out]"
    >
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 bg-cc-info/15 border border-cc-info/30">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-info" aria-hidden="true">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v4.19L7.03 8.72a.75.75 0 00-1.06 1.06l3.5 3.5a.75.75 0 001.06 0l3.5-3.5a.75.75 0 10-1.06-1.06l-2.22 2.22V6.75z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-cc-fg mb-0.5">A new version is available</div>
          <p className="text-xs text-cc-fg/80 leading-snug mb-2">
            Reload to get the latest build. Your current work is unaffected.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onUpdate}
              className="text-xs font-medium px-2.5 py-1 rounded-md bg-cc-info/20 hover:bg-cc-info/30 text-cc-fg border border-cc-info/30 cursor-pointer"
            >
              Update
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
