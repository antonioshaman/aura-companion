import { useEffect, useReducer, useRef, useState, useTransition } from "react";
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
//
// `executed` and `error` retain the last-known `preview` so the receipt can
// itemise what was in the sweep and the error state can keep the stale (but
// still-informative) candidate list on screen with a retry affordance instead
// of discarding everything to a bare message (Friedman: never strand the user).
type SweepState =
  | { tag: "idle" }
  | { tag: "previewing" }
  | { tag: "previewed"; preview: SweepPreview }
  | { tag: "confirming"; preview: SweepPreview }
  | { tag: "executing"; preview: SweepPreview }
  | { tag: "executed"; result: SweepResult; preview: SweepPreview | null }
  | { tag: "error"; message: string; preview?: SweepPreview };

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

/** The last preview visible in this state, if any — used to carry candidate
 *  detail forward into `executed`/`error` for the receipt and error retry. */
function previewOf(state: SweepState): SweepPreview | undefined {
  return "preview" in state && state.preview ? state.preview : undefined;
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
      // Keep the preview that produced this result so the receipt can itemise it.
      return { tag: "executed", result: action.result, preview: previewOf(state) ?? null };
    case "fail":
      // Keep whatever candidate set was on screen so a failed execute/preview
      // doesn't blank the page — the user can retry against the same context.
      return { tag: "error", message: action.message, preview: previewOf(state) };
    default:
      return assertNever(action);
  }
}

const REASON_LABEL: Record<SweepReason, string> = {
  "orphan": "Orphaned process",
  "archived-leak": "Archived-leak process",
  // "Stale session record", NOT "Stale session": the header promises we never
  // touch a live session, so the label must make clear this is a dead RECORD
  // (no live process), not a running conversation.
  "stale-session": "Stale session record",
  "orphan-timer": "Orphaned timer",
};

// One-line consequence per reason so the blast radius of each row is legible
// (Friedman: destructive lists must say what happens, not just what it is).
// Process-only reasons stress that the conversation survives; the record-only
// reason stresses that nothing running is touched.
const REASON_CONSEQUENCE: Record<SweepReason, string> = {
  "orphan": "Signals an orphaned CLI process this server lost track of — the conversation stays resumable.",
  "archived-leak": "Kills a process left running by an archived session — the conversation stays resumable.",
  "stale-session": "Removes a dead session record with no live process — nothing running is touched.",
  "orphan-timer": "Clears an orphaned internal timer — no process or conversation is affected.",
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

  const activePreview: SweepPreview | null =
    state.tag === "previewed" || state.tag === "confirming" || state.tag === "executing"
      ? state.preview
      : null;
  const candidates: SweepCandidate[] | null = activePreview?.candidates ?? null;
  const count = candidates?.length ?? 0;

  // ── Per-candidate selection (default ALL) ────────────────────────────────
  // Selection drives the confirm count and the confirm-dialog list. NOTE: the
  // `/sweep/execute` API binds the ENTIRE previewed set via its opaque token —
  // it cannot accept a subset — so a partial selection narrows what the user
  // REVIEWS/confirms, and the dialog says so loudly. Reset to all whenever a
  // fresh preview arrives (keyed on the immutable per-scan token).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (activePreview) {
      setSelectedIds(new Set(activePreview.candidates.map((c) => c.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePreview?.token]);

  function toggleCandidate(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedCandidates: SweepCandidate[] = candidates
    ? candidates.filter((c) => selectedIds.has(c.id))
    : [];
  const selectedCount = selectedCandidates.length;

  const body = (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-safe">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-cc-fg">Sweep orphans</h1>
          <p className="mt-0.5 text-[13px] text-cc-muted leading-relaxed">
            Reap resources this server spawned and lost — its own orphaned CLI
            processes, archived-leak processes, stale session records (no live
            process), and orphaned timers. Never another agent's process, never
            a live session.
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

      {/* Error — keep the last-known preview visible + retry INSIDE the block */}
      {state.tag === "error" && (
        <div className="mt-4 space-y-3">
          <div className="px-3 py-3 rounded-lg bg-cc-error/10 text-cc-error space-y-2.5" role="alert">
            <p className="text-xs leading-relaxed">{state.message}</p>
            <button
              onClick={runPreview}
              className="px-3 py-2 min-h-[40px] rounded-lg text-xs font-medium bg-cc-error/15 hover:bg-cc-error/25 text-cc-error cursor-pointer transition-colors"
            >
              Retry scan
            </button>
          </div>
          {state.preview && state.preview.candidates.length > 0 && (
            <div>
              <div className="text-[11px] font-medium text-cc-muted uppercase tracking-wide mb-2">
                Last scan (not swept)
              </div>
              <ul className="space-y-1">
                {state.preview.candidates.map((c) => (
                  <ReceiptRow key={c.id} candidate={c} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Executed — receipt: totals + per-reason breakdown + itemised set */}
      {state.tag === "executed" && (
        <div className="mt-4 space-y-4" role="status" aria-live="polite">
          <div className="rounded-xl bg-cc-card p-4 sm:p-5">
            <div className="text-sm font-medium text-cc-fg mb-3">Sweep complete</div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <ResultStat label="Requested" value={state.result.requested} />
              <ResultStat label="Swept" value={state.result.swept} />
              <ResultStat label="Skipped" value={state.result.skipped} />
            </div>

            <ReasonBreakdown perReason={state.result.perReason} />

            {state.preview && state.preview.candidates.length > 0 && (
              <div className="mt-4">
                <div className="text-[11px] font-medium text-cc-muted uppercase tracking-wide mb-2">
                  Candidates in this sweep
                </div>
                <ul className="space-y-1">
                  {state.preview.candidates.map((c) => (
                    <ReceiptRow key={c.id} candidate={c} />
                  ))}
                </ul>
              </div>
            )}

            {state.result.skipped > 0 && (
              <div className="mt-3 space-y-2.5">
                <p className="text-[11px] text-cc-muted leading-relaxed">
                  {state.result.skipped} candidate{state.result.skipped !== 1 ? "s" : ""} had
                  their identity change since preview (a re-check the server runs
                  immediately before each kill) — they were not touched. Rescan to
                  see the residual set.
                </p>
                <button
                  onClick={runPreview}
                  className="px-3 py-2 min-h-[40px] rounded-lg text-xs font-medium bg-cc-active text-cc-fg hover:bg-cc-hover cursor-pointer transition-colors"
                >
                  Rescan for remaining
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Previewed / confirming / executing — candidate list + trigger */}
      {candidates !== null && (
        <>
          <div className="flex items-center gap-2 mt-5 mb-3 text-[12px] text-cc-muted">
            <span>{`${count} candidate${count !== 1 ? "s" : ""}`}</span>
            {count > 0 && (
              <span aria-live="polite">· {selectedCount} selected</span>
            )}
          </div>

          {count === 0 ? (
            <div role="status" aria-live="polite" className="py-12 text-center text-sm text-cc-muted">
              Nothing to sweep — no orphaned resources found.
            </div>
          ) : (
            <>
              <ul className="space-y-1">
                {candidates.map((c) => (
                  <CandidateRow
                    key={c.id}
                    candidate={c}
                    selected={selectedIds.has(c.id)}
                    onToggle={() => toggleCandidate(c.id)}
                  />
                ))}
              </ul>
              <div className="mt-5 flex justify-end">
                <button
                  onClick={() => { if (selectedCount > 0) dispatch({ type: "confirm:open" }); }}
                  disabled={selectedCount === 0}
                  className={`px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                    selectedCount === 0
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                      : "bg-cc-error/90 hover:bg-cc-error text-white cursor-pointer"
                  }`}
                >
                  Sweep {selectedCount} item{selectedCount !== 1 ? "s" : ""}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {(state.tag === "confirming" || state.tag === "executing") && (
        <ConfirmDialog
          count={selectedCount}
          totalPreviewed={state.preview.candidates.length}
          candidates={selectedCandidates}
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

// Per-reason swept counts — derived straight from the result's `perReason`
// map, rendered in a stable reason order, omitting reasons with no kills.
function ReasonBreakdown({ perReason }: { perReason: Record<SweepReason, number> }) {
  const entries = (Object.keys(REASON_LABEL) as SweepReason[])
    .map((r) => [r, perReason[r] ?? 0] as const)
    .filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="text-[11px] font-medium text-cc-muted uppercase tracking-wide mb-2">
        Swept by reason
      </div>
      <ul className="space-y-1">
        {entries.map(([r, n]) => (
          <li key={r} className="flex items-center justify-between text-xs">
            <span className="text-cc-fg">{REASON_LABEL[r]}</span>
            <span className="font-mono-code tabular-nums text-cc-muted">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Compact, non-interactive candidate line used by the receipt + error views:
// reason + pid + session id. (The interactive, selectable form is CandidateRow.)
function ReceiptRow({ candidate }: { candidate: SweepCandidate }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-cc-muted">
      <span className="text-cc-fg">{REASON_LABEL[candidate.reason]}</span>
      {typeof candidate.pid === "number" && (
        <span className="font-mono-code">pid {candidate.pid}</span>
      )}
      {candidate.sessionId && (
        <span className="font-mono-code break-all">{candidate.sessionId}</span>
      )}
    </li>
  );
}

function CandidateRow({
  candidate,
  selected,
  onToggle,
}: {
  candidate: SweepCandidate;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-start gap-3 px-3 py-3 rounded-lg bg-cc-card">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Include ${REASON_LABEL[candidate.reason]}${typeof candidate.pid === "number" ? ` (pid ${candidate.pid})` : ""} in sweep`}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-cc-error"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cc-fg">{REASON_LABEL[candidate.reason]}</span>
          {typeof candidate.pid === "number" && (
            <span className="text-[11px] font-mono-code text-cc-muted">pid {candidate.pid}</span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-cc-muted leading-relaxed">{REASON_CONSEQUENCE[candidate.reason]}</p>
        <p className="mt-0.5 text-xs text-cc-muted break-words">{candidate.evidence}</p>
        {candidate.sessionId && (
          <p className="mt-0.5 text-[11px] font-mono-code text-cc-muted break-all">{candidate.sessionId}</p>
        )}
      </div>
    </li>
  );
}

// ── Confirm dialog — the destructive-action gate (abramov Principle 5 + axe) ─
//
// Danger scales with blast radius: an elevated `bg-cc-card` panel (distinct from
// the page `bg-cc-bg`) with a border, a destructive icon medallion, and a red
// accent — mirroring (and exceeding) the single-session delete dialog. The
// description carries an id wired to `aria-describedby` so screen readers
// announce the "cannot be undone" warning with the dialog.
function ConfirmDialog({
  count,
  totalPreviewed,
  candidates,
  pending,
  onCancel,
  onConfirm,
}: {
  count: number;
  totalPreviewed: number;
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

  // A partial selection can't be honoured server-side: the execute token binds
  // the WHOLE previewed set. Say so plainly rather than imply the subset is what
  // gets reaped.
  const partial = count < totalPreviewed;
  const label = `Confirm sweep of ${count} orphaned resource${count !== 1 ? "s" : ""}`;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-describedby="sweep-confirm-desc"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-md mx-0 sm:mx-4 flex flex-col bg-cc-card border border-cc-border rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden"
      >
        <div className="flex items-start gap-3 px-4 sm:px-5 py-3 sm:py-4 border-b border-cc-border">
          <div className="shrink-0 w-9 h-9 rounded-full bg-cc-error/10 flex items-center justify-center">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5 text-cc-error" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-cc-fg">{label}</h2>
            <p id="sweep-confirm-desc" className="mt-1 text-[13px] text-cc-muted leading-relaxed">
              Each is re-verified immediately before it is signalled; any whose
              identity changed is skipped. This cannot be undone.
            </p>
          </div>
        </div>
        {partial && (
          <div className="mx-4 sm:mx-5 mt-3 px-3 py-2 rounded-lg bg-cc-error/10 text-[12px] text-cc-error leading-relaxed" role="note">
            Heads up: this server reaps the entire previewed set bound to this
            scan — all {totalPreviewed} candidate{totalPreviewed !== 1 ? "s" : ""} will
            be swept, not just the {count} you selected. To sweep a subset,
            Rescan after the others clear.
          </div>
        )}
        <div className="max-h-[40dvh] overflow-y-auto px-4 sm:px-5 py-2 space-y-1">
          {candidates.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-cc-muted">
              <span className="text-cc-fg">{REASON_LABEL[c.reason]}</span>
              {typeof c.pid === "number" && <span className="font-mono-code">pid {c.pid}</span>}
              {c.sessionId && <span className="font-mono-code break-all">{c.sessionId}</span>}
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 px-4 sm:px-5 py-3 sm:py-4 border-t border-cc-border">
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
