/**
 * SessionDefaultsSettings — the "Session defaults" block of the Settings page.
 *
 * aura-diet (2026-10) flipped Aura's defaults per evidence:
 *  - New sessions are SOLO. AuraBench: observer +0pp at 2.4x cost, full
 *    council −6pp at 2.9x. Council stays one click away on the New-Session
 *    form; this setting only picks where that toggle STARTS.
 *  - The knowledge base is consulted on demand. "Load at session start"
 *    (the old /prime-first behaviour) is opt-in and off by default.
 *  - "Автопродолжение после лимита" (default on): when a session stops on a
 *    usage limit, Aura sends a continuation prompt shortly after the reset.
 *
 * Controlled component: SettingsPage owns the values and the API calls.
 * Works the same for Claude Code and Codex sessions (the KB directive is sent
 * as `--append-system-prompt` to Claude and `developerInstructions` to Codex);
 * Council itself needs a Claude orchestrator, which the New-Session form
 * already enforces.
 */

export type DefaultSessionMode = "solo" | "council";

export interface SessionDefaultsSettingsProps {
  mode: DefaultSessionMode;
  kbAutoPrime: boolean;
  onModeChange: (mode: DefaultSessionMode) => void;
  onKbAutoPrimeChange: (enabled: boolean) => void;
  /** Auto-continue after a usage limit resets. Optional so older callers keep compiling; hidden when absent. */
  autoResumeAfterLimit?: boolean;
  onAutoResumeAfterLimitChange?: (enabled: boolean) => void;
  /** Disable the controls (e.g. while settings are loading). */
  disabled?: boolean;
}

const MODE_OPTIONS: ReadonlyArray<{ value: DefaultSessionMode; label: string; hint: string }> = [
  {
    value: "solo",
    label: "Solo",
    hint: "One agent. Recommended for most work.",
  },
  {
    value: "council",
    label: "Council",
    hint: "Agent + independent observer. ~2–3× cost; worth it for payments, auth, DB migrations and plan review.",
  },
];

export function SessionDefaultsSettings({
  mode,
  kbAutoPrime,
  onModeChange,
  onKbAutoPrimeChange,
  autoResumeAfterLimit,
  onAutoResumeAfterLimitChange,
  disabled = false,
}: SessionDefaultsSettingsProps) {
  return (
    <div className="space-y-3" data-testid="session-defaults-settings">
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="text-sm text-cc-fg mb-1">Default session mode</legend>
        <p className="text-xs text-cc-muted px-1" id="default-session-mode-help">
          Where the Council toggle starts on the New Session form. You can still switch it per session.
        </p>
        <div className="space-y-2" role="radiogroup" aria-describedby="default-session-mode-help">
          {MODE_OPTIONS.map((opt) => {
            const checked = mode === opt.value;
            return (
              <label
                key={opt.value}
                className={`flex items-start gap-3 px-3 py-3 min-h-[44px] rounded-lg text-sm cursor-pointer transition-colors ${
                  checked ? "bg-cc-active text-cc-fg" : "bg-cc-hover text-cc-fg hover:bg-cc-active"
                }`}
              >
                <input
                  type="radio"
                  name="default-session-mode"
                  value={opt.value}
                  checked={checked}
                  onChange={() => onModeChange(opt.value)}
                  className="mt-0.5 accent-cc-primary"
                />
                <span className="flex flex-col">
                  <span>{opt.label}</span>
                  <span className="text-[11px] text-cc-muted mt-0.5">{opt.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <button
        type="button"
        role="switch"
        aria-checked={kbAutoPrime}
        aria-label="Load knowledge base at session start"
        aria-describedby="kb-auto-prime-help"
        disabled={disabled}
        onClick={() => onKbAutoPrimeChange(!kbAutoPrime)}
        className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span>Load knowledge base at session start</span>
        <span className={`text-xs font-medium ${kbAutoPrime ? "text-cc-success" : "text-cc-muted"}`}>
          {kbAutoPrime ? "On" : "Off"}
        </span>
      </button>
      <p id="kb-auto-prime-help" className="text-xs text-cc-muted px-1">
        Off: agents consult <code>.agents/knowledge</code> only when a task touches that area. On: new
        sessions are told to load relevant entries (/prime) before starting. Applies to Claude Code and
        Codex; ignored when the knowledge layer is disabled on the server.
      </p>

      {autoResumeAfterLimit !== undefined && onAutoResumeAfterLimitChange && (
        <>
          <button
            type="button"
            role="switch"
            aria-checked={autoResumeAfterLimit}
            aria-label="Автопродолжение после лимита"
            aria-describedby="auto-resume-help"
            disabled={disabled}
            onClick={() => onAutoResumeAfterLimitChange(!autoResumeAfterLimit)}
            className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span>Автопродолжение после лимита</span>
            <span className={`text-xs font-medium ${autoResumeAfterLimit ? "text-cc-success" : "text-cc-muted"}`}>
              {autoResumeAfterLimit ? "On" : "Off"}
            </span>
          </button>
          <p id="auto-resume-help" className="text-xs text-cc-muted px-1">
            When a session stops on a usage limit (Claude session/weekly limit, Codex usage limit), Aura
            sends a continuation prompt 1–2 minutes after the reset, relaunching the session if needed.
            Works for Claude Code and Codex, solo and Council sessions. Cancel per session from its banner.
          </p>
        </>
      )}
    </div>
  );
}
