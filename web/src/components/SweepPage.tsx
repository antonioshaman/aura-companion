import { useEffect, useReducer, useRef, useTransition } from "react";
import { createPortal } from "react-dom";
import { api, type SweepCandidate, type SweepPreview, type SweepReason, type SweepResult } from "../api.js";

interface Props {
  embedded?: boolean;
}

// ── Discriminated-union state machine (abramov Principle 8) ────────────────
//
// One tagged union, NOT four booleans. The tag itself carries what a nullable
// `candidates: SweepCandidate[] | null` would: `idle`/`previewing` mean "no set
// yet / loading" while `previewed` with an empty `candidates` array is the AC6
// empty state — structurally distinct from loading, never conflated.
type SweepState =
  | { tag: "idle" }
  | { tag: "previewing" }
  | { tag: "previewed"; preview: SweepPreview }
  | { tag: "confirming"; preview: SweepPreview }
  | { tag: "executing"; preview: SweepPreview }
  | { tag: "executed"; result: SweepResult }
  | { tag: "error"; message: string };

type SweepAction =
  | { type: "preview:start" }
  | { type: "preview:ok"; preview: SweepPreview }
  | { type: "confirm:open" }
  | { type: "confirm:cancel" }
  | { type: "execute:start" }
  | { type: "execute:ok"; result: SweepResult }
  | { type: "fail"; message: string };

function assertNever(x: never): never {
  throw new Error(`unhandled sweep action: ${JSON.stringify(x)}`);
}

function reducer(state: SweepState, action: SweepAction): SweepState {
  switch (action.type) {
    case "preview:start":
      // Reachable from idle (mount), error (retry), executed (rescan).
      return { tag: "previewing" };
    case "preview:ok":
      return { tag: "previewed", preview: action.preview };
    case "confirm:open":
      // Only a previewed set with candidates may open the destructive gate.
      return state.tag === "previewed" && state.preview.candidates.length > 0
        ? { tag: "confirming", preview: state.preview }
        : state;
    case "confirm:cancel":
      return state.tag === "confirming" ? { tag: "previewed", preview: state.preview } : state;
    case "execute:start":
      return state.tag === "confirming" ? { tag: "executing", preview: state.preview } : state;
    case "execute:ok":
      return { tag: "executed", result: action.result };
    case "fail":
      return { tag: "error", message: action.message };
    default:
      return assertNever(action);
  }
}

const REASON_LABEL: Record<SweepReason, string> = {
  "orphan": "Orphaned process",
  "archived-leak": "Archived-leak process",
  "stale-session": "Stale session",
  "orphan-timer": "Orphaned timer",
};

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SweepPage({ embedded = false }: Props) {
  const [state, dispatch] = useReducer(reducer, { tag: "idle" });
  // useTransition wraps BOTH network actions: `isPending` is a natural
  // double-click guard on the trigger and confirm buttons (abramov Principle 3).
  const [isPending, startTransition] = useTransition();

  function runPreview() {
    startTransition(async () => {
      dispatch({ type: "preview:start" });
      try {
        const preview = await api.sweepPreview();
        dispatch({ type: "preview:ok", preview });
      } catch (e) {
        dispatch({ type: "fail", message: errMessage(e) });
      }
    });
  }

  function runExecute(token: string) {
    startTransition(async () => {
      dispatch({ type: "execute:start" });
      try {
        const result = await api.sweepExecute(token);
        dispatch({ type: "execute:ok", result });
      } catch (e) {
        dispatch({ type: "fail", message: errMessage(e) });
      }
    });
  }

  // Fetch fresh on mount — NO persistence/cache; a stale candidate list is
  // exactly the drift a destructive flow must avoid (abramov Principle 1).
  useEffect(() => {
    runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const candidates: SweepCandidate[] | null =
    state.tag === "previewed" || state.tag === "confirming" || state.tag === "executing"
      ? state.preview.candidates
      : null;
  const count = candidates?.length ?? 0;

  const body = (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-safe">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-cc-fg">Sweep orphans</h1>
          <p className="mt-0.5 text-[13px] text-cc-muted leading-relaxed">
            Reap resources this server spawned and lost — its own orphaned CLI
            processes, archived-leak processes, stale sessions, and orphaned
            timers. Never another agent's process, never a live session.
          </p>
        </div>
        <button
          onClick={runPreview}
          disabled={isPending}
          className={`shrink-0 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
            isPending
              ? "bg-cc-hover text-cc-muted cursor-not-allowed"
              : "bg-cc-active text-cc-fg hover:bg-cc-hover cursor-pointer"
          }`}
        >
          Rescan
        </button>
      </div>

      {/* Loading */}
      {(state.tag === "idle" || state.tag === "previewing") && (
        <div role="status" aria-live="polite" className="py-12 text-center text-sm text-cc-muted">Scanning for orphaned resources…</div>
      )}

      {/* Error */}
      {state.tag === "error" && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-cc-error/10 text-xs text-cc-error" role="alert">
          {state.message}
        </div>
      )}

      {/* Executed — result reconciliation (requested / swept / skipped distinct) */}
      {state.tag === "executed" && (
        <div className="mt-4 space-y-4" role="status" aria-live="polite">
          <div className="rounded-xl bg-cc-card p-4 sm:p-5">
            <div className="text-sm font-medium text-cc-fg mb-3">Sweep complete</div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <ResultStat label="Requested" value={state.result.requested} />
              <ResultStat label="Swept" value={state.result.swept} />
              <ResultStat label="Skipped" value={state.result.skipped} />
            </div>
            {state.result.skipped > 0 && (
              <p className="mt-3 text-[11px] text-cc-muted leading-relaxed">
                Skipped candidates had their identity change since preview (a
                re-check the server runs immediately before each kill) — they
                were not touched.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Previewed / confirming / executing — candidate list + trigger */}
      {candidates !== null && (
        <>
          <div className="flex items-center gap-2 mt-5 mb-3 text-[12px] text-cc-muted">
            <span>{count} candidate{count !== 1 ? "s" : ""}</span>
          </div>

          {count === 0 ? (
            <div role="status" aria-live="polite" className="py-12 text-center text-sm text-cc-muted">
              Nothing to sweep — no orphaned resources found.
            </div>
          ) : (
            <>
              <ul className="space-y-1">
                {candidates.map((c) => (
                  <CandidateRow key={c.id} candidate={c} />
                ))}
              </ul>
              <div className="mt-5 flex justify-end">
                <button
                  onClick={() => dispatch({ type: "confirm:open" })}
                  className="px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium bg-cc-error/90 hover:bg-cc-error text-white cursor-pointer transition-colors"
                >
                  Sweep {count} item{count !== 1 ? "s" : ""}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {(state.tag === "confirming" || state.tag === "executing") && (
        <ConfirmDialog
          count={count}
          candidates={state.preview.candidates}
          // The `executing` tag IS the execute-in-flight signal — precise, and
          // (unlike `isPending`) it never carries over from the mount preview's
          // still-settling transition into the confirming render.
          pending={state.tag === "executing"}
          onCancel={() => dispatch({ type: "confirm:cancel" })}
          onConfirm={() => runExecute(state.preview.token)}
        />
      )}
    </div>
  );

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto overflow-x-hidden">
        {body}
      </div>
    );
  }
  return body;
}

function ResultStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-cc-bg py-3">
      <div className="text-xl font-semibold text-cc-fg tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] text-cc-muted">{label}</div>
    </div>
  );
}

function CandidateRow({ candidate }: { candidate: SweepCandidate }) {
  return (
    <li className="flex items-start gap-3 px-3 py-3 rounded-lg bg-cc-card">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cc-fg">{REASON_LABEL[candidate.reason]}</span>
          {typeof candidate.pid === "number" && (
            <span className="text-[11px] font-mono-code text-cc-muted">pid {candidate.pid}</span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-cc-muted break-words">{candidate.evidence}</p>
        {candidate.sessionId && (
          <p className="mt-0.5 text-[11px] font-mono-code text-cc-muted break-all">{candidate.sessionId}</p>
        )}
      </div>
    </li>
  );
}

// ── Confirm dialog — the destructive-action gate (abramov Principle 5 + axe) ─
function ConfirmDialog({
  count,
  candidates,
  pending,
  onCancel,
  onConfirm,
}: {
  count: number;
  candidates: SweepCandidate[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Default focus to Cancel (NOT confirm) so a stray Enter can't execute, and
  // restore focus to whatever triggered the dialog when it closes (WCAG 2.4.3).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // Trap Tab within the dialog (WCAG 2.1.2 / focus order): a modal must not let
  // keyboard focus wander onto the inert page behind it.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") { onCancel(); return; }
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])'),
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  const label = `Confirm sweep of ${count} orphaned resource${count !== 1 ? "s" : ""}`;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-md mx-0 sm:mx-4 flex flex-col bg-cc-bg rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden"
      >
        <div className="px-4 sm:px-5 py-3 sm:py-4">
          <h2 className="text-sm font-semibold text-cc-fg">{label}</h2>
          <p className="mt-1 text-[13px] text-cc-muted leading-relaxed">
            Each is re-verified immediately before it is signalled; any whose
            identity changed is skipped. This cannot be undone.
          </p>
        </div>
        <div className="max-h-[40dvh] overflow-y-auto px-4 sm:px-5 pb-2 space-y-1">
          {candidates.map((c) => (
            <div key={c.id} className="flex items-center gap-2 text-xs text-cc-muted">
              <span className="text-cc-fg">{REASON_LABEL[c.reason]}</span>
              {typeof c.pid === "number" && <span className="font-mono-code">pid {c.pid}</span>}
              {c.sessionId && <span className="font-mono-code break-all">{c.sessionId}</span>}
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 px-4 sm:px-5 py-3 sm:py-4">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={pending}
            className="px-4 py-2.5 min-h-[44px] text-sm rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={pending}
            className={`px-4 py-2.5 min-h-[44px] text-sm font-medium rounded-lg transition-colors ${
              pending
                ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                : "bg-cc-error/90 hover:bg-cc-error text-white cursor-pointer"
            }`}
          >
            {pending ? "Sweeping…" : `Sweep ${count} item${count !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
