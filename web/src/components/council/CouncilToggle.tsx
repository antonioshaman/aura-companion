/**
 * CouncilToggle — grouped control for the New-Session form (HomePage)
 * that enables Council Mode and lets the user pick the provider pairing.
 *
 * PLAN T15.1:
 *  - Off by default; subordinate to the Create button.
 *  - ON reveals the provider-pairing dropdown via height-transition (no
 *    flicker — content mounts before the height animates open).
 *  - Pairing labels spell out "Orchestrator: Claude · Observer: Codex"
 *    rather than the wire-form "claude+codex".
 *  - `claude+codex` carries an inline `experimental` chip and a one-line
 *    subcopy stating both halves are billed separately.
 *  - When Codex is unavailable (Task 11 probe), the option is disabled
 *    with a tooltip explaining what's missing.
 *  - 8/12 px internal spacing matches existing grouped controls.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type CouncilPairing = "claude+claude" | "claude+codex";

export interface CouncilToggleProps {
  /** Whether Council Mode is currently on. Controlled. */
  enabled: boolean;
  /** Currently selected pairing label. Controlled; ignored when !enabled. */
  pairing: CouncilPairing;
  /** Setter for enabled. */
  onEnabledChange: (enabled: boolean) => void;
  /** Setter for pairing. */
  onPairingChange: (pairing: CouncilPairing) => void;
  /**
   * Whether the `claude+codex` option is currently available (Codex CLI
   * detected + authenticated). When false, the option is disabled with a
   * tooltip. Default `true` for tests / Playground.
   */
  codexAvailable?: boolean;
  /** Optional human-readable reason when Codex is unavailable. Surfaced in tooltip + subcopy. */
  codexUnavailableReason?: string;
}

interface PairingOption {
  value: CouncilPairing;
  label: string;
  subcopy?: string;
  experimental?: boolean;
}

const PAIRING_OPTIONS: readonly PairingOption[] = Object.freeze([
  {
    value: "claude+claude",
    label: "Orchestrator: Claude · Observer: Claude",
  },
  {
    value: "claude+codex",
    label: "Orchestrator: Claude · Observer: Codex",
    subcopy: "Both halves are billed separately.",
    experimental: true,
  },
] as const);

/**
 * Pure helper: validate and normalise a pairing string. Returns null when
 * the value isn't one of the supported pairings. Exported for tests and
 * for the HomePage submit-path, which validates before posting to the API.
 */
export function isSupportedPairing(value: unknown): value is CouncilPairing {
  return value === "claude+claude" || value === "claude+codex";
}

function PairingDropdownItem({
  option,
  selected,
  available,
  unavailableReason,
  onSelect,
}: {
  option: PairingOption;
  selected: boolean;
  available: boolean;
  unavailableReason?: string;
  onSelect: () => void;
}) {
  const disabled = !available;
  const baseClass = "w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm rounded-md transition-colors";
  const stateClass = disabled
    ? "opacity-50 cursor-not-allowed text-cc-muted"
    : selected
      ? "bg-cc-primary/10 text-cc-fg cursor-pointer"
      : "text-cc-fg hover:bg-cc-hover cursor-pointer";
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      data-testid={`pairing-option-${option.value}`}
      title={disabled && unavailableReason ? unavailableReason : undefined}
      onClick={disabled ? undefined : onSelect}
      className={`${baseClass} ${stateClass}`}
    >
      <span className="flex flex-col items-start min-w-0">
        <span className="truncate">{option.label}</span>
        {option.subcopy && (
          <span className="text-[11px] text-cc-muted truncate">{option.subcopy}</span>
        )}
        {disabled && unavailableReason && (
          <span className="text-[11px] text-cc-muted">{unavailableReason}</span>
        )}
      </span>
      <span className="flex items-center gap-1 shrink-0">
        {option.experimental && (
          <span className="text-[10px] uppercase tracking-wide font-mono-code px-1.5 py-0.5 rounded bg-cc-info/10 text-cc-info border border-cc-info/15">
            exp
          </span>
        )}
        {disabled && (
          <span className="text-[10px] uppercase tracking-wide font-mono-code px-1.5 py-0.5 rounded bg-cc-muted/10 text-cc-muted border border-cc-border">
            unavailable
          </span>
        )}
      </span>
    </button>
  );
}

export function CouncilToggle({
  enabled,
  pairing,
  onEnabledChange,
  onPairingChange,
  codexAvailable = true,
  codexUnavailableReason = "Codex CLI not detected — install or sign in.",
}: CouncilToggleProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: PointerEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, [open]);

  const selectedOption = useMemo(
    () => PAIRING_OPTIONS.find((o) => o.value === pairing) ?? PAIRING_OPTIONS[0]!,
    [pairing],
  );

  const handleSelect = useCallback(
    (next: CouncilPairing) => {
      onPairingChange(next);
      setOpen(false);
    },
    [onPairingChange],
  );

  return (
    <div
      data-testid="council-toggle"
      className="border border-cc-border rounded-lg bg-cc-card/60 px-3 py-2.5"
    >
      {/* Toggle row */}
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle Council Mode"
          onClick={() => onEnabledChange(!enabled)}
          className={`mt-0.5 shrink-0 w-9 h-5 rounded-full transition-colors cursor-pointer relative ${
            enabled ? "bg-cc-primary" : "bg-cc-muted/30"
          }`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-cc-fg">Council Mode</div>
          <p className="text-xs text-cc-muted mt-0.5 leading-snug">
            Pair this session with an independent observer LLM that reviews each checkpoint.
          </p>
        </div>
      </div>

      {/* Provider-pairing dropdown — height-animated so the toggle row doesn't jump. */}
      <div
        data-testid="pairing-dropdown-container"
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          enabled ? "grid-rows-[1fr] mt-3" : "grid-rows-[0fr]"
        }`}
        // role="presentation" on the animation container; the actual listbox lives below.
      >
        <div className="overflow-hidden">
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-haspopup="listbox"
              aria-expanded={open}
              data-testid="pairing-trigger"
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-cc-fg bg-cc-card border border-cc-border rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
              disabled={!enabled}
            >
              <span className="flex items-center gap-2 min-w-0">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted shrink-0" aria-hidden="true">
                  <path d="M3.204 5h9.592L8 10.481 3.204 5zm-.753.659l5.197 5.943a.5.5 0 00.753 0l5.197-5.943A.5.5 0 0013.198 5H2.802a.5.5 0 00-.377.659z" />
                </svg>
                <span className="truncate">{selectedOption.label}</span>
                {selectedOption.experimental && (
                  <span className="text-[10px] uppercase tracking-wide font-mono-code px-1.5 py-0.5 rounded bg-cc-info/10 text-cc-info border border-cc-info/15 shrink-0">
                    exp
                  </span>
                )}
              </span>
            </button>
            {selectedOption.subcopy && pairing === "claude+codex" && (
              <p className="mt-1.5 text-[11px] text-cc-muted">{selectedOption.subcopy}</p>
            )}

            {open && (
              <div
                role="listbox"
                aria-label="Select pairing"
                className="absolute z-10 left-0 right-0 mt-1 p-1 bg-cc-card border border-cc-border rounded-md shadow-lg"
              >
                {PAIRING_OPTIONS.map((opt) => {
                  const available = opt.value === "claude+codex" ? codexAvailable : true;
                  return (
                    <PairingDropdownItem
                      key={opt.value}
                      option={opt}
                      selected={opt.value === pairing}
                      available={available}
                      unavailableReason={opt.value === "claude+codex" && !available ? codexUnavailableReason : undefined}
                      onSelect={() => handleSelect(opt.value)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
