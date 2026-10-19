# Kent Beck — Test Quality Review

Scope: 6 modified test files + the source surface they cover (observer-prompt builder/wrapper, claude-adapter `sendUserFrameFromServer`, session-orchestrator `dispatchObserverWake`/`drainPendingObserverWake`, council-wake-sentinel, observer-panel-state ladder, FindingsLog cadence response).

Stack: Vitest 4 + vitest-axe 0.1 + @testing-library/react 16. Pre-commit hook runs typecheck + tests. CLAUDE.md mandate: render + axe + interactive triad on every component test.

I do NOT re-flag AP-1..AP-3 or EC-1..EC-9 (per dispatch instruction).

---

## P1 — Fix Now

### P1-B1. The keystone `dispatchObserverWake` has zero direct behavioural tests

**File:** `/root/aura-companion/web/server/session-orchestrator.ts` (dispatcher, ~lines added in Task 3) — NOT covered by `/root/aura-companion/web/server/session-orchestrator.test.ts`.

**Evidence:**
```
$ grep -n "dispatchObserverWake\|WakeDispatchOutcome\|skip_reason" web/server/session-orchestrator.test.ts
(zero hits)
```

The dispatcher is the single point where 5 gates collapse into one of **8 discriminated `WakeDispatchOutcome` variants** (`sent` / 7 skip reasons per the context brief). Every outcome lands in an EC-9 log line. The brief calls this "the keystone for testability" — and there is no keystone test.

What exists today:
1. A static-grep canary in `observer-prompt.test.ts` (lines 436-451) asserting the call site is reachable from `handleCouncilCheckpoint`. This proves *only* mechanical reachability — see Principle 11 (Behavioural property): it would still pass on `dispatchObserverWake() { /* return; */ }`.
2. Builder-only tests (`buildObserverWakePayload`, lines 232-385) covering the format-transformation boundary but never traversing Gate 0 (sentinel idempotency), Gate 1 (group-status=active per AP-2), or Gate 3 (bridge send).
3. Producer-side `handleCouncilCheckpoint` tests (`session-orchestrator.test.ts:2018-2128`) — 4 tests, all written *before* the dispatcher landed. They assert `lastCheckpoint`, `previousCheckpoint`, `emitted` array length — none touch the new `this.dispatchObserverWake(…)` call site.

**Consequence (concrete):**
- A refactor that adds a 9th outcome and forgets to wire its EC-9 log line ships green.
- A refactor that swaps Gate 1 from "group-status=active" to "group-status≠archived" silently flips the contract (now wakes during `reconnecting`) — green.
- A regression where Gate 0's sentinel idempotency check is dropped (the EC-8 invariant) — green.
- The only assertion that the 5 gates fire in order and produce the 8 documented outcomes is **the source code itself**. There is no mutation-resistance proof. By Principle 6 (mutation resistance) and Principle 4 (test what might break), this is the highest-risk untested surface in the changeset.

**Plan-stated mitigation:** "the dispatcher integration (Task 3) is exercised through the existing `session-orchestrator.test.ts` patterns" (comment at `observer-prompt.test.ts:225-230`). This is **false**: I grepped — `dispatchObserverWake`, `WakeDispatchOutcome`, and `skip_reason` have zero hits in `session-orchestrator.test.ts`. The comment is aspirational. **Severity P1 — this is mock-built-never-injected applied to the test table itself** (cross-ref memory `feedback_verify_test_bodies_not_just_names`).

**Specify (what should land):** a `describe("dispatchObserverWake")` block in `session-orchestrator.test.ts` with one happy path (`outcome: "sent"`) plus 7 skip-reason rows in an `it.each` table, each asserting (a) the `WakeDispatchOutcome` discriminator, (b) the EC-9 log emission (or absence), (c) the sentinel mutation (or absence). Use `expect(outcome).toEqual({type: "skipped", reason: "<literal>"})` — no `objectContaining` shortcuts (cross-ref memory `feedback_static_grep_canary_regex_over_substring`'s sibling principle: literal outcomes for discriminated unions).

---

### P1-B2. No dedicated test file for the NEW `council-wake-sentinel.ts` module

**File:** `/root/aura-companion/web/server/council-wake-sentinel.ts` (Task 6, NEW, ~150 LOC).

**Evidence:**
```
$ ls web/server/council-wake-sentinel*
council-wake-sentinel.ts        # source only
# no .test.ts sibling
```

This is the EC-8 sentinel-before-sweep helper for restart idempotency. It owns:
- per-group sidecar `.council/state/<groupId>-wake.json`
- `writeAtomicJson` round-trip semantics
- the restart-recovery contract that prevents double-wakes

By Principle 4 (Beck's economics) — testing effort should match risk. A new module that gates a load-bearing restart invariant with **zero** dedicated tests inverts the economics. Memory `feedback_recovery_branch_reachability` says it directly: "Recovery/error/fallback branches могут ship зелёные но быть структурно недостижимы в runtime."

**Consequence (concrete):**
- A malformed sentinel file (truncated, wrong schema version, missing field) silently fails to load → restart wakes the observer twice for the same checkpoint. No test guards.
- The atomic-write contract (tmp+rename+fsync) has no per-module regression test; if a refactor uses `writeFileSync` directly, no test catches it.
- The sidecar path resolution has no realpath-containment test (Hunt's domain notwithstanding — Beck's domain is whether *any* test exists).

**Specify (what should land):** `council-wake-sentinel.test.ts` with at minimum (a) round-trip write→read, (b) reject malformed JSON, (c) reject wrong schema version (mirror the existing `parseObserverPromptHeader` table at `observer-prompt.test.ts:42-60`), (d) read-when-absent returns the "no prior" sentinel, (e) atomic-rename canary (write throws between tmp creation and rename — read still returns prior value).

---

### P1-B3. `sendUserFrameFromServer` adapter method has zero direct tests

**File:** `/root/aura-companion/web/server/claude-adapter.ts` (Task 2, new method + `observerTurnState` field).

**Evidence:**
```
$ grep -c "sendUserFrameFromServer\|observerTurnState" web/server/claude-adapter.test.ts
0
```
Source file `claude-adapter.ts` was modified May 13 00:29; test file `claude-adapter.test.ts` last touched May 8 13:41 — the test file pre-dates this change by 5 days.

The context brief documents 3 strict gates (turn-state, transport, backpressure) + a post-stringify `\n` assertion + NDJSON line-discipline tripwire — i.e. **5 outcomes** the dispatcher branches on (`sent` / `busy` / `socket_disconnected` / `backpressure` / `failed`).

The reviewer prompt asks: "Or are they covered indirectly via integration?" Answer: **no**. There is no integration test in either `ws-bridge.test.ts` or `session-orchestrator.test.ts` that exercises the new method — the integration path doesn't exist yet (see P1-B1, the dispatcher is also untested).

Cross-reference Principle 9 (recording-based replay tests): "No replay test on `claude-adapter.ts` — the adapter is the protocol translation layer; replay is its native test mode. Severity: P1." This was already a P1 floor; the new method extends the untested surface without paying it down.

**Consequence (concrete):**
- The post-stringify `\n` assertion is the only thing preventing a future refactor from breaking NDJSON line-discipline (one missing newline → CLI parser drops every frame after it). No test guards.
- The turn-state state machine (`idle ↔ in-flight`) flips on the result frame; if a future refactor misses the flip back to idle, the dispatcher's Gate 0 starts permanently rejecting wakes as `busy`. No test guards.
- The 5 outcomes have no mutation-resistance proof; collapsing any two into one (e.g. `backpressure` → `failed`) is undetectable.

**Specify:** `describe("sendUserFrameFromServer")` block in `claude-adapter.test.ts` with `it.each` over the 5 outcomes. For `sent`, assert the serialised bytes are exactly `JSON.stringify(payload) + "\n"` (literal, not `expect.stringContaining`). For `socket_disconnected` + `backpressure`, simulate via a mock socket exposing the readyState/bufferedAmount surface — these are at the system boundary per Principle 3, mocking is justified here.

---

## P2 — Fix Soon

### P2-B1. EC-6 wake-frame fixture: planned, not landed

**Plan:** the context brief lists "EC-6 fixture for the wake frame" as a deliverable. **Reality:** no `.jsonl` recording or test referencing one was added:

```
$ grep -rln "wake.*recording\|recording.*wake\|council-wake.*jsonl" web/ tests/
(zero hits in web/ outside source files themselves)
```

The only wake-related fixture in the repo is `.council/checkpoints/manual-wake-aura-rebrand.json` — a *checkpoint* artefact, not a recorded NDJSON wake frame round-trip. By Principle 9 + EC-6: load-bearing protocol parsers require replay-based regression tests. The wake frame is now a load-bearing protocol parser (it's a *producer*, and the observer's CLI parser is the matching *consumer*).

**Consequence:** if Claude Code CLI tightens its `user` frame schema in a future release, no replay test will catch the drift. The closest existing proxy — `buildObserverWakePayload` line 246 — pins the *body structure* with literal `startsWith`/`toContain` assertions but is a build-side unit test, not a wire-replay test.

**Specify:** capture one real wake frame via the recorder (`COMPANION_RECORD=1`, drive an actual council pair through one checkpoint), pin it as a fixture under `web/server/__fixtures__/council-wake/`, and add a replay test that parses it through whatever the observer-side reader is (currently the Claude Code CLI itself — see Realtime/NDJSON expert for the seam). Alternative if the consumer is opaque: a producer-only round-trip (serialise → parse via `JSON.parse` of the line → assert structural equality with `buildObserverWakePayload` output).

---

### P2-B2. Concurrent-call test (Beck Council Rec 3) for `handleCouncilCheckpoint` not written

**Plan:** "Concurrent-call test for handleCouncilCheckpoint with Promise.all keyed by sessionGroupId (Beck Council Rec 3)."

**Evidence:**
```
$ grep -n "Promise\.all\|concurrent" web/server/session-orchestrator.test.ts
(zero hits)
```

Cross-reference memory `feedback_parallel_test_fakes_keyed_by_input` — exactly this canary: parallel-async test fakes keyed by input id, not call counter. The existing `handleCouncilCheckpoint` tests (`session-orchestrator.test.ts:2025-2128`) are **all sequential single-call** — they never exercise the per-group isolation invariant.

**Consequence:** if a refactor accidentally shares a counter-like cursor across groups (e.g. last-seen-sequence stored at the orchestrator level instead of per-group), all 4 existing tests pass — they only ever hit one group. A `Promise.all([handle.call(orch, "grp_a", payload_a), handle.call(orch, "grp_b", payload_b)])` test would have caught it.

**Specify:** add an `it("isolates sequence tracking per sessionGroupId under concurrent calls", async () => {…})` test in the `handleCouncilCheckpoint` describe block. Seed two watchers (`grp_a` and `grp_b`), fire two `handle.call(…)` from inside `Promise.all`, assert each group's `lastCheckpoint` reflects its own payload — not the other group's.

---

### P2-B3. The static-grep canary at `observer-prompt.test.ts:436-451` is acceptable but the call-site comment overpromises

The canary itself uses regex with `\w+`-style escape (`/this\.dispatchObserverWake\s*\(/`) — that part is correct per memory `feedback_static_grep_canary_regex_over_substring`. **Good.**

But the surrounding comment block (lines 224-230) says:
> "The dispatcher integration (Task 3) is exercised through the existing `session-orchestrator.test.ts` patterns; here we pin the producer-side invariants in isolation…"

This statement is structurally false (P1-B1 above) and worse: future readers grep for "dispatcher integration" → find this comment → conclude coverage exists → don't add the missing tests. By Principle 10 (AI agents cheat — the spec is the constraint) and the memory `feedback_council_documented_contract_canary`: contract in comment ≠ enforcement. The comment is doing the job of the test. **Update the comment to admit the gap until P1-B1 lands**, otherwise it's a future-confusion canary.

---

### P2-B4. FindingsLog summary announcer test is silent on idempotence — the load-bearing claim is undertested

**File:** `/root/aura-companion/web/src/components/council/FindingsLog.test.tsx` lines 108-121.

The test name says "summarizes new findings into a single polite announcer per review event" and the inline comment (lines 115-118) explicitly states:
> "The summary string is the single source of truth — same findings re-rendered MUST NOT re-announce (lastIdsRef captures previously seen ids)."

But the test body **never re-renders with the same findings to verify**. It does one `rerender` from `[]` → `[stop, note]` and asserts the announcer's text. There is no second `rerender(<FindingsLog findings={[stop, note]} />)` followed by an assertion that the announcer's text did not change (or that the `lastIdsRef` mechanism short-circuited).

By Principle 6 (mutation resistance): a refactor that drops the `lastIdsRef` guard and re-runs the announcer on every render would pass this test green — the assertion only checks `.toContain("1 blocker")`, which is true the second time too. The test name promises what the body does not deliver.

**Consequence:** the cadence-aware a11y response (the entire point of Task 12) regresses silently if the dedup guard is dropped — SR users flood again, but no test fires red.

**Specify:** extend the test to perform a second identical `rerender`, capture the announcer's text content + a `data-render-tick` test-id (or use a render-counter ref), and assert idempotence. Alternative if testid is too invasive: rerender with the same findings, then rerender with an *added* finding, and assert the announcer's text changed exactly on the third rerender — not the second.

---

### P2-B5. ObserverPanel `nowMs` fixture update is correct but the test for `reviewing-stalled` is missing from this file

`/root/aura-companion/web/src/components/council/ObserverPanel.test.tsx:123-134` passes `nowMs={3_000}` for the `reviewing` state — good, keeps the window-defined test deterministic per memory `feedback_parallel_test_fakes_keyed_by_input`'s sibling principle (deterministic-clock fixtures over wallclock).

But the new `reviewing-stalled` and `queued-dropped` ladder states (Task 11) are tested **only** at the pure-deriver layer (`observer-panel-state.test.ts:152-184`). There is no `ObserverPanel.test.tsx` integration test asserting:
- the `reviewing-stalled` state pill renders with the expected `data-state="reviewing-stalled"` attribute,
- aria-busy flips off (it's past the deadline; the observer is presumed-stuck, not in-flight),
- axe passes on the stalled state.

By Principle 7 (Aura a11y triad): component tests must verify post-state-change accessibility. The deriver test proves the *logic* is correct; the component test proves the *render* honours the logic. Both are needed; one is missing.

**Consequence:** if the JSX template's `data-state` mapping or aria-busy logic regresses for `reviewing-stalled` (e.g. mis-keyed switch case falls through to `reviewing`), no test fires red.

**Specify:** add 2 tests to `ObserverPanel.test.tsx`: one for `reviewing-stalled` (seed group with `observerReviewing: true`, `wakeTimeoutMs: 90_000`, `lastCheckpointAt: 0`, then `nowMs: 200_000`) + axe scan; one for `queued-dropped` (seed group via `appendObserverReview` with non-empty `supersededCheckpointIds`) + axe scan. Both follow the existing accessibility-section pattern at lines 310-353.

---

### P2-B6. `findUnresolvedStops` empty-input branch tested 3 ways; `recentlySupersededCheckpointIds` priority untested

`observer-panel-state.test.ts:53-70` has **4 tests** for the empty/no-STOP early-return branch (empty list, no STOPs, all dismissed, all downgraded). Two are sufficient by Principle 4 (test as little as possible). The other two add maintenance load with no incremental signal.

Meanwhile, **the priority interaction** between `recentlySupersededCheckpointIds` and `observerReviewing` is untested: what if both are set (a review just landed *and* a checkpoint got superseded by a newer one mid-turn)? The ladder says `queued-dropped` only fires when reviewing isn't active — but the test at line 169-184 sets neither `observerReviewing` nor a `lastCheckpointAt`-within-window scenario. The interaction is not pinned.

**Consequence:** if a refactor swaps the priority of `queued-dropped` vs `reviewing` (a real risk — both touch `recentlySupersededCheckpointIds` flows), the deriver returns the wrong state and no test catches it.

**Specify:** add one test that sets both `observerReviewing: true, wakeTimeoutMs: 90_000` AND `recentlySupersededCheckpointIds: [...]` simultaneously, and asserts the ladder pick (currently `reviewing` should win per the brief's priority ladder degraded > blocker > reconnecting > reviewing > spawning > sleeping > queued-dropped > never-checkpointed-yet — confirm with source).

---

## P3 — Consider

### P3-B1. `expect(handlerStart).toBeGreaterThan(0)` in the static-grep canary

`observer-prompt.test.ts:444` — `expect(handlerStart).toBeGreaterThan(0)`. By Principle 6 (assertions ARE the test): on a file that doesn't contain `"private handleCouncilCheckpoint("`, `indexOf` returns `-1`, which is `<= 0`. So the assertion correctly catches "the method was renamed." But if the method moved to character offset 0 (impossible in practice — class body starts later), the assertion is wrong; should be `>= 0` for technical correctness OR `.not.toBe(-1)` for intent clarity. Cosmetic — flag, don't fix.

### P3-B2. `recorder.test.ts:78` version-bump assertion uses literal `2` — good

The bump from `version: 1` to `version: 2` is asserted as a literal (`expect(header.version).toBe(2)`) with an inline comment documenting the schema bump rationale. By Principle 10 (expected values from implementation): this is acceptable because the comment makes the rationale auditable. No change needed. Noting for completeness.

### P3-B3. `observer-prompt.test.ts:140-148` "in-repo prompt artifact" canary is excellent

This is the *right* shape of canary: a test that the on-disk artefact loads cleanly via the loader. Cross-ref memory `feedback_running_build_vs_disk_build` — closes the "running build ≠ on-disk source" failure mode for the prompt artefact specifically. Worth replicating for `observer-system.md`'s `observer_wake_payload_version_echo` field whenever a similar contract lands. Promote as a pattern. Noting for the codebase-facts knowledge file.

---

## Summary

- **2 P1 ship-blockers from missing test files**: `dispatchObserverWake` and `council-wake-sentinel.ts` are both unguarded.
- **1 P1 ship-blocker from stale test file**: `claude-adapter.test.ts` does not cover the new `sendUserFrameFromServer` (5 outcomes, NDJSON tripwire, turn-state).
- **6 P2** — the EC-6 wake-frame fixture is planned-not-landed; the concurrent-call test (Beck Council Rec 3) is unwritten; the static-grep canary is correctly-regexed but its comment overpromises; the FindingsLog announcer test undertesting idempotence; the new ladder states untested at the component layer; the priority-interaction between `queued-dropped` and `reviewing` unpinned.
- **3 P3** — minor canary polish + one positive pattern worth promoting.

The producer-side pure tests in `observer-prompt.test.ts` are **strong** — F4 happy/sad tables, literal `toEqual` assertions, deterministic sha256 round-trip, EC-7 wrapper symlink test, and the static-grep canary uses the regex placeholder idiom per memory rule. That part of the work is the example to follow. The gap is everything one layer up the stack: the dispatcher, the adapter, the sentinel module — the three pieces that together make the wake actually fire in production. The test pyramid currently has a strong base, an empty middle, and a thin a11y cap.

Beck's overriding filter Q3: "Is the highest-risk surface tested with realistic input?" Today: no. `dispatchObserverWake` is the highest-risk surface, and recordings are the answer.
