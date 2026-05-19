# TASK — Archive Council pair EC-2 violation (P1)

Discovered: 2026-05-14 (this orchestrator session)
Reporter: user via UI screenshot of Verdant Cedar (`grp_4f15985bfcc15b0661e6fcbbe71daab8`) sidebar

## Symptom

The sidebar's "Archive Council pair?" confirmation modal claims:

> This ends **both the orchestrator and the observer** in this claude+claude pair.

Clicking the red **Archive pair** button kills only ONE half of the pair. The other half remains alive and continues self-polling (visible in screenshot as a flood of "no new checkpoint, sequence=3 (council-plan), 19 (council-implement). Засыпаю." messages from the surviving observer-half whose orchestrator was archived).

## Wire path (verified via direct code read this session)

1. **UI** — `web/src/components/Sidebar.tsx:752` — "Archive pair" button → `confirmArchive()` (line 537) → `doArchive(confirmArchiveId, true)`.
2. **doArchive** — `web/src/components/Sidebar.tsx:512-535` — calls `api.archiveSession(sessionId, ...)` with a single session id. No group lookup, no group-archive call.
3. **API client** — `web/src/api.ts:892-893` — POSTs `/sessions/${sessionId}/archive` (single-session endpoint).
4. **Server route** — `web/server/routes.ts:1343-1351` — handler calls `orchestrator.archiveSession(id, ...)`. Never `coordinator.archiveGroup(groupId)`.
5. **Orchestrator** — `web/server/session-orchestrator.ts:2601-2650` — `archiveSession` is group-blind: marks `intentionalKills.add(sessionId)` for one id only, kills one CLI subprocess, archives one launcher record. Does NOT call `coordinator.findBySessionId(sessionId)` to escalate to group-aware path.
6. **Coordinator** — `web/server/session-group-coordinator.ts:497-529` — `archiveGroup` exists and is correct: routes through `applyEvent({type:"user_archived"})` → `deriveSideEffects` → bus `group:exited` BEFORE kills, then kills both halves sequentially with `onError` reporting. **Zero production call sites.** State-machine tests at `group-state-machine.test.ts:46-128` cover the `user_archived` transitions on the pure side.

## Convention failure class

Direct instance of `feedback_call_site_presence_not_just_symbol_export`: the group-aware archive symbol is exported, tested at the pure-function layer, and documented in `CLAUDE.md` ("`archiveGroup` routes through `applyEvent({type:"user_archived"})` so the `group:exited` emit comes from the same channel"), but **no production code path invokes it**.

Sibling: `feedback_identity_binding_placeholder_void` (recovery branch structurally void). The Friedman P2 comment at Sidebar.tsx:497-503 carefully routes council pairs into the confirm modal precisely so the "ends BOTH" microcopy is shown — but the destructive action below the modal still calls the wrong endpoint. Confirmation UX correct; wire path wrong.

## EC-2 invariant violation

CLAUDE.md convention floor:
> EC-2 Group-aware kills mark BOTH session ids intentional BEFORE either kill executes.

User-initiated archive of a council pair currently:
- Marks only the clicked half's id in `intentionalKills`.
- Kills only that half.
- The other half's `session:exited` (if it ever fires from supervisor reactions) is NOT seen as intentional → `armReconnect` grace window → eventually `group:degraded` instead of `group:exited reason:user_archived`.
- In the witnessed case the surviving half doesn't even exit; it keeps running its EC-13 self-poll forever, with no orchestrator partner to write checkpoints.

## Proposed fix (two viable shapes — observer should pick)

### Option A: Server-side detect-and-route (preferred)

In `orchestrator.archiveSession(sessionId, opts)`:
```ts
const group = this.coordinator.findBySessionId(sessionId);
if (group && group.status !== "archived") {
  await this.coordinator.archiveGroup(group.sessionGroupId);
  // group.archiveGroup already kills both via applyEvent → kills.
  // Skip the single-session kill flow below.
  return { ok: true, worktree: ..., linearTransition: ... };
}
// existing single-session path...
```

Pros: any caller of `/sessions/:id/archive` (CLI, future scripts, other tabs) gets correct EC-2 behaviour without knowing about groups. UI needs no change.

Cons: `archiveGroup` doesn't currently surface `linearTransition` or `worktreeResult` per-half. Need to fold the Linear transition logic and worktree cleanup into the group-archive path (or call them once per half).

### Option B: UI-side dedicated endpoint

Add `api.archiveGroup(groupId)` → `POST /api/groups/:id/archive` → `coordinator.archiveGroup`. Sidebar's `confirmArchive` branches on `isCouncilSession`.

Pros: clean separation of single vs group at the protocol layer.

Cons: every alternative archive entry point (gh CLI, programmatic, future automation) has to re-implement the branch. Higher long-term maintenance.

## Tests required either way

1. **Behavioural test** in `session-orchestrator.test.ts` (or new `archive-group-routing.test.ts`):
   - Spawn fake council group via injected spawner.
   - Call `orchestrator.archiveSession(orchestratorId)`.
   - Assert: BOTH half-ids added to `intentionalKills`, BOTH halves' `kill` called, `group:exited{reason:"user_archived"}` emitted exactly once.
2. **EC-6 static-grep canary** in same suite: `inspect`-via-`fs.readFileSync` assertion that `archiveSession` in `session-orchestrator.ts` contains a `coordinator.findBySessionId` OR `coordinator.archiveGroup` call. Survives renames via regex over `\w+`.
3. **UI integration test** (Sidebar.test.tsx): when council pair archive modal confirms, mocked `api.archiveSession` is called with the orchestrator's id, and behaviour does NOT regress to silent-skip (no thrown errors swallowed).

## Scope decision (observer architectural input requested)

This is **orthogonal to PR 2c Task 11** (synthetic-frame send pipeline). Options:

- **(a) Hotfix PR** (`fix/archive-pair-ec2-violation`) from `origin/main` now, ship before Task 11. Small, focused, gh pr merge --squash before resuming Task 11 work.
- **(b) Fold into PR 2c** as an additional commit. NOT recommended — violates `feedback_partial_fix_passed_as_complete` direction (different surface, different risk profile, different reviewer attention model).
- **(c) Defer to next session** as a known issue (already in this TASK file).

Strong preference for (a) given the user found it live in a screenshot. Observer: please confirm (a) is the right call or flag a counter-argument.

## Related memory

- `feedback_call_site_presence_not_just_symbol_export` — primary class
- `feedback_identity_binding_placeholder_void` — sibling (structural void of a recovery/dual-kill branch)
- `feedback_recovery_branch_reachability` — sibling
- `feedback_artifact_existence_not_automation_proof` — output-side dual (artifact = `archiveGroup` exists; no auto-trigger to it)
