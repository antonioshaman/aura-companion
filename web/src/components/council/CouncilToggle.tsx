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
  isActive,
  available,
  unavailableReason,
  onSelect,
}: {
  option: PairingOption;
  selected: boolean;
  isActive: boolean;
  available: boolean;
  unavailableReason?: string;
  onSelect: () => void;
}) {
  const disabled = !available;
  const baseClass = "w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm rounded-md transition-colors";
  // a11y APG listbox: `isActive` row gets a focus-style ring so sighted
  // keyboard users see the roving-focus position; SR users get the same
  // signal via `aria-activedescendant` on the trigger.
  const activeRing = isActive && !disabled ? "ring-2 ring-cc-primary/40" : "";
  const stateClass = disabled
    ? "opacity-50 cursor-not-allowed text-cc-muted"
    : selected
      ? "bg-cc-primary/10 text-cc-fg cursor-pointer"
      : "text-cc-fg hover:bg-cc-hover cursor-pointer";
  // a11y council review #10: aria-disabled keeps the option focusable
  // so screen-reader users can hear WHY it's unavailable; `disabled`
  // removes the option from Tab order entirely and the inline reason
  // text becomes unreachable.
  return (
    <button
      type="button"
      id={`pairing-option-${option.value}`}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      data-testid={`pairing-option-${option.value}`}
      title={disabled && unavailableReason ? unavailableReason : undefined}
      onClick={disabled ? undefined : onSelect}
      className={`${baseClass} ${stateClass} ${activeRing}`}
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  // a11y council review #10 (P2#10): roving-focus index for APG
  // `listbox` keyboard model. The currently-focused option is the one
  // SR users hear; Arrow/Home/End move it; Enter/Space activates; Escape
  // closes. `aria-activedescendant` on the listbox points the SR at
  // this row.
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    Math.max(0, PAIRING_OPTIONS.findIndex((o) => o.value === pairing)),
  );

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

  // On open, snap active index to the currently-selected pairing so
  // the first arrow press feels like "next item from selected", not
  // "from option 0".
  useEffect(() => {
    if (!open) return;
    const i = PAIRING_OPTIONS.findIndex((o) => o.value === pairing);
    if (i >= 0) setActiveIndex(i);
  }, [open, pairing]);

  const selectedOption = useMemo(
    () => PAIRING_OPTIONS.find((o) => o.value === pairing) ?? PAIRING_OPTIONS[0]!,
    [pairing],
  );

  const handleSelect = useCallback(
    (next: CouncilPairing) => {
      onPairingChange(next);
      setOpen(false);
      // Return focus to the trigger so keyboard users land back at
      // their starting point.
      requestAnimationFrame(() => triggerRef.current?.focus());
    },
    [onPairingChange],
  );

  /**
   * APG listbox keyboard model. Arrow/Home/End move the active row,
   * skipping disabled options. Enter/Space activates. Escape closes.
   * Bound to keydown on the trigger AND on the listbox container so
   * the user can drive it from either focus position.
   */
  const handleListboxKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
      return;
    }
    const step = (delta: number) => {
      // Advance through options, skipping any whose `available` flag is
      // false. Available is derived inline (only `claude+codex` is gateable today).
      const total = PAIRING_OPTIONS.length;
      let idx = activeIndex;
      for (let i = 0; i < total; i++) {
        idx = (idx + delta + total) % total;
        const candidate = PAIRING_OPTIONS[idx]!;
        const candidateAvailable = candidate.value === "claude+codex" ? codexAvailable : true;
        if (candidateAvailable) {
          setActiveIndex(idx);
          return;
        }
      }
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(PAIRING_OPTIONS.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const candidate = PAIRING_OPTIONS[activeIndex];
      if (!candidate) return;
      const candidateAvailable = candidate.value === "claude+codex" ? codexAvailable : true;
      if (!candidateAvailable) return;
      handleSelect(candidate.value);
    }
  }, [open, activeIndex, codexAvailable, handleSelect]);

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

      {/* Provider-pairing dropdown — height-animated so the toggle row doesn't jump.
       *
       * Structural note: the listbox lives OUTSIDE the `overflow-hidden`
       * animation wrapper as a sibling of the grid container. The wrapper
       * uses `overflow-hidden` to clip the trigger during the
       * grid-template-rows 1fr↔0fr collapse animation; an `absolute`
       * descendant rendered INSIDE that wrapper would be clipped to zero
       * pixels alongside the row collapse, making the dropdown invisible
       * even though `open === true`. By lifting `.relative` (the
       * positioning context that anchors the absolute listbox) to wrap
       * BOTH the animation container AND the open-state listbox, the
       * dropdown escapes the clip while still positioning correctly
       * via `top-full` (= bottom edge of the relative parent =
       * bottom edge of the animated container = directly below the
       * trigger when expanded). Re-introducing `overflow-hidden`
       * above the dropdownRef would silently regress the open behaviour
       * (the dropdown would render but be invisible). */}
      <div className="relative" ref={dropdownRef}>
        <div
          data-testid="pairing-dropdown-container"
          className={`grid transition-[grid-template-rows] duration-200 ease-out ${
            enabled ? "grid-rows-[1fr] mt-3" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setOpen(!open)}
              onKeyDown={handleListboxKeyDown}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-controls="council-pairing-listbox"
              data-testid="pairing-trigger"
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-cc-fg bg-cc-card border border-cc-border rounded-[10px] hover:bg-cc-hover transition-colors cursor-pointer"
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
          </div>
        </div>

        {open && (
          <div
            id="council-pairing-listbox"
            role="listbox"
            aria-label="Select pairing"
            aria-activedescendant={`pairing-option-${PAIRING_OPTIONS[activeIndex]?.value ?? ""}`}
            onKeyDown={handleListboxKeyDown}
            tabIndex={-1}
            // Saarinen council review #14: dropdown radius snapped
            // to project's `rounded-[10px]` shadow-lg convention.
            // `top-full` positions the listbox at the bottom of the
            // outer .relative (which contains the animated container);
            // when enabled = true, that bottom edge sits directly below
            // the trigger button. `mt-1` preserves the original 4px gap.
            className="absolute z-10 top-full left-0 right-0 mt-1 p-1 bg-cc-card border border-cc-border rounded-[10px] shadow-lg"
          >
            {PAIRING_OPTIONS.map((opt, idx) => {
              const available = opt.value === "claude+codex" ? codexAvailable : true;
              return (
                <PairingDropdownItem
                  key={opt.value}
                  option={opt}
                  selected={opt.value === pairing}
                  isActive={idx === activeIndex}
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
  );
}
