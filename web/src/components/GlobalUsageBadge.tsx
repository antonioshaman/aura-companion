import { Fragment, useEffect, useState } from "react";
import { fetchGlobalStats, type GlobalUsageStats } from "../api.js";

/**
 * Compact footer badge showing the global, anonymous usage count
 * ("X online · N active · M total") for Aura Companion. Fed by the opt-in
 * telemetry aggregator via the server's /stats/global proxy. Renders nothing
 * until a count is available, so a missing/unreachable aggregator is invisible
 * rather than an error.
 *
 * "online" is the time-sensitive figure — installs with a human at the UI in
 * the last few minutes — so the badge re-polls on a light interval to keep it
 * moving rather than freezing at the mount-time value.
 */

// Re-poll cadence. The proxy + Worker caches are ~30s, so anything faster just
// re-serves the same cached value; 60s keeps the online count fresh-enough.
const POLL_INTERVAL_MS = 60 * 1000;

export function GlobalUsageBadge() {
  const [stats, setStats] = useState<GlobalUsageStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchGlobalStats().then((s) => {
        if (!cancelled && s) setStats(s);
      });
    };
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const online = stats?.onlineNow;
  const active = stats?.activeInstances30d;
  const total = stats?.totalInstances;

  const segments: { key: string; value: number; label: string; accent: boolean }[] = [];
  if (typeof online === "number") {
    segments.push({ key: "online", value: online, label: "online", accent: true });
  }
  if (typeof active === "number") {
    segments.push({ key: "active", value: active, label: "active", accent: false });
  }
  if (typeof total === "number") {
    segments.push({ key: "total", value: total, label: "total", accent: false });
  }
  if (segments.length === 0) return null;

  return (
    <div
      className="mt-1.5 rounded-lg border border-cc-border/30 bg-cc-card/20 px-2 py-1 flex items-center gap-2"
      title="Anonymous global usage across all Aura Companion installs"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="w-3 h-3 shrink-0 text-cc-muted/75">
        <path d="M5.5 7a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm5 0a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm-8.5 6.5C2 11.567 3.567 10 5.5 10S9 11.567 9 13.5V14H2v-.5zm9-.5c0-.795-.235-1.535-.64-2.155A3.49 3.49 0 0110.5 10c1.933 0 3.5 1.567 3.5 3.5V14h-3v-1z" />
      </svg>
      <span className="text-[11px] font-medium text-cc-muted leading-tight">
        {segments.map((seg, i) => (
          <Fragment key={seg.key}>
            {i > 0 && <span className="text-cc-muted/60"> · </span>}
            <span className={seg.accent ? "text-cc-success tabular-nums" : "text-cc-fg tabular-nums"}>
              {seg.value.toLocaleString()}
            </span>{" "}
            {seg.label}
          </Fragment>
        ))}
      </span>
    </div>
  );
}
