# Friedman — UX Regression Review (Aura, commit 02e28c1)

Scope: regression on the user-facing copy of the fix-pass for the two new
panel states (`reviewing-stalled`, `queued-dropped`), the new
`wake_version_mismatch` downgrade-chip tooltip copy, and the cadence trade-off
on the bumped 300s `wakeTimeoutMs` fallback.

Files in scope:
- `/root/aura-companion/web/src/components/council/ObserverPanel.tsx`
  (StatusPill new cases at L143-166)
- `/root/aura-companion/web/src/components/council/FindingsLog.tsx`
  (`downgradeReasonHuman` map at L114-128, `DowngradedChip` at L130-140)
- `/root/aura-companion/web/src/observer-panel-state.ts`
  (300s fallback at L87, `queued-dropped` branch at L111-123)

I deliberately stay in the UX lane (copy, signal cadence, drill-down
expectation). I do not re-flag prior findings nor EC-1..EC-12 / AP-1..AP-3.

---

## P2-F1 — "Reviewed (skipped N)" copy is too implicit about what was skipped, and about who skipped it

**Where:** `ObserverPanel.tsx` L162.

```tsx
<span className="text-xs font-medium">Reviewed (skipped {state.droppedCheckpointIds.length})</span>
```

**UX consequence (concrete):**

A user finishing a Carmack-Council pass sees the pill resolve from
"Reviewing · refactor" to "Reviewed (skipped 2) · refactor". The intended
meaning is: *"the observer finished a review of the most recent checkpoint;
2 earlier checkpoints from the orchestrator were superseded by the
mid-turn queue's newest-wins policy and were deliberately not individually
reviewed."*

What the pill *actually* communicates to a user who hasn't internalised
the protocol:

- "Skipped" reads as an error code, not a deliberate policy. Users
  familiar with CI output read "skipped" as "didn't run because something
  was wrong" (skipped tests, skipped migrations) — not "intentionally
  coalesced". First-trust read of a 4-letter `(skipped 2)` chip in a
  paren-aside next to a green-ish info dot creates uncertainty rather
  than confidence.
- The subject of "skipped" is ambiguous. Users cannot tell from the
  string alone whether the *orchestrator* skipped some work (bad — means
  the council pipeline missed phases) or the *observer* skipped some
  reviews (the actual meaning — and benign, because the latest checkpoint
  is a superset). This matters: the failure mode the user is most
  afraid of (orchestrator dropping work) is the one this string
  accidentally evokes.
- N has no unit. `skipped 2` could be 2 findings, 2 files, 2 checkpoints,
  2 phases.

**What Friedman's principle 9 says:**
*"Every time a user discovers a mistake, it's a small betrayal of trust."*
A pill that reads "something was skipped, ambiguous what or by whom" on a
review path that is in fact healthy is precisely the trust-erosion the
9th principle warns about — even though the underlying system did the
right thing.

**Recommendation (copy only — no code from me):**

The pill should name the noun and the actor explicitly. Suggested copy
patterns the team should pick from:

- `Reviewed · 2 checkpoints coalesced`
- `Reviewed · skipped 2 earlier checkpoints`
- `Reviewed latest of 3 checkpoints`  *(my pick — frames the policy
  positively and tells the user "you didn't lose anything")*

The tooltip / `title=` attribute on the pill (currently absent) should
spell out the policy in one sentence: *"The observer reviews only the
most recent checkpoint when several land mid-turn. Earlier checkpoints
are superseded, not lost — their work is included in the latest
checkpoint manifest."*

Severity: **P2**. Doesn't block the user, but it does erode trust
exactly where the fix-pass intended to *build* trust by making the policy
visible.

---

## P2-F2 — "schema mismatch — review may be stale" mis-describes the safety posture

**Where:** `FindingsLog.tsx` L120-121, surfaced via `DowngradedChip` tooltip at L135.

```tsx
case "wake_version_mismatch":
  return "schema mismatch — review may be stale";
```

**UX consequence (concrete):**

The fix-pass made an absent wake-version-echo from the observer a
mandatory mismatch (`group.recordings v1→v2 echo missing ≡ mismatch`).
Server-side, every finding from such a review is downgraded to NOTE. The
user sees a yellow-ish chip on every finding row from that review with
the tooltip `Server downgraded this STOP — schema mismatch — review may
be stale`.

The chip copy ("stale") is wrong in two ways the user can act on:

1. **"Stale" implies time-related.** Stale food, stale data, stale
   cache — all temporal. The user's reasonable response: "OK, the
   observer was slow / running on an old read. Let me wait or restart."
   But the actual condition is **schema disagreement about wake
   payload shape**, not temporal lag. A re-run of the same checkpoint
   would yield the same downgrade. "Stale" sends the user toward the
   wrong remediation.

2. **"May be stale" softens a safety-posture decision.** The server
   isn't saying *"there's some chance these findings are old"*. It's
   saying *"I cannot trust this review's grounding because the observer
   may be on a protocol version that interprets the wake payload
   differently — therefore I refuse to honor any STOP."* That's a
   strong, deliberate, conservative posture. "May be stale" undersells
   it; the user reads it as a hedge ("findings are *probably* fine but
   marked cautiously") when the actual posture is binary distrust.

**What Friedman's principle 9 says:**
Trust depends on the system describing its own behaviour accurately.
If the user later discovers the actual policy is "all STOPs forcibly
downgraded because of a version disagreement" but the chip said "may be
stale", that's a precise instance of *trust compounding slowly, breaking
fast*.

**Recommendation (copy only):**

Replace `"schema mismatch — review may be stale"` with one of:

- `"protocol version mismatch — findings not trusted"`  *(my pick)*
- `"observer protocol disagreement — downgraded for safety"`
- `"wake schema disagreement — STOPs disabled"`

Each names the *cause* (protocol/schema disagreement, not time) and
states the *consequence* in posture-honest language (not trusted, not
honoured, disabled — not "may be stale"). Pair with a help-link or
"learn more" in the tooltip if the team wants users to be able to
chase the cause; the chip itself should stay <60 chars.

Severity: **P2**. Same as F1 — single-line copy issue that
mis-communicates a safety-relevant decision on a regression-prone path.

---

## P3-F3 — "Review stalled" copy is honest but doesn't tell the user whether action is required

**Where:** `ObserverPanel.tsx` L143-156.

```tsx
case "reviewing-stalled":
  …
  <span className="text-xs font-medium">Review stalled</span>
  …
  <span …>{state.phase}</span>
```

**UX consequence (concrete):**

After 5 minutes (300s, bumped from 90s in the fix-pass) without an
`observer_review` landing for a published checkpoint, the pill flips
from "Reviewing · refactor" to "Review stalled · refactor" rendered in
the `cc-warning` (amber) token.

The colour says *something is wrong*. The copy says *what* — "the
review has stopped progressing". But the pill is **silent on the only
question the user has at that moment: "do I need to do something?"**

For comparison, the other amber/warning state in the panel is
`degraded` — which has a DegradedBanner sibling with an explicit
"Respawn observer" call-to-action. `reviewing-stalled` has no banner,
no action affordance, no contextual help. The user is shown a problem
state with zero next-step.

Three plausible interpretations the user will reach, ranked by
likelihood:

1. *"The observer is broken; I should restart the session."* (Likely
   over-reaction — the underlying condition may be transient.)
2. *"The observer is slow; I'll wait."* (Possibly correct — but the
   user has no signal for how long to wait, since "stalled" implies the
   waiting is *already* over.)
3. *"Something I did caused this; I should look at my work."* (False
   attribution — the stall is on the observer side.)

**What Friedman's principle 5 says:**
*"Disabled buttons are a dead end."* The same applies to warning pills
that name a problem but provide no resolution affordance. The pill is
informational but the absence of an affordance creates the same
dead-end effect.

**Recommendation (copy + minimal affordance — no code from me):**

Two changes:

1. **Copy:** `Review stalled` → one of:
   - `Observer hasn't responded` *(neutral, descriptive)*
   - `Review pending · taking longer than expected` *(softer, hedges
     against false-alarm)*
   - `Observer slow to respond` *(my pick — neutral, names actor)*

2. **Affordance:** add a one-line subtext or muted-link affordance
   under the pill in this state — `"Respawn observer"` or `"Check
   observer status"` — that lets the user act if they choose to. Even
   a passive `"Auto-recovers when next checkpoint lands"` line tells
   the user the system has a plan, removing the dead-end feel.

Severity: **P3**. The state is reachable but the cadence question (P3-F4
below) means the user often won't see it; when they do, the copy is
honest enough to not be actively misleading — just inert.

---

## P3-F4 — 300s threshold is cadence-correct but the user has likely left the panel by then; consider a "soft" pre-alert

**Where:** `observer-panel-state.ts` L87 (`300_000`) and L88-102 (the
`reviewing → reviewing-stalled` cutover).

**UX consequence (concrete):**

300s = 5 minutes. For a typical Carmack-Council phase taking 2-3
minutes (per the brief), 300s gives ~100% headroom — Friedman is
generally in favour of generous thresholds (false alarms erode the
signal). But the trade-off the team should be aware of:

By the time `reviewing-stalled` fires, the user has been waiting
5 minutes for an observer review. In a chat-style developer tool, 5
minutes is well past the point where the user has:

- Switched tabs (the title-alert `(N)` only fires on **unresolved STOPs**,
  not on stalled reviews — verified in `use-browser-title-alert.ts`
  scope per the brief).
- Collapsed the panel (no SR announcement triggers either; the
  `reviewing-stalled` pill has `role="status"` but it's inside an
  `aside` that the user may have collapsed to the rail; collapsed rail
  shows only `unresolvedCount`, which is 0 here).
- Moved on to another session in the sidebar.

In other words: the signal fires correctly at 5 minutes, but the
**channel is muted** at 5 minutes for this specific state.

Compare with `degraded`, which is also amber but is surfaced via
DegradedBanner in the header (not collapsed) and via title-alert
aggregation in some flows.

**What Friedman's principle 6 says:**
*"No data freshness indicators on streaming state — a message that's
been streaming for 30s with no indication of liveness vs hang is P2."*
Here we have a *5-minute* hang state that the user is unlikely to
notice. Not a P2 in our context (the alert *does* fire and the user
*can* see it if they look), but the alert reaches the user only if
they happen to have the panel open and the right tab focused.

**Recommendation (no code):**

Either:

(a) Bring `reviewing-stalled` into the **title-alert aggregation** so
the user gets a passive cue across all tabs even after they've moved
on. The current title-alert hook scopes only to unresolved STOPs;
extending it to stalled reviews would close the channel gap. Cheap.

(b) Introduce an **earlier soft-warning state** at, say, ~150s
(2.5 min — past the median phase length but well short of the hard
5-minute cutover) that nudges the pill colour from `cc-primary` (blue,
healthy) to `cc-info` with a "taking longer than usual" subtitle. Same
pill, no new state in the union — just a derived sub-flag the
StatusPill can read. The user gets the signal while still attending
the panel. Friedman's principle 9 ("trust compounds slowly"): an
early, soft warning reads as the system being honest about its own
expectations; a 5-minute silence followed by `Review stalled` reads as
the system noticing late.

If neither is feasible this iteration, leave the threshold at 300s as
the fix-pass set it — but file the channel gap so it isn't lost.

Severity: **P3**. Cadence trade-off, not a bug. The fix-pass made the
*right* numerical call (300s vs 90s) for the false-alarm budget. The
gap is in *reaching* the user once the alarm fires.

---

## P3-F5 — `queued-dropped` exposes `droppedCheckpointIds` on the discriminated union but the panel never surfaces them

**Where:**

- Type: `observer-panel-state.ts` L121
  (`droppedCheckpointIds: group.recentlySupersededCheckpointIds`)
- Render: `ObserverPanel.tsx` L158-166 (`StatusPill` `queued-dropped`
  case) uses only `.length` and `state.lastPhase`.

**UX consequence (concrete):**

The deriver passes the ids of the dropped checkpoints through into the
discriminated-union state object as a `readonly string[]`. The panel
StatusPill consumes only the `.length`. There is no drill-down
anywhere in the panel that lets the user inspect *which* checkpoints
the mid-turn queue coalesced.

This matters because:

- A user investigating "the observer didn't catch the bug I expected
  it to catch" needs to know whether the relevant checkpoint phase
  (say `design-validate`) was the one whose review they're reading,
  or one of the ones the queue dropped. The phase string in the pill
  is the *latest* phase only.
- The deriver already has the data. The user-visible surface
  discards it.

**What Friedman's principle 6 says:**
*"Dashboards shouldn't just display data, but create understanding"
— and "No drill-down from summary to detail" is P2 for summaries with
no detail path.* This pill is exactly a summary ("skipped N") with no
detail path.

**Recommendation (no code):**

Two cheap options the team should pick from:

(a) **Tooltip drill-down.** Add `title={state.droppedCheckpointIds.join(", ")}`
to the pill's `(skipped N)` span — or, more usefully, render
`"skipped N (last: <phase-1>, <phase-2>, ...)"` if the checkpoint id
contains a phase suffix the deriver can extract. Zero new components,
fits a chip-sized affordance, expert-only — beginners see the count and
move on; investigators get the detail.

(b) **FindingsLog detail row.** When `queued-dropped` is the current
state, prepend a single muted `<li>` to FindingsLog of the form
`"2 earlier checkpoints coalesced into this review: design-validate,
refactor"`. Same channel (`role="log"`) the user is already attending,
no new visual surface.

Severity: **P3**. The state is correctly tracked and the pill correctly
counts. The drill-down gap is polish — but it's polish on exactly the
investigation path the new state was built to support.

---

## Summary

| # | Severity | Surface | Issue |
|---|----------|---------|-------|
| F1 | P2 | `ObserverPanel.tsx` L162 | "Reviewed (skipped N)" — noun + actor ambiguous, "skipped" reads as error |
| F2 | P2 | `FindingsLog.tsx` L121 | "schema mismatch — review may be stale" — "stale" mis-describes safety posture (temporal vs protocol) |
| F3 | P3 | `ObserverPanel.tsx` L153 | "Review stalled" — honest copy but no next-step affordance |
| F4 | P3 | `observer-panel-state.ts` L87 | 300s correct numerically, but title-alert channel doesn't reach an absent user; consider title-alert inclusion or soft pre-alert |
| F5 | P3 | `ObserverPanel.tsx` L158-166 + deriver L121 | `droppedCheckpointIds` carried through state but not surfaced — summary without drill-down |

All five are copy / cadence / drill-down findings — no code changes
proposed (stay in UX lane). The fix-pass closed the structural gaps
(states exist, exhaustive switches, wallclock-anchored cutover); these
five are the second-order UX-surface refinements layered on top.

Two of the five (F1, F2) are P2 because they mis-communicate
safety-relevant policy on the exact paths the fix-pass intended to
make trustworthy. Friedman principle 9 — trust breaks fast — applies
to both.
