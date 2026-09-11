# TASK: Solo-session lifecycle state machine (Fowler F5 — deferred from Council Review 2026-09-11-0829)

**Severity:** P2 (structure, not a correctness bug)
**Origin:** `/council-review-aura` 2026-09-11 — Fowler finding F5. Deferred out of the
`fix/council-lifecycle-hardening-findings` PR by explicit decision: bundling a large rewrite
of the incident-prone lifecycle core with correctness fixes going to prod would undermine
the stability goal. Ship it as its own focused PR with isolated validation.

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
