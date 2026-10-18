/**
 * How tall an upward-opening dropdown may be without its top rows landing
 * where nothing can scroll to them.
 *
 * Owner bug 2026-10-18 (PR #386 follow-up): a fixed `max-h` (24rem / 70vh)
 * still overflowed the page's scroll container on a short window — the
 * container starts below the top bar, so "70% of the viewport" was more than
 * the room above the trigger and the first row (Opus 5.5) stayed clipped. The
 * only honest cap is the measured distance from the trigger's top edge to the
 * top of the nearest scroll container (or the viewport when there is none).
 *
 * Returns `null` when nothing can be measured (jsdom reports zero rects), so
 * callers keep their static CSS cap instead of collapsing the list.
 */
export const DROPDOWN_FIT_MAX_PX = 384; // 24rem — matches ModelSwitcher's cap
export const DROPDOWN_FIT_MIN_PX = 96; // never shorter than ~3 rows
const DROPDOWN_FIT_GAP_PX = 8; // breathing room below the container edge

export function findScrollContainer(el: Element): Element | null {
  let node: Element | null = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

export function availableHeightAbove(trigger: Element): number | null {
  const triggerTop = trigger.getBoundingClientRect().top;
  const container = findScrollContainer(trigger);
  const containerTop = container ? container.getBoundingClientRect().top : 0;
  const room = triggerTop - containerTop - DROPDOWN_FIT_GAP_PX;
  if (!Number.isFinite(room) || room <= 0) return null;
  return Math.min(DROPDOWN_FIT_MAX_PX, Math.max(DROPDOWN_FIT_MIN_PX, Math.round(room)));
}
