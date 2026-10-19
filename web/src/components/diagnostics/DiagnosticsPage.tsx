import { useCallback, useEffect, useReducer, useRef, useState, useTransition } from "react";
import { api, type Decision, type DiagnosticsOverview, type KbAnalysisStatus } from "../../api.js";
import { SectionErrorBoundary } from "../SectionErrorBoundary.js";
import type { FrameSource } from "./CardFrame.js";
import { KbFindingsCard, KbHealthCard, MemoryReportCard, type FindingUi, type RunUi } from "./KbCards.js";
import { BackendCard, ContextAdvisoryCard, DriftCard, PairsCard, UsageCard } from "./StatusCards.js";


/**
 * Diagnostics page (#/diagnostics) — spec `diagnostics-page-and-kb-analyzer-v1.md`,
 * plan Tasks 14–15.
 *
 * Local reducer, no store slice (one consumer, fresh on every visit). Two
 * sources — the overview and the KB-analysis status — polled every 30 s,
 * paused while the tab is hidden, refetched on focus, and every response is
 * sequence-numbered so a late reply can never overwrite a newer one. While an
 * analysis runs the status polls every 3 s. A failed refresh keeps the last
 * good data (marked stale) instead of blanking a card.
 *
 * One visually hidden polite announcer speaks only transitions (a card going
 * unavailable / back, a run starting / finishing, a decision applied) — never
 * a same-state poll, never a relative age.
 */

export const POLL_MS = 30_000;
export const RUNNING_POLL_MS = 3_000;

type Src<T> =
  | { tag: "loading" }
  | { tag: "ready"; data: T; at: number; failedAt: number | null }
  | { tag: "failed"; message: string };

interface State {
  overview: Src<DiagnosticsOverview>;
  kb: Src<KbAnalysisStatus>;
  run: RunUi;
  findings: Record<string, FindingUi>;
}

type Action =
  | { type: "overview:ok"; data: DiagnosticsOverview; at: number }
  | { type: "overview:fail"; message: string; at: number }
  | { type: "kb:ok"; data: KbAnalysisStatus; at: number }
  | { type: "kb:fail"; message: string; at: number }
  | { type: "run:starting" }
  | { type: "run:settled" }
  | { type: "run:failed"; message: string }
  | { type: "finding:posting"; id: string; decision: Decision }
  | { type: "finding:rejected"; id: string; message: string }
  | { type: "finding:clear"; id: string };

function ok<T>(data: T, at: number): Src<T> {
  return { tag: "ready", data, at, failedAt: null };
}
function fail<T>(prev: Src<T>, message: string, at: number): Src<T> {
  return prev.tag === "ready" ? { ...prev, failedAt: at } : { tag: "failed", message };
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "overview:ok":
      return { ...s, overview: ok(a.data, a.at) };
    case "overview:fail":
      return { ...s, overview: fail(s.overview, a.message, a.at) };
    case "kb:ok":
      return { ...s, kb: ok(a.data, a.at) };
    case "kb:fail":
      return { ...s, kb: fail(s.kb, a.message, a.at) };
    case "run:starting":
      return { ...s, run: { tag: "starting" } };
    case "run:settled":
      return { ...s, run: { tag: "idle" } };
    case "run:failed":
      return { ...s, run: { tag: "failed", message: a.message } };
    case "finding:posting":
      return { ...s, findings: { ...s.findings, [a.id]: { tag: "posting", decision: a.decision } } };
    case "finding:rejected":
      return { ...s, findings: { ...s.findings, [a.id]: { tag: "rejected", message: a.message } } };
    case "finding:clear": {
      const { [a.id]: _gone, ...rest } = s.findings;
      return { ...s, findings: rest };
    }
    default: {
      const never: never = a;
      throw new Error(`unhandled diagnostics action ${JSON.stringify(never)}`);
    }
  }
}

type CardKey = "backend" | "pairs" | "drift" | "contextAdvisory" | "usage";
const CARD_NAMES: Record<CardKey, string> = {
  backend: "Backend",
  pairs: "Council pairs",
  drift: "Drift",
  contextAdvisory: "Context advisory",
  usage: "Usage upstream",
};

function frameOf<K extends CardKey>(src: Src<DiagnosticsOverview>, key: K): FrameSource<never> {
  if (src.tag === "loading") return { tag: "loading" };
  if (src.tag === "failed") return { tag: "page-failed", message: src.message };
  return { tag: "source", source: src.data[key] } as FrameSource<never>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function DiagnosticsPage({ embedded = false }: { embedded?: boolean }) {
  const [state, dispatch] = useReducer(reducer, {
    overview: { tag: "loading" },
    kb: { tag: "loading" },
    run: { tag: "idle" },
    findings: {},
  });
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState("");
  const [, startTransition] = useTransition();
  const seq = useRef({ overview: 0, kb: 0 });

  const loadOverview = useCallback(() => {
    const mine = ++seq.current.overview;
    api
      .diagnosticsOverview()
      .then((data) => {
        if (mine !== seq.current.overview) return;
        startTransition(() => dispatch({ type: "overview:ok", data, at: Date.now() }));
      })
      .catch((e) => {
        if (mine === seq.current.overview) dispatch({ type: "overview:fail", message: errText(e), at: Date.now() });
      });
  }, []);

  const loadKb = useCallback(() => {
    const mine = ++seq.current.kb;
    return api
      .kbAnalysisLatest()
      .then((data) => {
        if (mine !== seq.current.kb) return;
        startTransition(() => dispatch({ type: "kb:ok", data, at: Date.now() }));
      })
      .catch((e) => {
        if (mine === seq.current.kb) dispatch({ type: "kb:fail", message: errText(e), at: Date.now() });
      });
  }, []);

  const refreshAll = useCallback(() => {
    setNow(Date.now());
    loadOverview();
    void loadKb();
  }, [loadOverview, loadKb]);

  // Polling: 30 s, paused while hidden, refetch on becoming visible.
  useEffect(() => {
    refreshAll();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") refreshAll();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshAll]);

  // Faster status polling while an analysis runs (any tab may have started it).
  const inFlight = state.kb.tag === "ready" ? state.kb.data.inFlight : null;
  useEffect(() => {
    if (!inFlight && state.run.tag !== "starting") return;
    const t = setInterval(() => {
      setNow(Date.now());
      void loadKb();
    }, RUNNING_POLL_MS);
    return () => clearInterval(t);
  }, [inFlight, state.run.tag, loadKb]);

  // Announcer: transitions only.
  const prevAvail = useRef<Record<string, boolean> | null>(null);
  useEffect(() => {
    if (state.overview.tag !== "ready") return;
    const d = state.overview.data;
    const avail = Object.fromEntries((Object.keys(CARD_NAMES) as CardKey[]).map((k) => [k, d[k].status === "available"]));
    const prev = prevAvail.current;
    prevAvail.current = avail;
    if (!prev) return;
    for (const k of Object.keys(CARD_NAMES) as CardKey[]) {
      if (prev[k] !== avail[k]) {
        setAnnouncement(`${CARD_NAMES[k]}: ${avail[k] ? "available again" : "source unavailable"}.`);
        return;
      }
    }
  }, [state.overview]);

  const prevRunning = useRef<boolean | null>(null);
  useEffect(() => {
    if (state.kb.tag !== "ready") return;
    const running = state.kb.data.inFlight !== null;
    if (prevRunning.current === true && !running) {
      const r = state.kb.data.report;
      const n = r?.status === "available" ? r.data.findings.length : 0;
      setAnnouncement(state.kb.data.lastFailure ? `Analysis failed: ${state.kb.data.lastFailure.reason}.` : `Analysis finished: ${n} findings.`);
      if (state.run.tag === "starting") dispatch({ type: "run:settled" });
    }
    if (prevRunning.current === false && running) setAnnouncement("Analysis started.");
    prevRunning.current = running;
  }, [state.kb, state.run.tag]);

  const onRun = useCallback(
    (includeMemory: boolean) => {
      dispatch({ type: "run:starting" });
      api
        .kbAnalysisRun(includeMemory)
        .then(({ status, body }) => {
          // 202 (we started it) and 409 (someone else did) land in the same
          // running state — a 409 is not an error for the operator.
          if (status === 202 || status === 409) {
            void loadKb();
            return;
          }
          dispatch({ type: "run:failed", message: body.message ?? `Could not start the analysis (HTTP ${status}).` });
        })
        .catch((e) => dispatch({ type: "run:failed", message: errText(e) }));
    },
    [loadKb],
  );

  const onDecide = useCallback(
    (entryId: string, decision: Decision, mergeInto?: string) => {
      if (state.kb.tag !== "ready" || state.kb.data.report?.status !== "available") return;
      const runId = state.kb.data.report.data.runId;
      dispatch({ type: "finding:posting", id: entryId, decision });
      api
        .kbAnalysisDecide(runId, [{ entryId, decision, ...(mergeInto ? { mergeInto } : {}) }])
        .then(async ({ status, body }) => {
          if (status === 200) {
            await loadKb();
            dispatch({ type: "finding:clear", id: entryId });
            setAnnouncement(`${entryId}: ${decision === "archive" ? "archived" : decision === "merge" ? "marked for merge" : decision === "seen" ? "marked as seen" : "kept"}.`);
            return;
          }
          if (status === 202) {
            await loadKb();
            dispatch({ type: "finding:rejected", id: entryId, message: `Recorded but not applied yet: ${body.message ?? "retry"}.` });
            return;
          }
          if (status === 409 || status === 400) void loadKb();
          dispatch({
            type: "finding:rejected",
            id: entryId,
            message: status === 409 ? `${body.message ?? "The report changed"} — reloading.` : body.message ?? `Failed (HTTP ${status}).`,
          });
        })
        .catch((e) => dispatch({ type: "finding:rejected", id: entryId, message: errText(e) }));
    },
    [state.kb, loadKb],
  );

  const ov = state.overview;
  // The latest refresh failed but earlier data is shown → "showing data from <time>".
  const stale = ov.tag === "ready" && ov.failedAt !== null ? ov.at : null;
  const cardProps = { now, staleSince: stale ?? null };

  const body = (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-safe space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-cc-fg">Diagnostics</h1>
          <p className="mt-0.5 text-[13px] text-cc-muted">
            Backend, council pairs, drift, context and usage at a glance, plus the knowledge-base review. Refreshes every 30 seconds.
          </p>
        </div>
        <button
          type="button"
          onClick={refreshAll}
          className="shrink-0 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium bg-cc-active text-cc-fg hover:bg-cc-hover cursor-pointer"
        >
          Refresh
        </button>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <SectionErrorBoundary label="Backend">
        <BackendCard frame={frameOf(ov, "backend")} {...cardProps} />
      </SectionErrorBoundary>
      <SectionErrorBoundary label="Council pairs">
        <PairsCard frame={frameOf(ov, "pairs")} {...cardProps} />
      </SectionErrorBoundary>
      <SectionErrorBoundary label="Drift">
        <DriftCard frame={frameOf(ov, "drift")} {...cardProps} />
      </SectionErrorBoundary>
      <SectionErrorBoundary label="Context advisory">
        <ContextAdvisoryCard frame={frameOf(ov, "contextAdvisory")} {...cardProps} />
      </SectionErrorBoundary>
      <SectionErrorBoundary label="Usage upstream">
        <UsageCard frame={frameOf(ov, "usage")} {...cardProps} />
      </SectionErrorBoundary>

      {state.kb.tag === "loading" && (
        <section aria-label="Knowledge base" className="rounded-xl border border-cc-border bg-cc-card p-4 text-xs text-cc-muted">
          Loading the knowledge-base status…
        </section>
      )}
      {state.kb.tag === "failed" && (
        <section aria-label="Knowledge base" className="rounded-xl border border-cc-border bg-cc-card p-4 text-xs text-cc-error">
          Source unavailable: the knowledge-base status request failed ({state.kb.message}).
        </section>
      )}
      {state.kb.tag === "ready" && (
        <>
          <SectionErrorBoundary label="Knowledge base">
            <KbHealthCard status={state.kb.data} now={now} run={state.run} onRun={onRun} />
          </SectionErrorBoundary>
          <SectionErrorBoundary label="KB analysis — decisions">
            <KbFindingsCard status={state.kb.data} findingUi={state.findings} onDecide={onDecide} />
          </SectionErrorBoundary>
          <SectionErrorBoundary label="Memory report">
            <MemoryReportCard status={state.kb.data} findingUi={state.findings} onSeen={(id) => onDecide(id, "seen")} />
          </SectionErrorBoundary>
        </>
      )}
    </div>
  );

  if (embedded) {
    return <div className="h-full bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto overflow-x-hidden">{body}</div>;
  }
  return body;
}

