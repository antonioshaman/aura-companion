# Fowler — Refactoring Review

Scope: `council-types.ts`, `council-types.test.ts`, `session-group-coordinator.ts`, `group-state-machine.ts`, `backend-provider.ts`, `session-types.ts`, `group-reconciliation.ts`.

Overall structural verdict: the keystone seam (Task 4) did land — `SessionGroupCoordinator` consumes spawn through an injected function and never reaches into `session-orchestrator.ts`. The state machine is genuinely the single source of truth for "is this group degraded?" — no parallel booleans. `council-types.ts` correctly hosts the schema for both writer and observer in one place; that is *non*-speculative because two consumers exist on day one. Findings below are about a `BackendProvider` interface that is shipping ahead of any consumer, a small naming split (`primary` vs `orchestrator`), and a redundant predicate.

---

## FINDING 1

- **Title:** `BackendProvider` interface + named singletons are speculative — only one of four exports is consumed
- **File:** `/root/aura-companion/web/server/backend-provider.ts`
- **Principle:** Principle 5 — Speculative Generality
- **Severity:** P2
- **What's wrong:** The module exports four pieces of public surface — `BackendProvider` (interface), `CLAUDE_BACKEND` (singleton), `CODEX_BACKEND` (singleton), `getBackend(type)` — alongside the actually-used pairing surface (`SUPPORTED_PAIRINGS`, `isSupportedPairing`). Only `isSupportedPairing` has a real caller (`session-group-coordinator.ts` line 89). The JSDoc explicitly markets the interface as a future migration target: *"the eventual migration replaces those branches with method dispatch through this interface"* — but `cli-launcher.ts` lines 309 / 332 / 413 / 430 (and `cron-scheduler.ts` / `agent-executor.ts` / `routes/system-routes.ts`) still branch on `=== "codex"` inline. The interface today carries only `backendType` and `binaryName`; the actual divergence between backends is spawn args, env, sandbox flags, model defaults, prompt shape — none of which appear on the interface. So when the real migration arrives, `BackendProvider` will have to grow new members anyway and the current shape will be re-litigated rather than reused. Carmack's rule applies: *"two implementations is fine; three needs a registry, two does not."* There are two, and the registry shape doesn't yet know what it has to abstract.
- **Consequence:** Two costs. (a) Future readers will see `getBackend()` next to `if (backendType === "codex")` branches and waste cycles asking "which is canonical? am I supposed to migrate this call site?" (b) When the real seam lands it will need to break the interface — speculative published surface is harder to change than no surface.
- **Fix:** Keep `SUPPORTED_PAIRINGS`, `BackendPairing`, `isSupportedPairing` (those have a day-one consumer). Delete `BackendProvider`, `CLAUDE_BACKEND`, `CODEX_BACKEND`, `getBackend`, and the corresponding tests. Re-introduce the interface in the same PR that actually replaces the four `if (backendType === "codex")` sites in `cli-launcher.ts` — at that point the shape is driven by the call sites, not guessed at. Rename the file to `backend-pairings.ts` to reflect what stays.

---

## FINDING 2

- **Title:** Vocabulary split — `primary` (coordinator) vs `orchestrator` (role enum / state machine / docs)
- **File:** `/root/aura-companion/web/server/session-group-coordinator.ts`
- **Principle:** Principle 4 — Inconsistent vocabulary across modules
- **Severity:** P3
- **What's wrong:** The same concept has two names in adjacent modules:
  - `SessionGroupRole = "orchestrator" | "observer"` (`session-types.ts` line 441)
  - `GroupEvent = { type: "half_died"; role: GroupRole }` (`group-state-machine.ts`), where `role` is `"orchestrator" | "observer"`
  - `CheckpointPayload` / `ObserverReviewPayload` use `observer_provider`, no `orchestrator` field but the writer-side concept is orchestrator
  - But `CreateGroupRequest`, `GroupRecord`, the rollback variable `primarySpawn`, and the `findBySessionId` body all use `primary` — and the JSDoc on `CreateGroupRequest.primary` line 19 literally reads *"The primary (orchestrator) backend"*, confessing the alias.

  So a reader switching between `coordinator.applyEvent(id, { type: "half_died", role: "orchestrator" })` and `coordinator.get(id).primary` has to remember the translation. The PLAN's own observer review (in `council-types.test.ts` line 102) flags this exact issue: *"Consider renaming `BackendProvider`"* — there is awareness, but the rename didn't happen.
- **Consequence:** Low velocity tax today (the codebase is small), but every new touch site is a coin-flip on which name to use, and the JSDoc-explained alias is exactly the shape that becomes a fear-zone over months. Cheap to fix now while there are no UI / route consumers.
- **Fix:** Pick one — `orchestrator` is already the role enum value and matches the domain (Council Mode = orchestrator + observer), so rename `CreateGroupRequest.primary` → `orchestrator`, `GroupRecord.primary` → `orchestrator`, `primarySpawn` → `orchestratorSpawn`, the JSDoc on the rollback comment, and the `relaunch_observer.primarySessionId` field in `group-reconciliation.ts` line 35 → `orchestratorSessionId`. Single-pass mechanical rename.

---

## FINDING 3

- **Title:** `isOperable` and `isObserverHealthy` predicates duplicate the state machine and risk being the "three diverging booleans" the union was meant to prevent
- **File:** `/root/aura-companion/web/server/group-state-machine.ts`
- **Principle:** Principle 2 — Extracting trivial helpers / Principle 4 — Names that hide intent
- **Severity:** P3
- **What's wrong:** The header comment of this module makes exactly the right argument: *"Encoding the lifecycle as a discriminated union + a single deterministic `transition()` function means three different callers cannot disagree on 'is this group degraded?'."* Then lines 60–68 ship two predicates that re-derive secondary facts from the state — `isOperable(state)` (which buckets `active | degraded | reconnecting`) and `isObserverHealthy(state)` (`state === "active"`). Neither has a caller in this batch. Once they get callers, the second-order question — *"can the orchestrator accept input?"* vs *"is the observer healthy?"* — becomes the surface that callers reason about, not the state itself. That is the seed of the very divergence the union was supposed to prevent: a caller writes `if (state === "degraded" || state === "reconnecting")` inline, a second caller uses `isOperable`, a third writes its own predicate, and now there are three notions of "operable".
- **Consequence:** Not a bug today, but speculative API. Either delete them (callers can match on the union and `tsc` will police exhaustiveness), or commit to them as the *only* sanctioned secondary projection and forbid inline state comparisons in callers. Shipping both leaves the door open.
- **Fix:** Delete `isOperable` and `isObserverHealthy` until a caller appears. When a caller appears, add the predicate it needs *and* eliminate any equivalent inline check at that point — keep the projections exhaustive and single-sourced. Alternative: keep them and add an ESLint rule banning string-literal comparisons against `GroupStatus` outside this module. Either works; shipping both predicates without callers is the worst of three options.

---

## No findings on

- **`council-types.ts`** — schema cohesion is right: one file owns both `CheckpointPayload` (writer) and `ObserverReviewPayload` (reader), `COUNCIL_SCHEMA_VERSION` is shared, validators reject schema drift. This is the case where shared types are *non*-speculative because two consumers exist on day one. Bounded-string helpers and the relative-path predicate are reused cleanly across both parsers — no duplication, no primitive obsession.
- **`session-types.ts`** — the `sessionGroupId` + `sessionGroupRole` addition is a true data clump only when it appears in three or more parameter lists. Today it appears as two adjacent fields on `SessionState` and as a pair on `SessionSpawner`'s options object. Two sites does not earn an extraction; a `SessionGroupMembership` record type would be premature here. Re-evaluate after Task 12 (event bus) and Task 15 (UI) land more consumers.
- **`group-reconciliation.ts`** — the four-state `ReconciliationAction` discriminated union with explicit `reason` strings on the degraded branches is exactly the shape that survives. Boundary with `group-state-machine.ts` is clean: reconciliation decides *what action to dispatch*, the state machine consumes the resulting events. No leakage.
- **`SessionGroupCoordinator` god-module risk** — at 184 LOC with five public methods (`createGroup`, `applyEvent`, `archiveGroup`, `get`, `findBySessionId`) and `clear` for tests, this is on the right side of the cohesion line. The PLAN's named risk — branching back into `sessionOrchestrator.createSession` — did not happen; spawn is an injected function and the coordinator never imports the orchestrator. Watcher and event-bus belong to later tasks per the PLAN and were correctly kept out.
