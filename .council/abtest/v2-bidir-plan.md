# Council Plan (Aura): Council Mode bidirectional pipeline — Orchestrator ↔ Observer cycle

**Scope:** Land the structural keystones for the bidirectional pipeline spec (canonical sequence visibility + inline peer-message channel + convergence-cycle detection with sidebar badge). Defer Phase 3 (REST `:3457`), Phase 4 (memory propagation), and Phase 6 (atomic promotion) — each is a session-sized chunk; this plan covers Phases 1 + 2 + 5 only.

**Context:** Council Mode pair coordination today flows one-way (orchestrator emits checkpoint → watcher → observer review). The spec adds: (1) operator-visible peer messages crossing back from observer into orchestrator's chat thread; (2) a clean-cycle counter that converts repeated zero-STOP reviews into a `converged` signal; (3) a canonical 9-step sequence constant the orchestrator can announce. The existing `injectUserMessage(origin?: "server:cron"|"server:agent"|"server:rest")` already threads EC-16 — extending its discriminator with `council:peer` is the cheapest seam that preserves the convention. Convergence is a derived property of the `group:review` event stream, owned by the coordinator beside the existing reconnect/degrade state machine.

**Boundaries:**
- ✅ In scope: `council:peer` origin + EC-16 skip; peer-formatter with 1KB cap; convergence-cycle tracker with revoke-on-P1; `convergence-trial` / `converged` checkpoint phases; `cycleNumber` + `convergenceState` fields on GroupRecord; convergence badges in ObserverPanel StatusPill; CANONICAL_SEQUENCE constant module.
- 🚫 Out of scope (this plan): REST `:3457` heartbeat server; bidirectional wake from REST (peer-message wake is the visibility surface, not the liveness surface — Phase 3 owns liveness); memory propagation across halves; orchestrator system-prompt loader file (defer to follow-up; constant module unblocks AC); ConvergedActionsPopover; suppress-inline-peer toggle; step-N checkpoint files; out-of-sequence WARN detector.

**Council dispatched (10 of 12 seats, parallel, each returned plan recommendations):**
- Backend/protocol expert — 5 task recommendations on `injectUserMessage` extension, peer-routing helper, formatter cap, `convergence-trial` checkpoint, coordinator counter
- Frontend/React expert — 5 recommendations on GroupRecord shape, panel-state derivation, badge rendering, popover, suppress-toggle
- Persistence/process expert — 4 recommendations on orchestrator-prompt loader pattern, step checkpoint emission, structured WARN, converged-checkpoint reconcile-on-init
- a11y expert — 4 recommendations on badge contract, focus management, truncation semantics, peer-tag announcement
- Testing expert — 4 recommendations on canonical-sequence deep-equality, peer-origin skip assertion, 1KB boundary, converged lifecycle
- Skipped: UI expert (visual scope ≤ a11y's badge audit), UX expert (no flow-state changes; badge inherits existing pill semantics)

---

## Task Sequence

### 1. Extend `injectUserMessage` origin union with `council:peer`

| | |
|---|---|
| **Domain** | Backend/protocol expert × Carmack — EC-16 (idle-timer skip on server-originated frames) + EC-5 (strict-on-discriminator) |
| **Ref** | `conventions.md` → EC-16; `references/quality-backend.md` → Principle 1 |
| **Depends on** | — |

The existing `injectUserMessage(sessionId, content, origin?: "server:cron"|"server:agent"|"server:rest")` already gates the `userFrameObservers` fanout (idle-timer `noteUserMessage`) on `origin.startsWith("server:")`. Widening the union to include `"council:peer"` requires three changes: the type, the routing signature in `routeBrowserMessage`, and the skip predicate (which must now match `server:` OR `council:peer` — peer traffic is neither user activity nor server-housekeeping but shares the "don't advance idle token" semantic). The EC-9 structured log line on injection learns the new origin tag for forensic.

### 2. Add peer-message formatter with 1KB cap + audit pointer

| | |
|---|---|
| **Domain** | Backend/protocol expert × Carmack — AP-3 (writer + reader colocated; one cross-process contract per file) |
| **Ref** | `conventions.md` → AP-3 |
| **Depends on** | — |

Co-locate `formatPeerMessage(sourceRole, severity, body, reviewPath)` and `PEER_MESSAGE_MAX_BYTES` (1024) inside `council-types.ts` alongside `CheckpointPayload` / `ObserverReviewPayload` — same shape, same module, single audit point. Formatter emits the `[from-observer: <severity>]` prefix, the claim, and (on overflow) a workspace-relative pointer back to the review file so the orchestrator's chat thread is an index, not an archive. Boundary tests cover 1023 / 1025 byte bodies.

### 3. Export `CANONICAL_ORCHESTRATOR_SEQUENCE` as a constant module

| | |
|---|---|
| **Domain** | Persistence/process expert × Carmack — Single source of truth |
| **Ref** | `references/quality-persistence.md` → Principle 1 |
| **Depends on** | — |

The 9-step sequence (`/prime → /spec-writer → /council-plan → /council-implement → /council-review → /test-architect → /self-improvement → /learn → /self-reflect`) becomes a frozen exported array in a new `web/server/canonical-sequence.ts` module — pure data, no I/O. The orchestrator-system-prompt loader (deferred to a follow-up) and any UI start-banner consume the same constant. Test asserts `deepEqual` against the spec list (not substring) to defend Story 1.1 AC without the substring-pass failure mode (`feedback_i18n_test_assert_key_not_substring`).

### 4. Server-side convergence tracker (clean-cycle counter + revoke)

| | |
|---|---|
| **Domain** | Backend/protocol expert × Carmack — AP-1 (coordinator decoupled via DI) + AP-2 (state machine owns lifecycle events) |
| **Ref** | `conventions.md` → AP-1 + AP-2; `references/refactoring.md` → Principle 3 |
| **Depends on** | — |

New module `web/server/convergence-tracker.ts` listens for `group:review` events and maintains per-group `cleanCycleCount`. When a review has zero STOP-severity findings, increment; when ANY STOP arrives, reset to 0 (and emit `convergence:revoked` if previously converged). On reaching threshold (default 3) emit `convergence:converged` and persist a `converged` checkpoint via `writeAtomicJson` — the audit-trail boundary (`🚫 Never: replace filesystem checkpoints with a transient channel`) is preserved. Tracker exposes pure functions for tests: `nextStateAfterReview(state, hasStop, threshold)` returns `{state, cleanCycleCount, event}` without side effects; the live wiring composes pure logic with the atomic-write effect.

### 5. Extend `GroupRecord` with convergence fields + broadcast

| | |
|---|---|
| **Domain** | Frontend/React expert × Carmack — Single source of truth (server publishes; frontend never derives local counter) |
| **Ref** | `references/quality-frontend.md` → Principle 2 |
| **Depends on** | Task 4 |

Add to `web/server/session-types.ts` `GroupRecord`: `cycleNumber?: number`, `convergenceThreshold?: number`, `convergenceState?: "in-progress" | "converged" | "revoked"`. Update the broadcast surface (`group_status` / `group_created` payloads) so frontend reads server truth. Frontend re-export in `web/src/types.ts` requires no change beyond the inherited shape. Defends Story 4.1.5 — badge data is server-authoritative; frontend never decides "converged" itself.

### 6. Extend `deriveObserverPanelState` + render badges in `StatusPill`

| | |
|---|---|
| **Domain** | Frontend/React expert + a11y expert × Carmack — Derived state at the render boundary (pure function of `(group, findings, dismissedStopIds, nowMs)`) |
| **Ref** | `references/quality-frontend.md` → Principle 4; WCAG 4.1.3 (status messages) |
| **Depends on** | Task 5 |

Add `cycle-progress` and `converged` variants to the existing `ObserverPanelState` discriminated union, slotted into the priority ladder ABOVE `sleeping` but BELOW `degraded`/`blocker-found`/`reconnecting` so the spec's "convergence freezes during degraded" semantic falls out of existing ordering with zero new conditionals. `StatusPill` switch adds three rendered cases: `🔄 Cycle <N>/<threshold>`, `✅ Converged — ready to ship` (`emerald-500` token), `⚠️ Degraded` (existing `amber-500`). a11y: emoji `aria-hidden`, non-emoji equivalent ("Cycle 2 of 3", "Converged — ready to ship", "Degraded") provides the same signal under WCAG 1.4.1. Update `Playground.tsx` mocks per CLAUDE.md mandate.

### 7. Beck verifier triad — peer-skip, truncation boundary, convergence lifecycle

| | |
|---|---|
| **Domain** | Testing expert × Carmack — Test names reveal intent; assert behaviour, not presence |
| **Ref** | `references/quality-testing.md` → Principle 1, 2, 3 |
| **Depends on** | Tasks 1, 2, 4 |

Three new test files, each anchored to a memory-recorded failure mode:
- `ws-bridge.peer-origin.test.ts` — spy on `noteUserMessage`, assert ZERO calls when origin is `council:peer`, ONE call for human frame. Guards `feedback_verify_test_bodies_not_just_names`.
- `council-peer-truncation.test.ts` — boundary at 1023 (untouched) and 1025 (truncated + audit pointer resolvable). Guards `feedback_call_site_presence_not_just_symbol_export`.
- `convergence-tracker.test.ts` — drive 3 sequential 0-STOP reviews → assert `converged` emit; drive a 4th with a STOP → assert `revoked` + counter reset to 0. Key spies by `checkpointId` per `feedback_parallel_test_fakes_keyed_by_input`. Pure-function `nextStateAfterReview` table-driven test covers all transitions.

---

## Risks & Watchpoints

- **EC-4 watcher debounce vs converged checkpoint:** the new `converged-*.json` filenames must NOT collide with existing `<phase>.json` debounce buckets (`(file, mtimeNs)` keying already covers this, but the new phase tag should land in the filename for human grep).
- **EC-13 5-min observer failsafe coexistence:** the converged checkpoint is event-shaped; the failsafe poll will see it as just another unseen checkpoint. The observer's behaviour on `phase: "converged"` should be no-op (no review file), but that contract is held in the observer prompt (out of scope for this plan; document in EC-27).
- **Counter reset semantics under degraded state:** spec Story 4.1.5 — "convergence counter freezes (does not advance during degraded state)". The tracker MUST consult group status before incrementing; freeze-not-reset is the contract. Test must drive a `degraded` event between clean cycles and assert the counter did not advance OR reset.
- **Frontend persistence:** the new GroupRecord fields are server-authoritative; if a frontend store hydration overwrites them with stale localStorage, the badge will lie. Hydration test must assert server-pushed values win.

---

## External Setup Required

No external setup required. All tasks can be implemented within the codebase. No new env vars (convergence threshold defaults to 3 in-code; spec's `COMPANION_CONVERGENCE_THRESHOLD` is a Phase 3 concern). No new ports. No CI changes.

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | Extend injectUserMessage origin union with `council:peer` | Backend/protocol | — |
| 2 | Peer-message formatter with 1KB cap + audit pointer | Backend/protocol | — |
| 3 | Export CANONICAL_ORCHESTRATOR_SEQUENCE constant | Persistence/process | — |
| 4 | Server convergence tracker (counter + revoke + checkpoint emit) | Backend/protocol | — |
| 5 | Extend GroupRecord with convergence fields + broadcast | Frontend | 4 |
| 6 | Extend ObserverPanelState + StatusPill badges (a11y-clean) | Frontend + a11y | 5 |
| 7 | Beck verifier triad (peer-skip, truncation, convergence lifecycle) | Testing | 1, 2, 4 |

## Verdict

The structural keystone is **Task 1** — extending the EC-16 origin discriminator is the single bottleneck primitive every other peer-message task (formatter, tracker fanout) ultimately routes through. Without `council:peer` as a first-class tag, peer traffic either launders through `server:agent` (audit gap) or hacks the skip predicate at the call site (the laundering the convention forbids). Pair the work in build order: Task 1 unlocks Task 7's first verifier; Tasks 2-4 are independent and parallel-friendly; Tasks 5-6 are a tight pair gated on Task 4's emit shape. If a pair agent is valuable during build, name the backend/protocol expert — Task 4's pure-vs-effectful split is the slice most likely to absorb structural feedback.
