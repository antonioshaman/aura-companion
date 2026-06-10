import { useEffect, useState } from "react";
import { fetchGlobalStats, type GlobalUsageStats } from "../api.js";

/**
 * Compact footer badge showing the global, anonymous usage count
 * ("N active · M total") for Aura Companion. Fed by the opt-in telemetry
 * aggregator via the server's /stats/global proxy. Renders nothing until a
 * count is available, so a missing/unreachable aggregator is invisible rather
 * than an error.
 */
export function GlobalUsageBadge() {
  const [stats, setStats] = useState<GlobalUsageStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGlobalStats().then((s) => {
      if (!cancelled) setStats(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = stats?.activeInstances30d;
  const total = stats?.totalInstances;
  if (typeof active !== "number" && typeof total !== "number") return null;

  return (
    <div
      className="mt-1.5 rounded-lg border border-cc-border/30 bg-cc-card/20 px-2 py-1 flex items-center gap-2"
      title="Anonymous global usage across all Aura Companion installs"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="w-3 h-3 shrink-0 text-cc-muted/75">
        <path d="M5.5 7a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm5 0a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm-8.5 6.5C2 11.567 3.567 10 5.5 10S9 11.567 9 13.5V14H2v-.5zm9-.5c0-.795-.235-1.535-.64-2.155A3.49 3.49 0 0110.5 10c1.933 0 3.5 1.567 3.5 3.5V14h-3v-1z" />
      </svg>
      <span className="text-[11px] font-medium text-cc-muted leading-tight">
        {typeof active === "number" && (
          <>
            <span className="text-cc-fg tabular-nums">{active.toLocaleString()}</span> active
          </>
        )}
        {typeof active === "number" && typeof total === "number" && (
          <span className="text-cc-muted/60"> · </span>
        )}
        {typeof total === "number" && (
          <>
            <span className="text-cc-fg tabular-nums">{total.toLocaleString()}</span> total
          </>
        )}
      </span>
    </div>
  );
}
