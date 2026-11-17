/**
 * One button system for the sign-in journey (wizard → Diagnostics → sign-in
 * window → chat cards). Before, the same role rendered in three shapes and two
 * oranges (council review 2026-11-15, saarinen S-3). One radius (rounded-md),
 * one compact height (36px), one primary fill (`btn-primary-aa`, AA with white
 * text). `aria-disabled` is styled like `disabled`: controls that keep focus
 * while busy use it (watson P2-4).
 */
const base = "inline-flex items-center justify-center px-3 py-1.5 min-h-[36px] rounded-md text-xs font-medium cursor-pointer disabled:opacity-50 disabled:cursor-default aria-disabled:opacity-50 aria-disabled:cursor-default";

/** The one action to press. */
export const primaryButtonClass = `${base} btn-primary-aa text-white`;

/** Any other action. */
export const secondaryButtonClass = `${base} bg-cc-active text-cc-fg hover:bg-cc-hover`;

/** Low-weight inline action (chip, notes). */
export const linkButtonClass = "text-xs font-medium link-primary-aa underline underline-offset-2 cursor-pointer disabled:opacity-50 disabled:cursor-default";

/** Window chrome (Close): same hit area, no fill until hovered (saarinen S-9). */
export const ghostButtonClass = `${base} text-cc-muted hover:text-cc-fg hover:bg-cc-hover`;

/** A secondary / destructive inline action next to an accent link (saarinen S-15). */
export const mutedLinkButtonClass = "text-xs font-medium text-cc-muted hover:text-cc-fg underline underline-offset-2 cursor-pointer disabled:opacity-50 disabled:cursor-default";
