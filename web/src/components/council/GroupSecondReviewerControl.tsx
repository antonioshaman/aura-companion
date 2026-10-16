/**
 * GroupSecondReviewerControl — per-pair "second opinion" setting (W15), shown
 * collapsed inside the ObserverPanel. Loads the pair's effective setting only
 * when opened (no request on every panel mount) and saves it for this pair via
 * `PUT /api/groups/:id/second-reviewer`; the change applies from the next
 * checkpoint. Same choices as the global default in Settings.
 */

import { useState } from "react";
import { api } from "../../api.js";
import { SecondReviewerSettings, type SecondReviewerConfig } from "./SecondReviewerSettings.js";

export interface GroupSecondReviewerControlProps {
  sessionGroupId: string;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; config: SecondReviewerConfig; source: "group" | "global" }
  | { kind: "error"; message: string };

export function summarizeSecondReviewer(config: SecondReviewerConfig): string {
  const r = config.reviewer;
  if (r === "off") return "off";
  if (r === "auto") return "auto";
  return r.model ? `${r.backend} · ${r.model}` : `${r.backend} · default model`;
}

export function GroupSecondReviewerControl({ sessionGroupId }: GroupSecondReviewerControlProps) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setState({ kind: "loading" });
    try {
      const res = await api.getGroupSecondReviewer(sessionGroupId);
      setState({ kind: "ready", config: { reviewer: res.reviewer, scope: res.scope }, source: res.source });
    } catch (e: unknown) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async (next: SecondReviewerConfig) => {
    if (state.kind !== "ready") return;
    setState({ kind: "ready", config: next, source: "group" });
    setSaving(true);
    try {
      const res = await api.setGroupSecondReviewer(sessionGroupId, next);
      setState({ kind: "ready", config: { reviewer: res.reviewer, scope: res.scope }, source: "group" });
    } catch (e: unknown) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <details
      data-testid="group-second-reviewer"
      className="shrink-0 border-b border-cc-border"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && state.kind === "idle") void load();
      }}
    >
      <summary className="px-3 py-1.5 text-[11px] text-cc-muted cursor-pointer select-none hover:text-cc-fg">
        Second opinion
        {state.kind === "ready" && (
          <span className="ml-1 font-mono-code" data-testid="group-second-reviewer-summary">
            · {summarizeSecondReviewer(state.config)}
            {state.source === "global" ? " (default)" : ""}
          </span>
        )}
      </summary>
      <div className="px-3 pb-3">
        {state.kind === "loading" && <p className="text-xs text-cc-muted">Loading…</p>}
        {state.kind === "error" && (
          <p role="alert" className="text-xs text-cc-error">
            Could not load or save the second-opinion setting: {state.message}{" "}
            <button type="button" onClick={() => void load()} className="underline cursor-pointer">
              Retry
            </button>
          </p>
        )}
        {state.kind === "ready" && (
          <SecondReviewerSettings value={state.config} onChange={(next) => void save(next)} disabled={saving} />
        )}
      </div>
    </details>
  );
}
