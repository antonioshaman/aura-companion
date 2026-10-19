import { useEffect, useRef, useState } from "react";

/**
 * KnowledgeAnalysisSettings — the "Knowledge analysis" block under Session
 * defaults (diagnostics spec §3.2; plan Task 15; friedman, watson, abramov).
 *
 * Three accumulation thresholds (any ONE reaching its value makes the hourly
 * check start an analysis) and the report-only memory switch. Controlled:
 * SettingsPage owns the values and the API calls. Numbers validate and save
 * on blur — never per keystroke, so clearing a field to retype "25" does not
 * flash an error — and always send the full trio (the server patches the
 * object as a whole). Bounds mirror the server's KB_ANALYSIS_BOUNDS.
 */

export interface KbAnalysisThresholds {
  newEntriesThreshold: number;
  sessionsThreshold: number;
  maxAgeDays: number;
}

const FIELDS: ReadonlyArray<{ key: keyof KbAnalysisThresholds; label: string; help: string; min: number; max: number }> = [
  { key: "newEntriesThreshold", label: "New or changed KB entries since the last run", help: "Default 10.", min: 1, max: 1000 },
  { key: "sessionsThreshold", label: "Finished sessions since the last run", help: "Default 25. Sessions with at least one turn; Claude and Codex count the same.", min: 1, max: 10000 },
  { key: "maxAgeDays", label: "Maximum days between analyses", help: "Default 14. Safety net so the report never gets old.", min: 1, max: 365 },
];

export function KnowledgeAnalysisSettings({
  thresholds,
  memoryReport,
  onThresholdsChange,
  onMemoryReportChange,
  disabled = false,
}: {
  thresholds: KbAnalysisThresholds;
  memoryReport: boolean;
  onThresholdsChange: (next: KbAnalysisThresholds) => void;
  onMemoryReportChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<Record<keyof KbAnalysisThresholds, string>>(() => toDraft(thresholds));
  const [errors, setErrors] = useState<Partial<Record<keyof KbAnalysisThresholds, string>>>({});
  // Fields the user has typed in and not committed yet (review P2-3): a save
  // or rollback of ANOTHER field must not overwrite them.
  const dirty = useRef(new Set<keyof KbAnalysisThresholds>());
  const { newEntriesThreshold, sessionsThreshold, maxAgeDays } = thresholds;
  useEffect(() => {
    const confirmed = toDraft({ newEntriesThreshold, sessionsThreshold, maxAgeDays });
    setDraft((d) => {
      const next = { ...d };
      for (const f of FIELDS) if (!dirty.current.has(f.key)) next[f.key] = confirmed[f.key];
      return next;
    });
  }, [newEntriesThreshold, sessionsThreshold, maxAgeDays]);

  function commit(key: keyof KbAnalysisThresholds) {
    const f = FIELDS.find((x) => x.key === key)!;
    const n = Number(draft[key]);
    if (draft[key].trim() === "" || !Number.isInteger(n) || n < f.min || n > f.max) {
      setErrors((e) => ({ ...e, [key]: `Enter a whole number from ${f.min} to ${f.max}.` }));
      return;
    }
    setErrors((e) => ({ ...e, [key]: undefined }));
    dirty.current.delete(key);
    if (n !== thresholds[key]) onThresholdsChange({ ...thresholds, [key]: n });
  }

  return (
    <div className="space-y-3" data-testid="knowledge-analysis-settings">
      <fieldset disabled={disabled} className="space-y-3">
        <legend className="text-sm text-cc-fg mb-1">Knowledge analysis</legend>
        <p className="text-xs text-cc-muted px-1">
          An hourly check starts a knowledge-base analysis when any one of these is reached. Results and decisions are on the{" "}
          <a href="#/diagnostics" className="text-cc-fg underline decoration-cc-border hover:decoration-cc-fg">Diagnostics</a> page. Nothing is
          deleted or edited automatically.
        </p>
        {FIELDS.map((f) => {
          const id = `kb-analysis-${f.key}`;
          const err = errors[f.key];
          return (
            <div key={f.key} className="px-1">
              <label htmlFor={id} className="block text-sm text-cc-fg">
                {f.label}
              </label>
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={f.min}
                max={f.max}
                step={1}
                value={draft[f.key]}
                aria-invalid={err ? true : undefined}
                aria-describedby={`${id}-help${err ? ` ${id}-error` : ""}`}
                onChange={(e) => {
                  dirty.current.add(f.key);
                  setDraft((d) => ({ ...d, [f.key]: e.target.value }));
                }}
                onBlur={() => commit(f.key)}
                className="mt-1 w-32 rounded-lg border border-cc-border bg-cc-bg px-3 py-2 text-sm text-cc-fg"
              />
              <p id={`${id}-help`} className="mt-1 text-xs text-cc-muted">
                {f.help}
              </p>
              {err && (
                <p id={`${id}-error`} className="mt-1 text-xs text-cc-error">
                  {err}
                </p>
              )}
            </div>
          );
        })}
      </fieldset>

      <button
        type="button"
        role="switch"
        aria-checked={memoryReport}
        aria-label="Memory report on the Diagnostics page"
        aria-describedby="kb-memory-report-help"
        disabled={disabled}
        onClick={() => onMemoryReportChange(!memoryReport)}
        className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span>Memory report on the Diagnostics page</span>
        <span className={`text-xs font-medium ${memoryReport ? "text-cc-success" : "text-cc-muted"}`}>{memoryReport ? "On" : "Off"}</span>
      </button>
      <p id="kb-memory-report-help" className="text-xs text-cc-muted px-1">
        Report-only: lists duplicate, outdated and dead-reference memory files. It runs only when you press “Run memory report”, and
        nothing under the memory directory is ever written.
      </p>
    </div>
  );
}

function toDraft(t: KbAnalysisThresholds): Record<keyof KbAnalysisThresholds, string> {
  return { newEntriesThreshold: String(t.newEntriesThreshold), sessionsThreshold: String(t.sessionsThreshold), maxAgeDays: String(t.maxAgeDays) };
}
