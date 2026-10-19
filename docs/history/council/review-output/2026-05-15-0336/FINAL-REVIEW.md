# Council Review (Aura): Task 11 wire-up integration (PR #54 / squash `3dee080`)

**Scope:** 7 server-side files in `main~1..main` — `ws-bridge.ts`, `claude-adapter.ts`, `session-orchestrator.ts`, `index.ts`, plus the three matching `.test.ts` files. Subsections 11.6 (cross-tab user-frame observer) + 11.7 (idle-kill clock split) + 11.8 (synthetic-frame send + 4 cleanup paths).

**Context:** Wires three foundation surfaces from PRs #45–#51 (shipped with unit tests but zero production callers) into actual call sites. Closes a long-standing `feedback_call_site_presence_not_just_symbol_export` debt against the auto-proceed pipeline. The pipeline is now end-to-end callable in production; the question is whether the boundaries hold under stress.

**Council dispatched:** 7/13 — Hunt, Fowler, Backend (Bun/Hono/TS), Realtime/NDJSON, Subprocess Lifecycle, Willison (LLM), Beck (Test Quality). Skipped (zero domain files in scope): Persistence, React/UI, a11y, Saarinen, Friedman, Docker/GHA.

---

## P1 — Fix Now

### 1. Denylist gate fails open silently on `idleTimerProbe === null` — defence-in-depth that vanishes under one DI ordering change

| | |
|---|---|
| **File** | `web/server/claude-adapter.ts:896-913` |
| **Council** | Willison × Hunt × Subprocess × Carmack — quality-llm.md Principle 3 (LLM-graded permission with no rule-based fallback is fail-open); cross-ref: Subprocess P1-S1 (torn-read on same gate), Backend P3-4 (structural cast bypasses type system) |
| **Ref** | `references/quality-llm.md` → Principle 3 |

**Finding:** The gate predicate `this.idleTimerProbe?.isSyntheticTurnInFlight(this.sessionId) && isToolUseDeniedForSynthetic(...)` short-circuits to `undefined` when the probe is null — the documented default for unit tests AND the production state in the boot window between WsBridge construction and `wsBridge.setIdleTimerProbe(...)`. Three independent reviewers (Willison, Subprocess, Backend) converged on the same DI-ordering-flip risk.

**Consequence:** A future refactor moving synthetic-frame send earlier in the boot sequence — or any test path that wires the synthetic path without wiring the probe — silently approves a denylisted tool through the browser permission UI. Per `feedback_multi_expert_convergence_promotion`, 3+ experts on the same root cause = structural truth.

**Fix:** Either make probe a constructor-required parameter for council-mode adapters (fail-closed on absence), OR change the gate to fail-CLOSED on `idleTimerProbe === null` for ANY `can_use_tool` whose tool/input matches the denylist regardless of in-flight state. The current shape optimises for test-ergonomics at the cost of the safety promise.

---

### 2. Synthetic-send path has no orchestrator turn-state gate — TOCTOU window allows duplicate `user` frames against one orchestrator slot

| | |
|---|---|
| **File** | `web/server/claude-adapter.ts:1126` (`sendOrchestratorSyntheticFrame`) vs `:1174` (`sendUserFrameFromServer`) |
| **Council** | Realtime × Carmack — quality-realtime.md Principle 6 (single-shot ack discipline) + `feedback_council_documented_contract_canary` (JSDoc contracts are docs, not enforcement) |
| **Ref** | `references/quality-realtime.md` → Principle 6 |

**Finding:** The wake path gates on `if (this.observerTurnState === "in-flight") return {kind:"busy"}` BEFORE transport gates; the new synthetic path deliberately drops the symmetric `orchestratorTurnState.kind === "in-flight"` check and hands enforcement to the caller (IdleTimerManager) in a different stack. Between the manager's read of `getOrchestratorTurnState()` and the adapter's send, a real user can flip `orchestratorTurnState` to `in-flight` via `handleOutgoingUserMessage` (line 440) — the synthetic then lands ON TOP of a genuine in-flight user turn.

**Consequence:** The CLI has two `user` frames pending against one orchestrator slot. The second result arrives first, fires the `in-flight → awaiting-input` transition prematurely, clears the synthetic sticky token via `noteTerminalResultFrame`, and the genuine user's later result finds state already `awaiting-input` and silently drops both the bus event AND the cleanup. Silent invariant break.

**Fix:** Move the gate inside `sendOrchestratorSyntheticFrame` mirroring the wake path. Carmack's principle: the check and the act must be the same act.

---

### 3. `isSyntheticTurnInFlight` double-`.get` torn-read + operator-precedence footgun

| | |
|---|---|
| **File** | `web/server/idle-timer-manager.ts:372-375` |
| **Council** | Subprocess × Carmack — quality-subprocess.md Principle 2 (identity verification under concurrency); Principle 4 (silent fail-open on the denylist gate is the most expensive class) |
| **Ref** | `references/quality-subprocess.md` → Principle 4 |

**Finding:** The accessor calls `this.states.get(sessionId)` TWICE and reads `pendingSyntheticTurnToken` from each result independently. Microtask interleaving between the two reads can produce `null` from the second read while the first saw a non-null token → returns `false`. The denylist gate then falls through to the user-facing permission UI for a tool that should have been silently denied. Compounding: the never-armed-session value `undefined !== null && undefined !== undefined` reduces to `false` only **by accident** of operator precedence — a natural simplification (`!== null` first) inverts the semantics for solo sessions.

**Consequence:** Narrow race window, but the gate is the load-bearing security primitive for unattended auto-proceed loops. Failure mode: destructive tool ran in unattended mode without user approval.

**Fix:** Single `const state = this.states.get(sessionId)`, then `state !== undefined && state.pendingSyntheticTurnToken !== null`. Make never-armed an explicit `false` return, not an emergent property of `&&` short-circuit.

---

### 4. Non-exhaustive `BridgeObserverWakeOutcome` mapping in `index.ts` — new variants will silently stringify

| | |
|---|---|
| **File** | `web/server/index.ts:147-158` |
| **Council** | Realtime × Carmack — quality-realtime.md Principle 7 (protocol drift); EC-5 (parsers reject unknown shapes extends to typed protocol outcomes) |
| **Ref** | `references/quality-realtime.md` → Principle 7 |

**Finding:** The wake path's analogous mapping at `session-orchestrator.ts:1808-1953` ends in `const _exhaustive: never = bridgeOutcome` — a compile-time tripwire when new variants ship. The synthetic path's mapping is a 3-arm if/else cascade; the final `else` swallows any future variant as a bare kind string. The asymmetry is worse because the synthetic path is the NEW code — the lesson the wake path learned (after a council finding) didn't carry across.

**Consequence:** When PR #52's outbound FIFO lands and adds `{kind:"queued"; depth:number}`, the auto-proceed pipeline will log `error: "queued"` while the wake path's exhaustive switch would have broken the build for human attention.

**Fix:** Replace the if/else cascade with `switch (outcome.kind)` exhausting every variant + `const _exhaustive: never = outcome; void _exhaustive;` tail. Mirrors the wake path exactly.

---

### 5. `archiveSession` explicit `clearPendingSyntheticTurn` runs AFTER `archiveGroup` await — race-able after any future async-kill refactor

| | |
|---|---|
| **File** | `web/server/session-orchestrator.ts:2740-2748` |
| **Council** | Subprocess × Carmack — `feedback_recovery_branch_reachability` (a "defence" branch structurally subordinate to the listener it's meant to redundantly cover) |
| **Ref** | `references/quality-subprocess.md` → Principle 4 |

**Finding:** Current sequence: (1) mark intentional, (2) `await coord.archiveGroup(...)` which synchronously triggers `session:exited` → bus listener clears tokens, (3) explicit `clearPendingSyntheticTurn(group.primary.sessionId)` runs AFTER the await resolves. The explicit call is sold in the PR description as belt-and-braces but is actually the **opposite**: a future refactor that defers `deps.kill` to `setImmediate` (reasonable async-hygiene change) makes the synchronous `session:exited` no longer fire before step 3 → step 3 races with the eventual exit-emit. Also: the orchestrator-only clear silently assumes the observer half can never have a pending synthetic turn — unverified by code or test.

**Consequence:** Today: safe. Next refactor: silent token-survival across archive, denylist gate stuck-armed against the resumed session.

**Fix:** Move the explicit clear BEFORE `await coord.archiveGroup` so it's unconditionally before any kill. Document the orchestrator-half assumption with an assertion or extend cleanup to both halves.

---

### 6. No replay test exercises the `server:auto-proceed` recorder origin — load-bearing forensic discriminant uncovered

| | |
|---|---|
| **File** | `web/server/recorder.ts:73-85` (the origin definition) + missing test in `recorder.test.ts` |
| **Council** | Willison × Beck × Carmack — quality-llm.md Principle 4 (load-bearing modules without replay tests = P1) |
| **Ref** | `references/quality-llm.md` → Principle 4 |

**Finding:** The `RecordingOrigin` union is the load-bearing distinguisher between three provenance classes (browser / wake / auto-proceed). Replay-based tooling for incident triage relies on this field. Zero tests assert that the synthetic-frame send actually writes `origin: "server:auto-proceed"`, that the replay loader round-trips the field, or that a corpus containing both `server:council-wake` AND `server:auto-proceed` can be filtered.

**Consequence:** A future PR refactors recorder.ts to compact origin (disk-size optimisation). Unit tests still pass (they assert the field exists at write time). Replay tools silently misclassify auto-proceed turns as browser-relayed → forensic analysis attributes operator actions to the user → incident response writes the wrong post-mortem.

**Fix:** One fixture-based recorder test that writes a synthetic frame via `ClaudeAdapter.sendOrchestratorSyntheticFrame`, reads the resulting file with the replay loader, asserts `entries[0].origin === "server:auto-proceed"`. Add a second case with mixed origins to prove the filter works. ~20 lines including fixture.

---

### 7. Session-orchestrator wiring has ZERO behavioural test coverage — three new call sites, mock-built-never-asserted

| | |
|---|---|
| **File** | `web/server/session-orchestrator.test.ts:184` (only diff is `onUserFrameObserved: vi.fn(() => () => {})` stub); production wiring at `session-orchestrator.ts:495` (`noteUserMessage`), `:507-509` (`session:exited → clearPendingSyntheticTurn`), `:2747` (`archiveSession → clearPendingSyntheticTurn`) |
| **Council** | Beck × Carmack — `feedback_call_site_presence_not_just_symbol_export` + `feedback_verify_test_bodies_not_just_names` |
| **Ref** | `references/quality-testing.md` → Behavioural vs structure-insensitive assertions |

**Finding:** The orchestrator test file diff is purely defensive (without the mock stub, the constructor would crash on the new bridge method). NO test anywhere asserts that `initialize()` registers a callback forwarding to `noteUserMessage`, that the new `session:exited` listener fires on emit, or that the `archiveSession` council-branch cleanup actually calls the manager. The existing `session:exited` count tests verify count ≥ N but don't distinguish which handler is wired — a regression deleting the specific listener still keeps the count valid.

**Consequence:** Future refactor moves the orchestrator subscription line into a conditional gate, accidental deletion during conflict resolution, etc. — every existing test passes, the standalone manager tests pass, the standalone bridge tests pass, but **production turn-token never advances on user typing → pending auto-proceed fires don't cancel → user types and the agent then auto-fires anyway.** Classic `feedback_partial_fix_passed_as_complete`.

**Fix:** Three behavioural tests in `session-orchestrator.test.ts` — capture callback from `onUserFrameObserved`, invoke it, assert manager.noteUserMessage was called. Emit `session:exited` on companionBus, assert `clearPendingSyntheticTurn` was called. Exercise `archiveSession` council branch, assert orchestrator-half's clear fired.

---

## P2 — Fix Soon

### 8. `WsBridge` god-module hits 1698 LOC with three independent reasons-to-change in this PR — extract before PR #52 lands +200 more LOC

| | |
|---|---|
| **File** | `web/server/ws-bridge.ts` (entire file) |
| **Council** | Fowler × Beck × Carmack — refactoring.md Principle 6 (missing boundaries) + Principle 7 (fear-zones) |
| **Ref** | `references/refactoring.md` → Principle 6 |

**Finding:** Bridge owns 13 distinct concerns (session map + CLI handlers + browser handlers + idle-kill watchdog + heartbeat + disconnect debounce + AI validation + Council hydration + auto-proceed dispatcher trio + user-frame observer registry + interrupted-stream synthesis + pending message queue + two synthetic-send façades). Sibling extracts (`ws-bridge-persist`, `ws-bridge-publish`, etc.) prove the pattern works.

**Fix:** Extract three modules — `ws-bridge-idle-watchdog.ts` (timers + heartbeat + dispatcher trio), `ws-bridge-council.ts` (group hydration + send façades + observer registry), `ws-bridge-ai-validation.ts`. Pure-extract refactor, no behaviour change. Sequence BEFORE PR #52's `enqueueOutboundFrame`.

---

### 9. Late-injection probe interface duplicated at 5 sites — type drift footgun

| | |
|---|---|
| **File** | `web/server/ws-bridge.ts:119-122, 140-144, 1032-1035` + `web/server/claude-adapter.ts:134-136, 195-198` |
| **Council** | Fowler × Backend × Carmack — refactoring.md Principle 4; cross-ref: this exact failure shape produced `ffb48d3` (the 7th commit on PR #54 fixing CI typecheck) |
| **Ref** | `references/refactoring.md` → Principle 4 |

**Finding:** Probe interface `{ isSyntheticTurnInFlight; noteTerminalResultFrame }` hand-redeclared at 5 sites. A future task adding a third method (e.g. `noteUserMessage` migration) WILL drift first at one site; the structural cast in `index.ts:108-113` (`adapter as unknown as { orchestratorTurnState?: ... }`) bypasses the type system on the load-bearing dispatch read. The 11.7→11.8 widening already proved this: PR #54 commit `8cdbc74` shipped the widened interface but `ws-bridge.test.ts` stubs weren't updated; CI caught it, fix landed in `ffb48d3`.

**Fix:** Export `IdleTimerProbe` type from `idle-timer-manager.ts` (the producer). Import at all consumer sites. Replace the structural cast in `index.ts` with `ClaudeAdapter.getOrchestratorTurnState()` accessor (already exists at line 1274-1285).

---

### 10. Denylist coverage narrower than gate prose — "destructive operations" is actually 4 publish-to-others entries

| | |
|---|---|
| **File** | `web/server/claude-adapter.ts:884-886` (prose) + `web/server/auto-proceed-permissions.ts:61-66` (actual list) |
| **Council** | Hunt × Willison × Carmack — security.md Principle 9 (false-confidence amplifies impact) |
| **Ref** | `references/security.md` → Principle 9 |

**Finding:** Gate inline comment claims denial of "Bash:git push, network operations, destructive filesystem actions etc." Actual `SYNTHETIC_FRAME_TOOL_DENYLIST` contains exactly four entries: `git push`, `git commit`, `gh pr create`, `gh pr merge`. No `rm -rf`, no `curl`/`wget`, no `npm publish`, no `git push --force`, no `kubectl`, no `docker push`. The doc lies about coverage.

**Consequence:** Auto-proceed escalates to "let me clean up the workspace" → `Bash:rm -rf ~/.companion/recordings` slips past the gate while the PR/handoff narrative reads "destructive operations are gated".

**Fix:** Either widen the denylist to actually cover destructive fs + network ops, OR tighten the prose to match the actual list ("publish-to-others operations only; destructive local fs is NOT denied"). The module-level doc on `auto-proceed-permissions.ts:6-9` is already honest — sync the inline comment.

---

### 11. Predicate falls open silently when CLI sends non-string `tool_name` — type-confusion bypass

| | |
|---|---|
| **File** | `web/server/claude-adapter.ts:324` (no runtime shape check on `JSON.parse(line)`) + `web/server/auto-proceed-permissions.ts:88-89` (`if (toolName === "Bash")`) |
| **Council** | Hunt × Carmack — security.md Principle 2 (validate at every protocol boundary) |
| **Ref** | `references/security.md` → Principle 2 |

**Finding:** `tool_name` and `tool_input` are cast straight to TypeScript types with no runtime validation. If a malformed/malicious frame sends `tool_name: ["Bash"]` (array) or `input: {command: ["git", "push"]}` (array, not string), the strict-equality and prefix-match checks return false, denylist falls open. Anthropic's own SDK has shipped `tool_name: string | array` in preview iterations — this is a real protocol-drift class.

**Fix:** Add `if (typeof toolName !== "string") return true` (fail-CLOSED) at the top of `isToolUseDeniedForSynthetic`. Symmetric guard for input shape. Document the fail-closed convention in module header.

---

### 12. `injectUserMessage` fires `userFrameObservers` for server-originated injects — cron/agent automation silently cancels every auto-proceed timer

| | |
|---|---|
| **File** | `web/server/ws-bridge.ts:1229-1247` (`injectUserMessage` + `injectMcpSetServers`); callers: `agent-executor.ts:224`, `cron-scheduler.ts:151`, `linear-agent-bridge.ts:361`, `routes/system-routes.ts:225` |
| **Council** | Backend × Carmack — quality-backend.md Principle 2 (validation gap at boundary) + clock-axis asymmetry |
| **Ref** | `references/quality-backend.md` → Principle 2 |

**Finding:** `injectUserMessage` routes through `routeBrowserMessage` which fires every observer in `userFrameObservers`. Production observer is `IdleTimerManager.noteUserMessage` which advances `turnToken` and cancels any pending timer. So a cron-scheduled prompt, an agent-executor injection, a Linear-bridge message, or a REST `POST /sessions/:id/message` all count as "user typed" for auto-proceed.

**Consequence:** A cron-driven council session that fires every 5 minutes will NEVER reach auto-proceed because every injection resets the turn-token. The user sees auto-proceed as broken for cron+council pairs without any diagnostic.

**Fix:** Thread an `origin: "browser" | "server:cron" | "server:agent" | "server:linear" | "server:auto-proceed"` flag through `routeBrowserMessage` so observers can filter (mirrors the recorder origin pattern). Smaller alternative: fire observers only inside `handleBrowserMessage` (real browser origin) and skip in inject* helpers.

---

## P3 — Consider

### 13. `detachWebSocket` silently swallows in-flight → awaiting-input bus emit during mid-synthetic WS flap

`web/server/claude-adapter.ts:249-258` (Subprocess P3-S3). The defensive reset on detach is correct (Council Review 2026-05-13 Subprocess #2's lesson), but a transient WS flap during a synthetic in-flight turn silently transitions state without firing the bus event — `handleResultMessage`'s in-flight guard then skips `noteTerminalResultFrame`, leaving the sticky token persistent across the now-completed synthetic turn. Reachable but narrow (requires transient WS flap mid-synthetic without process exit). Fix: in `detachWebSocket`, if prior state was `in-flight`, also call `idleTimerProbe?.noteTerminalResultFrame(this.sessionId)`.

---

### 14. Denial-message embeds CLI-controlled `command` head in backtick-quoted markdown — low-probability XSS in stored chat surface

`web/server/auto-proceed-permissions.ts:111-120` (Hunt 3 + Willison P3.1). `denialMessageForSynthetic` interpolates `head` (first 80 bytes of `toolInput.command`) into a markdown code span without backtick escaping. The CLI's `can_use_tool` deny response is persisted in recordings + replayed in chat. A command containing an embedded backtick can break out of the code span. Pre-condition is high (synthetic turn in flight + tool-use with crafted command + tool also matches denylist prefix), but the trust elevation pattern matches `feedback_format_transformation_validation`. Fix: strip backticks (or all markdown control chars) from `head` before interpolation, OR emit a fixed denial message without command-head injection.

---

### 15. ZW-class characters bypass denylist prefix-match — `trimStart` doesn't strip them

`web/server/auto-proceed-permissions.ts:93-99` (Hunt 4). Module doc correctly states `trimStart` covers Unicode whitespace but doesn't enumerate ZW chars (U+200B, U+FEFF, U+202E). A leading ZW byte makes `trimmed.startsWith("git push")` false; gate falls open with one extra byte. Real-world risk is an LLM cargo-culting Unicode quoting from a code-review thread, not targeted attack. Fix: explicitly strip ZW + BOM + bidi-control before prefix-match, OR enumerate the bypass class in the Limitations comment so the next person extending the denylist doesn't assume coverage.

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Denylist gate fails open on probe=null (3-expert convergence) | P1 | Willison × Hunt × Subprocess | ~10 LOC + spawn-seam assertion |
| 2 | Synthetic-send missing orchestrator turn-state gate (TOCTOU) | P1 | Realtime | ~5 LOC, move gate inside adapter |
| 3 | `isSyntheticTurnInFlight` torn-read + operator-precedence | P1 | Subprocess | ~3 LOC |
| 4 | Non-exhaustive `BridgeObserverWakeOutcome` mapping in index.ts | P1 | Realtime | ~10 LOC, switch + `never` tail |
| 5 | `archiveSession` clear AFTER archiveGroup await (race-prone) | P1 | Subprocess | Move 1 LOC before `await` |
| 6 | No replay test for `server:auto-proceed` recorder origin | P1 | Willison × Beck × Carmack | ~20 LOC test |
| 7 | Session-orchestrator wiring has zero behavioural test coverage | P1 | Beck | ~3 tests, ~60 LOC |
| 8 | `WsBridge` god-module split before PR #52 lands | P2 | Fowler | Pure-extract, ~3 new files |
| 9 | Probe interface duplicated at 5 sites (drift footgun) | P2 | Fowler × Backend | Export named type + 5 imports |
| 10 | Denylist prose claims "destructive ops"; actual list is 4 publish entries | P2 | Hunt × Willison | Sync prose or widen list |
| 11 | Predicate falls open on non-string `tool_name` (type-confusion) | P2 | Hunt | ~3 LOC fail-closed guard |
| 12 | `injectUserMessage` server-origin observer-fire breaks cron+council | P2 | Backend | Add origin flag through `routeBrowserMessage` |
| 13 | `detachWebSocket` silently swallows synthetic-turn cleanup | P3 | Subprocess | ~3 LOC |
| 14 | Denial-message markdown injection from CLI-controlled `command` | P3 | Hunt × Willison | Strip backticks or fixed message |
| 15 | ZW-class characters bypass denylist prefix-match | P3 | Hunt | ~5 LOC normalize or doc |

**Totals:** 7 P1 / 5 P2 / 3 P3 = 15 findings.

## Verdict

This is shipping-quality code with shipping-quality gaps. The PR closes long-standing call-site-presence debt and the implementation honestly documents its limitations — but the boundaries where the framing is supposed to be ENFORCED rather than DOCUMENTED are where the P1s cluster.

**Start with #1** — the probe-null fail-open. Three independent reviewers converged on it from different lenses (LLM-pipeline fail-mode, subprocess race-condition, type-system bypass). Per `feedback_multi_expert_convergence_promotion`, that convergence is structural truth — the defence-in-depth claim of the denylist is currently one DI refactor away from silent absence.

The most critical domain for THIS codebase right now is **Subprocess Lifecycle** — Task 11 wire-up created a contract that spans three classes (IdleTimerManager, WsBridge, ClaudeAdapter) coupled by late-injection with no integration tests, exactly the pattern that produced the production `degraded` bug we shipped PR #53 to fix earlier this session. Beck P1.4 (deferred 5-step race-regression integration test, folded into finding #7) is the single highest-leverage missing test in the entire auto-proceed plan.

Carmack would say: ship the PR with explicit follow-up issues for each P1. The wire-up gap was real and worse than these P1s. But don't build atop this surface without closing #1, #2, #3, #6, #7 first.

---

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key Areas |
|--------|----|----|----|----|-----------|
| Hunt (Security) | 0 | 2 (#10, #11) | 2 (#14, #15) | 4 | Denylist scope honesty, type-confusion, XSS |
| Fowler (Refactoring) | 0 | 2 (#8, #9) | 0 | 2 | God-module growth, interface drift |
| Bun/Hono/TS Backend | 0 | 1 (#12) | 0 | 1 | Cross-tab observer asymmetry |
| Realtime/NDJSON Protocol | 2 (#2, #4) | 0 | 0 | 2 | Gate hand-off TOCTOU, outcome exhaustiveness |
| Subprocess Lifecycle | 2 (#3, #5) | 0 | 1 (#13) | 3 | Torn-read, ordering, mid-flap cleanup |
| Willison (LLM Pipeline) | 1 (#1 shared, #6) | 1 (#10 shared) | 1 (#14 shared) | 2 unique | Probe-null, replay coverage |
| Beck (Test Quality) | 2 (#6 shared, #7) | 0 | 0 | 1 unique | Mock-built-never-asserted cluster |
| **TOTAL** | **7** | **5** | **3** | **15** | |

**Review output written to:** `.council/review-output/2026-05-15-0336/FINAL-REVIEW.md`

**Expert output files:**
- Hunt: `.council/review-output/2026-05-15-0336/hunt.md`
- Fowler: `.council/review-output/2026-05-15-0336/fowler.md`
- Bun/Hono/TS: `.council/review-output/2026-05-15-0336/backend-ts.md`
- Realtime/NDJSON: `.council/review-output/2026-05-15-0336/realtime.md`
- Subprocess: `.council/review-output/2026-05-15-0336/subprocess.md`
- Willison: `.council/review-output/2026-05-15-0336/willison.md`
- Beck: `.council/review-output/2026-05-15-0336/beck.md`
