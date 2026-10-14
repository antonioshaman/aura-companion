import type { BackendAuthState } from "../../api.js";

/**
 * Compact "is this coding CLI signed in" indicator for the New Session screen.
 * Reassures when authorized (Ductor-style ✓) and, when the CLI is not usable,
 * says so plainly with a one-click route to where the user fixes it (Settings
 * → Providers, or `claude setup-token` / `codex auth` on the server).
 *
 * Renders nothing when `authState` is absent — an older server that doesn't
 * report sign-in status, or a backend whose binary isn't installed (the toggle
 * already shows that). The status text is a live region so a screen reader
 * announces a change from authorized → expired.
 */
export function BackendAuthBadge({
  backendName,
  authState,
  onFix,
}: {
  backendName: string;
  authState?: BackendAuthState;
  onFix?: () => void;
}) {
  if (!authState) return null;

  if (authState === "authorized") {
    return (
      <div className="flex items-center justify-center gap-1.5 text-[11px] text-cc-muted" role="status">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-3 h-3 text-emerald-500" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M5.5 8.2l1.8 1.8 3.2-3.6" />
        </svg>
        <span>{backendName} signed in</span>
      </div>
    );
  }

  const expired = authState === "expired";
  const label = expired ? `${backendName} token expired` : `${backendName} not signed in`;
  const action = expired ? "Re-authenticate" : "Set up access";

  return (
    <div className="flex items-center justify-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400" role="status">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-3 h-3" aria-hidden="true">
        <path d="M8 1.5l6.5 11.5H1.5L8 1.5z" />
        <path d="M8 6.2v3.1M8 11.2v.01" strokeLinecap="round" />
      </svg>
      <span>{label}</span>
      {onFix && (
        <button
          type="button"
          onClick={onFix}
          className="underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500 rounded-sm"
        >
          {action}
        </button>
      )}
    </div>
  );
}
