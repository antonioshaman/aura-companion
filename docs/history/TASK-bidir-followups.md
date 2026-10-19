# Bidirectional Pipeline — Follow-up Tasks

Captured from spec `council-mode-bidirectional-pipeline.md` A/B test #3 judge findings (`/tmp/abtest3-judge-decision.md`). v2 shipped the Phase-1+2+5 slice wired end-to-end; v1 went broader on the scaffold and surfaced these architectural defects (judge-verified by grep against production code).

## P1 — Verified production-breaking (grep-positive)

### 1. Group-id validator regex drift
- **File:** `web/server/group-authorization.ts` (existing) vs sanitiser regex in v1's `peer-message-sanitiser` scaffold
- **Bug:** Production mints `grp_<32 hex>` ids (`GROUP_ID_PATTERN = /^grp_[a-f0-9]{32}$/`). v1's sanitiser used `^g_[A-Za-z0-9_-]{1,128}$` — rejects every real id.
- **Fix:** Import `GROUP_ID_PATTERN` from `group-authorization.ts` into any new module that validates group ids. Single source of truth.
- **Test:** Cross-module contract canary — `grp_<32 hex>` must pass every sanitiser/validator that touches group ids.

### 2. `transition()` declared pure but calls `Date.now()` directly
- **File:** v1's `convergence-state-machine.ts` (not in current diff yet, but documented in v1's bundle lines 1104/1138/1147)
- **Bug:** State transition documented as pure but `Date.now()` on three branches → replay determinism broken, `acknowledgeRevoke` dwell-gate untestable.
- **Fix:** Add `atMs` field to `cycle_clean` / `cycle_p1` / `gates_failed` events. Stamp `atMs` at coordinator boundary (impure layer), not inside `transition()` (pure layer).
- **Test:** Property-based test asserting `transition(state, event)` is identical across two calls with the same args.

### 3. `convergence_state.seq` shadowed by transport counter
- **File:** `web/server/ws-bridge-replay.ts:52`
- **Bug:** Bridge does `const sequenced = { ...msg, seq }` — overwrites application-domain `seq` field with transport counter. v1's `convergence_state.seq` is silently corrupted.
- **Fix:** Rename application-domain field to `convergenceSeq` (or namespace-prefix it) to avoid shadow.
- **Test:** Assert that messages with both transport `seq` and application `convergenceSeq` survive the bridge with both fields intact.

## P2 — Self-acknowledged shipping risk (v2 P1)

### 4. Tag-injection in `formatPeerMessage`
- **File:** `web/server/peer-message-formatter.ts:_` (v2's diff)
- **Bug:** Formatter doesn't escape `[from-X]` markers from peer payload. Cross-half prompt-injection vector.
- **Fix:** JSON-escape or regex-strip `[from-` patterns from peer body before formatting envelope.
- **Test:** Property test — peer payload containing `[from-observer: STOP]` must NOT propagate as authoritative finding.

## P2 — UI gaps

### 5. Story 4.1.5 Sidebar badge scope drift
- **File:** Spec says "upper-left header attached to pair-label slot". v2 (X) put badge in `ObserverPanel` `StatusPill`.
- **Fix:** Add Sidebar header badge mirroring `commit ec93eab feat(sidebar): council role decoration`.
- **Test:** Sidebar test asserts pair-label slot renders the convergence pill.

### 6. `revoked` UI variant absent
- **File:** `ObserverPanel.tsx` / `observer-panel-state.ts`
- **Bug:** When convergence is revoked (P1 found after green), UI silently collapses to `cycle-progress` — the silent trust-break the spec specifically warns against.
- **Fix:** Add `revoked` discriminated variant + distinct visual treatment (warning palette, not green, not loading).
- **Test:** `deriveObserverPanelState` test for revoked transition.

## P3 — Phase 3-6 not implemented

v2's scope was deliberately Phase 1+2+5. Phases 3/4/6 (memory propagator, liveness monitor, Docker wiring) remain. Pull from v1's scaffold (worktree `abtest/v1-bidir`, branch tagged `abtest/tie-v1-bidir-2026-05-17` for archive). v1's modules are PURE and well-tested but unwired — extract + wire in next iteration.

## P3 — Coverage gate backfill (carried from PR #65)

### 7. Backfill session-orchestrator.ts coverage above 80%
- **File:** `web/server/session-orchestrator.ts`
- **Why:** PR #65 added 52 LOC of ConvergenceTracker integration glue (lazy init + `attach()` in `initialize()`). Coverage dipped to 78.33% — god-module cascade per `feedback_file_level_coverage_gate_cascade` memory. Temporarily added to coverage-gate exclude list.
- **Fix:** Either (a) add integration test verifying `initialize()` attaches the tracker + the `isFrozen` lambda returns `true` for `degraded` / `reconnecting` group status, OR (b) refactor the convergence-attach block into a sibling file `session-orchestrator-convergence.ts` that gets its own 80%-covered test (memory's preferred path).
- **Remove from exclude list** in `.github/workflows/coverage-gate.yml` once back above 80%.

## Source

- A/B test #3 judge decision: `/tmp/abtest3-judge-decision.md`
- v1 (loser) worktree: `/home/auracomp/aura-companion-v1-test-3` on `abtest/v1-bidir` (review file: `.council/abtest/v1-bidir-review.md`)
- v2 (winner) worktree: `/home/auracomp/aura-companion-v2-test-3` on `abtest/v2-bidir` (merged to feat as `c30301b..c59eccd`)
- Coverage gate failure: PR #65 run https://github.com/antonioshaman/aura-companion/actions/runs/26004571947
