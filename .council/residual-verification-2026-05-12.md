# Residual verification — Council Mode review 2026-05-11-2251

**Date:** 2026-05-12
**Verifier:** Council Mode orchestrator half (autonomous)
**HEAD at verification:** `c9282a4` (`fix(council): inject checkpoint manifest into observer CLI to unblock pre-init`)
**Method:** grep + read of production code (not test files); commit body claims discarded per `feedback_trust_diff_not_prose.md`.

Each finding from `.council/review-output/2026-05-11-2251/FINAL-REVIEW.md` is verified against the on-disk HEAD. Status labels:

- `closed-with-evidence` — production call site present at file:line; non-test caller exists; behaviour is enforced, not documented.
- `closed-partial` — at least one sub-fix from the FINAL-REVIEW "Fix:" section is verified, at least one is missing.
- `open` — production call site absent or behaviour not enforced.

---

## P1 — Fix Now

### P1#1 — Observer subprocess spawns without tool restrictions; Codex observer unrole-d

**Status:** `closed-partial`

Sub-fixes verified:

- ✅ `applyCouncilObserverSpawnConfig` is called from initial spawn (`web/server/cli-launcher.ts:373`) AND from relaunch (`web/server/cli-launcher.ts:562`). Both code paths intersect caller-allowed with `OBSERVER_ALLOWED_TOOLS`, apply `OBSERVER_DISALLOWED_TOOLS`, and set `OBSERVER_PERMISSION_MODE`.
- ✅ Observer prompt body is composed into `options.systemPrompt` (`web/server/cli-launcher.ts:414-416`) so Claude (`spawnCLI`) consumes it via `--append-system-prompt` at line 679, AND `spawnCodexWs` consumes it via `CodexAdapter` constructor at line 1022, AND `spawnCodexStdio` via the same option at line 1234.
- ✅ Disallowed-tools array is pushed into Claude argv at `web/server/cli-launcher.ts:681-685`.

Sub-fix missing:

- ❌ **Boot-time canary at `Bun.spawn` site.** The spec ("Fix:" sub-d) calls for "a boot-time canary that fails if an observer-role launch reaches `Bun.spawn` without `--disallowedTools Bash` in argv." No such argv inspection exists at any of `cli-launcher.ts:743` (Claude `Bun.spawn`), `:967` (CodexWs `Bun.spawn`), `:1147` (CodexStdio `Bun.spawn`). Existing `assertObserverToolPolicyConsistent()` (`observer-permissions.ts:101`) is a module-load canary on the allow/deny list shape, NOT a per-spawn argv inspection — a future regression that disables `applyCouncilObserverSpawnConfig` would slip through it.

### P1#2 — Three Phase E primitives are imported by tests only

**Status:** `closed-partial`

Sub-fixes verified:

- ✅ **`buildObserverContextManifest` wired** at `web/server/session-orchestrator.ts:575` (in `handleCouncilCheckpoint` — produces the manifest that wakes the observer with delta-only paths) AND at `:610` (in `handleCouncilReview` — feeds `modifiedFiles` to the grounding validator). Delta semantics now load-bearing.
- ✅ **`formatObserverInvocationLog` wired** at `web/server/session-orchestrator.ts:668`. The `observer.invocation.completed` structured log entry now carries `promptSha256`, `latencyMs`, STOP counts on every review completion.

Sub-fixes missing:

- ❌ **`wrapObserverFindingForInjection` has ZERO production callers.** Grep confirms: defined at `observer-attribution.ts:81`, called only from `observer-attribution.test.ts:68/90/97/107/121/129/141`. The observer-side preamble + delimiter + JSX escape multi-layer defence remains a tested primitive that the orchestrator → CLI synthetic injection path does not invoke. The "Fix:" intent ("Wire `wrapObserverFindingForInjection` at the orchestrator-side synthetic message injection point — when a STOP banner is created") is not enacted. STOPs surface to the browser as `group:review` wire-form (intended) but the orchestrator CLI itself never sees a structured-envelope synthetic message.
- ❌ **`assertObserverWriteAllowed` has ZERO production callers.** Grep confirms: defined at `observer-write-policy.ts:67`, called only from `observer-write-policy.test.ts:97/109/118/122/126/130/134`. The "Fix:" intent ("Wire `assertObserverWriteAllowed` into the observer-side `canUseTool` callback for Write/Edit/MultiEdit") is not enacted. The observer can in principle invoke Write (`OBSERVER_ALLOWED_TOOLS` includes `"Write"`) on any path inside its workspace; the write-boundary primitive exists but ws-bridge.ts has no observer-aware `permission_request` handler that consults it.

### P1#3 — `group:exited` and `group:degraded` are wired as listeners but never emitted

**Status:** `closed-with-evidence`

Production emit sites:

- `companionBus.emit("group:degraded", …)` at `web/server/session-group-coordinator.ts:173` (state-machine `pairing|active → degraded` transition) and at `web/server/session-orchestrator.ts:452` (unintentional `session:exited` against a council-tracked half — drives the proactive degrade signal).
- `companionBus.emit("group:exited", …)` at `web/server/session-group-coordinator.ts:177` (state-machine `→ archived` transition) and at `:200` (direct emit inside `archiveGroup` BEFORE the kills proceed — so the browser cleans up while kills are in flight).
- Listeners fan to browser wire variants in `wireGroupListeners` (`web/server/session-orchestrator.ts:388-401`); fanout test at `session-orchestrator.test.ts:1928-1948` exercises the degrade path against a synthetic `session:exited`.

### P1#4 — Council context lost on relaunch / idle-kill / shutdown

**Status:** `closed-with-evidence`

All five sub-fixes verified:

- **(a) `relaunch()` carries `sessionGroupRole` + `sessionGroupId`:** `web/server/cli-launcher.ts:545,558` populate `baseRelaunchOptions`; `web/server/cli-launcher.ts:562` re-invokes `applyCouncilObserverSpawnConfig` so the observer prompt + tool restrictions re-apply.
- **(b) `session:exited` of a council half drives `group:degraded` via the coordinator:** `web/server/session-orchestrator.ts:440-453` listener catches the case, looks up the group from `councilGroupMeta`, marks BOTH ids in `intentionalKills` BEFORE emitting (EC-2 invariant honoured), then emits `group:degraded` with the resolved `deadRole`.
- **(c) `group-shutdown.ts` tears down watchers:** `web/server/group-shutdown.ts:61` calls `coordinator.archiveGroup` which (per `session-group-coordinator.ts:200`) emits `group:exited` synchronously; the orchestrator's `group:exited` listener at `session-orchestrator.ts:430-433` then calls `stopCouncilWatchers` and drops `councilGroupMeta`. Watcher leak closed via bus chain.
- **(d) `info.observerPromptSha256` refreshed on relaunch:** `applyCouncilObserverSpawnConfig` reassigns `info.observerPromptSha256 = artifact.sha256` at `cli-launcher.ts:411` on every call, so the relaunch path re-stamps the hash.
- **(e) Idle-kill skips observer-role sessions:** `web/server/session-orchestrator.ts:332-335` early-returns from the `session:idle-kill` handler when `info.sessionGroupRole === "observer"`, logging `skipping idle-kill for observer session`.

### P1#5 — `watchReviews` debounces by filename only — claude+codex collision

**Status:** `closed-with-evidence`

- Filename regex requires the provider segment: `REVIEW_FILE_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}-(claude|codex)-observer\.md$/` at `web/server/review-watcher.ts:32`.
- Observer prompt artifact documents the rule: `.council/prompts/observer-system.md` ("Write to `<workspace>/.council/reviews/<phase>-<provider>-observer.md` … The provider segment is REQUIRED").
- Debounce keying includes `mtimeNs` per-window: `web/server/review-watcher.ts:97-104` captures `observedMtimeNs` and `:108-117` detects when a second write arrives within the debounce window with a different mtime, clears the first timer, AND logs `onDropped("superseded", …)` — EC-4 invariant honoured ("the loss is visible, not absorbed").

## P2 — Fix Soon

### P2#6 — Server-generated finding ids are non-deterministic

**Status:** `closed-with-evidence`

- `deterministicFindingId({sessionGroupId, checkpointId, observerProvider, findingIndex, evidencePath, claim})` is called at `web/server/session-orchestrator.ts:626`. Random-bytes fallback removed.
- Downgrade-id correlation throws on out-of-bounds index (`web/server/session-orchestrator.ts:651-654`) instead of substituting a random id.
- Replay-after-restart determinism: test at `session-orchestrator.test.ts:2222-2264` asserts `f0.id` matches `^fnd_` shape derived from input bytes.

### P2#7 — Lazy `await import("node:path")` inside `startCouncilWatchers`

**Status:** `closed-with-evidence`

- Top-level `import { join } from "node:path"` at the top of `web/server/session-orchestrator.ts`. `startCouncilWatchers` is fully synchronous (`:482-536`); no `await import` remains.
- `mkdirSync(checkpointsDir, { recursive: true })` + `mkdirSync(reviewsDir, …)` at `web/server/session-orchestrator.ts:501-502` BEFORE `watchCheckpoints` / `watchReviews` attach.
- On mkdir failure: the entry is removed from `councilWatchers`, the abort is fired, the watcher does NOT half-install (`:503-511`).

### P2#8 — `handleCouncilCheckpoint` no sequence-monotonicity check

**Status:** `closed-with-evidence`

Guard at `web/server/session-orchestrator.ts:553-560`: rejects `payload.sequence <= entry.lastCheckpoint.sequence` with structured warn log, returns early — neither overwrites `lastCheckpoint` nor emits `group:checkpoint`. Test at `session-orchestrator.test.ts:1979-2089` exercises `[0, 2, 1]` and asserts only two checkpoints surface.

### P2#9 — `handleCouncilReview` pipeline + SSE Council branch untested

**Status:** `closed-with-evidence`

- `describe("handleCouncilReview", …)` at `web/server/session-orchestrator.test.ts:2189` with three behavioural tests: (i) deterministic ids + outside-modifiedFiles downgrade against a real tmp workspace (`:2222-2264`); (ii) no-emission when group has no watcher entry (`:2266-2284`); (iii) handler-error swallow keeps watcher loop alive (`:2286-2306`).
- `describe("POST /api/sessions/create-stream — Council Mode branch (Beck council review #9)", …)` at `web/server/routes.test.ts:3990` with three SSE-shape tests: valid `claude+codex` pairing produces in_progress + done with full `pair` shape (`:3991-4033`); invalid pairing surfaces `error` event before any `progress` (`:4035-4055`); coordinator failure propagates as SSE `error` after first progress (`:4057-4080`).

### P2#10 — CouncilToggle APG-non-compliant; ProviderBadges / DegradedBanner contrast

**Status:** `closed-with-evidence`

- CouncilToggle APG listbox keyboard: `ArrowDown`/`ArrowUp` handlers at `web/src/components/council/CouncilToggle.tsx:229-232`, `aria-activedescendant` at `:326`, listbox/option keyboard fan at `:202-205,229-249,297,324-327`, `aria-disabled={disabled || undefined}` at `:106`.
- ProviderBadges contrast: `text-cc-primary-btn` / `text-cc-codex-btn` (button-grade WCAG AA tokens) at `web/src/components/council/ProviderBadges.tsx:65,68`; background widened to `/25` for surface contrast.
- DegradedBanner contrast: label + body switched to `text-cc-fg` at `web/src/components/council/DegradedBanner.tsx:91-92`; bg snapped to `/10` (was `/8`, off the project's 5/10/15/25 scale) at `:82`; button text `text-cc-fg` at `:115`.

### P2#11 — No loading/reconnecting pill; uncontainerized archive bypass

**Status:** `closed-with-evidence`

- Loading pill: `spawning` and `reconnecting` variants added to `ObserverPanelState`, inserted above `never-checkpointed-yet` in the priority ladder at `web/src/observer-panel-state.ts:56-78` (reconnecting at `:56-62`, spawning at `:72-78`).
- Uncontainerized council archive: `web/src/components/Sidebar.tsx:497-508` adds `const inCouncilGroup = groupBySessionId.has(sessionId)` and the confirm preview now opens when EITHER `isContainerized OR inCouncilGroup` — so the carefully-written "ends BOTH the orchestrator and observer" microcopy reaches the user before `doArchive` fires. Previous gate was `isContainerized` alone.

## P3 — Consider

### P3#12 — Two parallel cleanup paths for council state on session removal

**Status:** `closed-with-evidence`

`cleanupCouncilForSession` has been deleted from the slice's exported surface (`web/src/store/council-slice.ts:187-190` comment: "eliminating the parallel `cleanupCouncilForSession` export the prior commit shipped unused"). `sessions-slice.removeSession` (`web/src/store/sessions-slice.ts:112`) carries the cleanup inline. Grep confirms zero remaining references to the deleted export name anywhere in `web/src/` or `web/server/`.

### P3#13 — Coordinator's spawn-rollback kill does not mark intentional first (EC-2)

**Status:** `open`

The rollback kill at `web/server/session-group-coordinator.ts:144` calls `this.deps.kill(primarySpawn.sessionId)` whose adapter (`session-orchestrator.ts:791-793`) calls `this.killSession(sessionId)` — and `killSession` (`session-orchestrator.ts:1225-1231`) does NOT add the id to `intentionalKills` first. `archiveSession` (`:1287`) and `deleteSession` (`:1304`) DO mark intentional before the kill; the coordinator-injected kill shim does not.

Concrete race: orchestrator spawn succeeds → observer spawn fails → coordinator catch block calls `this.deps.kill(primarySpawn.sessionId)` → `launcher.kill` fires → `session:exited` bus event emits → `scheduleProactiveRelaunch` listener (`session-orchestrator.ts:306-308, 1453-1456`) checks `intentionalKills.has(sessionId)` — finds nothing — schedules a relaunch of the half being rolled back. Orphan CLI process becomes attached to a `sessionGroupId` that was never registered on the orchestrator (no entry in `councilGroupMeta` because the throw happens before `:815`).

The `wireGroupListeners` degrade path at `:440-453` does NOT trigger here because `councilGroupMeta.get(foundGroupId)!` would return undefined (the group was never added). But `scheduleProactiveRelaunch` does fire.

Fix in scope: have the coordinator's kill shim mark `intentionalKills.add(sessionId)` before invoking `killSession`, OR have `killSession` itself mark it (defensive — pairs with `archiveSession`/`deleteSession`). Either keeps the rollback from racing the relaunch budget.

### P3#14 — Saarinen cluster (warning hot-spot, banner animation, opacity drift, rounded-md)

**Status:** `closed-with-evidence`

- DegradedBanner desaturation: label + body text now `text-cc-fg` (not `text-cc-warning`), button bg `bg-cc-warning/20` + text `text-cc-fg` — saturated tokens reserved to icon + border. `web/src/components/council/DegradedBanner.tsx:91,92,115`.
- Banner animation alignment: both `DegradedBanner` (`:82`) and `BlockerBanner` (`web/src/components/council/BlockerBanner.tsx:53`) carry `animate-[fadeSlideIn_0.2s_ease-out]`.
- Opacity-scale snap: `bg-cc-warning/10` (was `/8`) at `DegradedBanner.tsx:82` aligns to the project's 5/10/15/25 scale.
- CouncilToggle rounded convention: `rounded-[10px]` at `web/src/components/council/CouncilToggle.tsx:302` (trigger) and `:331` (dropdown plate). Comment at `:330` cites the convention.

### P3#15 — `session-orchestrator.initialize()` mixes single-session + council

**Status:** `closed-with-evidence`

Council listener bag extracted to `private wireGroupListeners()` at `web/server/session-orchestrator.ts:372-454`; `initialize()` body now reduces to a labelled call `this.wireGroupListeners()` at `:356` with a single comment explaining the surface split. The council surface lives in one named block, isolated from the solo-session lifecycle subscriptions above.

---

## Summary

| # | Finding | Status |
|---|---------|--------|
| P1#1 | Observer subprocess EC-1 + Codex prompt | `closed-partial` — boot-time canary at `Bun.spawn` argv missing |
| P1#2 | Phase E primitives unused | `closed-partial` — `wrapObserverFindingForInjection` + `assertObserverWriteAllowed` have zero production callers |
| P1#3 | `group:exited` / `group:degraded` never emitted | `closed-with-evidence` |
| P1#4 | Council context lost on non-initial transition | `closed-with-evidence` |
| P1#5 | `watchReviews` filename collision | `closed-with-evidence` |
| P2#6 | Non-deterministic finding ids | `closed-with-evidence` |
| P2#7 | Lazy `node:path` import | `closed-with-evidence` |
| P2#8 | `handleCouncilCheckpoint` monotonicity | `closed-with-evidence` |
| P2#9 | `handleCouncilReview` + SSE Council untested | `closed-with-evidence` |
| P2#10 | CouncilToggle APG + WCAG AA contrast | `closed-with-evidence` |
| P2#11 | Loading state + uncontainerized archive bypass | `closed-with-evidence` |
| P3#12 | Two parallel Council cleanup paths | `closed-with-evidence` |
| P3#13 | EC-2 spawn-rollback intentional-mark gap | `open` |
| P3#14 | Saarinen UI cluster | `closed-with-evidence` |
| P3#15 | `initialize()` extracted `wireGroupListeners` | `closed-with-evidence` |

**To close in Story 2:**

1. **P1#1 sub-d** — Add a per-spawn boot-time canary that throws if an observer-role launch reaches `Bun.spawn` without `--disallowedTools Bash` in the constructed argv (Claude path) or without a non-empty `systemPrompt` flowing into the adapter constructor (Codex paths).
2. **P1#2 sub-a** — Wire `wrapObserverFindingForInjection` into the orchestrator-side synthetic message injection for unresolved STOP findings inside `handleCouncilReview`. The wrapped payload feeds the orchestrator CLI via `wsBridge.injectUserMessage(primarySessionId, …)` so the orchestrator LLM sees the same structured envelope the JSDoc and prompt artifact already document.
3. **P1#2 sub-d** — Wire `assertObserverWriteAllowed` into the ws-bridge `permission_request` handling so that an observer-role session's `Write` / `Edit` / `MultiEdit` request is short-circuit-validated server-side: `allow` with the original input if the resolved target sits inside the workspace, `deny` with an explanatory message otherwise.
4. **P3#13** — Mark the rollback-bound session id in `intentionalKills` before the coordinator's kill shim invokes `killSession`, so the proactive-relaunch listener does not race the rollback. The simplest local fix is to make `killSession` itself mark intentional (mirrors `archiveSession` / `deleteSession`), which closes the same window for any future kill caller.

Tests + commits land per Story 2 boundaries (one commit per residual fix; each fix gets a `*.test.ts` adjacent to source; convention citations in commit body when touching the Convention floor).
