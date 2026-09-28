# Context Brief for Aura Council Review — Council Mode (paired sessions)

**Timestamp:** 2026-05-11-1953
**Scope:** 3 commits implementing Tasks 1–9 of `PLAN-council-mode-paired-sessions.md`. 22 new TypeScript files (11 source + 11 test) in `web/server/`, plus PLAN and spec markdown.

## What this code does

Adds "Council Mode" to Aura Companion: a paired-session feature where one workspace hosts two linked SDK CLI subprocesses — an **orchestrator** (the user-driving session) and an **observer** (a second LLM session that wakes on filesystem checkpoints, reviews artifacts, and surfaces findings back to the orchestrator). Supports `claude+claude` (default) and `claude+codex` (experimental) pairings. This batch implements the backend foundations: schema, group state, atomic write, FS watcher, lifecycle state machine, restart reconciliation, observer permissions, group authorization, and Codex JSON-RPC envelope validation. UI surface (Task 15) is NOT in this scope.

## Architecture (scoped area)

The feature is implemented entirely in `web/server/` as a set of small, mostly-pure modules layered ON TOP of the existing single-session machinery (`session-orchestrator.ts`, `cli-launcher.ts`, `ws-bridge.ts`, `session-store.ts`). New layout:

- **Schema layer** — `council-types.ts` (178 LOC) defines `CheckpointPayload` / `ObserverReviewPayload` shared by writer (orchestrator) and reader (observer wake handler). `session-types.ts` extended with `sessionGroupId: string | null` and `role: "orchestrator" | "observer" | null`.
- **Coordination layer** — `session-group-coordinator.ts` (184 LOC) owns the `groupId → { primaryId, observerId, role, status, watcher, abortController }` map. Delegates session creation back to existing `sessionOrchestrator.createSession(...)` — does NOT branch the single-session path.
- **Backend abstraction** — `backend-provider.ts` (51 LOC) is the seam for `ClaudeBackend` / `CodexBackend` (lifts the existing `if (backendType === "codex")` branches out of `cli-launcher.ts`).
- **Durability layer** — `atomic-write.ts` (52 LOC) tmp+rename+fsync helper; `checkpoint-watcher.ts` (95 LOC) FS watcher with AbortController binding, debounce, size cap, schema validation; `group-reconciliation.ts` (88 LOC) the 4-state restart reconciliation (both/orchestrator-only/observer-only/neither).
- **Lifecycle** — `group-state-machine.ts` (68 LOC) pure `transition(state, event)` discriminated union for pairing → active → degraded → archived + reconnecting.
- **Security layer** — `observer-write-policy.ts` (43 LOC) `isObserverWriteAllowed(absolutePath, workspaceRoot)` allowlist predicate; `observer-permissions.ts` (87 LOC) the narrow SDK permission profile applied at spawn; `group-authorization.ts` (47 LOC) the IDOR check that every group-touching REST handler must call; `codex-envelope.ts` (105 LOC) strict typed parser for Codex JSON-RPC frames.
- **Tests** — every source file has a paired `.test.ts` (mostly behaviour-on-realistic-inputs style, no mock theatre observed at glance).

## Stack in use within scope

- **Bun + Node fs/promises** for atomic writes and the watcher.
- **TypeScript strict** (typecheck passes clean).
- **Vitest** (all tests pass).
- **No Hono routes added** in this batch — Task 7 (group-authorization) implements the PREDICATE that routes will call; the actual route wiring isn't here.
- **No WebSocket/NDJSON path changes** in this batch — Task 12 (group event-bus fanout) not yet implemented; `codex-envelope.ts` provides the parser to feed into the bridge later.
- **No React / Tailwind / Zustand changes** — Task 15 UI not in scope.
- **No Dockerfile / GHA workflow changes** — Task 10/11 deploy work not in scope.
- **Subprocess spawn** — `backend-provider.ts` defines the seam but does NOT yet replace the call sites in `cli-launcher.ts` (verify in dispatch).

## Key observations

- 22 files / 2176 LOC across source+test. Modules are small (median ~85 LOC), well-scoped, paired with tests of comparable size — Beck-friendly shape.
- Per the PLAN, Task 4 (BackendProvider seam) is named as the structural keystone — if it leaks branching back into `session-orchestrator.ts`, every future change reasons about paired vs solo. Worth checking that the seam landed cleanly and didn't ship dead.
- Task 5 (atomic write + watcher) is named as the highest-leverage quality task — the historical "болтается" anti-pattern lives in watcher lifecycle. Worth checking AbortController binding, fsync-parent-dir, debounce, size cap, schema validation.
- Tasks 3, 7, 9 (observer-write-policy, group-authorization, observer-permissions + codex-envelope) are the "irreversible security decisions" per PLAN Verdict — wrong defaults here ship an IDOR. Per memory `feedback_no_sentinel_user_id_fallback`, sentinel-based fallbacks must never substitute for hard auth checks.
- Tasks 8, 10–15 are NOT in this scope. Reviewers should not flag "missing Task 10 graceful shutdown" — that's a planned follow-up, not a finding.
- No conventions.md at the project root yet — clean slate for Phase 7 candidates.
- Per the user's memory `feedback_council_review_multirepo_scoping`: review = full surface, no per-task scoping unless explicitly requested.

## Automated check results

- **typecheck (`bun run typecheck`)**: ✅ exit 0. No TypeScript errors anywhere in `web/`.
- **tests (`bun run test`)**: ✅ exit 0. Full Vitest suite (including all 11 new council `.test.ts` files) passes.
- **a11y (`bun run test:a11y`)**: ✅ exit 0. No axe violations on a11y-targeted tests. (Note: no new frontend components in this scope, so a11y delta is zero — but the existing suite stays green.)

All green. No pre-existing failures to subtract from review findings.

## Domain File Assignments

**Hunt (Security):** observer-write-policy.ts, observer-write-policy.test.ts, observer-permissions.ts, observer-permissions.test.ts, group-authorization.ts, group-authorization.test.ts, codex-envelope.ts, codex-envelope.test.ts, backend-provider.ts (spawn args / env). Cross-ref `session-types.ts` for sessionGroupId entropy review.

**Fowler (Refactoring):** council-types.ts (schema cohesion), session-group-coordinator.ts (potential god-module), group-state-machine.ts (discriminated union purity), backend-provider.ts (seam vs registry), session-types.ts (data clumps), group-reconciliation.ts (state vs state machine boundary).

**Bun/Hono/TS Backend Expert:** session-group-coordinator.ts, group-reconciliation.ts, checkpoint-watcher.ts, atomic-write.ts, backend-provider.ts, codex-envelope.ts (handler-side async/error discipline, resource lifecycle, structured logging).

**FS-JSON Persistence Expert:** atomic-write.ts, atomic-write.test.ts, checkpoint-watcher.ts, checkpoint-watcher.test.ts, group-reconciliation.ts, group-reconciliation.test.ts.

**Realtime/NDJSON Protocol Expert:** codex-envelope.ts, codex-envelope.test.ts. Cross-ref council-types.ts as the wire-shape for checkpoint payloads. (The actual ws-bridge integration is not in this batch.)

**Subprocess Lifecycle Expert:** backend-provider.ts, session-group-coordinator.ts (spawn delegation), group-reconciliation.ts (restart-after-server-crash path), observer-permissions.ts (per-subprocess SDK permission profile applied at spawn).

**Willison (LLM Pipeline):** observer-permissions.ts (observer SDK profile = blast-radius control on prompt injection), codex-envelope.ts (LLM-content boundary validation), council-types.ts (`ObserverReviewPayload` shape that observer LLM must produce). The observer system prompt artifact (Task 13) is NOT in scope — flag if any observer-side prompt is baked into code here.

**Beck (Test Quality):** ALL 11 `.test.ts` files AND their corresponding source files. Check: red-step proof, behavioural-vs-structure-coupled, mock count, happy-path coverage, assertion strength, recording-based replay where applicable (none expected at this layer), AI-cheating signals (weakened assertions, .skip, mock-built-never-injected per memory `feedback_verify_test_bodies_not_just_names`).

**NOT dispatched (zero files in scope):**
- React/Web UI Expert — no `.tsx`/store/ws.ts changes in this batch.
- a11y Auditor — no components added.
- Saarinen (UI Quality) — no UI.
- Friedman (UX Quality) — no user-visible flows yet.
- Docker/GHA Deploy Expert — no Dockerfile/workflow/Husky changes.

If reviewers find code in these domains they should flag a scope-mismatch issue rather than report on it as a finding.
