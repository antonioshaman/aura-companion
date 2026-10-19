import type { ReactNode } from "react";
import type { CardSource } from "../../api.js";
import { ago, clock } from "./format.js";

/**
 * The one place the "never render nothing" rule lives (plan Task 14; fowler 16,
 * abramov, friedman, watson). Every Diagnostics card renders through it:
 *   loading      — the first fetch has not answered yet;
 *   page-failed  — the request itself failed and there is no earlier data;
 *   unavailable  — the server answered but this card's source is down
 *                  (reason + since, where the data would sit);
 *   ready        — children render; `stale` adds a "last good" note when the
 *                  latest refresh failed but earlier data is still shown.
 * A refresh never drops a ready card back to loading; `busy` only sets
 * aria-busy. Cards carry no live regions — the page announcer speaks.
 */

export type FrameSource<T> = { tag: "loading" } | { tag: "page-failed"; message: string } | { tag: "source"; source: CardSource<T> };

const UNAVAILABLE_REASON: Record<string, string> = {
  "source-error": "the source failed to answer",
  "report-unreadable": "the report file is unreadable",
  "report-invalid": "the report file has an unexpected shape",
  "report-schema-newer": "the report was written by a newer server",
};

export function CardFrame<T>({
  id,
  title,
  frame,
  now,
  busy = false,
  staleSince,
  verdict,
  children,
}: {
  id: string;
  title: string;
  frame: FrameSource<T>;
  now: number;
  busy?: boolean;
  /** Set when the latest refresh failed but earlier data is shown. */
  staleSince?: number | null;
  /** One-line answer to "is anything wrong here?", shown first. */
  verdict?: (data: T) => string;
  children: (data: T) => ReactNode;
}) {
  const headingId = `diag-${id}-title`;
  let body: ReactNode;
  let verdictText: string | null = null;
  let updated: number | null = null;
  if (frame.tag === "loading") {
    body = <p className="text-xs text-cc-muted">Loading…</p>;
  } else if (frame.tag === "page-failed") {
    body = (
      <p className="text-xs text-cc-error">
        Source unavailable: the diagnostics request failed ({frame.message}).
      </p>
    );
  } else if (frame.source.status === "unavailable") {
    const reason = UNAVAILABLE_REASON[frame.source.reason] ?? frame.source.reason;
    body = (
      <p className="text-xs text-cc-error">
        Source unavailable{frame.source.since !== null ? ` since ${clock(frame.source.since)}` : ""}: {reason}.
      </p>
    );
  } else {
    updated = frame.source.fetchedAt;
    verdictText = verdict ? verdict(frame.source.data) : null;
    body = children(frame.source.data);
  }
  return (
    <section
      id={`diagnostics-${id}`}
      aria-labelledby={headingId}
      aria-busy={busy || undefined}
      className="rounded-xl border border-cc-border bg-cc-card p-4 sm:p-5 scroll-mt-4"
    >
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 id={headingId} className="text-sm font-semibold text-cc-fg">
          {title}
        </h2>
        {updated !== null && <span className="shrink-0 text-[11px] text-cc-muted">updated {ago(now, updated)}</span>}
      </div>
      {verdictText && <p className="text-[13px] text-cc-fg mb-3">{verdictText}</p>}
      {staleSince !== undefined && staleSince !== null && (
        <p className="text-[11px] text-cc-warning mb-2">Refresh failed — showing data from {clock(staleSince)}.</p>
      )}
      {body}
    </section>
  );
}
