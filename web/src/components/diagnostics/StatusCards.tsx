import { useState } from "react";
import type { ContextAdvisoryView, DriftEventView, DiagnosticsOverview, PairView, RuntimeSnapshotView, UpstreamStatus } from "../../api.js";
import { decodeContextAdvisory } from "../../utils/context-advisory.js";
import { CardFrame, type FrameSource } from "./CardFrame.js";
import { ago, clock, dateTime, minutesBetween, uptime } from "./format.js";

/**
 * The five status cards of the Diagnostics page (plan Task 15; friedman,
 * abramov, watson). Pure: props in, nothing out. Raw ids and event names are
 * shown verbatim — the page exists to replace journalctl, so nothing is
 * paraphrased away. Tables carry real header cells.
 */

/** An observer is "silent" once its last inbound frame is this old. */
export const SILENT_AFTER_MINUTES = 5;

type Frame<K extends keyof Omit<DiagnosticsOverview, "generatedAt">> = FrameSource<
  Extract<DiagnosticsOverview[K], { status: "available" }>["data"]
>;

const th = "text-left font-medium text-cc-muted py-1 pr-3 whitespace-nowrap";
const td = "py-1 pr-3 align-top";

// ─── Backend ────────────────────────────────────────────────────────────────

export function BackendCard({ frame, now, staleSince, busy }: { frame: Frame<"backend">; now: number; staleSince?: number | null; busy?: boolean }) {
  return (
    <CardFrame<RuntimeSnapshotView>
      id="backend"
      title="Backend"
      frame={frame}
      now={now}
      staleSince={staleSince}
      busy={busy}
      verdict={(d) => `Running: pid ${d.pid}, up ${uptime(d.uptimeMs)}, ${d.snapshot.sessions ?? "?"} sessions, ${d.snapshot.browsers ?? "?"} browsers.`}
    >
      {(d) => (
        <>
          <p className="text-[11px] text-cc-muted mb-2">
            Aura {d.version} on Bun {d.bunVersion}. 5-minute snapshot last logged {ago(now, d.lastLoggedAt)}.
          </p>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
            {Object.entries(d.snapshot).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 min-w-0">
                <dt className="text-cc-muted truncate">{k}</dt>
                <dd className="text-cc-fg tabular-nums font-mono-code truncate">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </CardFrame>
  );
}

// ─── Pairs ──────────────────────────────────────────────────────────────────

function halfLiveness(now: number, at: number | null): { label: string; silent: boolean } {
  if (at === null) return { label: "no frame yet", silent: false };
  const m = minutesBetween(now, at);
  return m >= SILENT_AFTER_MINUTES ? { label: `silent ${m}m`, silent: true } : { label: `frame ${ago(now, at)}`, silent: false };
}

export function PairsCard({ frame, now, staleSince, busy }: { frame: Frame<"pairs">; now: number; staleSince?: number | null; busy?: boolean }) {
  return (
    <CardFrame<PairView[]>
      id="pairs"
      title="Council pairs"
      frame={frame}
      now={now}
      staleSince={staleSince}
      busy={busy}
      verdict={(pairs) => {
        if (pairs.length === 0) return "No live council pairs.";
        const silent = pairs.filter((p) => p.halves.some((h) => h.role === "observer" && halfLiveness(now, h.lastInboundFrameAt).silent)).length;
        const degraded = pairs.filter((p) => p.status === "degraded").length;
        return `${pairs.length} pair${pairs.length === 1 ? "" : "s"}; ${silent} with a silent observer; ${degraded} degraded.`;
      }}
    >
      {(pairs) =>
        pairs.length === 0 ? null : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <caption className="sr-only">Council pairs and the liveness of each half</caption>
              <thead>
                <tr>
                  <th scope="col" className={th}>Group</th>
                  <th scope="col" className={th}>Status</th>
                  <th scope="col" className={th}>Role</th>
                  <th scope="col" className={th}>Session</th>
                  <th scope="col" className={th}>Liveness</th>
                  <th scope="col" className={th}>Last checkpoint</th>
                </tr>
              </thead>
              <tbody>
                {pairs.flatMap((p) =>
                  p.halves.map((h, i) => {
                    const live = halfLiveness(now, h.lastInboundFrameAt);
                    return (
                      <tr key={`${p.sessionGroupId}:${h.role}`} className="border-t border-cc-border">
                        {i === 0 && (
                          <>
                            <td className={`${td} font-mono-code break-all`} rowSpan={p.halves.length}>
                              {p.sessionGroupId}
                              <div className="text-cc-muted">{p.pairing}</div>
                            </td>
                            <td className={td} rowSpan={p.halves.length}>
                              <span className={p.status === "degraded" ? "text-cc-error font-medium" : "text-cc-fg"}>{p.status}</span>
                              {p.degradedReason && <div className="text-cc-muted">{p.deadRole} · {p.degradedReason}</div>}
                            </td>
                          </>
                        )}
                        <td className={td}>{h.role}</td>
                        <td className={`${td} font-mono-code break-all`}>
                          <a className="text-cc-fg underline decoration-cc-border hover:decoration-cc-fg" href={`#/session/${h.sessionId}`}>{h.sessionId}</a>
                          <div className="text-cc-muted">{h.backendType}{h.pid !== null ? ` · pid ${h.pid}` : ""}{h.state ? ` · ${h.state}` : ""}</div>
                        </td>
                        <td className={td}>
                          <span className={live.silent ? "text-cc-warning font-medium" : "text-cc-fg"}>{live.label}</span>
                          {h.lastInboundFrameAt !== null && <div className="text-cc-muted">last frame {clock(h.lastInboundFrameAt)}</div>}
                        </td>
                        {i === 0 && (
                          <td className={td} rowSpan={p.halves.length}>
                            {p.lastCheckpointAt !== null ? `${clock(p.lastCheckpointAt)} (${ago(now, p.lastCheckpointAt)})` : "none yet"}
                            {p.lastWakeAt !== null && <div className="text-cc-muted">wake {clock(p.lastWakeAt)}</div>}
                          </td>
                        )}
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        )
      }
    </CardFrame>
  );
}

// ─── Drift ──────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;

function DriftRow({ e }: { e: DriftEventView }) {
  const fields = Object.entries(e.fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return (
    <tr className="border-t border-cc-border">
      <td className={`${td} whitespace-nowrap tabular-nums`}>{clock(e.ts)}</td>
      <td className={`${td} font-mono-code break-all`}>{e.event}</td>
      <td className={`${td} font-mono-code break-all`}>{e.sessionId || "—"}</td>
      <td className={td}>
        {e.reason ?? "—"}
        {fields && <div className="text-cc-muted font-mono-code break-all">{fields}</div>}
      </td>
    </tr>
  );
}

export function DriftCard({ frame, now, staleSince, busy }: { frame: Frame<"drift">; now: number; staleSince?: number | null; busy?: boolean }) {
  const [showEarlier, setShowEarlier] = useState(false);
  return (
    <CardFrame
      id="drift"
      title="Drift and relaunch (24h)"
      frame={frame}
      now={now}
      staleSince={staleSince}
      busy={busy}
      verdict={(d) => {
        const lastHour = d.events.filter((e) => now - e.ts < HOUR).length;
        return d.events.length === 0
          ? `No drift events since ${dateTime(d.windowStart)}.`
          : `${lastHour} event${lastHour === 1 ? "" : "s"} in the last hour, ${d.totalInWindow ?? d.events.length} in the window.`;
      }}
    >
      {(d) => {
        const recent = d.events.filter((e) => now - e.ts < HOUR);
        const earlier = d.events.filter((e) => now - e.ts >= HOUR);
        const shown = showEarlier ? d.events : recent;
        return (
          <>
            <p className="text-[11px] text-cc-muted mb-2">
              Kept in memory since {dateTime(d.windowStart)}
              {d.wrapped ? "; older events dropped — the rest are only in journalctl" : ""}.
              {d.totalInWindow !== undefined && d.totalInWindow > d.events.length ? ` Showing the newest ${d.events.length} of ${d.totalInWindow}.` : ""}
            </p>
            {shown.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <caption className="sr-only">Drift events, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={th}>Time</th>
                      <th scope="col" className={th}>Event</th>
                      <th scope="col" className={th}>Session</th>
                      <th scope="col" className={th}>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((e) => (
                      <DriftRow key={`${e.ts}:${e.sessionId}:${e.event}`} e={e} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {earlier.length > 0 && (
              <button
                type="button"
                aria-expanded={showEarlier}
                onClick={() => setShowEarlier((v) => !v)}
                className="mt-2 text-xs text-cc-fg underline decoration-cc-border hover:decoration-cc-fg cursor-pointer"
              >
                {showEarlier ? "Show only the last hour" : `Show ${earlier.length} earlier event${earlier.length === 1 ? "" : "s"} (1–24h)`}
              </button>
            )}
          </>
        );
      }}
    </CardFrame>
  );
}

// ─── Context advisory ───────────────────────────────────────────────────────

function milestoneText(signal: string, milestone: number): string {
  return signal === "transcript_bytes" ? `${(milestone / 1024 / 1024).toFixed(1)} MB transcript` : `${milestone} compactions`;
}

export function ContextAdvisoryCard({ frame, now, staleSince, busy }: { frame: Frame<"contextAdvisory">; now: number; staleSince?: number | null; busy?: boolean }) {
  return (
    <CardFrame<ContextAdvisoryView[]>
      id="context"
      title="Context advisory"
      frame={frame}
      now={now}
      staleSince={staleSince}
      busy={busy}
      verdict={(rows) => (rows.length === 0 ? "No session has a context advisory." : `${rows.length} session${rows.length === 1 ? "" : "s"} with a context advisory.`)}
    >
      {(rows) =>
        rows.length === 0 ? null : (
          <ul className="space-y-1 text-xs">
            {rows.map((r) => {
              const rec = (r.advisory ?? {}) as { tier?: string; at?: number; signal?: "transcript_bytes" | "codex_compactions"; milestone?: number; milestoneBytes?: number };
              const decoded = decodeContextAdvisory(rec);
              return (
                <li key={r.sessionId} className="flex flex-wrap gap-x-2">
                  <a className="font-mono-code text-cc-fg underline decoration-cc-border hover:decoration-cc-fg break-all" href={`#/session/${r.sessionId}`}>{r.sessionId}</a>
                  <span className="text-cc-muted">{r.backendType}</span>
                  <span className="text-cc-fg">{rec.tier ?? "advisory"} · {milestoneText(decoded.signal, decoded.milestone)}</span>
                  {typeof rec.at === "number" && <span className="text-cc-muted">{ago(now, rec.at)}</span>}
                </li>
              );
            })}
          </ul>
        )
      }
    </CardFrame>
  );
}

// ─── Usage upstream ─────────────────────────────────────────────────────────

const FAILURE_TEXT: Record<string, { label: string; fix: string }> = {
  "kv-quota": { label: "KV quota exceeded", fix: "The Cloudflare free-tier quota resets at 00:00 UTC." },
  "oauth-expired": { label: "OAuth expired", fix: "Re-login the Claude CLI on the host." },
  "no-credentials": { label: "No credentials", fix: "Log the Claude CLI in on the host." },
  http: { label: "Upstream error", fix: "Check the upstream service." },
  timeout: { label: "Upstream timed out", fix: "Check the network from the host." },
  network: { label: "Upstream unreachable", fix: "Check the network from the host." },
  parse: { label: "Unexpected upstream reply", fix: "Check the upstream service." },
};

export function upstreamLine(s: UpstreamStatus): string {
  if (s.failure) {
    const t = FAILURE_TEXT[s.failure.kind] ?? { label: s.failure.kind };
    return `${t.label}${s.failure.httpStatus ? ` (HTTP ${s.failure.httpStatus})` : ""} since ${clock(s.failure.since)}`;
  }
  if (s.lastOkAt === null) return "No request yet since the server started";
  return "OK";
}

function UpstreamRow({ name, s, now }: { name: string; s: UpstreamStatus; now: number }) {
  const fix = s.failure ? FAILURE_TEXT[s.failure.kind]?.fix : null;
  return (
    <div className="py-1">
      <div className="flex flex-wrap gap-x-2 text-xs">
        <span className="text-cc-muted">{name}:</span>
        <span className={s.failure ? "text-cc-error font-medium" : "text-cc-fg"}>{upstreamLine(s)}</span>
        <span className="text-cc-muted">last success {ago(now, s.lastOkAt)}</span>
      </div>
      {fix && <p className="text-[11px] text-cc-muted">{fix}</p>}
    </div>
  );
}

export function UsageCard({ frame, now, staleSince, busy }: { frame: Frame<"usage">; now: number; staleSince?: number | null; busy?: boolean }) {
  return (
    <CardFrame
      id="usage"
      title="Usage upstream"
      frame={frame}
      now={now}
      staleSince={staleSince}
      busy={busy}
      verdict={(d) => (d.globalStats.failure || d.usageLimits.failure ? "An upstream is failing — see below." : "Both upstreams answer.")}
    >
      {(d) => (
        <>
          <UpstreamRow name="Sidebar usage badge (stats worker)" s={d.globalStats} now={now} />
          <UpstreamRow name="Usage limits (Anthropic OAuth)" s={d.usageLimits} now={now} />
        </>
      )}
    </CardFrame>
  );
}
