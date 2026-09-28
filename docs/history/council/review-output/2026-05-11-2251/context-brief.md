# Context Brief for Aura Council Review

## What this code does

Council Mode for Aura Companion — a UI + backend feature that pairs an "orchestrator" session with an independent "observer" LLM session sharing one workspace. The observer wakes on filesystem checkpoint sentinels written by the orchestrator, reads the checkpoint's artifact manifest, emits a structured JSON review file, and the server intercepts it, runs grounding validation (STOPs whose evidence path isn't in the modified-files set are downgraded to NOTE), and surfaces findings into the orchestrator's chat banner + side-panel. Two pairings: `claude+claude` (default), `claude+codex` (experimental).

This review covers Phases D-G (the work since the prior council review on 2026-05-11-1957 closed out Phase A-C). Phases A-C have already been council-reviewed and 25 fixes applied — DO NOT re-flag the conventions in `conventions.md` (EC-1 through EC-9 + AP-1 through AP-3).

## Architecture

Council Mode is layered onto Aura's existing single-session machinery via composition, not branching:

- **Backend (Phases A-D, G):** `session-group-coordinator.ts` owns the spawn-with-rollback + archive lifecycle; `cli-launcher.ts` accepts `sessionGroupId`/`sessionGroupRole` + loads `.council/prompts/observer-system.md` for observer-role spawns; `session-orchestrator.ts` adds `createCouncilGroup` + per-group filesystem watchers (`checkpoint-watcher.ts` + new `review-watcher.ts`); `routes.ts` adds council-mode branches to `/api/sessions/create` and `/sessions/create-stream`; `ws-bridge.ts` adds `broadcastToGroup` for two-half fanout.
- **Frontend (Phase F):** new Zustand slice `store/council-slice.ts` (groups, findings, panel-open per session, dismissed STOPs, downgrades); pure `observer-panel-state.ts` discriminated-union derivation; 6 components in `components/council/` (CouncilToggle, ObserverPanel, BlockerBanner, DegradedBanner, ProviderBadges, FindingsLog); two global hooks (`use-browser-title-alert.ts`, `use-council-shortcuts.ts`); Sidebar/SessionItem/ProjectGroup/TopBar/ChatView/HomePage/App wiring; full Playground section.
- **Pure modules (Phase E):** `observer-prompt.ts` (CLI-agnostic prompt loader + per-checkpoint context manifest helper); `observer-attribution.ts` (synthetic system-message wrapper + invocation-log shape); `observer-grounding.ts` (STOP-only grounding validation; server-side downgrade emission).
- **Wire contract:** five new `BrowserIncomingMessage` variants — `group_created`, `group_exited`, `group_degraded`, `group_checkpoint`, `observer_review`. Five new `CompanionEventMap` entries on `companionBus`.

## Stack in use within scope

Present in this review:
- **Bun + Hono backend** (routes.ts, session-orchestrator.ts) — Hono SSE for stream creation.
- **Bun.spawn subprocess** (cli-launcher.ts) — observer-role pass-through + system-prompt-at-spawn.
- **Filesystem JSON persistence** (review-watcher, checkpoint-watcher, atomic-write, observer-write-policy, observer-prompt loader).
- **WebSocket bridge** (ws-bridge.ts) — adds `broadcastToGroup` only; the per-session fan stays unbranched.
- **React 19 + Zustand + Tailwind** components (6 new in `components/council/`, plus wiring into ChatView/TopBar/Sidebar/HomePage/App).
- **Playground entries** for every new component state.
- **Vitest + vitest-axe** tests for every new module/component.

Absent in this review:
- No new Docker / GHA workflow changes (deploy expert skipped).
- No new Codex JSON-RPC handling (codex-envelope.ts already shipped in Phase B, unchanged here).
- No Telegram, no aiogram, no Postgres — same as base Aura.

## Key observations

- **Convention compliance:** EC-1 through EC-9 codified in Phase A-C are the prior-review floor. Phase E added `isAttributeSafeToken` (format-transformation defence), `checkStopGrounding` (Beck-F4 pure helper), and follows the EC-7 idiom (integrated wrapper + injected-predicate pure helper). Phase G follows EC-2 (group-aware kill via coordinator's `archiveGroup`). EC-9 (structured log) wired in checkpoint-watcher + review-watcher + orchestrator.
- **Scope of test coverage:** every new module has a `.test.ts(x)` co-located. Component tests follow the render + axe + interaction triad (CLAUDE.md). 5494 tests pass, 4 pre-existing skipped, 0 failures.
- **Grounding semantic shift from PLAN:** the plan said "evidence_path matches a file the orchestrator modified in this phase" — for v1 the orchestrator's authority is the checkpoint's `artifact_paths` manifest, not a git-diff between phase boundaries. The shift is documented in `session-orchestrator.handleCouncilReview`.
- **Observer prompt-at-spawn is hard-fail:** missing or malformed prompt artifact fails the observer spawn, which causes the coordinator to roll back the orchestrator half. Silent "undirected observer" is impossible.
- **Backend route handler for council pairing is a NEW request shape** — `councilMode: "council"` + `councilPairing: "<a>+<b>"`. The server validates pairing against the supported allow-list BEFORE any spawn; the browser-supplied label is never forwarded to spawn argv.
- **Recent commit trajectory** (this branch is 13 commits ahead of main): Phase A architecture, Phase B security primitives + Codex envelope, Phase C convention adoption + 25 review-fix pass, Phase D runtime primitives (shutdown, probe, event types), Phase E prompt + attribution + grounding, Phase F.1 store/types/ws, Phase F.2 components + Playground + wiring, Phase F.3 keyboard shortcuts + sidebar badges + archive preview + workbench collapsed, Phase G.1 backend handler + ws-bridge fanout, Phase G.2 observer-prompt-at-spawn + watchers + observer_review.

## Automated check results

- **Typecheck:** ✅ Clean (`bun run typecheck` exits 0).
- **Tests:** ✅ 5494 passed, 4 pre-existing skipped, 0 failures across 223 test files. Latest full run completed minutes before this review.
- **A11y:** ✅ Every new component test in `components/council/` includes `expect(results).toHaveNoViolations()` for at least the idle state and at least one interactive/varied state. ObserverPanel passes axe in sleeping, blocker-found, degraded, and collapsed-rail states.

No pre-existing failures or yellow flags carried over from prior runs that would muddy this review.

## Domain File Assignments

**Hunt (Security):** `web/server/routes.ts` (council branches), `web/server/cli-launcher.ts` (observer prompt loader + spawn-argv injection), `web/server/session-orchestrator.ts` (council watchers + grounding handler), `web/server/observer-prompt.ts`, `web/server/observer-grounding.ts`, `web/server/observer-attribution.ts`, `.council/prompts/observer-system.md`, `web/server/preflight-probe.ts`, `web/server/group-shutdown.ts`, `web/server/review-watcher.ts`.

**Fowler (Refactoring):** `web/server/session-orchestrator.ts` (now 1100+ LOC with council additions), `web/server/cli-launcher.ts` (observer branching), `web/src/components/Sidebar.tsx`, `web/src/components/Playground.tsx` (council section), `web/src/store/council-slice.ts`, `web/src/observer-panel-state.ts`, the council components family for boundary cohesion.

**Bun/Hono/TS Backend Expert:** `web/server/routes.ts` (council route handlers + SSE branch), `web/server/session-orchestrator.ts` (council watcher lifecycle + bus subscriptions), `web/server/ws-bridge.ts` (`broadcastToGroup`), `web/server/event-bus-types.ts`.

**FS-JSON Persistence Expert:** `web/server/review-watcher.ts`, `web/server/observer-prompt.ts` (artifact loader), `web/server/observer-write-policy.ts` (unchanged but in scope as predicate for review files), `web/server/checkpoint-watcher.ts` (already reviewed in 1957 — only re-review if NEW changes detected).

**Realtime / NDJSON Protocol Expert:** `web/server/ws-bridge.ts` (`broadcastToGroup` + group event handler interactions), `web/server/session-types.ts` (5 new `BrowserIncomingMessage` variants), `web/server/event-bus-types.ts`, `web/src/ws.ts` (group event routing).

**Subprocess Lifecycle Expert:** `web/server/cli-launcher.ts` (observer-role spawn + prompt artifact loading + SdkSessionInfo extension), `web/server/session-orchestrator.ts` (`createCouncilGroup` + watcher lifecycle + abort coordination + `handleCouncilReview` + `handleCouncilCheckpoint`).

**React/Web UI Expert:** `web/src/components/council/*.tsx` (6 components + index), `web/src/components/ChatView.tsx` (BlockerBanner slot), `web/src/components/TopBar.tsx` (ProviderBadges), `web/src/components/HomePage.tsx` (CouncilToggle + state persistence), `web/src/App.tsx` (ObserverPanel sibling + hook mounts), `web/src/components/SessionItem.tsx` + `ProjectGroup.tsx` (badge prop drilling), `web/src/components/Sidebar.tsx` (council badges + archive preview + Workbench collapsible), `web/src/store/council-slice.ts`, `web/src/store/sessions-slice.ts` (cross-slice cleanup additions), `web/src/store/index.ts`, `web/src/observer-panel-state.ts`, `web/src/use-browser-title-alert.ts`, `web/src/use-council-shortcuts.ts`, `web/src/ws.ts` (group message handlers), `web/src/types.ts` (council types).

**a11y Auditor:** `web/src/components/council/CouncilToggle.tsx`, `ObserverPanel.tsx`, `BlockerBanner.tsx`, `DegradedBanner.tsx`, `FindingsLog.tsx`, `ProviderBadges.tsx`, `web/src/components/Sidebar.tsx` (new collapsible nav buttons + archive confirm), `web/src/components/TopBar.tsx`, `web/src/components/HomePage.tsx` (CouncilToggle integration), `web/src/use-council-shortcuts.ts` (textarea/input ignore branches + focus-on-blocker shortcut). Test files paired.

**Saarinen (UI Quality):** same component set as a11y but visual lens — color tokens, spacing, dark-mode elevation, motion, typography hierarchy. Special attention to the destructive/warning/info palette use across `cc-error` BlockerBanner vs `cc-warning` DegradedBanner vs `cc-info` first-run microcopy.

**Friedman (UX Quality):** `web/src/components/council/CouncilToggle.tsx` (off→on flow, provider dropdown reveal, codex unavailable affordance), `web/src/components/council/ObserverPanel.tsx` (five state pills, rail collapse, microcopy), `web/src/components/council/BlockerBanner.tsx` (reasoning visibility, action stacking), `web/src/components/Sidebar.tsx` (archive confirm both-halves preview, multi-group unread counter), `web/src/use-browser-title-alert.ts` (title alert for backgrounded tabs).

**Willison (LLM Pipeline):** `web/server/observer-prompt.ts`, `web/server/observer-attribution.ts`, `web/server/observer-grounding.ts`, `.council/prompts/observer-system.md`, `web/server/session-orchestrator.ts` (handleCouncilReview pipeline including stable-id assignment + grounding downgrade), `web/server/review-watcher.ts`, `web/server/council-types.ts` (only the `ObserverReviewPayload` shape — already reviewed in 1957 for the base shape; review only what changed since).

**Beck (Test Quality):** every `.test.ts(x)` in the scope file list above, and the source files they test. Special attention to: (1) ObserverPanel.test.tsx covers all 5 states + axe in 4 of them; (2) BlockerBanner.test.tsx claims to assert "renderer must escape content" — verify the assertion is meaningful, not just `getByText` on the literal; (3) council-slice.test.ts uses `dismissStop` idempotency check via referential equality (`.toBe`); (4) routes.test.ts mocks `createCouncilGroup` but asserts both the strip-extras and the not-called branch; (5) use-council-shortcuts test for input/textarea ignore branches; (6) review-watcher dedup key correctness.

**Docker/GHA Deploy Expert:** No files in scope. Skip.

## Prior conventions to honour (do NOT re-flag)

- AP-1: Coordinator decoupled from session-orchestrator via DI.
- AP-2: `group-state-machine.ts` is single source of truth for group lifecycle status.
- AP-3: `council-types.ts` hosts both writer and reader schemas in one file.
- EC-1: Observer SDK permission profile must apply at spawn (boot canary).
- EC-2: Group-aware kill marks BOTH IDs intentional before either kill executes.
- EC-3: Coordinator types distinguish Companion sessionId from cliSessionId.
- EC-4: FS watcher debounce must never silently coalesce distinct payloads.
- EC-5: Protocol parsers reject unknown METHODS + FRAME SHAPES; tolerate polymorphic-by-spec FIELDS.
- EC-6: Load-bearing protocol parsers require replay-based regression tests.
- EC-7: Filesystem-access predicates inline path resolution OR are exposed only via resolving wrapper.
- EC-8: Reconciliation actions require sentinel-before-sweep helpers.
- EC-9: Group-lifecycle log lines must be structured JSON.
