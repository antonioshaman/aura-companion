import { Fragment, useEffect, useState } from "react";
import { fetchGlobalStats, type GlobalUsageStats } from "../api.js";

/**
 * Compact footer badge showing the global, anonymous usage count for Aura
 * Companion ("X online · N active · M total installs"). Fed by the opt-in
 * telemetry aggregator via the server's /stats/global proxy. Renders nothing
 * until a count is available, so a missing/unreachable aggregator is invisible
 * rather than an error.
 *
 * Two DIFFERENT units share the badge, so they are grouped and labelled
 * distinctly: `online` is a headcount of PEOPLE currently using the app (summed
 * distinct browsers across installs), while `active`/`total` count INSTALLS.
 * Because one install can host several people, `online` can legitimately exceed
 * the install counts — the "installs" noun on the second group keeps that from
 * reading as a contradiction.
 *
 * "online" is the time-sensitive figure — people at the UI in the last few
 * minutes — so the badge re-polls on a light interval to keep it moving rather
 * than freezing at the mount-time value.
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

  // PEOPLE currently online — a headcount, distinct unit from installs below.
  const hasOnline = typeof online === "number";

  // INSTALLS (active in 30d / cumulative total) — their own unit, so they share
  // one "installs" noun and sit in a separate group after the people count.
  const installSegments: { key: string; value: number; label: string }[] = [];
  if (typeof active === "number") {
    installSegments.push({ key: "active", value: active, label: "active" });
  }
  if (typeof total === "number") {
    installSegments.push({ key: "total", value: total, label: "total" });
  }

  if (!hasOnline && installSegments.length === 0) return null;

  return (
    <div
      className="mt-1.5 rounded-lg border border-cc-border/30 bg-cc-card/20 px-2 py-1 flex items-center gap-2"
      title="Anonymous global usage: people online now vs. number of installs (active in 30d / total). One install can host several people, so the online headcount may exceed the install counts."
    >
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="w-3 h-3 shrink-0 text-cc-muted/75">
        <path d="M5.5 7a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm5 0a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm-8.5 6.5C2 11.567 3.567 10 5.5 10S9 11.567 9 13.5V14H2v-.5zm9-.5c0-.795-.235-1.535-.64-2.155A3.49 3.49 0 0110.5 10c1.933 0 3.5 1.567 3.5 3.5V14h-3v-1z" />
      </svg>
      <span className="text-[11px] font-medium text-cc-muted leading-tight">
        {hasOnline && (
          <>
            <span className="text-cc-success tabular-nums">{online!.toLocaleString()}</span> online
          </>
        )}
        {hasOnline && installSegments.length > 0 && <span className="text-cc-muted/60"> · </span>}
        {installSegments.map((seg, i) => (
          <Fragment key={seg.key}>
            {i > 0 && <span className="text-cc-muted/60"> · </span>}
            <span className="text-cc-fg tabular-nums">{seg.value.toLocaleString()}</span> {seg.label}
          </Fragment>
        ))}
        {installSegments.length > 0 && " installs"}
      </span>
    </div>
  );
}
