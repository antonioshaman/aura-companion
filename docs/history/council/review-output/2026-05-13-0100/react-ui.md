# React/Web UI Expert Review — Observer Auto-Wake (Story 2 AC#1)

Stack: React 19 + Zustand 5 + Tailwind. Scope per dispatch brief:
`observer-panel-state.ts`, `store/council-slice.ts`, `ws.ts`,
`components/council/ObserverPanel.tsx`, `components/council/FindingsLog.tsx`,
`types.ts`. Lane: React/Zustand quality only — a11y / visual design / UX
flow excluded per dispatch instructions.

---

## P1-1 — `reviewing → reviewing-stalled` is wallclock-anchored but the panel has no clock subscription, so the transition fires only on the next unrelated re-render

**Files:** `web/src/observer-panel-state.ts` (lines 50, 83–98) +
`web/src/components/council/ObserverPanel.tsx` (lines 176–208) +
`web/src/App.tsx` line 320 (`<ObserverPanel sessionId={currentSessionId} />` — no `nowMs` prop).

**Finding.** The deriver computes `now = nowMs ?? Date.now()` at call
time, then compares `lastCheckpointAt + wakeTimeoutMs` against it. In
tests the caller passes a fixed `nowMs` and the transition is
deterministic. In production `App.tsx` mounts `<ObserverPanel
sessionId={currentSessionId} />` with no `nowMs` prop, so `Date.now()`
fires at every render of the panel. But the only re-render triggers for
this panel are Zustand store changes selected by the panel
(`groupBySessionId`, `groups`, `findings`, `dismissedStopIds`,
`observerPanelOpen`, `observerPanelWidth`, `firstRunHintDismissed`).
Between checkpoints — exactly the window the `reviewing` → `reviewing-stalled`
transition is supposed to cover — no store action fires. There is
**no `setInterval`, no `useSyncExternalStore` with a clock, no
`requestAnimationFrame` loop** that ticks the panel at the
`wakeTimeoutMs` boundary. I confirmed this by grepping the council
subtree (`web/src/components/council/`) for `setInterval` — zero
matches.

**Concrete failure mode.** Server publishes `group_created` with
`wakeTimeoutMs = 90_000`. Orchestrator writes checkpoint at T=0.
Server dispatches wake; observer hangs. At T=90s the deriver would
yield `reviewing-stalled` **if asked**, but no asking happens. The
panel keeps showing the blue pulsing `Reviewing` pill indefinitely.
If the user does nothing — exactly the case the stalled state was
added to surface — the recovery branch is unreachable in runtime
even though the unit test passes. Sibling of
`feedback_recovery_branch_reachability.md`: ship-green but
structurally void.

What unblocks it accidentally today: a permission request from the
orchestrator (changes a different slice), an `assistant` message
(changes `messages` — but `ObserverPanel` doesn't select messages, so
this actually doesn't re-render it either), or another
`group_checkpoint` (but that arrival itself flips `observerReviewing`
back to true and resets `lastCheckpointAt`). The cleanest accidental
trigger is the panel collapse/expand button. None of those are
guaranteed to happen at T=90s.

**Recommendation (no code per dispatch rules).** Subscribe the panel
to a clock at the cadence of the smallest meaningful threshold (the
90s wakeTimeoutMs floor → a 5–15s interval is plenty; not faster).
Either a module-level `useNow(intervalMs)` hook backed by
`useSyncExternalStore` (preferred — opt-in per component, batched, SSR-
safe even though Aura is SPA-only) or a Zustand-driven `nowTickMs` slot
that a single setInterval at app root bumps. Tests already pass
explicit `nowMs`, so the hook should accept an override prop for that
path. Pair with a test that mounts the panel, fast-forwards the fake
timer past `expiresAt`, and asserts the pill text flips without any
intervening store action. Until then the unit test on the deriver is
not load-bearing for the user-visible behaviour — durable EC-6-style
canary: a component-level test that ONLY advances time and asserts
state name.

**Severity: P1.** The stalled state was added precisely to defeat the
recovery-branch-reachability failure mode; shipping it without a
re-render trigger reproduces the same failure mode at a different
layer.

---

## P2-1 — `findings` slice returns a fresh array reference on every `appendObserverReview` **even when zero new findings are appended**, re-firing the FindingsLog effect needlessly

**Files:** `web/src/store/council-slice.ts` line 298 + `web/src/components/council/FindingsLog.tsx` lines 200–214.

**Finding.** `appendObserverReview` unconditionally executes
`findings.set(sessionGroupId, [...prior, ...newOnes])` — the spread
runs even when `newOnes.length === 0` (the dedup path filtered every
incoming wire finding because the server re-emitted on reconnect, per
the comment on line 295). That writes a *new array reference* under
the same key, which is structurally fine for Zustand identity-based
change detection but causes the consumer effect in `FindingsLog` to
re-run:

```
useEffect(() => { … setAnnouncement(summary); }, [findings]);
```

The effect's first line is `const newOnes = findings.filter((f) =>
!lastIdsRef.current.has(f.id))`. When the dedup path produced zero new
ids, `newOnes.length === 0` and the effect short-circuits at line 206
— so the **observable** outcome (announcer text) does not change. The
hidden cost: every `observer_review` arrival walks the findings array
twice (once in slice dedup, once in effect dedup) even when the
content is unchanged. For a long-lived Council session with a few
hundred findings this is sub-millisecond, so it's not a correctness
bug — it's a "write path that broadcasts no-op events".

The bigger structural concern: the slice's "new array on every
review-event, even zero-new" pattern means **anyone** else who
subscribes to `findings.get(sessionGroupId)` re-renders on every
review event whether or not it carried new findings.
`countUnresolvedStopsAcrossGroups` (consumed by
`use-browser-title-alert` and the Sidebar badge) iterates *every*
group's array — that's pure but the parent component still re-renders.

**Recommendation.** Guard the slice write: when
`newOnes.length === 0 && newDowngrades.length === 0 &&
supersededCheckpointIds is empty/omitted`, return `{}` from `set`.
Match the same pattern already in place on `recordCheckpoint`
(early-return for out-of-order seq) and `dismissStop` (early-return
when id already in set). This makes the FindingsLog effect's
dependency-tracking observably correct rather than coincidentally
correct.

**Severity: P2.** Performance hygiene; turns into P1 only if combined
with high-frequency re-broadcasts.

---

## P2-2 — `appendObserverReview` overwrites `recentlySupersededCheckpointIds` to `[]` on every clean review, conflating "never had any" with "had some, now cleared"

**Files:** `web/src/store/council-slice.ts` lines 282–288 + `web/src/observer-panel-state.ts` lines 107–119.

**Finding.** The slice writes:

```
...(Array.isArray(supersededCheckpointIds) && supersededCheckpointIds.length > 0
  ? { recentlySupersededCheckpointIds: supersededCheckpointIds }
  : { recentlySupersededCheckpointIds: [] }),
```

The dispatch brief explicitly asks whether this is distinguishable
from "never had any". It is not: both states materialise as
`recentlySupersededCheckpointIds: []`. The deriver guards with
`Array.isArray(...) && .length > 0` (line 108), so both paths
collapse to the next-priority branch correctly. **However**, this
breaks two downstream invariants that could otherwise hold:

1. **`undefined` vs `[]` ambiguity.** Other code paths (server replay,
   future telemetry, debug introspection) can no longer distinguish
   "we explicitly told the slice supersededCheckpointIds was empty"
   from "the field was never populated". A typed-state purist would
   flag this; pragmatically the panel-state derivation is unaffected
   today.
2. **Clean-review timing.** Per Task 11 the field is supposed to clear
   on the *next clean review*. The code does clear it — but it also
   *re-clears it* on every clean review, including ones that arrive
   when the field was already absent. Every clean review now writes a
   new key into the group record (and produces a new group object
   reference), bumping every consumer that selects `groups.get(id)`
   even when nothing observable changed.

The first concern is mild type-hygiene. The second is the same shape
as the `findings`-no-op-write issue above: structurally correct,
operationally noisy.

**Recommendation.** Distinguish three cases at the slice boundary:
(a) `supersededCheckpointIds` non-empty → write the array;
(b) `supersededCheckpointIds` empty/omitted **and** the group
currently has `recentlySupersededCheckpointIds` non-empty → clear the
field (this is the meaningful transition); (c) otherwise → omit the
field from the spread. Today's branch only handles (a) and a merged
(b+c). Same pattern as the dedup guard in P2-1.

**Severity: P2.**

---

## P2-3 — `ObserverPanel` does not pass `nowMs` through to `findUnresolvedStops` (irrelevant — pure) but DOES pass `nowMs` to the deriver and to `FindingsLog`, creating two clock references in the same render

**Files:** `web/src/components/council/ObserverPanel.tsx` lines 208, 250, 281.

**Finding.** Three call sites read the clock during a single render of
the panel:

1. `deriveObserverPanelState({ … nowMs })` — uses the optional prop,
   falls back to `Date.now()`.
2. `formatRelativeTime(… , typeof nowMs === "number" ? nowMs :
   Date.now())` — header timestamp.
3. `<FindingsLog … nowMs={nowMs} />` — and `FindingsLog` itself
   computes `const now = typeof nowMs === "number" ? nowMs : Date.now()`.

When the caller (App.tsx today) omits `nowMs`, all three sites call
`Date.now()` independently. Between the first call (line 208) and the
third (inside FindingsLog) a microsecond or two passes. For the
header-timestamp + finding-row-timestamp rendering this is meaningless
(both round to whole seconds). For the deriver's `now <= expiresAt`
check at the deadline boundary it is *also* meaningless because they
agree to the millisecond unless the JS engine context-switched
between the calls — extremely unlikely.

This is benign **today**. It becomes load-bearing the moment Task 11's
intent (deterministic stalled-transition) needs to ship a production
clock subscription per P1-1 above. Once you have a `useNow()` hook,
the panel should consume it once and pass the resulting `nowMs` to
the deriver, the header timestamp formatter, and the FindingsLog — so
they all derive from the same snapshot. Otherwise the deriver could
yield `reviewing-stalled` while the header timestamp reads "89s ago"
because Date.now() advanced between them.

**Recommendation.** Memoise the clock read once at the top of
`ObserverPanel` (use the proposed `useNow(15_000)` hook, falling back
to `Date.now()` once if no hook ships). Pass the **same** value to
all three consumers. The current "prop wins, otherwise call
`Date.now()` per consumer" pattern is exactly the React shape that
makes the deriver's logic non-deterministic across a single render.

**Severity: P2.** Coupled with P1-1; downgrade to P3 if P1-1 is
addressed differently.

---

## P3-1 — `useRef<Set<string>>(new Set())` for last-known-ids in `FindingsLog` re-mounts the ref in StrictMode dev double-render, producing one spurious announcer line on every mount cycle

**Files:** `web/src/components/council/FindingsLog.tsx` lines 200–214.

**Finding.** `lastIdsRef` is initialised with `new Set()` and updated
inside `useEffect`. In React 19 StrictMode dev mode the effect fires
twice on first mount: the first run populates the ref with the
current finding ids and sets the announcer; the cleanup (none here)
runs; the second run sees `lastIdsRef.current` populated from the
first run, so `newOnes.length === 0` and the announcer doesn't change.
That's the **safe** path.

The unsafe path: when StrictMode re-mounts a component (which it does
on Fast Refresh and on parent key changes), `useRef` re-initialises to
`new Set()` — empty. The next effect run treats every finding as new
and produces a "Observer review complete: N notes" announcement that
isn't actually new content. SR users hear the entire log read out as
"new" every time the panel remounts. That's a real
behavioural bug for an a11y feature, even though it's outside the
react-ui lane to fully attribute (a11y handles it).

From a React-state-discipline angle the issue is: **the ref is acting
as state**. The "did we already announce this id" predicate is
deriveable from the message of "I just appended N new findings to this
group". That information lives in the slice
(`appendObserverReview` already filtered to `newOnes` on line 293),
but it's discarded once the spread merges into the bucket. If the
slice instead emitted a per-event count or a monotonic
`lastReviewCheckpointId`, FindingsLog could announce based on that
rather than reverse-engineer it from a ref-tracked diff.

**Recommendation.** Either (a) move the announcement summary into the
slice/store as a transient `lastReviewSummary` field that the slice
sets at append time and the component reads as derived state (no ref);
or (b) accept the StrictMode re-announcement cost and document it
explicitly with a comment so the next maintainer doesn't try to
"optimise it away". The current code is right-shaped for production
but its dev-mode behaviour is exactly the noise the a11y refactor
was supposed to delete.

**Severity: P3** for React/Zustand discipline. The a11y consequence
is in the a11y auditor's lane.

---

## P3-2 — Wire-types optional-field spread in `ws.ts` for `supersededCheckpointIds` works but introduces a third "is it undefined or empty" representation

**Files:** `web/src/ws.ts` lines 1243–1245 + `web/src/store/council-slice.ts` lines 282–288.

**Finding.** `ws.ts` spreads conditionally:

```
...(data.supersededCheckpointIds !== undefined
  ? { supersededCheckpointIds: data.supersededCheckpointIds }
  : {}),
```

That correctly hides absence — `appendObserverReview` sees the field
omitted when the server didn't send it. The slice then maps both
"omitted" and "empty array" to `recentlySupersededCheckpointIds: []`
on the group record (P2-2 above). So the wire's discrimination
between "field absent" and "field present but empty" is faithfully
preserved across the WS boundary, then collapsed at the slice
boundary. That's not a contradiction — it's a chosen-by-design
loss of distinction — but it does mean the optional-field spread in
ws.ts is **defensively shaped against a discrimination the consumer
doesn't use**. Functionally fine. Aesthetically: either commit to
discriminating throughout, or commit to collapsing at the wire and
delete the spread guard.

**Recommendation.** If P2-2's recommendation lands (slice
distinguishes "clear" from "no-op"), the spread guard in ws.ts
becomes load-bearing — keep it. If P2-2 doesn't land, simplify the
spread to `supersededCheckpointIds: data.supersededCheckpointIds ?? []`
and let the slice's existing empty-array path handle it.

**Severity: P3.**

---

## P3-3 — `queued-dropped` priority sits above `sleeping` and below `reviewing`/`blocker-found` — correct per spec; flagged only to confirm priority-ladder is exhaustively tested

**Files:** `web/src/observer-panel-state.ts` lines 101–119.

**Finding.** The dispatch brief asks whether `blocker-found` correctly
outranks `queued-dropped` (it does — a live STOP demands attention
before a "we skipped some coverage" note). The dispatch brief also
asks about the interaction with `reviewing`: a `queued-dropped` flag
means the *previous* review carried superseded ids, which is
orthogonal to whether the *current* checkpoint is mid-review. The
code orders `reviewing` (line 77) above `queued-dropped` (line 107),
which is right — if a new review is in flight, surface that;
surface the dropped-coverage residue from the prior review only when
nothing else is happening. The test at
`observer-panel-state.test.ts:169` pins the `queued-dropped` case but
does **not** pin the interaction case (review is in flight *and*
prior review had superseded ids). Per current code that scenario
yields `reviewing` (correct), but it's untested. Sibling concern of
P1-1: untested priority interactions are the next layer of
recovery-branch-reachability traps.

**Recommendation.** Add a test case:
`observerReviewing: true, lastCheckpointAt set, wakeTimeoutMs set,
recentlySupersededCheckpointIds: ["chk_a"]`. Expect `reviewing`. Pin
the same scenario with `nowMs` past `expiresAt` → expect
`reviewing-stalled`, not `queued-dropped`. This is Beck-territory,
but the priority ladder is React-state-machine territory and a
single untested interaction is the trapdoor.

**Severity: P3.**

---

## Out-of-scope but worth noting (no finding — observation only)

- `groupBySessionId` reverse index is maintained in `upsertGroup` and
  `removeGroup`. No drift potential in the current code paths.
- The slice's per-action `new Map(s.X)` clone-on-write pattern is the
  canonical Zustand-with-Maps idiom; flagged here only to note it is
  doing the right thing — none of the new Task 11 fields broke it.
- `ObserverPanel`'s selectors are individually narrow
  (`groupBySessionId.get(sessionId)`, `groups.get(groupId)`, etc.) —
  no whole-store reads, no fresh-object-per-call selector returns.
  Selector discipline is clean.

---

## Severity summary

| ID    | Title                                                         | Severity |
| ----- | ------------------------------------------------------------- | -------- |
| P1-1  | Stalled transition has no clock subscription in production    | P1       |
| P2-1  | Slice writes new findings array on zero-new dedup result      | P2       |
| P2-2  | Empty-array vs absent ambiguity on supersededCheckpointIds    | P2       |
| P2-3  | Multiple independent `Date.now()` reads per render            | P2       |
| P3-1  | useRef as state — StrictMode re-mount re-announces everything | P3       |
| P3-2  | ws.ts optional-spread shape vs slice collapse mismatch        | P3       |
| P3-3  | reviewing × queued-dropped interaction untested               | P3       |
