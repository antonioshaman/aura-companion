# Council Plan (Aura): Orchestrator Idle Auto-Proceed

**Plan written to:** `PLAN-aura-orchestrator-idle-auto-proceed.md`

**Scope:** Opt-in idle timer on orchestrator-half council sessions that fires a synthetic, versioned `[auto-proceed:idle-timeout v1]` `user_message` frame after N minutes of awaiting-user-input, capped at 10 consecutive iterations, with restart-durable counter, secrets-redacted AFK summary, and a five-state UI indicator. The loaded skill (council-plan-aura / implement / review — already (b)-modified today) recognises the directive and proceeds with best judgment marked `(unconfirmed)`.

**Context:** Aura Companion's Council pipeline is end-to-end working (PR #8 wake bridge + PR #10 checkpoint producer + PR #11 coverage backfill, validated by smoke test 2026-05-13). The orchestrator and observer halves both spawn as `claude -p` non-interactive subprocesses; observer wakes on filesystem checkpoint, orchestrator currently awaits user input on every gate. This feature mirrors the observer-wake pattern *for the orchestrator half*: the bridge already has `sendUserFrameFromServer` (currently used to wake the observer); we add a new TRIGGER (idle timer + state machine + cap) without changing the wire format.

**Boundaries:** No auto-implementing observer STOPs. No auto `git push/commit/gh pr`. No multi-hour unbounded runs (10-iteration cap is the bound; raising ≥10 is an "ask first" event). No changes to the existing observer pipeline (regression-invariant: `scripts/smoke-test-council-checkpoint.sh` MUST PASS UNCHANGED). No bypass of the per-session permission profile (EC-1) — synthetic frames take the same `can_use_tool` path as a user-typed message.

**Council dispatched:** 12 subagents — Hunt (security, 7 recs), Fowler (refactoring, 5 recs), Backend Bun/Hono/TS (7 recs), Persistence FS-JSON (8 recs), Realtime/NDJSON Protocol (8 recs), Subprocess Lifecycle (8 recs), React/Web UI (7 recs), a11y Auditor (8 recs), Saarinen UI Quality (7 recs), Friedman UX Quality (8 recs), Willison LLM Pipeline (7 recs), Deploy Docker+GHA (7 recs). All 12 returned non-empty recommendations.

---

## Task Sequence

### 1. Versioned synthetic-frame envelope contract

| | |
|---|---|
| **Domain** | Willison (LLM Pipeline) × Carmack — Principle 7 (model/CLI portability), Principle 9 (deterministic same-bytes-same-effect) |
| **Ref** | `references/quality-llm.md` → Principle 7, 9 |
| **Depends on** | — |

Define a single shared module that exports the literal prefix `[auto-proceed:idle-timeout v1]` plus a closed-key JSON envelope schema (`directive`, `iteration`, `max_iterations`, `paused_at`, `phase`, `group_id`). Both the producer (server) and the consumer (skill recognition canary in Task 2) gate on the version token; unknown versions are refused. Per-field validators are semantic-category-split per `feedback_validator_per_semantic_category` — `phase` is bounded-token (no whitespace), `paused_at` is `isIsoTimestamp`, `group_id` reuses the cryptographic-group-id pattern. Body must be exactly one line (no embedded newlines — NDJSON splitter trap per Realtime). Cross-ref: Hunt also informed this — see Risks & Watchpoints.

---

### 2. Skill recognition static-grep canary

| | |
|---|---|
| **Domain** | Willison (LLM Pipeline) × Carmack — Principle 3 (rule-based gate) |
| **Ref** | `references/quality-llm.md` → Principle 3 |
| **Depends on** | Task 1 |

CI test that mechanically asserts the three council-aura skill files contain the exact recognition prefix `[auto-proceed:idle-timeout v1]` AND the structured-envelope handling clause, using regex over `\w+` placeholders per `feedback_static_grep_canary_regex_over_substring`. Per `feedback_council_documented_contract_canary` — the SKILL.md text is documentation, not enforcement; this canary IS the enforcement. Failing canary blocks merge.

---

### 3. Injected clock seam (`ClockSource` DI)

| | |
|---|---|
| **Domain** | Fowler (Refactoring) × Carmack — Principle 7 (tests coupled to implementation) |
| **Ref** | `references/refactoring.md` → Principle 7 |
| **Depends on** | — |

Add a `ClockSource` interface in `session-types.ts` exposing `now(): number` and `schedule(fn, ms): { cancel(): void }`. Real impl wraps `Date.now()` + `setTimeout`/`clearTimeout` with `.unref()`. Inject via constructor at the orchestrator-coordinator level (AP-1 precedent). Tests substitute a deterministic fake that drives `now` and the schedule queue manually — no `vi.useFakeTimers` gymnastics, no 5-minute wallclock test sleeps. Per EC-11, this is the explicit clock-tick subscription that wallclock-anchored derivation requires. Cross-ref: Backend also recommended this — same task.

---

### 4. `orchestratorTurnState` + `orchestrator:turn-done` event

| | |
|---|---|
| **Domain** | Fowler (Refactoring) × Carmack — Principle 4 (names reveal design), Principle 3 (eliminate impossible states) |
| **Ref** | `references/refactoring.md` → Principle 4 |
| **Depends on** | — |

Add `orchestratorTurnState` to `claude-adapter.ts` as a discriminated union — NOT a boolean — mirroring the existing `observerTurnState` precedent at line 144: `{ kind: "in-flight" } | { kind: "awaiting-input"; blockedByStop: boolean }`. Emit a new `orchestrator:turn-done` event in `event-bus-types.ts` on the in-flight→awaiting-input transition, gated on whether the session is the orchestrator-half of an active council group. The `blockedByStop` axis encodes JS-3 (STOP pauses timer) in the type system. Cross-ref: Subprocess and Backend also informed this — same task.

---

### 5. Resolving path wrapper for `.council/state/`

| | |
|---|---|
| **Domain** | Persistence (FS-JSON) × Carmack — Principle 6 (slug + path validation) + EC-7 |
| **Ref** | `references/quality-persistence.md` → Principle 6 |
| **Depends on** | — |

One helper — `resolveCouncilStatePath(workspaceRoot, groupId, suffix)` — that calls the existing group-id-pattern validator from `council-types.ts`, joins under `<workspaceRoot>/.council/state/`, calls `path.resolve`, and asserts the result `startsWith(path.resolve(stateDir) + path.sep)`. Both the trace writer AND the afk-summary writer MUST go through this single wrapper; duplicating the join inline is the EC-7 violation pattern. Normalises slug to lowercase for macOS/Linux consistency.

---

### 6. Persistence layer — trace JSON + afk-summary writer

| | |
|---|---|
| **Domain** | Persistence (FS-JSON) × Carmack — Principle 4 (append-only logs split lines), Principle 8 (schema versioning), Principle 9 (cross-fs rename) |
| **Ref** | `references/quality-persistence.md` → Principle 1, 4, 8, 9 |
| **Depends on** | Task 5 |

Two new artefacts per active council pair, both written via the resolving wrapper from Task 5:
- `<group-id>-auto-proceed-trace.json` — via existing `writeAtomicJson`, schema: `{ schemaVersion: 1, sessionGroupId, iterationCount, firedAt: ISO[], cappedAt: ISO|null, lastObjectiveGateResult: "pass"|"fail"|null }`. Reader rejects unknown `schemaVersion` LOUDLY (never silent-default).
- `<group-id>-afk-summary.md` — append-only with `O_APPEND`, each entry ≤ PIPE_BUF (4KB) JSON-block-in-markdown so single `write(2)` is atomic. First-byte schema marker `<!-- afk-summary v1 -->` written once at file creation; reader refuses to append to mismatched-version files.

Confirm `writeAtomicJson` tmp file is co-located with target (same FS, same dir) — cross-FS rename is not atomic. Both files retained on archive (audit trail); explicit purge endpoint only. Cross-ref: Hunt — see secrets redactor in Risks & Watchpoints.

---

### 7. `idle-timer-manager.ts` — DI-owned module

| | |
|---|---|
| **Domain** | Fowler (Refactoring) × Carmack — Principle 6 (missing boundaries where they matter), Principle 1 (economic test) |
| **Ref** | `references/refactoring.md` → Principle 6, 1 |
| **Depends on** | Tasks 3, 4, 5, 6 |

New module owned by session-orchestrator via DI (mirrors AP-1 SessionGroupCoordinator pattern). Owns:
- Per-session timer registry (field on session record, NOT global Map — cleanup inherits existing teardown ladder).
- Arm-on-awaiting-input gated by AND of: `state="connected"`, `sessionGroupRole="orchestrator"`, group `status="active"`, `orchestratorTurnState.blockedByStop=false`, reconnect-grace not in progress.
- Cancel-on-user-message via a monotonic `turnToken` minted at arm; fire path re-reads the current turnToken under the same lock that processes inbound user frames and aborts if mismatched (Hunt — race-window defence).
- Iteration counter persisted to disk BEFORE fire (Task 6 writer), force-flush bypasses 150ms debounce.
- Fire callback: fresh lookup of session state, try/catch around send, on session-exit between schedule and dispatch — silent skip + EC-9 log line.

Cross-ref: Backend, Subprocess, Hunt, Realtime also informed this — same task.

---

### 8. State-machine integration via `applyEvent`

| | |
|---|---|
| **Domain** | Fowler (Refactoring) × Carmack — Principle 3 (global data / wide-scope mutation) + AP-2 |
| **Ref** | `references/refactoring.md` → Principle 3 |
| **Depends on** | Task 7 |

Extend `group-state-machine.ts` with auto-proceed-relevant events: `orchestrator_turn_idle`, `orchestrator_turn_active`, `stop_finding_raised`, `stop_finding_resolved`, `auto_proceed_fired`, `iteration_cap_tripped`. `deriveSideEffects` table decides arm/disarm/persist/log actions and the timer manager from Task 7 is the executor. This preserves AP-2 (state-machine as single source of truth) and keeps EC-9 log fanout coherent with existing `group:*` events.

---

### 9. Boot reconcile + SIGTERM drain

| | |
|---|---|
| **Domain** | Persistence (FS-JSON) × Carmack — Principle 3 (sentinel rows, close every state on every exit path) + EC-12 |
| **Ref** | `references/quality-persistence.md` → Principle 3 |
| **Depends on** | Tasks 6, 7 |

In `session-orchestrator.initialize()`, after sessions load from disk, scan `<workspace>/.council/state/*-auto-proceed-trace.json` and rehydrate iteration counters into the in-memory timer manager. Skip orphan files (sessionGroupId mismatch) and unknown-schemaVersion files at WARN level. In `group-shutdown.ts` SIGTERM path: `timerManager.disposeAll()` is the FIRST step, then flush pending trace writes, then propagate SIGTERM to children. EC-2 invariant extends naturally: mark timers cleared BEFORE kills propagate. Cross-ref: Deploy, Subprocess also informed — same task.

---

### 10. Hono boundary validation + opt-in flag persistence

| | |
|---|---|
| **Domain** | Bun/Hono/TS Backend × Carmack — Principle 2 (validate at the boundary), Principle 8 (type safety) |
| **Ref** | `references/quality-backend.md` → Principle 2, 8 |
| **Depends on** | — |

In `routes.ts` `/sessions/create` and `/sessions/create-stream`: parse `body.autoProceedOnIdle: { idleMs: number, maxIterations: number }` through a strict validator (Zod or hand-typed with structural identity to the `session-types.ts` type). Reject `NaN`, `±Infinity`, non-finite, negative, non-integer; clamp `idleMs` into `[5_000, 3_600_000]`, `maxIterations` into `[1, 10]` (raising above 10 is an "ask first" gate per spec Boundaries). Collapse omit/`false`/`null`/`undefined` all to `undefined` on the session record (tri-state-collapse at the boundary makes the regression invariant grep-auditable). Field on session record is `readonly autoProceedOnIdle?: { readonly idleMs; readonly maxIterations }`. IDOR check via existing auth path. Cross-ref: Hunt also informed — same task.

---

### 11. Synthetic-frame send pipeline + first-class recording

| | |
|---|---|
| **Domain** | Realtime (NDJSON Protocol) × Carmack — Principle 4 (broadcast fan-out / send ordering), Principle 6 (control_request ack discipline), Principle 7 (protocol drift) |
| **Ref** | `references/quality-realtime.md` → Principle 4, 6, 7 |
| **Depends on** | Tasks 1, 7 |

Add a per-session outbound FIFO queue ahead of `claude-adapter.sendUserFrameFromServer` so synthetic and real user frames cannot interleave at the OS write level. Permission gate (EC-1) preserved — synthetic frames take the same `can_use_tool` path; explicit denylist of `git push`, `git commit`, `gh pr create/merge` enforced at the permission-gate layer (not skill prose). Server-side single-firer gate: in multi-tab fan-out, only ONE auto-proceed fires per session; "user input observed" is the UNION across all attached browser sockets. Every synthetic frame recorded to `~/.companion/recordings/` with `synthetic: true` marker so post-hoc replay distinguishes server-injected from user-typed. Idle-kill 4h timer NOT reset by synthetic frames (Subprocess Rec1). Cross-ref: Subprocess, Hunt, Willison also informed — same task.

---

### 12. Browser wire variant + auto-proceed store slice

| | |
|---|---|
| **Domain** | React/Web UI × Carmack — Principle 4 (WebSocket-driven state, single write path), Principle 8 (exhaustive discriminated union) + EC-11 |
| **Ref** | `references/quality-frontend.md` → Principle 4, 8 |
| **Depends on** | Task 11 |

Add `auto_proceed_status` as a new typed variant on `BrowserIncomingMessage` (discriminated by closed `state` enum: `"armed" | "firing" | "fired" | "cancelled" | "paused_by_stop" | "cap_reached"`), carrying `armedAtMs`, `deadlineMs` (absolute wallclock, not relative remaining-ms), `iteration`, `maxIterations`, `seq` (monotonic per session for reconnect-replay). Strict parsers per EC-5 reject unknown `state` values. New `auto-proceed-slice.ts` in store (separate from council-slice — different lifecycle, different consumers). Single module-level `setInterval(() => store.setState({ tickMs: Date.now() }), 1000)` on a `clock-slice` provides the wallclock anchor for the countdown per EC-11 — NOT per-component `setInterval`. ws.ts dispatches to `setAutoProceedStatus(sessionId, status)`; components NEVER call it directly. Cross-ref: Realtime also informed — same task.

---

### 13. `AutoProceedChip` component + a11y discipline

| | |
|---|---|
| **Domain** | React/Web UI × Carmack — Principle 8 (exhaustive discriminated union renderer) + EC-10 |
| **Ref** | `references/quality-frontend.md` → Principle 8 |
| **Depends on** | Task 12 |

`AutoProceedIndicatorState` union with five `kind`s (`disabled | idle | armed | blocked-by-stop | cap-reached`); renderer uses `switch (state.kind) { ... default: const _: never = state; }` so adding a sixth variant compile-fails (EC-10). Visual: fixed-width tabular numerals (`font-variant-numeric: tabular-nums`) for the countdown — no width jitter; static chip (no pulse — animation budget reserved for state transitions only, 150ms crossfade, respects `prefers-reduced-motion`); five semantic role tokens (info-muted / warning-muted / etc.) not five raw hues; same elevation as ProviderBadges; placed RIGHT of ProviderBadges, LEFT of unread-STOP counter with 8px gap; opacity-not-display-none on disabled state to prevent layout shift. a11y: visible chip text NOT in aria-live; separate `role="status" aria-live="polite" aria-atomic="true"` sibling region announces transitions only (never the per-second tick). No focus move on synthetic-message arrival. Text + icon, not color-only signalling. Chip non-interactive default — if "view trace" affordance added later, full `<button>` with `:focus-visible` ring. Playground entries covering all 5 variants + tests: render, axe (`toHaveNoViolations`), state-transition with injected fake clock asserting aria-live announce ordering, count-text mutation across deadline boundary. Cross-ref: a11y, Saarinen also informed — same task.

---

### 14. AFK Summary surface + New Session form opt-in

| | |
|---|---|
| **Domain** | Friedman (UX) × Carmack — Principle 2 (design all five screen states), Principle 9 (trust through reasoning visibility) |
| **Ref** | `references/quality-ux.md` → Principle 2, 9 |
| **Depends on** | Task 13 |

Two surfaces:
- **AFK Summary above-chat banner** when user returns and `firedCount > lastSeenFiredCount`: compact card titled "Auto-proceed ran N times while you were away — review or accept", info-token (not destructive — auto-proceed itself isn't an alarm), vertical list of `(unconfirmed)` decisions each with one-line claim + "Jump to message" link that scrolls transcript without stealing focus. Stacking under `BlockerBanner` when both exist (BlockerBanner first — STOP dominates). Per-item `Accept` and `Revisit` buttons. Dismiss only after explicit per-item resolution. Sidebar entry in ObserverPanel FindingsLog as synthetic non-finding entry (info-tier) so the record survives banner dismissal.
- **New Session form toggle**: checkbox "Auto-proceed when idle — 5 min · 10 iterations max" with the two numbers inline-editable. Same vocabulary as the header chip so users don't re-learn on return.

Cap-reached state offers `Approve 10 more` + `Stop auto-proceed for this session` buttons (per Friedman Rec6) — not a dead-end disabled state. Cross-ref: Saarinen, React also informed — same task.

---

### 15. Replay regression + sibling smoke test + coverage gate

| | |
|---|---|
| **Domain** | Realtime × Beck (Test Quality) × Carmack — Principle 4 (recording-based replay), Principle 7 (replay regression for load-bearing parsers) + EC-6 |
| **Ref** | `references/quality-realtime.md` → Principle 7, `quality-deploy.md` → Principle 6 |
| **Depends on** | Tasks 11, 13 |

Three deliverables:
- **Replay test:** capture one canonical synthetic-frame send to `~/.companion/recordings/`; commit stripped fixture to `web/server/__fixtures__/auto-proceed-frame.jsonl`. Vitest replay asserts the `out`/`cli` frame body matches regex `^\[auto-proceed:idle-timeout v1\]` AND the parser-level synthetic marker equals `"server.autoProceed"`. Two-axis check survives renames on either side.
- **Sibling smoke test:** `scripts/smoke-test-auto-proceed.sh` creates a council pair with `autoProceedOnIdle: { idleMs: 2000, maxIterations: 3 }`, waits for the synthetic frame to fire, asserts `.council/state/<group-id>-afk-summary.md` and `-auto-proceed-trace.json` exist and parse. Existing `scripts/smoke-test-council-checkpoint.sh` MUST PASS BIT-IDENTICALLY (regression-invariant — fail the PR if this script's output diff is non-empty).
- **Coverage gate:** every new file in this PR lands at ≥80% line coverage in the same commit per `feedback_file_level_coverage_gate_cascade`. New module boundaries (timer-manager, persistence helpers, store slice, AutoProceedChip) keep coverage local to avoid the god-module cascade trap.

Cross-ref: Deploy also informed — same task.

---

## Risks & Watchpoints

- **Willison — Output validator for `(unconfirmed)` token presence:** After each synthetic fire, the server should scan the orchestrator's next assistant turn for `(unconfirmed)` markers in known-unilateral phases. Absence = contract violation. Blocks cap-counter advance in strict mode. Consider whether v1 ships with this validator or defers to v2; spec's "structurally impossible to bypass cap" is weaker without it.
- **Hunt — Secrets redactor on persistence write:** afk-summary and trace files record prompts that can legitimately contain pasted env values / tokens. Pattern-match known secret shapes (`sk-…`, `ghp_…`, `xox[bpoa]-…`, AWS `AKIA…`, JWT `eyJ…`, generic `[A-Z0-9_]{16,}=`) and substitute `[redacted:<kind>]` before `writeAtomicJson`. Same redactor for EC-9 log lines. File mode `0600`, dir `0700`.
- **Hunt — Trace file untrusted on read-back:** Server-side reader must re-parse JSON with strict typed parser (EC-5 pattern from `council-types.ts`), reject unknown fields, bound array sizes, validate `sessionGroupId` field equals expected group. Never render markdown summary as HTML (XSS surface).
- **Subprocess — Auto-relaunch counter cascade:** If CLI crashes mid-auto-proceed and `--resume` succeeds, consecutive-fires counter must persist (Task 9 boot reconcile covers this); also apply a "stable for N minutes" gate before re-arming the idle timer on the freshly-relaunched CLI to avoid crash-loop tickle.
- **Realtime — Recording must not be silently skipped:** When `COMPANION_RECORD=0`, either auto-proceed declines to fire or logs loud warning. Auditing requires the exact synthetic bytes.
- **Saarinen — `<HeaderChip>` primitive extraction:** If ProviderBadges and unread-STOP counter aren't already abstracted into a shared chip primitive, this PR is the moment to extract. Pair with Fowler — economic test still applies.
- **a11y — afk-summary in-UI rendering:** If the AFK Summary banner eventually renders the markdown file content directly (rather than just listing decisions from the wire payload), use semantic `<h2>`/`<h3>`/`<ul>`/`<time datetime>` so screen-reader users can navigate by heading.
- **Friedman — Loud cancellation toast:** "Type to cancel" feedback (2-second toast transition from `Armed — 4:32` → `Cancelled — type your message`) is UX polish; not v1 blocker but reduces user-mental-model surprise on subsequent re-arm.
- **Willison — Per-decision citation:** Each AFK-summary entry should cite the specific `(unconfirmed)` assumption text it relied on + the prompt the orchestrator was answering. Requires skill cooperation beyond `[auto-proceed:idle-timeout]` recognition; consider v2 of the envelope schema.
- **Deploy — Dockerfile + `.dockerignore` audit:** `.dockerignore` must continue excluding `.council/state/`; runner stage's `USER bun` must retain write permission on workspace-mounted `.council/state/`. No new layers expected; verify with one-line assertion in image smoke test.
- **Friedman — First-run nudge:** First-ever AFK fire per workspace shows a one-line preamble in the AFK summary card ("First time using auto-proceed? You can review or accept each decision below."). Dismiss once, never again per-workspace. Defer to UX polish.

---

## External Setup Required

| # | What | Why | Blocking task |
|---|------|-----|---------------|
| 1 | Document `COMPANION_ORCH_IDLE_AUTO_PROCEED_DEFAULT_MS` env var (default 300_000, range 5_000–3_600_000) in README or `.env.example` | Operators need to know how to globally override the per-session default | Task 9 |
| 2 | Document `COMPANION_ORCH_AUTO_PROCEED_MAX_ITERATIONS_CEILING` env var (default 10) — server refuses to start with values higher than ceiling unless explicit `--allow-elevated-cap` flag set | Hardens against runaway in deploys where the operator wants to enforce a maximum bound across all sessions | Task 9 |

Both env vars are optional. No new secrets required, no new GHA permissions, no `pull_request_target` step, no new third-party action invocations. Workflow `permissions:` block must not be modified by this feature's PR — verify with `git diff main -- .github/workflows/`.

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | Versioned synthetic-frame envelope contract | Willison | — |
| 2 | Skill recognition static-grep canary | Willison | 1 |
| 3 | Injected ClockSource DI | Fowler | — |
| 4 | orchestratorTurnState + orchestrator:turn-done event | Fowler | — |
| 5 | Resolving path wrapper for .council/state/ | Persistence | — |
| 6 | Persistence layer — trace JSON + afk-summary writer | Persistence | 5 |
| 7 | idle-timer-manager.ts DI-owned module | Fowler | 3, 4, 5, 6 |
| 8 | State-machine integration via applyEvent | Fowler | 7 |
| 9 | Boot reconcile + SIGTERM drain | Persistence | 6, 7 |
| 10 | Hono boundary validation + opt-in flag persistence | Backend | — |
| 11 | Synthetic-frame send pipeline + first-class recording | Realtime | 1, 7 |
| 12 | Browser wire variant + auto-proceed store slice | React | 11 |
| 13 | AutoProceedChip component + a11y discipline | React | 12 |
| 14 | AFK Summary surface + New Session form opt-in | Friedman | 13 |
| 15 | Replay regression + sibling smoke test + coverage gate | Realtime × Beck | 11, 13 |

## Verdict

The most important architectural decision in this plan is **routing arm/disarm through the existing `applyEvent` state machine (Task 8) rather than spawning a parallel mutator alongside it**. Two sources of truth for "is the orchestrator awaiting user input" is the same dual-write pattern EC-2 was introduced to prevent — and the entire spec's regression-invariant ("opt-out is bit-identical") only holds if arm/disarm is a clean side-effect of the existing event surface, not a sibling state machine. Fowler's domain is the critical lane.

Start at **Task 1** (envelope contract) so the synthetic-frame body shape is locked before any sender, parser, replay test, or skill canary depends on it; ship Tasks 1–4 as one "foundation" PR with hot tests, then Tasks 5–9 as "persistence + timer + state-machine" PR, then Tasks 10–11 as "boundary + send pipeline" PR, then Tasks 12–15 as "frontend + regression suite" PR. Four-PR sequence keeps reviews under 600 lines each and the regression-invariant gate (Task 15) is the final guardrail.

Pair agent recommendation: **@pair-fowler during Tasks 7, 8** (timer manager + state machine — highest god-module risk on the server side). Carmack's line — *don't plan what isn't needed* — the deferred risks (output validator, per-decision citation, loud cancellation toast, first-run nudge) are explicitly v2 candidates. Ship v1 with the regression-invariant intact; iterate from production signal.
