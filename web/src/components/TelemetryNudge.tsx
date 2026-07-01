import { useEffect, useState } from "react";
import { api } from "../api.js";

/**
 * Compact footer nudge that surfaces the anonymous usage-counter opt-out as a
 * plain yes/no toggle next to GlobalUsageBadge. The full control lives in
 * Settings → Telemetry; this duplicate exists so existing installs (which are
 * grandfathered OFF because the old default was persisted) have a discoverable
 * one-click way to join the global counter without hunting through Settings.
 *
 * Controls the SAME server-side `telemetryEnabled` setting as the Settings
 * toggle. Renders nothing until the current value loads, and nothing at all if
 * the user has dismissed it — so it never nags and a settings-fetch failure is
 * invisible rather than an error.
 */

const DISMISS_KEY = "aura.telemetryNudgeDismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function TelemetryNudge() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (!cancelled) setEnabled(s.telemetryEnabled);
      })
      .catch(() => {
        /* leave enabled=null → stay invisible, like the badge */
      });
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  if (dismissed || enabled === null) return null;

  const toggle = async () => {
    if (busy) return;
    const next = !enabled;
    setEnabled(next);
    setBusy(true);
    try {
      await api.updateSettings({ telemetryEnabled: next });
    } catch {
      setEnabled(!next); // revert on failure
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore storage failure — still hide for this session */
    }
    setDismissed(true);
  };

  return (
    <div className="mt-1.5 rounded-lg border border-cc-border/30 bg-cc-card/20 px-2 py-1.5 flex items-center gap-2">
      <p className="text-[11px] leading-tight text-cc-muted flex-1">
        Join the global usage counter?
      </p>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={enabled}
        aria-label={`Global usage counter: ${enabled ? "on" : "off"}`}
        className="shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer tabular-nums"
      >
        {enabled ? "On" : "Off"}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss usage counter prompt"
        className="shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="w-3 h-3">
          <path d="M4.28 3.22a.75.75 0 00-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 101.06 1.06L8 9.06l3.72 3.72a.75.75 0 101.06-1.06L9.06 8l3.72-3.72a.75.75 0 00-1.06-1.06L8 6.94 4.28 3.22z" />
        </svg>
      </button>
    </div>
  );
}
