/**
 * UiuxToolkitSettings — the "UI/UX toolkit" row of Settings → Session defaults
 * (PLAN Task 8, spec `uiux-agent-enrichment.md` AC2.2 / AC2.5).
 *
 * The switch is the default of the server's `uiux` layer flag for NEW sessions
 * (a running session keeps what it got at spawn). Below it, every skill of the
 * shipped pack with what a new Claude Code / Codex session would get:
 *  - the user's own skill with the same name always wins ("Your skill is used");
 *  - Claude-only skills stay listed for Codex with a muted "Requires Claude Code"
 *    tag — information, not a warning.
 *
 * Controlled component: SettingsPage owns the value, the API calls and the view.
 */

import type { ToolkitRow, ToolkitView } from "../api.js";

type Item = ToolkitRow["claude"];

export interface UiuxToolkitSettingsProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** `null` while loading; `{ loadError }` when the request failed. */
  view: ToolkitView | null | { loadError: string };
  disabled?: boolean;
}

function statusText(item: Item): string {
  switch (item.outcome) {
    case "provide":
      return "Included";
    case "skip-user-owns":
      return "Your skill is used";
    case "blocked-by-gate":
      return "Not shipped";
    case "requires-claude":
      return "Requires Claude Code";
    case "disabled":
      return "Reference data";
    default:
      return item.outcome;
  }
}

function Status({ cli, item }: { cli: string; item: Item }) {
  const text = statusText(item);
  const muted = item.outcome !== "provide";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] ${
        muted ? "bg-cc-hover text-cc-muted" : "bg-cc-active text-cc-fg"
      }`}
      title={item.reasons.length > 0 ? item.reasons.join("; ") : undefined}
    >
      <span className="sr-only">{cli}: </span>
      {text}
    </span>
  );
}

export function UiuxToolkitSettings({ enabled, onEnabledChange, view, disabled = false }: UiuxToolkitSettingsProps) {
  return (
    <div className="space-y-2" data-testid="uiux-toolkit-settings">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="UI/UX toolkit"
        aria-describedby="uiux-toolkit-help"
        disabled={disabled}
        onClick={() => onEnabledChange(!enabled)}
        className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span>UI/UX toolkit</span>
        <span className={`text-xs font-medium ${enabled ? "text-cc-success" : "text-cc-muted"}`}>{enabled ? "On" : "Off"}</span>
      </button>
      <p id="uiux-toolkit-help" className="text-xs text-cc-muted px-1">
        UI/UX and Council skills shipped with Aura. Applies to new sessions. In Claude Code they are
        invoked as <code>/aura-toolkit:&lt;name&gt;</code>. A skill of your own with the same name is never
        changed and is the one used.
      </p>

      {view === null && <p className="text-xs text-cc-muted px-1">Loading the skill list…</p>}
      {view !== null && "loadError" in view && (
        <p className="text-xs text-cc-muted px-1">Could not load the skill list: {view.loadError}</p>
      )}
      {view !== null && "installed" in view && !view.installed && (
        <p className="text-xs text-cc-muted px-1">The toolkit is not installed on this server ({view.error}).</p>
      )}
      {view !== null && "installed" in view && view.installed && (
        <>
          {view.claudeUnavailable && (
            <p className="text-xs text-cc-muted px-1">Claude Code sessions: unavailable — {view.claudeUnavailable}.</p>
          )}
          {view.missingRuntimes?.map((m) => (
            <p key={m.runtime} className="text-xs text-cc-muted px-1">
              {m.runtime} is not installed on this server, so these skills cannot run their scripts: {m.skills.join(", ")}.
            </p>
          ))}
          <ul aria-label="Toolkit skills" className={`space-y-1 ${enabled ? "" : "opacity-60"}`}>
            {view.rows.map((row) => (
              <li key={row.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-cc-card text-sm">
                <span className="font-mono text-[12px] text-cc-fg">{row.name}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-cc-muted" aria-hidden="true">Claude</span>
                  <Status cli="Claude Code" item={row.claude} />
                  <span className="text-[11px] text-cc-muted" aria-hidden="true">Codex</span>
                  <Status cli="Codex" item={row.codex} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
