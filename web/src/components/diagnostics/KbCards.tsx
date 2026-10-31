import { KB_ARCHIVE_UNAVAILABLE } from "../../../server/knowledge/archive-availability.js";
import { useState } from "react";
import type { Decision, KbAnalysisStatus, KbFinding, MemoryFinding } from "../../api.js";
import { ago, clock, dateTime } from "./format.js";

/**
 * Knowledge-base cards (plan Task 15; friedman, abramov, watson; spec §3.1).
 * Pure: the page owns fetching and posting; these render props and call
 * callbacks. Nothing here edits a file — decisions are POSTed by the page and
 * the server applies them (archive is the only KB write; memory is read-only).
 */

/**
 * idle → starting (POST sent) → accepted (202, or 409 = someone else's run;
 * we remember which run) → idle once a status shows that run finished.
 */
export type RunUi =
  | { tag: "idle" }
  | { tag: "starting" }
  | { tag: "accepted"; runId: string | null; startedAt: number }
  | { tag: "failed"; message: string };
export type FindingUi = { tag: "posting"; decision: Decision } | { tag: "rejected"; message: string };

/** The exact AC4 card string — mirrors `formatProgress` on the server. */
export function progressLine(p: NonNullable<KbAnalysisStatus["progress"]>): string {
  const due = p.due ? "due now" : `due in ≤${p.dueInDays} days`;
  return `${p.newEntries}/${p.newEntriesThreshold} entries · ${p.sessions}/${p.sessionsThreshold} sessions · ${due}`;
}

const btn = "px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium transition-colors";
const btnPrimary = `${btn} bg-cc-fg text-cc-bg hover:opacity-90 cursor-pointer`;
const btnSecondary = `${btn} border border-cc-border text-cc-fg hover:bg-cc-hover cursor-pointer`;
const btnInert = `${btn} border border-cc-border text-cc-muted cursor-not-allowed`;

function Gauge({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="text-xs">
      <div className="flex justify-between">
        <span className="text-cc-muted">{label}</span>
        <span className="tabular-nums text-cc-fg">
          {value} / {max}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded bg-cc-hover" aria-hidden="true">
        <div className="h-1.5 rounded bg-cc-fg/60" style={{ width: `${Math.min(100, (value / Math.max(1, max)) * 100)}%` }} />
      </div>
    </div>
  );
}

// ─── KB health + accumulation + run control ─────────────────────────────────

export function KbHealthCard({
  status,
  now,
  run,
  onRun,
}: {
  status: KbAnalysisStatus;
  now: number;
  run: RunUi;
  onRun: (includeMemory: boolean) => void;
}) {
  const running = status.inFlight !== null || run.tag === "starting" || run.tag === "accepted";
  const runningMemory = status.inFlight?.includeMemory === true;
  const h = status.health;
  const p = status.progress;
  const reasonId = "diag-kb-run-reason";
  return (
    <section id="diagnostics-kb" aria-labelledby="diag-kb-title" className="rounded-xl border border-cc-border bg-cc-card p-4 sm:p-5 scroll-mt-4">
      <h2 id="diag-kb-title" className="text-sm font-semibold text-cc-fg mb-1">Knowledge base</h2>
      {h === null ? (
        <p className="text-xs text-cc-error">Source unavailable: the knowledge base (.agents/knowledge) could not be read on this server.</p>
      ) : (
        <>
          <p className="text-[13px] text-cc-fg mb-3">
            {h.total} entries; {h.used} used, {h.neverSurfaced} never surfaced, {h.stale} stale, {h.promoted} promoted
            {h.parseErrors > 0 ? `, ${h.parseErrors} corrupt lines` : ""}.
          </p>
          {p && (
            <>
              <p className="text-xs text-cc-fg mb-2">{progressLine(p)}</p>
              <div className="grid sm:grid-cols-3 gap-3 mb-2">
                <Gauge label="New or changed entries" value={p.newEntries} max={p.newEntriesThreshold} />
                <Gauge label="Finished sessions" value={p.sessions} max={p.sessionsThreshold} />
                <Gauge label="Days since last run" value={p.ageDays} max={p.maxAgeDays} />
              </div>
              <p className="text-[11px] text-cc-muted mb-3">
                An analysis starts when any one of these reaches its threshold (checked hourly). Thresholds are in{" "}
                <a href="#/settings" className="text-cc-fg underline decoration-cc-border hover:decoration-cc-fg">Settings → Session defaults</a>.
              </p>
            </>
          )}
        </>
      )}
      <p className="text-[11px] text-cc-muted mb-3">
        Last run: {status.lastRun ? `${dateTime(status.lastRun.at)} (${status.lastRun.trigger})` : "never"}.
        {status.lastFailure ? ` Last failure ${clock(status.lastFailure.at)}: ${status.lastFailure.reason}.` : ""}
        {status.autoTriggerSuppressed ? " Automatic runs are paused until a manual run succeeds." : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={running ? btnInert : btnPrimary}
          aria-disabled={running || undefined}
          aria-describedby={running ? reasonId : undefined}
          onClick={() => {
            if (!running) onRun(false);
          }}
        >
          {running && !runningMemory ? "running…" : "Run analysis now"}
        </button>
        {status.memoryReportEnabled && (
          <button
            type="button"
            className={running ? btnInert : btnSecondary}
            aria-disabled={running || undefined}
            aria-describedby={running ? reasonId : undefined}
            onClick={() => {
              if (!running) onRun(true);
            }}
          >
            {running && runningMemory ? "running…" : "Run memory report"}
          </button>
        )}
        {running && (
          <span id={reasonId} className="text-[11px] text-cc-muted">
            An analysis is already running
            {status.inFlight ? `, started ${clock(status.inFlight.startedAt)} (${ago(now, status.inFlight.startedAt)}, ${status.inFlight.trigger})` : ""}.
          </span>
        )}
        {run.tag === "failed" && (
          <span className="text-[11px] text-cc-error">{run.message}</span>
        )}
      </div>
      {status.memoryReportEnabled && (
        <p className="mt-2 text-[11px] text-cc-muted">The memory report reads the memory files (~470, ~2 MB) and runs only when you press it.</p>
      )}
    </section>
  );
}

// ─── KB findings (decision cards) ───────────────────────────────────────────

const SIGNAL_LABEL: Record<string, string> = {
  "never-used": "never used",
  "dead-reference": "dead reference",
  duplicate: "duplicate",
  contradiction: "contradiction",
  "outdated-reports": "reported outdated",
  "stale-promoted": "stale promoted",
  "bitter-pill": "model may do this already",
};
const HEURISTIC = new Set(["contradiction", "bitter-pill"]);

function DecidedRow({ id, d }: { id: string; d: { decision: Decision; ts: number; mergeInto?: string } }) {
  const text =
    d.decision === "archive"
      ? "archived → .agents/knowledge/archive/"
      : d.decision === "keep"
        ? "kept; hidden from reports for 90 days unless it changes"
        : d.decision === "merge"
          ? `marked to merge into ${d.mergeInto}`
          : "marked as seen";
  return (
    <li className="rounded-lg border border-cc-border px-3 py-2 text-xs">
      <span className="font-mono-code text-cc-fg">{id}</span> <span className="text-cc-muted">— {text} ({clock(d.ts)})</span>
    </li>
  );
}

function FindingCard({
  f,
  ui,
  onDecide,
}: {
  f: KbFinding;
  ui: FindingUi | undefined;
  onDecide: (entryId: string, decision: Decision, mergeInto?: string) => void;
}) {
  const [mergeOpen, setMergeOpen] = useState(false);
  const partners = [...new Set(f.signals.filter((s) => s.signal === "duplicate" && s.partnerId).map((s) => s.partnerId!))];
  const [picked, setPicked] = useState(partners[0] ?? "");
  // Review P2-2: a newer report may change the partners; never post a choice
  // the select is not showing.
  const target = partners.includes(picked) ? picked : (partners[0] ?? "");
  const posting = ui?.tag === "posting";
  const headingId = `finding-${f.entryId}`;
  const heuristicOnly = f.signals.every((s) => HEURISTIC.has(s.signal));
  const act = (d: Decision, into?: string) => {
    if (!posting) onDecide(f.entryId, d, into);
  };
  return (
    <li>
      <div role="group" aria-labelledby={headingId} className="rounded-lg border border-cc-border p-3">
        <h3 id={headingId} className="text-xs font-semibold text-cc-fg">
          <span className="font-mono-code">{f.entryId}</span> — {f.signals.map((s) => SIGNAL_LABEL[s.signal] ?? s.signal).join(", ")}
          {heuristicOnly && <span className="ml-2 font-normal text-cc-warning">heuristic — verify by hand</span>}
        </h3>
        <ul className="mt-1 space-y-0.5 text-[11px] text-cc-muted">
          {f.signals.map((s, i) => (
            <li key={i}>
              {SIGNAL_LABEL[s.signal] ?? s.signal}: {s.criterion}
              {s.partnerId ? ` (with ${s.partnerId})` : ""}
            </li>
          ))}
        </ul>
        <div className="mt-2 text-xs text-cc-fg whitespace-pre-wrap break-words">{f.entry.fact}</div>
        {f.entry.recommendation && <div className="mt-1 text-xs text-cc-muted whitespace-pre-wrap break-words">→ {f.entry.recommendation}</div>}
        <div className="mt-1 text-[11px] text-cc-muted">
          {f.entry.file} · {f.entry.type} · confidence {f.entry.confidence || "?"} · used {f.entry.usage} · helpful {f.entry.helpfulCount}
          {f.entry.createdAt ? ` · created ${f.entry.createdAt.slice(0, 10)}` : ""}
        </div>
        {f.entry.affectedFiles.length > 0 && (
          <div className="mt-1 text-[11px] font-mono-code break-all">
            {f.entry.affectedFiles.map((a) => (
              <span key={a.path} className={a.exists ? "text-cc-muted mr-2" : "text-cc-error mr-2"}>
                {a.path}
                {a.exists ? "" : " (missing)"}
              </span>
            ))}
          </div>
        )}
        {f.suggested && <p className="mt-2 text-[11px] text-cc-fg">Suggested: {f.suggested === "merge" ? "mark for merge" : f.suggested}.</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={posting ? btnInert : btnSecondary} aria-disabled={posting || undefined} onClick={() => act("keep")}>
            Keep <span className="sr-only">{f.entryId}</span>
          </button>
          <button type="button" className={posting ? btnInert : btnSecondary} disabled title={KB_ARCHIVE_UNAVAILABLE} onClick={() => act("archive")}>
            {posting && ui.decision === "archive" ? "archiving…" : "Archive"} <span className="sr-only">{f.entryId}</span>
          </button>
          {partners.length > 0 && (
            <button
              type="button"
              className={posting ? btnInert : btnSecondary}
              aria-disabled={posting || undefined}
              aria-expanded={mergeOpen}
              onClick={() => !posting && setMergeOpen((v) => !v)}
            >
              Mark for merge <span className="sr-only">{f.entryId}</span>
            </button>
          )}
        </div>
        {mergeOpen && partners.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <label htmlFor={`merge-${f.entryId}`} className="text-cc-muted">
              Merge {f.entryId} into
            </label>
            <select
              id={`merge-${f.entryId}`}
              value={target}
              onChange={(e) => setPicked(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setMergeOpen(false);
              }}
              className="rounded border border-cc-border bg-cc-bg px-2 py-1 text-cc-fg"
            >
              {partners.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button type="button" className={btnPrimary} onClick={() => act("merge", target)}>
              Confirm
            </button>
            <button type="button" className={btnSecondary} onClick={() => setMergeOpen(false)}>
              Cancel
            </button>
          </div>
        )}
        <p className="mt-2 text-[11px] text-cc-muted">
          Keep hides it for 90 days unless it changes. {KB_ARCHIVE_UNAVAILABLE}
          {partners.length > 0 ? " Mark for merge only records the pair — no text is changed." : ""}
        </p>
        {ui?.tag === "rejected" && (
          <p role="alert" className="mt-1 text-[11px] text-cc-error">
            {ui.message}
          </p>
        )}
      </div>
    </li>
  );
}

export function KbFindingsCard({
  status,
  findingUi,
  onDecide,
}: {
  status: KbAnalysisStatus;
  findingUi: Record<string, FindingUi>;
  onDecide: (entryId: string, decision: Decision, mergeInto?: string) => void;
}) {
  const r = status.report;
  let body;
  if (r === null) {
    body = <p className="text-xs text-cc-muted">No report yet — the first analysis runs when a threshold is reached, or press “Run analysis now”.</p>;
  } else if (r.status === "unavailable") {
    body = <p className="text-xs text-cc-error">Source unavailable since {clock(r.since)}: the latest report could not be used ({r.reason}).</p>;
  } else {
    const rep = r.data;
    const open = rep.findings.filter((f) => !status.decisions[f.entryId]);
    const decided = rep.findings.filter((f) => status.decisions[f.entryId]);
    body = (
      <>
        <p className="text-[13px] text-cc-fg mb-1">
          {rep.findings.length === 0 ? "No findings — nothing in the knowledge base needs a decision." : `${open.length} of ${rep.findings.length} findings need a decision.`}
        </p>
        <p className="text-[11px] text-cc-muted mb-3">
          Report from {dateTime(rep.generatedAt)} ({rep.trigger}), based on {rep.kbEntryCount} entries.
          {status.progress && status.progress.newEntries > 0 ? ` The KB changed since: ${status.progress.newEntries} entries added or edited — findings may be stale.` : ""}
        </p>
        {rep.mergeTasks.length > 0 && (
          <div className="mb-3 text-xs">
            <h3 className="font-semibold text-cc-fg">Merge tasks</h3>
            <ul className="text-cc-muted">
              {rep.mergeTasks.map((t) => (
                <li key={t.entryId} className="font-mono-code">
                  {t.entryId} → {t.mergeInto}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ul className="space-y-2">
          {open.map((f) => (
            <FindingCard key={f.entryId} f={f} ui={findingUi[f.entryId]} onDecide={onDecide} />
          ))}
        </ul>
        {decided.length > 0 && (
          <ul className="mt-3 space-y-1">
            {decided.map((f) => (
              <DecidedRow key={f.entryId} id={f.entryId} d={status.decisions[f.entryId]!} />
            ))}
          </ul>
        )}
      </>
    );
  }
  return (
    <section id="diagnostics-kb-decisions" aria-labelledby="diag-kbd-title" className="rounded-xl border border-cc-border bg-cc-card p-4 sm:p-5 scroll-mt-4">
      <h2 id="diag-kbd-title" className="text-sm font-semibold text-cc-fg mb-1">KB analysis — decisions</h2>
      {body}
    </section>
  );
}

// ─── Memory report (read-only) ──────────────────────────────────────────────

export function MemoryReportCard({
  status,
  findingUi,
  onSeen,
}: {
  status: KbAnalysisStatus;
  findingUi: Record<string, FindingUi>;
  onSeen: (findingId: string) => void;
}) {
  const rep = status.report?.status === "available" ? status.report.data : null;
  const mem = rep?.memory ?? null;
  let body;
  if (!status.memoryReportEnabled) {
    body = <p className="text-xs text-cc-muted">The memory report is off. Turn it on in Settings → Session defaults → Knowledge analysis, then press “Run memory report”.</p>;
  } else if (!mem) {
    body = <p className="text-xs text-cc-muted">No memory report yet — press “Run memory report” on the Knowledge base card.</p>;
  } else {
    const open = mem.findings.filter((f) => !status.decisions[f.findingId]);
    body = (
      <>
        <p className="text-[13px] text-cc-fg mb-2">
          {mem.findings.length === 0 ? `No findings in ${mem.fileCount} files.` : `${open.length} of ${mem.findings.length} findings not yet seen (${mem.fileCount} files${mem.truncated ? ", report truncated" : ""}).`}
        </p>
        <ul className="space-y-2">
          {open.map((f: MemoryFinding) => {
            const ui = findingUi[f.findingId];
            const posting = ui?.tag === "posting";
            const headingId = `mem-${f.file}`;
            return (
              <li key={f.findingId}>
                <div role="group" aria-labelledby={headingId} className="rounded-lg border border-cc-border p-3 text-xs">
                  <h3 id={headingId} className="font-semibold text-cc-fg font-mono-code break-all">
                    {f.file}
                  </h3>
                  <p className="text-cc-muted">{f.description}</p>
                  <ul className="mt-1 text-[11px] text-cc-muted">
                    {f.signals.map((s, i) => (
                      <li key={i}>
                        {s.signal}: {s.criterion}
                        {s.partnerFile ? ` (with ${s.partnerFile})` : ""}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className={`mt-2 ${posting ? btnInert : btnSecondary}`}
                    aria-disabled={posting || undefined}
                    onClick={() => !posting && onSeen(f.findingId)}
                  >
                    Mark as seen <span className="sr-only">{f.file}</span>
                  </button>
                  <p className="mt-1 text-[11px] text-cc-muted">Records a line in decisions.jsonl; the memory file is untouched.</p>
                  {ui?.tag === "rejected" && (
                    <p role="alert" className="mt-1 text-[11px] text-cc-error">
                      {ui.message}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </>
    );
  }
  return (
    <section id="diagnostics-memory" aria-labelledby="diag-mem-title" className="rounded-xl border border-cc-border bg-cc-card p-4 sm:p-5 scroll-mt-4">
      <h2 id="diag-mem-title" className="text-sm font-semibold text-cc-fg mb-1">Memory report — read-only; Aura never writes to memory files</h2>
      {body}
    </section>
  );
}
