# Fowler — Structural Review (Observer Auto-Wake)

Reviewer lane: refactoring / structural quality. Out of lane: security, runtime correctness, tests. AP-1..AP-3 and EC-1..EC-9 already accepted; not re-flagged.

Files in scope:
- `web/server/session-orchestrator.ts` (2479 LOC; +481 this change)
- `web/server/council-wake-sentinel.ts` (143 LOC, new)
- `web/server/observer-prompt.ts` (~515 LOC; builder + EC-7 wrapper added)
- `web/server/claude-adapter.ts` (1088 LOC; `observerTurnState` + `sendUserFrameFromServer` added)

---

## Summary judgement on the brief's headline questions

- **Has `session-orchestrator.ts` crossed the line?** It is at the edge, not over it. The +481 growth is *additive but interleaved* — see Finding 1. The dispatcher itself is fine.
- **Is `dispatchObserverWake` correctly extracted?** Yes. Single sequence of gates, one outcome per gate, one EC-9 log per outcome. Size (~250 LOC) is the cost of explicit-state visibility (Carmack P2 — keep mutations visible and sequential). Extracting inner gates would *hide* the contract, not reveal it.
- **Should the wake pipeline live in `observer-wake-dispatcher.ts`?** Not yet. The dispatcher depends on `councilWatchers`, `councilGroupMeta`, `coordinator`, `wsBridge`. Backend variance for Codex already lives at the adapter seam (`sendUserFrameFromServer` on `ClaudeAdapter`; bridge does the narrowing). Extraction today is speculative generality (Fowler P5) — pull it when the second adapter actually ships and the seam is concrete.
- **Is `council-wake-sentinel.ts` earning its boundary?** Yes. Versioned schema, three exports, isolated FS I/O, mirrors the AP-3 colocation pattern, independently testable. Not speculative.
- **Is `observerTurnState` on `ClaudeAdapter` feature envy?** No — it is the *opposite* of feature envy. Turn-state is derived from `result` NDJSON frames the adapter parses; the bus event `observer:turn-done` is the backend-agnostic seam the orchestrator reads. Moving it up would force the orchestrator to parse backend-specific frames.
- **Is the 8-skip-reason union evidence of mixed responsibilities?** No. Each skip reason maps 1:1 to a distinct gate failure with a distinct operator action and a distinct EC-9 log line. Healthy discrimination.

---

## FINDING 1

- **Title:** Council reconnect/wake listeners interleaved with solo-session listeners inside `initialize()`
- **File:** `web/server/session-orchestrator.ts` (initialize, lines ~394–645)
- **Principle:** Refactoring P5 — Shotgun Surgery / Missing boundaries where they matter (P6)
- **Severity:** P2
- **What's wrong:** `wireGroupListeners()` already extracted the `group:*` broadcast surface (per the in-source "Fowler council review #15" comment). But three additional council listeners still live inline in `initialize()`: `observer:turn-done` drain (Task 4), the council branch of `session:cli-id-received` for reconnect resolution (Task 4), and `session:relaunch-failed` short-circuit (Task 5). These sit between solo-session listeners (`session:exited` → agentExecutor / exitCallbacks / state-machine, `session:idle-kill`, `session:first-turn-completed`, `session:git-info-ready`, `session:relaunch-needed`). A developer changing the council reconnect grace must read past unrelated solo handlers; a developer changing solo idle-kill must skip past 50+ LOC of council reconnect-identity binding. The author has already paid the cost of one extraction (`wireGroupListeners`); a sibling extraction is the obvious finish.
- **Consequence:** The next council change (Codex pairing, observer model fallback, partial-pair recovery refinement) will add yet another inline listener. Story 2's +200 LOC inside `initialize()` is the curve to extrapolate. By Story 3 the method exceeds the threshold where developers reflexively avoid changing it — Fowler P7 fear-zone formation. The accumulated cost is shotgun surgery on every council-lifecycle PR.
- **Fix:** Extract `wireCouncilLifecycleListeners()` next to `wireGroupListeners()`. Move the three council-tagged listeners verbatim. `initialize()` then reads as: solo-session wiring → `this.wireGroupListeners()` → `this.wireCouncilLifecycleListeners()` → reconciliation → watchdog. Single-pass, cohesive blocks, named seams for future additions.

---

## FINDING 2

- **Title:** Wake-version-echo downgrade logic embedded mid-function in `handleCouncilReview`
- **File:** `web/server/session-orchestrator.ts` (`handleCouncilReview`, lines ~1470–1624)
- **Principle:** Refactoring P2 — Extract pure logic; long function mixing concerns
- **Severity:** P3
- **What's wrong:** `handleCouncilReview` runs five distinct phases in sequence: (1) build delta manifest, (2) ground findings + collect downgrades, (3) assign deterministic ids, (4) **wake-version-echo mismatch downgrade pass** (Task 10), (5) emit invocation log + bus event. Step 4 is a pure transformation over `(findings, downgrades, payload.observer_wake_payload_version_echo, OBSERVER_WAKE_PAYLOAD_VERSION)` — it has no I/O, no event emit, no state mutation outside the local arrays. It is also the only piece of this function that is currently *not* independently unit-testable, because it can only be reached by constructing a full review payload that survives grounding. The function's body is also the natural place a sixth downgrade reason (e.g. cross-checkpoint stale-evidence) will land next quarter, compounding the smell.
- **Consequence:** Adding the next downgrade reason will either inline another for-loop into this function (the existing pattern), or require partial extraction at that point — at which time the wake-version pass will still be inline and the inconsistency itself becomes a smell. Today's cost is modest; the compounding curve is the reason this is worth flagging now while the surface is one extraction.
- **Fix:** Extract `applyWakeVersionDowngrade({findings, downgrades, echo, expected}): {findings, downgrades}` (or in-place mutate, matching the in-source style). Pure function — testable on synthetic inputs. Leave the call site visible in `handleCouncilReview` so the sequence of phases stays readable. This is the canonical "extract pure logic, keep mutations visible" idiom from the refactoring reference's Principle 2.

---

## FINDING 3 (Watchpoint, not P1/P2/P3)

- **Title:** `dispatchObserverWake` + helper state cluster is the next extraction candidate when Codex pairing lands
- **File:** `web/server/session-orchestrator.ts` (dispatchObserverWake / drainPendingObserverWake / handleCouncilCheckpoint / handleCouncilReview, plus the `councilWatchers` + `councilGroupMeta` maps)
- **Principle:** Refactoring P6 — Architecture earns its boundaries (deferred until concrete)
- **Severity:** Watchpoint
- **What's wrong:** Not wrong *today*. The dispatcher and its sibling helpers form a coherent cluster of ~500 LOC that own: per-group watcher state, per-group meta cache, the gate pipeline, the drain hook, and the review handler. When `claude+codex` ships, the only per-backend variance lands on `CodexAdapter.sendUserFrameFromServer` and stays inside `ws-bridge.sendObserverWakeFrame`'s narrowing — the dispatcher stays unchanged. *That* is the moment to extract `CouncilWakePipeline` (or similar) — when the seam is concrete and the extraction collapses the orchestrator down to the lifecycle surface it was built for.
- **Consequence:** Extracting today is speculative generality (would invent DI for state that has one consumer). Extracting too late (after 3 more stories add to the cluster) is a fear-zone refactor. The triggering signal is: any single one of `councilWatchers`, `councilGroupMeta`, `coordinator.applyEvent` from outside-the-orchestrator wanting to read this state. Track it.
- **Fix:** No action this PR. Add to the conventions doc as a tracked structural watchpoint so the next council reviewer doesn't re-derive the same cost-benefit calculation.

---

## Findings written: 3 (P1: 0, P2: 1, P3: 1, Watchpoint: 1)
