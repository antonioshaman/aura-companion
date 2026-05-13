# Council Regression Review (Aura): Observer Auto-Wake fix-pass — commit 02e28c1

**Scope:** 30 files in commit `02e28c1` (24 fixes + 3 new files closing the 25 findings of `.council/review-output/2026-05-13-0100/FINAL-REVIEW.md`). Excludes pre-existing uncommitted changes in ChatView/Composer/SessionItem/etc., which are unrelated work.

**Context:** Second review pass on observer auto-wake. The fix-pass closed 22 of 25 prior findings cleanly. THREE prior findings either did not fully close or the fix introduced a new structural defect. Plus regression review found 16 NEW concerns of varying severity.

**Council dispatched (11):** Hunt, Fowler, Bun/Hono/TS Backend, FS-JSON Persistence, Realtime/NDJSON Protocol, Subprocess Lifecycle, React/Web UI, a11y Auditor, Friedman, Willison, Beck. Saarinen (no visual surface change) + Docker/GHA (no deploy surface) deliberately skipped.

---

## P1 — Fix Now

### 1. Wake-body directive instructs echo of the WRONG field name — mandatory-echo defence (#12) collapses every review to NOTE

| | |
|---|---|
| **File** | `web/server/observer-prompt.ts:288-289` (terminator sentence in buildObserverWakePayload) |
| **Council** | Willison × Carmack — Principle 8 (Context propagation — schema-name drift) |
| **Ref** | `references/quality-llm.md` → Principle 8 |

**Finding:** The wake body's directive terminator says *"Echo `observer_wake_payload_version`, `session_group_id`, `checkpoint_id`, and `phase` from the manifest verbatim."* But the schema field the parser checks is `observer_wake_payload_version_echo` (with `_echo` suffix). A conforming observer that follows the directive literally emits `observer_wake_payload_version: 1` in its review JSON, the parser silently ignores the unknown key, the schema's optional `observer_wake_payload_version_echo` is absent → the mandatory-echo defence (prior fix #12) downgrades EVERY finding in EVERY review to NOTE.

**Consequence:** STOPs become NOTEs across the board. The user sees observer reviews that all read as "informational" — no blockers, no warnings ever surface. The `wake_version_mismatch` downgrade reason is correctly applied; the orchestrator dispatcher correctly logs `observer.schema_mismatch`; but the silence is wrong because the prompt + body are misaligned, not the observer.

**Fix:** Change the wake-body terminator to direct echo of `observer_wake_payload_version_echo` (with the `_echo` suffix). Pair with a parser-side assertion test that a wake body produced by `buildObserverWakePayload` followed-literally by an observer would yield a passing review. The system prompt's output spec already uses the correct field name; the wake-body directive is the lone drift.

---

### 2. `dispatchObserverWake` keystone STILL has no direct behavioural test table

| | |
|---|---|
| **File** | `web/server/session-orchestrator.test.ts` (no `describe("dispatchObserverWake", ...)` block); source at `session-orchestrator.ts:1211-1659` (10 outcome branches, 5 gates) |
| **Council** | Beck × Carmack — Principle 4 (test what might break — high-risk path untested) |
| **Ref** | `references/quality-testing.md` → Principle 4 |

**Finding:** The prior pass flagged this as P1 Beck #13 ("keystone surfaces zero direct tests — dispatchObserverWake, sendUserFrameFromServer, council-wake-sentinel.ts"). The fix-pass landed test files for SENTINEL and FIXTURE but NOT for the dispatcher itself — only a static-grep canary at `observer-prompt.test.ts:436-451` asserts the call site exists. The 10 outcome branches (dispatched + 8 skip reasons + failed) and 5 gates (sentinel, group_status, build_error, busy/disconnected/backpressure, send) have NO behavioural assertions.

**Consequence:** Every future change to the dispatcher carries silent-regression risk. A subtle gate-order bug (e.g. group_status skip running before sentinel check) is undetectable from the test suite. The fix-pass dispatcher gained 4 NEW branches (cross-group check, reconnecting-queue, backpressure-queue, exhaustiveness-default) and STILL has zero direct tests.

**Fix:** Add `describe("dispatchObserverWake", ...)` to `session-orchestrator.test.ts` with one `it()` per outcome row — explicit setup helpers (mirror `seedGroup`/`seedCheckpoint` patterns), injected `sendObserverWakeFrame` mock that can stage each `BridgeObserverWakeOutcome` variant, literal-value assertions on `WakeDispatchOutcome` returned + EC-9 log captured. Beck Council Rec 1 from the prior pass — re-state the requirement, it didn't land.

---

### 3. `sendUserFrameFromServer` adapter method STILL has no direct behavioural test

| | |
|---|---|
| **File** | `web/server/claude-adapter.test.ts` (no test for the 5 outcomes); source at `claude-adapter.ts:983-1057` |
| **Council** | Beck × Carmack — Principle 4 |
| **Ref** | `references/quality-testing.md` → Principle 4 |

**Finding:** Same class as #2. The adapter method has 5 distinct outcome variants (`sent`/`busy`/`socket_disconnected`/`backpressure`/`failed`) and ONE invariant added by fix #15 (markActivity unconditional). No test asserts any of them. The fix-pass added the `observerTurnState` resets to `detachWebSocket` and `handleTransportClose` — these are correctness-critical (closed prior P1 #2) — and there's no test for them either.

**Consequence:** A future refactor that breaks the `observerTurnState` reset, the markActivity ordering, or the NDJSON line-discipline assertion ships green.

**Fix:** Extend `claude-adapter.test.ts` with: (a) one test per `ObserverWakeSendOutcome` variant via staged mock `cliSocket` (readyState + getBufferedAmount + send stub); (b) `attachWebSocket` → `sendUserFrameFromServer` returns "sent"; (c) `detachWebSocket` then `handleResultMessage` — assert turn-state idle; (d) inbound `result` while NOT in-flight does NOT emit `observer:turn-done` event.

---

## P2 — Fix Soon

### 4. Reverse-index `councilGroupBySessionId` leaks when archive paths bypass `group:exited`

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:294-302` (Map declaration); cleanup only inside `group:exited` listener at :1015-1019 |
| **Council** | Backend × Carmack — Principle 3 (state minimisation; index discipline) |
| **Ref** | `references/quality-backend.md` → Principle 3 |

**Finding:** The new `councilGroupBySessionId` Map is populated alongside `councilGroupMeta` at 2 sites (createCouncilGroup, reconcileCouncilGroups) and cleaned only on `group:exited`. If a per-session archive/delete path mutates state directly without emitting `group:exited` (e.g., one half of the group archived independently of the other), the Map retains a stale `sessionId → groupId` mapping. The `observer:turn-done` listener then routes a stale sessionId to a non-existent groupId, causing the drain hook to silently no-op for what should be the survivor.

**Fix:** Add `councilGroupBySessionId.delete(sessionId)` to the per-session cleanup path that fires before group-level teardown (search for sites that touch `intentionalKills.add(...)` followed by `launcher.kill(...)`).

---

### 5. `attachWebSocket` does not reset `observerTurnState` — race window with stale-detach guard

| | |
|---|---|
| **File** | `web/server/claude-adapter.ts:108-121` (attachWebSocket); `:127-140` (detachWebSocket stale-socket guard) |
| **Council** | Subprocess × Carmack — Principle 2 (state-transition atomicity) |
| **Ref** | `references/quality-subprocess.md` → Principle 2 |

**Finding:** The fix-pass made `observerTurnState` reset to idle inside `detachWebSocket` and `handleTransportClose`. But `detachWebSocket` has a stale-socket guard at line 129 (`if (this.cliSocket !== ws) return;`) — if a NEW socket attaches BEFORE the old detach event fires, the guard skips the reset. The new socket inherits whatever `observerTurnState` the prior socket left behind, including `in-flight`.

**Consequence:** A race where socket A is mid-turn → socket B attaches (new CLI process) → socket A's close event fires LATE → stale-socket guard skips reset → state stays `in-flight` from socket A's turn → socket B is blocked from receiving wakes ("busy" forever).

**Fix:** Reset `observerTurnState = "idle"` at the TOP of `attachWebSocket` — the new socket is by definition a fresh turn. Pair with a test that races attach+late-detach against the prior socket.

---

### 6. Dispatcher arm duplication — three call sites mutate `pendingCheckpoint` with near-identical supersede-log code

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:1296-1315` (reconnecting case), `:1565-1585` (busy case), `:1602-1622` (backpressure case) |
| **Council** | Fowler × Carmack — Principle 2 (Extract Function — duplication compounds across cases) |
| **Ref** | `references/refactoring.md` → Principle 2 |

**Finding:** Three branches of `dispatchObserverWake` each do the identical "if prior pendingCheckpoint exists, push id to supersededCheckpointIds and log council.checkpoint.superseded, then overwrite pendingCheckpoint" sequence. ~20 lines repeated × 3. The fix-pass added the reconnecting and backpressure cases by copy-paste of the busy case.

**Consequence:** A future invariant change (e.g. cap on superseded list length, different log shape, sentinel-on-queue) requires three near-identical edits — exactly the shotgun-surgery smell Fowler P5 names. The duplication is fresh (1-day-old code), perfect time to extract.

**Fix:** Extract `enqueuePendingCheckpoint(entry, payload, observerSessionId, queueReason)` private helper that handles the supersede log + slot overwrite. Call from all three branches. The three reasons (`busy`/`reconnecting`/`backpressure`) become parameters to the log entry only.

---

### 7. Sentinel orphan on `group:degraded` (without `group:exited`)

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:983-1019` (group:exited listener does cleanup; group:degraded listener does NOT) |
| **Council** | FS-JSON Persistence × Carmack — Principle 3 (sentinel-before-sweep; orphan cleanup) |
| **Ref** | `references/quality-persistence.md` → Principle 3 |

**Finding:** Fix #16 deletes the sentinel on `group:exited`. But a group can transition to `degraded` without `exited` (one half died, group stays operable with surviving half). The sentinel for that group sticks around indefinitely — `.council/state/` accumulates degraded-group sentinels alongside the EXITED-group ones the fix already handles.

**Consequence:** Less severe than complete absence of cleanup (the prior P2 #16), but still accumulates over a long-running multi-group server. Hours-to-days lifecycle, not seconds.

**Fix:** Also call `deleteCouncilWakeSentinel` inside the `group:degraded` listener (the existing one in session-orchestrator.ts that broadcasts the wire frame). Mirror the same try/catch + WARN log pattern from #16. Mind: don't double-delete when `group:degraded` fires immediately followed by `group:exited` — ENOENT-tolerance already absorbs this.

---

### 8. `DowngradedChip` rationale visible only via `title` attribute — AT-silent

| | |
|---|---|
| **File** | `web/src/components/council/FindingsLog.tsx:130-138` (chip with `title={...}`) |
| **Council** | a11y × Carmack — Principle 5 (visible label; AT-discoverable affordance) |
| **Ref** | `references/quality-a11y.md` → Principle 5 |

**Finding:** The fix-pass extended `downgradeReasonHuman` to render reason text in `title={...}`. `title` is keyboard-AT-silent on most platforms (hover-only on desktop; Android TalkBack does read it; iOS VoiceOver reads on focus). A screen-reader user navigating the FindingsLog hears "downgraded" with no explanation; sighted-mouse users see the tooltip on hover; keyboard users see nothing.

**Consequence:** The new `wake_version_mismatch` reason (added by fix #19) — the most operationally-important of the three — is the LEAST visible. Users encounter mass-downgraded reviews with no clue why.

**Fix:** Replace `title` with `aria-label` on the chip element AND surface the human-readable reason inline as a visually-small but DOM-rendered text (e.g. small grey text after "downgraded"). Pair with a screen-reader test asserting the reason is announced.

---

### 9. "Reviewed (skipped N)" copy misleads — doesn't communicate WHAT was skipped or whether action is needed

| | |
|---|---|
| **File** | `web/src/components/council/ObserverPanel.tsx:161-167` (queued-dropped StatusPill copy) |
| **Council** | Friedman × Carmack — Principle 9 (trust through reasoning visibility) |
| **Ref** | `references/quality-ux.md` → Principle 9 |

**Finding:** The `queued-dropped` pill renders "Reviewed (skipped N)" — too implicit. The user doesn't know (a) what was skipped (checkpoints), (b) why (server's newest-wins queue), (c) whether action is required (no — those checkpoints are superseded), or (d) which checkpoints those were (the deriver exposes `droppedCheckpointIds` but the panel never surfaces them).

**Consequence:** First-time exposure: user reads "skipped" and wonders if they need to manually re-trigger something. The "Trust through reasoning" UX principle fails — the user has signal but no understanding.

**Fix:** Change pill to "Reviewed phase X (N earlier superseded)" or similar that names BOTH what was reviewed AND what was deliberately dropped. Add a tooltip or expand-button that surfaces the `droppedCheckpointIds` for drill-down. The data is already on the deriver output; surfacing it is one component change.

---

### 10. "Review stalled" copy doesn't communicate WHAT triggered or next action

| | |
|---|---|
| **File** | `web/src/components/council/ObserverPanel.tsx:144-156` (reviewing-stalled StatusPill copy) |
| **Council** | Friedman × Carmack — Principle 6 (disabled controls explanation) |
| **Ref** | `references/quality-ux.md` → Principle 6 |

**Finding:** "Review stalled · {phase}" surfaces only that something is wrong. The user doesn't learn: was the wake send refused? Did the observer hang? Should they manually relaunch? With 300s `wakeTimeoutMs` (fix #18), the user has been waiting 5 minutes — they need direction at this moment, not just a label.

**Consequence:** UX dead-end — user sees the stalled pill, has no next-step affordance, panel offers no actions.

**Fix:** Add a "Relaunch observer" button to the stalled state (mirrors the existing `DegradedBanner` pattern). The action invokes the existing observer-half kill+relaunch path. If the observer is genuinely stuck, the relaunch heals it; if the wake send is the actual bottleneck, the user gets fresh evidence in logs.

---

## P3 — Consider

### 11. `scanForMissedObserverWakes` reads + parses ALL checkpoint files at init — unbounded sync I/O on hostile or large workspaces

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:670-722` |
| **Council** | Backend × Hunt — quality-backend.md P5 + security.md P1 |

The scan does `readdirSync + readFileSync + parseCheckpointPayload` for every `.json` under every group's `.council/checkpoints/`. No per-file size cap before the read (parser absorbs oversize), no count cap on file iteration. A workspace with thousands of checkpoint files OR symlink-bombed files blocks `initialize()` proportionally — startup DoS on a long-uptime workspace. Mitigations: per-file `statSync` size-gate before read; bounded iteration count with structured log on overflow; or skip files older than a configurable threshold.

---

### 12. Claim fence-triplet strip increases byte length AFTER `MAX_CLAIM_LEN` check

| | |
|---|---|
| **File** | `web/server/council-types.ts:319-323` |
| **Council** | Hunt × Carmack — Principle 1 (length-bounded contract) |

The fence-triplet strip (fix #22) runs `f.claim.replace(/```/g, "ʼ`ʼ`ʼ`")` AFTER `isBoundedText(f.claim, MAX_CLAIM_LEN)`. The replacement is 4 chars per occurrence of 3 chars — net +33% length. A 4000-char claim with many triplets exceeds MAX_CLAIM_LEN after substitution, violating the post-condition the cap was supposed to guarantee. Reorder: strip BEFORE the length check.

---

### 13. Live-builder canary test asserts shape but does NOT byte-compare against the pinned fixture

| | |
|---|---|
| **File** | `web/server/observer-wake-fixture.test.ts:107-130` (`live builder...round-trips` test) |
| **Council** | Realtime × Beck — quality-realtime.md P7 + EC-6 |

The "live builder canary" test checks that `buildObserverWakePayload({fixture inputs})` produces a body that contains H1 + fenced JSON. It does NOT compare the resulting bytes against the pinned `claude-v1.jsonl` file. So a future drift between the builder's output and the fixture goes undetected — the test pins shape, not bytes. To close: capture builder output, slot into the same envelope `JSON.stringify({type:"user",...})`, byte-compare against `readFileSync(FIXTURE_PATH)`.

---

### 14. `queued-dropped` pill lacks `role="status"` — peer transient states have it

| | |
|---|---|
| **File** | `web/src/components/council/ObserverPanel.tsx:160-167` |
| **Council** | a11y × Carmack — Principle 3 (live regions for transient states) |

The `reconnecting` and `reviewing-stalled` pills have `role="status"` + `aria-atomic="true"` so SR users get a polite announcement on transition. `queued-dropped` is also a transient signal (lasts until next clean review) but renders without those attributes — SR users don't hear the transition. Add `role="status" aria-atomic="true"` to the queued-dropped pill for parity.

---

### 15. `ANNOUNCED_FINDING_IDS_BY_SCOPE` Map never freed — JSDoc-only contract

| | |
|---|---|
| **File** | `web/src/components/council/FindingsLog.tsx:46-58` (module-level Map) |
| **Council** | React/Web UI × Fowler — quality-frontend.md P1 + refactoring.md P3 |

The fix #10 moved the announcer state to a module-level Map. JSDoc says "Never freed — bounded by page lifetime." For typical single-user single-tab usage this is fine. But the slice already has a `removeGroup` action that fires on group teardown — adding a `ANNOUNCED_FINDING_IDS_BY_SCOPE.delete(sessionGroupId)` call there would close the contract without significant complexity. Not blocking; flag for the next FindingsLog touch.

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Wake-body directive references wrong field name — defence #12 collapses | **P1** | Willison | 1 line in observer-prompt.ts + 1 regression test |
| 2 | dispatchObserverWake still has zero direct test table | **P1** | Beck | ~150 LOC test, 10 cases |
| 3 | sendUserFrameFromServer still has zero direct adapter tests | **P1** | Beck | ~80 LOC test, 5 cases + state resets |
| 4 | councilGroupBySessionId leaks on per-session archive paths | P2 | Backend | audit + 1 cleanup site |
| 5 | attachWebSocket doesn't reset observerTurnState — race window | P2 | Subprocess | 1 line + 1 race test |
| 6 | Dispatcher arm duplication — 3 copies of supersede-log code | P2 | Fowler | extract helper, ~40 LOC delta |
| 7 | Sentinel orphan on group:degraded (without exited) | P2 | Persistence | 1 cleanup site in degraded listener |
| 8 | DowngradedChip reason title-only — AT-silent | P2 | a11y | aria-label + inline text + 1 test |
| 9 | "Reviewed (skipped N)" copy doesn't drill down | P2 | Friedman | pill copy + tooltip/expand |
| 10 | "Review stalled" copy lacks next-step action | P2 | Friedman | add Relaunch button to stalled state |
| 11 | scanForMissedObserverWakes unbounded sync I/O at init | P3 | Backend × Hunt | size/count gate |
| 12 | Claim fence-triplet strip violates MAX_CLAIM_LEN post-condition | P3 | Hunt | reorder check |
| 13 | Live-builder canary doesn't byte-compare fixture | P3 | Realtime × Beck | extend existing test |
| 14 | queued-dropped pill lacks role=status | P3 | a11y | 2 attribute additions |
| 15 | ANNOUNCED_FINDING_IDS_BY_SCOPE never cleared | P3 | React × Fowler | 1 delete call in removeGroup |

**Totals:** 3 P1, 7 P2, 5 P3 (from 24 raw findings; weakest P3s cut per Phase 4 rule).

## Verdict

The fix-pass on commit `02e28c1` correctly closes 22 of the 25 prior findings — typecheck clean, 5621/5621 tests pass, EC-1..EC-12 (including the three new conventions EC-10/11/12) all honoured. Recovery-branch reachability — the headline pattern from the prior pass — is structurally resolved: `reviewing-stalled` now has a clock subscription, `StatusPill` is exhaustive, restart-gap catchup is implemented, `dropped` semantic lives in the system prompt.

**But three findings are NOT cleanly closed.** Two of them (#2, #3) are the same Beck #13 keystone-test-gap as before — the fix-pass landed 17 tests across sentinel + fixture surfaces, but the dispatcher itself still has only a static-grep canary. The third (#1) is worse: the fix-pass for Willison's prior #12 (mandatory echo) has a load-bearing typo — the wake-body directive instructs the observer to echo `observer_wake_payload_version` when the parser expects `observer_wake_payload_version_echo`. A conforming observer that follows the prompt's most-recent-and-most-prominent instruction emits the wrong field name; the parser silently ignores it; the mandatory-echo defence triggers on EVERY review and downgrades all findings to NOTE. The very fix that closed prior P1 #12 created its own P1.

**Start with #1.** It is one line of text in `observer-prompt.ts:288-289`. Without this, the rest of the council pipeline outputs nothing usable in production. Then **#2 + #3** — the dispatcher is the central piece of the feature and STILL has no behavioural tests; every future change to it ships green by default. The P2s are tractable-but-real maintenance debt; the P3s are watchpoints.

**Most critical lane this pass:** Willison (LLM Pipeline) for finding #1; Beck (Test Quality) for findings #2 + #3. Carmack would say: the cluster pattern repeated. The recovery-branch-reachability pattern from the prior pass is closed; the new pattern is "fix-pass introduces a new defect of the same severity it just closed" — for the second time in two reviews, the central echo-validation contract has a structural hole. Either the contract is genuinely subtle and needs convention-level discipline, or the fix-pass quality on Willison/echo surfaces specifically needs more rigour. Either way, ship after #1 + #2 + #3 are closed.

---

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key Areas |
|--------|----|----|----|-------|-----------|
| Hunt (Security) | 0 | 0 | 1 | 1 | claim-replace length post-cond |
| Fowler (Refactoring) | 0 | 1 | 0 | 1 | dispatcher arm duplication |
| Bun/Hono/TS Backend | 0 | 1 | 1 | 2 | reverse-index leak; scan unbounded I/O |
| FS-JSON Persistence | 0 | 1 | 0 | 1 | sentinel orphan on degraded |
| Realtime/NDJSON | 0 | 0 | 1 | 1 | live-builder canary byte-compare |
| Subprocess Lifecycle | 0 | 1 | 0 | 1 | attachWebSocket reset race |
| React/Web UI | 0 | 0 | 1 | 1 | Map never freed |
| a11y Auditor | 0 | 1 | 1 | 2 | chip title-only; queued-dropped role |
| Friedman (UX) | 0 | 2 | 0 | 2 | copy not drillable; no next action |
| Willison (LLM) | 1 | 0 | 0 | 1 | wake-body directive wrong field name |
| Beck (Tests) | 2 | 0 | 0 | 2 | dispatcher untested; adapter untested |
| **TOTAL** | **3** | **7** | **5** | **15** | |

**Cross-references:**
- #1 (Willison) — the SAME class as prior P1 #12 it was supposed to fix (echo contract drift)
- #2 + #3 (Beck) — the SAME P1 finding from the prior pass; fix-pass partially landed but skipped the keystone surfaces
- #11 (Backend × Hunt) — multi-expert co-flag
- #13 (Realtime × Beck) — multi-expert co-flag
- #15 (React × Fowler) — multi-expert co-flag

**Review output written to:** `.council/review-output/2026-05-13-0150/FINAL-REVIEW.md`

**Expert output files:**
- Hunt: `.council/review-output/2026-05-13-0150/hunt.md`
- Fowler: `.council/review-output/2026-05-13-0150/fowler.md`
- Bun/Hono/TS: `.council/review-output/2026-05-13-0150/backend-ts.md`
- FS-JSON: `.council/review-output/2026-05-13-0150/persistence.md`
- Realtime/NDJSON: `.council/review-output/2026-05-13-0150/realtime.md`
- Subprocess: `.council/review-output/2026-05-13-0150/subprocess.md`
- React/Web UI: `.council/review-output/2026-05-13-0150/react-ui.md`
- a11y: `.council/review-output/2026-05-13-0150/a11y.md`
- Friedman: `.council/review-output/2026-05-13-0150/friedman.md`
- Willison: `.council/review-output/2026-05-13-0150/willison.md`
- Beck: `.council/review-output/2026-05-13-0150/beck.md`
