# Fowler — Refactoring Regression Review

Scope: regression pass on the fix-pass that closed 24/25 findings from the 2026-05-13-0100 review. Re-evaluating P3 #25 (orchestrator size watchpoint) plus three specific structural questions about new fix-pass artefacts (`ANNOUNCED_FINDING_IDS_BY_SCOPE`, `councilGroupBySessionId`, `dispatchObserverWake`). EC-1..EC-12 / AP-1..AP-3 / prior FINAL-REVIEW.md findings excluded by rule.

Economic test applied throughout: **"Will this slow us down in the next few weeks?"** Where the answer is "not yet" the severity drops or the finding is omitted.

---

## P2 — Fix Soon

### F-1. `dispatchObserverWake` has three near-identical "queue into pendingCheckpoint" arms — extract `enqueuePending(reason)`

**Files:** `web/server/session-orchestrator.ts:1384-1411` (reconnecting), `:1530-1561` (busy), `:1575-1607` (backpressure)

The fix-pass added a new `reconnecting` arm at the head of `dispatchObserverWake` (per prior #3) and a new `backpressure` arm in the bridge-outcome switch (per prior #17). Combined with the pre-existing `busy` arm, the dispatcher now contains **three** structurally identical blocks that:

1. Capture `entry.pendingCheckpoint` into `prior`.
2. If `prior` exists, emit the same `council.checkpoint.superseded` EC-9 log line with the same 6-key field set, then push `prior.checkpoint_id` onto `supersededCheckpointIds`.
3. Assign `entry.pendingCheckpoint = payload`.
4. Build a `WakeDispatchOutcome` with `kind: "skipped"`.
5. Emit `group.observer_wake_skipped` with `queued: true` plus a reason-specific suffix.

Each arm is ~25 LOC; the three together are ~75 LOC of near-duplicate sequence. The reason-specific differences are exactly two fields per arm: the `reason` string and one optional context key (`groupStatus`, `bufferedAmount`, or none).

Why this fires the economic test, not just hygiene:

- The next time someone adds a fourth "try again later, same group" gate (e.g. observer adapter mid-restart, or a future per-pairing rate-limit), they must remember to duplicate **five** correlated steps in a fourth arm or the audit trail diverges silently. The fix-pass already shows this risk materialised — the reconnecting arm copies the busy arm's logic but does NOT include the `groupStatus: "reconnecting"` field as a separate code path; it's hand-replicated.
- The shared-shape `superseded` log invariant ("if we drop a queued checkpoint, name BOTH ids") is now spread across three callsites. Future EC-4 review will need to inspect three places instead of one.
- Tests for the three paths likely cover the happy path but cannot easily assert "all three arms have identical superseded-log shape" without an extraction.

**Recommendation:** Extract a sibling helper inside the same class:

```
private enqueuePendingCheckpoint(
  entry: CouncilWatcherEntry,
  sessionGroupId: string,
  observerSessionId: string,
  payload: CheckpointPayload,
  reason: "observer_busy" | "backpressure",
  extraContext?: Record<string, unknown>,
): WakeDispatchOutcome
```

State-mutation visibility (Carmack/Fowler P2): the helper keeps the mutation visible and named — `entry.pendingCheckpoint = payload` stays in one place — and the sequential reading order at each caller is `enqueuePendingCheckpoint(...)` followed by `return`. The pure log-payload assembly moves into the helper; the impure write is single-sourced.

Severity: **P2**. The duplication is structural, was just compounded by the fix-pass (3 sites instead of 1), and is in a hot lifecycle path. Adding a fourth gate before extraction will be visibly harder than after.

---

## P3 — Consider

### F-2. `ANNOUNCED_FINDING_IDS_BY_SCOPE` Map has a wired observation point but no wired cleanup — JSDoc defers to "future"

**File:** `web/src/components/council/FindingsLog.tsx:39-50`

The fix-pass replaced the previous per-mount `useRef` coalescer with a module-level `Map<string, Set<string>>` keyed by `announcerScope` (typically `sessionGroupId`). This is the correct shape — collapsing/re-expanding the panel must not re-announce findings — and it's NOT a Fowler P3 "Global Data" violation in the dangerous sense, because:

- It's scoped per `sessionGroupId`, so cross-group bleed is impossible by construction.
- Reads and writes are both inside a single `useEffect`, so there's no fan-out mutation surface.
- It's append-only within a scope, so concurrent-mutation hazards don't apply.

What IS the structural concern: the JSDoc at line 44-48 explicitly states "future cleanup belongs in the council slice's `removeGroup` if accumulation becomes a concern" — and `removeGroup` exists today (`web/src/store/council-slice.ts:222`, called from `web/src/ws.ts:1195` on `group_exited`). The hook to clean the Map exists; the cleanup just isn't wired. So the comment is **describing-not-enforcing** — exactly the pattern flagged in memory `feedback_council_documented_contract_canary`.

This is bounded (each Council group accumulates at most a few hundred finding ids; a tab lifetime of dozens of groups gives kilobytes of retained `Set` entries), and finding ids are short strings, so memory is not the issue. The issue is the **invariant drift surface**: a future reader who sees the module-level Map and asks "where does this get freed?" finds the JSDoc, sees the answer "future work", and either (a) wires the cleanup ad-hoc somewhere that desynchronises from `removeGroup`, or (b) assumes it's intentional and never wires it. Both outcomes are slower in a future refactor than wiring it now.

**Recommendation:** Either (a) actually wire `ANNOUNCED_FINDING_IDS_BY_SCOPE.delete(sessionGroupId)` into the slice's `removeGroup` and tighten the JSDoc to "cleared on `removeGroup`", or (b) replace the JSDoc's conditional "if accumulation becomes a concern" with a concrete bound and assertion (e.g. "never freed; bounded by O(groups-per-tab-lifetime × findings-per-group)") so the contract isn't aspirational.

Severity: **P3**. Will not slow us down in the next few weeks; will slow someone down the first time they need to reason about FindingsLog memory or correctness across a long-lived tab.

---

### F-3. `councilGroupBySessionId` doubles state across two Maps — all three mutation sites are paired today, no NEW gap, but the invariant should be expressed in code

**Files:** `web/server/session-orchestrator.ts:366` (declaration), `:820-821` + `:1934-1935` (writes paired with `councilGroupMeta.set`), `:1013-1017` (deletes paired with `councilGroupMeta.delete`).

Reviewed all three sync sites; the discipline is correct:

- Both `set` sites pair `councilGroupBySessionId.set(...)` immediately after `councilGroupMeta.set(...)` in lockstep, same scope, no intervening async boundary.
- The single `delete` site reads `exitedMeta` from `councilGroupMeta` BEFORE deleting from `councilGroupMeta`, so the IDs needed for the reverse-index delete are still in hand. Order is correct.
- `grep` confirms there is no fourth mutation site that escapes the pattern (only one read site for the bus listener, which is the whole reason the reverse index was added per prior #21).

This is the **right doubling** — O(1) lookup at hot bus-listener path beats the O(active-groups) iteration over `councilGroupMeta` the prior pass flagged. Not a regression.

What I would suggest, but at P3 (not flagging as a finding-to-fix): the invariant "the two maps stay in sync" is currently maintained by discipline at three callsites; the type system doesn't enforce it. A small encapsulator (`setCouncilGroup(meta) / deleteCouncilGroup(sessionGroupId)` private methods that update both maps as a unit) would convert the discipline into a structural guarantee. But this is hygiene, not a velocity blocker — three callsites is comfortably within the "fan out beyond ~3 sites" threshold from refactoring.md Principle 3.

**No structural finding to fix.** Recording as a watchpoint: any future fourth write/delete callsite added to `councilGroupBySessionId` should trigger the encapsulator extraction.

---

## Watchpoints (no action)

### W-1. session-orchestrator.ts size — the fix-pass did NOT trip a new economic-test threshold

The file is ~2705 LOC total; ~1100 LOC of that is council-specific surface (dispatcher + checkpoint + review + reconcile + scan + listener wiring). The fix-pass added approximately +150 LOC of council code: `scanForMissedObserverWakes` (~60), reverse-index plumbing + 3 sync sites (~10), `reconnecting` gate arm in dispatcher (~28), wake-version-mismatch branch in `handleCouncilReview`, sentinel cleanup in `group:exited` (~22), exhaustive `default:` arm with `never` check (~14), and call-site for `scanForMissedObserverWakes` in `initialize`.

Apply the economic test: is the **fix-pass's incremental contribution** what will slow us down? The additions are:

- **Additive-cohesive**: each new branch sits adjacent to its sibling cases (a new bridge-outcome arm next to existing bridge-outcome arms; a new gate arm next to existing gates). None introduce a new concern the file didn't already own.
- **Locally testable**: the 17 new tests in the two new test files (per Beck dispatch) pin the new branches directly.
- **Type-discipline-tight**: the new exhaustiveness `never` checks (EC-10) at the dispatcher tail and at `StatusPill`/`DowngradedChip` actually make future additions **easier** to land safely, not harder. Static-analysis carry-over from Carmack's third principle.

The legacy P3 #25 watchpoint stands — the file remains a god-module with the same four-ish concerns (session lifecycle, council, container/worktree, watchdogs) that prior pass observed — but **the fix-pass itself did not push past a new threshold**. The natural extraction boundary (a `CouncilOrchestrator` mixin or class that owns the council surface and is composed into `SessionOrchestrator`) is the same shape and same priority as before. Flagging it again would be restating P3 #25.

### W-2. ObserverPanel clock-tick `setInterval` cleanup — correct as written

Verified `useEffect` at `web/src/components/council/ObserverPanel.tsx:251-255`:

- Guard `if (!isReviewingNow) return;` prevents the interval from arming when not in `reviewing`.
- Returned cleanup `clearInterval(handle)` fires on dep-change AND unmount.
- Dependency `[isReviewingNow]` correctly toggles the interval as `reviewing` ↔ other states.
- `void clockTick` reference at line 258 keeps lint quiet without leaking the value.
- 1000 ms cadence is appropriate for the wallclock-anchored `reviewing-stalled` transition past `wakeTimeoutMs` (default 300 s — a 1 s tick is sub-percent overhead).

No structural concern. EC-11 idiom correctly applied.

---

## Summary

| Finding | Severity | New from fix-pass? |
|---------|----------|---------|
| F-1 dispatchObserverWake three duplicated queue-pending arms | P2 | Yes (reconnecting arm added in fix-pass, backpressure rerouted from drop to queue in fix-pass — 3-way duplication is new) |
| F-2 ANNOUNCED_FINDING_IDS_BY_SCOPE deferred-cleanup contract | P3 | Yes (Map itself was added in fix-pass; cleanup gap is the new structural surface) |
| F-3 councilGroupBySessionId doubling | Watchpoint only | Confirmed correct at all 3 sites; not flagging |
| W-1 orchestrator size | Watchpoint (restates P3 #25, not a new finding) | No |
| W-2 ObserverPanel clock-tick | OK | No structural concern |

Two NEW structural findings (one P2, one P3) emerged from fix-pass-specific additions. The size watchpoint persists but the fix-pass's contribution is additive-cohesive and does not warrant escalation.
