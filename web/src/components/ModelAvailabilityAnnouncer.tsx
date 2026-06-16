/**
 * ModelAvailabilityAnnouncer — Model Registry Task 10. A visually-hidden,
 * polite live region that speaks the three model-availability events
 * (substituted / reverted / unavailable) to screen-reader users.
 *
 * a11y (quality-a11y.md P3): `role="log"` + `aria-live="polite"` +
 * `aria-atomic="false"` — the same idiom as the Council FindingsLog. Polite
 * (never `assertive`): a model failover is infrastructure information, not an
 * emergency that should interrupt the user's current speech. `aria-atomic="false"`
 * so only the newly-appended line is announced, not a re-read of the region.
 *
 * Why a dedicated region and not the chat log: the reactive-revert and
 * `unavailable` notices render in `MessageFeed` (which has no live region) and
 * the `substituted` notice is a purely-visual banner — so without this region
 * none of the three events reach a screen reader. ws.ts writes the announcement
 * string to the store on each event; this component reads it and renders one
 * line, keyed by `firedAt` so two identical messages in a row (e.g. two reverts
 * to the same model) still produce a distinct DOM node the SR will speak.
 */

import { useStore } from "../store.js";

export function ModelAvailabilityAnnouncer({ sessionId }: { sessionId: string }) {
  const announcement = useStore((s) => s.modelAvailabilityAnnouncements.get(sessionId));
  return (
    <div
      role="log"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Model availability"
      data-testid="model-availability-announcer"
      className="sr-only"
    >
      {announcement ? <span key={announcement.firedAt}>{announcement.text}</span> : null}
    </div>
  );
}
