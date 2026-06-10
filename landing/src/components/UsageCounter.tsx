import { useEffect, useState } from "react";

// The stats aggregator (Cloudflare Worker). Override at build time with
// VITE_STATS_URL; defaults to the production Worker.
const VITE_ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const STATS_URL =
  VITE_ENV?.VITE_STATS_URL?.replace(/\/+$/, "") ||
  "https://companion-stats.auracomp.workers.dev";

interface GlobalStats {
  activeInstances30d: number | null;
  totalInstances: number | null;
}

/**
 * Anonymous global usage counter, read from the opt-in telemetry aggregator.
 * Renders nothing until a count is available, so an unreachable aggregator is
 * silently absent rather than a broken card.
 */
export function UsageCounter() {
  const [stats, setStats] = useState<GlobalStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${STATS_URL}/stats/global`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Partial<GlobalStats> | null) => {
        if (cancelled || !data) return;
        const active = typeof data.activeInstances30d === "number" ? data.activeInstances30d : null;
        const total = typeof data.totalInstances === "number" ? data.totalInstances : null;
        if (active === null && total === null) return;
        setStats({ activeInstances30d: active, totalInstances: total });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!stats) return null;

  return (
    <div className="mt-8 mx-auto max-w-[760px] cc-card bg-cc-card rounded-2xl p-5 sm:p-6 animate-fade-up-4">
      <div className="flex flex-wrap items-center justify-center gap-8 text-center">
        {typeof stats.activeInstances30d === "number" && (
          <div>
            <div className="font-condensed text-[clamp(32px,7vw,56px)] leading-none text-cc-primary tabular-nums">
              {stats.activeInstances30d.toLocaleString()}
            </div>
            <div className="text-xs uppercase tracking-[0.16em] text-cc-muted mt-2">Active installs</div>
          </div>
        )}
        {typeof stats.totalInstances === "number" && (
          <div>
            <div className="font-condensed text-[clamp(32px,7vw,56px)] leading-none tabular-nums">
              {stats.totalInstances.toLocaleString()}
            </div>
            <div className="text-xs uppercase tracking-[0.16em] text-cc-muted mt-2">Total installs</div>
          </div>
        )}
      </div>
    </div>
  );
}
