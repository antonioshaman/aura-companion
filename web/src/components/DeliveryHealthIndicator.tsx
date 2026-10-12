import { useCallback, useEffect, useState } from "react";
import { api, type DeliveryMetricsSnapshot } from "../api.js";

/**
 * Compact "are replies getting through" indicator for the Settings
 * diagnostics area. Reads `GET /api/metrics/delivery` (server-wide, since
 * server start) and shows the counters behind "zero lost / stalled replies".
 *
 * Works for Claude Code and Codex alike; the stuck-reply recovery counter is
 * Claude-only (Codex has no CLI jsonl to compare and no init probe), which
 * the row label says.
 */
export interface DeliveryHealthIndicatorProps {
  /** Injected for tests; defaults to the API client. */
  load?: () => Promise<DeliveryMetricsSnapshot>;
}

/** Bucket bound → "≤ 2.5 s". The +Infinity bucket arrives as null over JSON. */
export function formatBucket(ms: number | null | undefined, hasSamples: boolean): string {
  if (!hasSamples) return "—";
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "> 5 min";
  if (ms < 60_000) return `≤ ${ms / 1000} s`;
  return `≤ ${Math.round(ms / 60_000)} min`;
}

export function DeliveryHealthIndicator({ load = api.getDeliveryMetrics }: DeliveryHealthIndicatorProps) {
  const [snap, setSnap] = useState<DeliveryMetricsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSnap(await load());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const g = snap?.global;
  const ttfo = snap?.timeToFirstOutputMs;
  const hasSamples = (ttfo?.count ?? 0) > 0;
  const problems = g ? g.stalledMessages + g.noResponseRequestedReplies : 0;
  const thresholdS = snap ? Math.round(snap.stallThresholdMs / 1000) : 60;

  return (
    <div className="mt-6 pt-5 border-t border-cc-border" data-testid="delivery-health">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div>
          <h3 className="text-sm font-medium text-cc-fg">Reply delivery</h3>
          <p className="mt-0.5 text-xs text-cc-muted">
            Did every message get an answer? Since server start, all sessions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
            loading
              ? "bg-cc-hover text-cc-muted cursor-not-allowed"
              : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
          }`}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-3 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
          {error}
        </div>
      )}

      {g && ttfo && (
        <>
          <p
            role="status"
            className={`mb-2 text-xs font-medium ${problems > 0 ? "text-cc-warning" : "text-cc-success"}`}
          >
            {g.userMessages === 0
              ? "No messages yet"
              : problems > 0
                ? `${problems} message${problems === 1 ? "" : "s"} without a proper answer`
                : "All messages answered"}
            {g.awaitingReply > 0 ? ` · ${g.awaitingReply} waiting now` : ""}
          </p>
          <dl className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="text-cc-muted">Messages / answered</dt>
              <dd className="text-cc-fg font-mono">
                {g.userMessages} / {g.firstOutputs}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-cc-muted">First reply p50 · p95</dt>
              <dd className="text-cc-fg font-mono">
                {formatBucket(ttfo.p50Bucket, hasSamples)} · {formatBucket(ttfo.p95Bucket, hasSamples)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-cc-muted">No reply within {thresholdS} s</dt>
              <dd className="text-cc-fg font-mono">{g.stalledMessages}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-cc-muted">&ldquo;No response requested.&rdquo; replies</dt>
              <dd className="text-cc-fg font-mono">{g.noResponseRequestedReplies}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-cc-muted">Stuck-reply recoveries (Claude Code only)</dt>
              <dd className="text-cc-fg font-mono">
                {g.driftRecoveries}
                {/* A recovery kills the CLI, and every background task it still ran. */}
                {g.backgroundTasksKilled > 0 ? ` · ${g.backgroundTasksKilled} background tasks killed` : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-cc-muted">Nudges like &ldquo;are you there?&rdquo; (proxy)</dt>
              <dd className="text-cc-fg font-mono">{g.nudges}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}
