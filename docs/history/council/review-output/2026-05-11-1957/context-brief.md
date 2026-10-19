# Context Brief for Aura Council Review

**Timestamp:** 2026-05-11-1957
**Scope:** Phase A+B+C of the Council Mode paired-sessions feature in Aura Companion. 25 new/changed files on branch `feat/council-mode-paired-sessions` (3 commits ahead of `main`).

## What this code does

Adds backend foundations for Council Mode — a UI toggle that spawns two linked Claude Code / Codex CLI sessions (orchestrator + observer) sharing one workspace. Observer wakes on filesystem checkpoint sentinels written by the orchestrator, reviews artifacts, surfaces findings. This review covers backend primitives only — UI is Phase F (not yet built).

## Architecture (scope under review)

All changes are in `web/server/` as new pure modules + tests, plus one optional-field extension to `session-types.ts`. Wiring into existing files (`session-orchestrator.ts`, `cli-launcher.ts`, `ws-bridge.ts`, `routes.ts`) is **deferred to Phase D/F** — these modules are not yet called from anywhere in the live code path.

Module map:

- **Schema + types**: `council-types.ts` (CheckpointPayload / ObserverReviewPayload + validators) — flat schema, manual validation, size cap 256 KiB, validators return null never throw.
- **Filesystem primitives**: `atomic-write.ts` (tmp+rename+fsync writer), `checkpoint-watcher.ts` (node:fs/promises watch + AbortController + 150ms debounce).
- **State machines**: `group-state-machine.ts` (pure discriminated-union transition over { pairing, active, degraded, archived, reconnecting }).
- **Coordinator**: `session-group-coordinator.ts` (composes existing SessionOrchestrator via injected spawn/kill; all-or-nothing rollback).
- **Backend seam**: `backend-provider.ts` (declarative pairing allow-list; full cli-launcher migration deferred per plan).
- **Security primitives**: `observer-write-policy.ts` (pure path predicate), `group-authorization.ts` (groupId format check + map lookup), `observer-permissions.ts` (pinned allow + deny tool lists), `codex-envelope.ts` (strict JSON-RPC parser).
- **Lifecycle**: `group-reconciliation.ts` (4-state restart policy + tombstone writer).
- **Session type extension**: `session-types.ts` adds `sessionGroupId?: string` and `sessionGroupRole?: SessionGroupRole` to existing `SessionState`.

## Stack in use within scope

- Bun + TypeScript strict, ESM with `.js` import extension convention.
- `node:fs` (sync for atomic-write) + `node:fs/promises` (watch + readFile).
- `node:crypto.randomBytes` (cryptographic group IDs).
- Vitest 4 + `vi.fn<TFn>` (Vitest 4.x generic shape, NOT the old `<TArgs, TReturn>`).
- No deps added — no zod (manual validators), no chokidar (native fs/promises watch).

## What is NOT in scope of this review

- `routes.ts`, `cli-launcher.ts`, `ws-bridge.ts`, `session-orchestrator.ts`, `session-store.ts` — **not changed** in Phase A-C. The new modules will be wired into these in Phase D.
- React frontend — no UI work yet (Phase F).
- Codex JSON-RPC method allow-list — deferred until wiring; current `codex-envelope.ts` validates frame shape only.

## Key observations from structural exploration

1. **Single-host auth model** in Aura Companion (`verifyToken` in routes.ts) — there is no multi-tenant boundary in this codebase. `group-authorization.ts` adds a second-layer membership check below the existing token verifier.
2. **No conventions.md** at project root — `CLAUDE.md` is the normative document.
3. **Plan T4 partially implemented**: `BackendProvider` seam exists as a declarative manifest, but the cli-launcher.ts migration (replacing ~10 inline `if (backendType === "codex")` branches with adapter dispatch) is **deferred to a follow-up commit** — logged honestly in commit `ae81a3c`.
4. **Pure-module discipline** runs throughout: validators return null on failure (never throw), predicates are unit-testable without filesystem mocks, state machines have no side effects, the coordinator takes spawn/kill as dependency injection.
5. **All 11 new source modules have accompanying `.test.ts` files** with comprehensive case coverage (166 new tests across Phase A+B+C). Tests use Vitest, sit alongside source per project convention.

## Automated check results

- **`bun run typecheck`** — clean (`tsc --noEmit` returns 0).
- **`bun run test`** — **207 files / 5139 passed, 4 skipped, 0 failed** as of last Phase C verification. No pre-existing failures regressed.
- **a11y dedicated** — not relevant in this phase (no React work).
- Husky pre-commit hook (typecheck + tests + coverage) passed on all three Phase commits.

## Files under review

### Source modules (11)
- `web/server/council-types.ts` — 155 LOC, schema + validators
- `web/server/observer-write-policy.ts` — 47 LOC, pure path predicate
- `web/server/atomic-write.ts` — 55 LOC, tmp+rename+fsync
- `web/server/checkpoint-watcher.ts` — 91 LOC, FS watcher
- `web/server/group-state-machine.ts` — 65 LOC, pure transition
- `web/server/backend-provider.ts` — 50 LOC, declarative pairings
- `web/server/session-group-coordinator.ts` — 165 LOC, coordinator class
- `web/server/group-authorization.ts` — 49 LOC, format + lookup
- `web/server/group-reconciliation.ts` — 81 LOC, restart policy + tombstone
- `web/server/observer-permissions.ts` — 88 LOC, pinned tool lists
- `web/server/codex-envelope.ts` — 106 LOC, JSON-RPC parser

### Test files (11, ≈900 LOC total)
Co-located `.test.ts` for each module above.

### Type extension (1)
- `web/server/session-types.ts` — added 2 optional fields + 1 type alias to `SessionState`.

## Domain file assignments (council-review-aura)

For this phase, frontend / deploy experts have **zero files in scope** — skipped per skill rules. 8 experts spawn.

- **Hunt (Security)** — `observer-write-policy.ts`, `group-authorization.ts`, `codex-envelope.ts`, `observer-permissions.ts`, `atomic-write.ts`, `session-group-coordinator.ts`, `council-types.ts`
- **Fowler (Refactoring)** — all 11 source modules (structural lens)
- **Bun/Hono/TS Backend** — `atomic-write.ts`, `checkpoint-watcher.ts`, `session-group-coordinator.ts`, `codex-envelope.ts`, `group-reconciliation.ts`, `observer-permissions.ts`
- **FS-JSON Persistence** — `atomic-write.ts`, `council-types.ts`, `checkpoint-watcher.ts`, `group-reconciliation.ts`
- **Realtime/NDJSON Protocol** — `codex-envelope.ts`, `council-types.ts`, `checkpoint-watcher.ts`
- **Subprocess Lifecycle** — `session-group-coordinator.ts`, `backend-provider.ts`, `observer-permissions.ts`, `group-reconciliation.ts`
- **Willison (LLM Pipeline)** — `observer-permissions.ts`, `council-types.ts`, `codex-envelope.ts`
- **Beck (Test Quality)** — ALL 11 `.test.ts` files + corresponding source for context

Skipped: React/Web UI (no React work), a11y (no UI), Saarinen (no visuals), Friedman (no UX flow yet), Docker/GHA Deploy (no deploy changes).
