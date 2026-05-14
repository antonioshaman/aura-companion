/**
 * ProviderBadges — small monospace chips that label each half of a Council
 * pair. Sits in TopBar (between Session tab + AiValidationToggle) and in
 * the ObserverPanel header so the provider/billing pairing is visible at a
 * glance.
 *
 * Visual register (PLAN T15.5):
 *  - `label-muted` token (cc-muted on cc-code-bg/30) — NOT accent-coloured pills.
 *  - claude+claude → two identical chips.
 *  - claude+codex  → two visibly different chips (claude tint vs cc-codex tint).
 *    The asymmetry IS the provider affordance — users read pairing from the
 *    chip colours, not by parsing a label.
 */

import type { GroupRecord } from "../../types.js";

export interface ProviderBadgesProps {
  /**
   * Pairing label as the server emitted it. Today only "claude+claude" and
   * "claude+codex" are validated server-side; the component renders the
   * two halves whatever the label says — unknown providers fall back to a
   * neutral chip so a future provider doesn't render as a broken UI.
   */
  pairing: GroupRecord["pairing"];
  /** Optional size variant. `compact` for TopBar, `default` for ObserverPanel header. */
  size?: "compact" | "default";
  /** Optional aria-label for the wrapper (Saarinen P8 — single semantic chunk). */
  ariaLabel?: string;
}

/**
 * Pure helper: parse a pairing label like "claude+codex" into its two halves.
 * Returns `null` if the label is not a two-part `+`-separated pair — the
 * caller renders a neutral fallback.
 *
 * Exported so Beck-F4 tests cover both branches (well-formed / malformed)
 * directly without rendering the component.
 */
export function parsePairing(pairing: string): { orchestrator: string; observer: string } | null {
  if (typeof pairing !== "string" || pairing.length === 0) return null;
  const parts = pairing.split("+");
  if (parts.length !== 2) return null;
  const [o, b] = parts;
  if (!o || !b) return null;
  return { orchestrator: o.toLowerCase(), observer: b.toLowerCase() };
}

/**
 * `true` when both halves of the pairing reference the same provider — the
 * chips would render identical labels and only crowd the surrounding row
 * (e.g. Sidebar's SessionItem). Callers in dense contexts can suppress
 * ProviderBadges in that case; asymmetric pairings still carry information
 * the user reads from the chip colours. Malformed input returns `false` so
 * the caller falls back to ProviderBadges' own neutral-chip rendering.
 */
export function isHomogeneousPairing(pairing: string): boolean {
  const parsed = parsePairing(pairing);
  if (!parsed) return false;
  return parsed.orchestrator === parsed.observer;
}

/**
 * Return the pair halves that should remain visible given the backend
 * already shown alongside (e.g. the `CC`/`CX` BackendBadge in SessionItem).
 * Backend `"claude"` hides any `"claude"` half; backend `"codex"` hides any
 * `"codex"` half. Halves are returned in orchestrator-then-observer order so
 * callers preserve the original pairing direction.
 *
 * Returns `[]` for malformed input — caller renders nothing, matching the
 * homogeneous-suppression behavior shipped in PR #27. Returns `[]` for
 * homogeneous pairs whose provider matches the backend (e.g.
 * `claude+claude` on a Claude backend). The single-chip case is the
 * asymmetric pairing (`claude+codex`) where one half duplicates the
 * backend indicator and the other adds genuine signal.
 */
export function pairHalvesAfterBackendCollapse(
  pairing: string,
  backend: "claude" | "codex",
): string[] {
  const parsed = parsePairing(pairing);
  if (!parsed) return [];
  return [parsed.orchestrator, parsed.observer].filter((half) => half !== backend);
}

/**
 * Tailwind class string for a single provider chip. Exported so callers in
 * dense rows (SessionItem) can render a one-off chip without depending on
 * the full ProviderBadges pair-rendering component — keeps the styling
 * token co-located with its semantic meaning while letting the caller use
 * plain markup. See `pairHalvesAfterBackendCollapse` for the suppression
 * rule that produces the single-chip case.
 */
export { providerChipClass };

interface BadgeProps {
  provider: string;
  role: "orchestrator" | "observer";
  size: "compact" | "default";
}

function providerChipClass(provider: string): string {
  // Brand-tinted backgrounds with WCAG-AA-rated text tokens (a11y
  // council review #10 / P2#10): `cc-primary` and `cc-codex` over an
  // alpha-blended brand background fail AA at 10-11px body sizes. The
  // `-btn` darker variants in `index.css` are documented as
  // "Darker button-grade variants — meet WCAG AA (4.5:1) with white
  // text"; we use the same tokens here for legible chip text on the
  // tinted surface. Background alpha widened (10→25) so the contrast
  // ratio is built on a more saturated surface for both light and dark
  // themes.
  if (provider === "claude") {
    return "bg-cc-primary/25 text-cc-primary-btn border border-cc-primary/30 dark:text-cc-primary";
  }
  if (provider === "codex") {
    return "bg-cc-codex/25 text-cc-codex-btn border border-cc-codex/30 dark:text-cc-codex";
  }
  return "bg-cc-muted/10 text-cc-muted border border-cc-border";
}

function Badge({ provider, role, size }: BadgeProps) {
  const sizeClass = size === "compact"
    ? "text-[10px] px-1.5 py-0.5 rounded-md"
    : "text-[11px] px-2 py-0.5 rounded-md";
  return (
    <span
      data-testid={`provider-chip-${role}`}
      role="img"
      aria-label={`${role}: ${provider}`}
      className={`font-mono-code uppercase tracking-wide leading-none ${sizeClass} ${providerChipClass(provider)}`}
    >
      {provider}
    </span>
  );
}

export function ProviderBadges({ pairing, size = "compact", ariaLabel }: ProviderBadgesProps) {
  const parsed = parsePairing(pairing);
  const orchestrator = parsed?.orchestrator ?? "unknown";
  const observer = parsed?.observer ?? "unknown";
  return (
    <div
      data-testid="provider-badges"
      aria-label={ariaLabel ?? `Pairing: orchestrator ${orchestrator}, observer ${observer}`}
      className="inline-flex items-center gap-1"
    >
      <Badge provider={orchestrator} role="orchestrator" size={size} />
      <span aria-hidden="true" className="text-cc-muted text-[10px]">+</span>
      <Badge provider={observer} role="observer" size={size} />
    </div>
  );
}
