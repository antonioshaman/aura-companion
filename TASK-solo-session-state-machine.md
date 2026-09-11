# TASK: Solo-session lifecycle transition table (Fowler F5 — remaining half)

**Severity:** P3 (the cohesion win landed; this is the enforcement upgrade)
**Origin:** `/council-review-aura` 2026-09-11 — Fowler finding F5.

**STATUS UPDATE (2026-09-11):** the **encapsulation half is DONE** — the five scattered
relaunch/keepalive fields now live in one cohesive owner, `SoloRelaunchLifecycle`
(`web/server/solo-relaunch-lifecycle.ts` + unit test), with intention-revealing methods, and
the orchestrator drives them through that object (behavior-preserving; 218 orchestrator tests
green unchanged). What remains is the **transition-table enforcement** described below — the
guard that makes invalid orderings *impossible* rather than merely cohesive.

## Problem

Solo-session lifecycle in `web/server/session-orchestrator.ts` is smeared across ~9
uncoordinated `Set`/`Map` fields whose cross-field ordering invariants are enforced ONLY by
comments:

- `relaunchingSet`, `autoRelaunchCounts`, `relaunchExhaustedNotified`, `intentionalKills`,
  `keepaliveTimers`, `silenceRecurrenceCounts`, `spawnCheckpointPending`,
  `spawnCheckpointPollsInFlight`, `catchupWakesInFlight`.

Invariants currently living in prose (each references a prior prod incident):
- "mark `intentionalKills` BEFORE the SIGTERM" (else the old proc's `session:exited` arms the
  council reconnect timer → transient `reconnecting → active` UI flicker).
- "clear in the `finally` or keepalive is locked out" (a stale `intentionalKills` mark blocks
  ALL future keepalive for that session).
- "use `has()` not `delete()`" in specific spots.
`handleAutoRelaunch` alone mutates four of these in ordering-critical steps.

The group side got `group-state-machine.ts` (AP-2, pure `transition(state, event)`); the solo
side never did — and this is the exact surface the 2026-09 churn kept re-patching (relaunch
flicker, wedged keepalive, deaf-but-alive PID).

## Recommended approach

Introduce an explicit solo-session lifecycle state machine mirroring `group-state-machine.ts`:
a pure `transition(state, event)` over `{ idle | relaunching | cooling-down | exhausted |
intentional-kill }`, and collapse the scattered `Set`/`Map`s into its state so ordering
invariants are enforced by construction, not comment discipline.

Alternative lower-risk intermediate (if a full transition table is too big a step): extract a
`SoloSessionLifecycle` helper class that OWNS the 9 fields and exposes intention-revealing
methods (`beginRelaunch`/`endRelaunch`, `markIntentional`/`clearIntentional`/`isIntentional`,
counter get/bump/reset, timer arm/clear) with the ordering invariants baked into the methods —
a pure encapsulation that preserves control flow.

## Related (already shipped in the sibling PR)

- Fowler F1: `relaunch()` now routes every exhaustion return through the single
  `abortRelaunch(sessionId, reason, error)` tail (`cli-launcher.ts`), making the
  clearPidAndPersist obligation structural. The solo-orchestrator state machine is the
  remaining half.

## Acceptance

- No behavior change to the existing relaunch/keepalive/silence-rotation flows (the existing
  `session-orchestrator.test.ts` + `cli-launcher.test.ts` suites stay green unchanged).
- Ordering invariants become code (method preconditions / transition guards), not comments.
- Add unit tests for the pure transition table (mirror `group-state-machine.test.ts`).
