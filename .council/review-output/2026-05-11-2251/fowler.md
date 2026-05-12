# Fowler — Refactoring Review (Council Mode Phases D-G)

Reviewer: Martin Fowler. Lens: structural quality / will-this-slow-us-down.
Scope: `session-orchestrator.ts`, `cli-launcher.ts`, Sidebar council wiring, Playground council section, `store/council-slice.ts`, `observer-panel-state.ts`, and the six components in `components/council/`.

Conventions in `conventions.md` (AP-1..3, EC-1..9) are floor — not re-flagged.

---

## F1. Observer system-prompt loading is wedged into the Claude-only spawn path; the `claude+codex` pairing silently spawns an undirected Codex observer

- **Title:** Observer prompt is Claude-only; `claude+codex` observer goes unrole-d
- **File:** `/root/aura-companion/web/server/cli-launcher.ts` (lines 586-601 in `spawnCLI`; `spawnCodexWs` / `spawnCodexStdio` have no equivalent branch)
- **Principle:** Principle 6 — Missing boundaries where they matter / Principle 5 — Speculative-vs-real generality
- **Severity:** P1
- **What's wrong:** `loadObserverSystemPrompt` + `--append-system-prompt` injection lives ONLY inside `spawnCLI`. `backend-provider.SUPPORTED_PAIRINGS` lists `{ primary: "claude", observer: "codex" }` as a valid pairing, so a real coordinator spawn for that pairing routes the observer half through `spawnCodex*` — which never reads `options.sessionGroupRole`, never loads `.council/prompts/observer-system.md`, and never sets `info.observerPromptSha256`. The "Loud failure — without the prompt the observer is undirected" guarantee at line 594 holds only for Claude observers. CodexAdapter accepts a `systemPrompt` (line 938, 1150) but no caller wires the observer artifact into it.
- **Consequence:** The contract that "missing/malformed prompt artifact fails the spawn loudly … silent 'undirected observer' is impossible" (context-brief key observation #3) is satisfied for claude+claude but **silently violated** for claude+codex. A future Codex observer will run on the default Codex system prompt, produce review payloads that look structurally valid, and the reader-side grounding will faithfully ground unrole-d output. This is exactly the failure mode the artifact loader was built to prevent — it just doesn't cover the supported-pairing surface. It will also block a third backend cleanly: every new observer-capable backend has to re-find this branch.
- **Fix:** Lift the observer-prompt resolve+inject step out of `spawnCLI` and into the launcher's `launch()` (or a small helper called from both `spawnCLI` and `spawnCodex*`) so the precondition is `sessionGroupRole === "observer"`, not `sessionGroupRole === "observer" AND backendType === "claude"`. For the Codex branches, route the resolved `artifact.body` into `CodexAdapter`'s existing `systemPrompt` option. Keep the SHA-256 record on `SdkSessionInfo` regardless of backend so EC-1 boot-canary and the recorder forensic story are uniform.

---

## F2. `session-orchestrator.initialize()` duplicates a four-line member-lookup loop across four group-event listeners

- **Title:** `for (const s of this.launcher.listSessions()) if (s.sessionGroupId === sessionGroupId) ids.push(...)` repeated four times in `initialize()`
- **File:** `/root/aura-companion/web/server/session-orchestrator.ts` lines 295-346 (group:exited / group:degraded / group:checkpoint / group:review handlers)
- **Principle:** Principle 2 — Extract pure logic / Principle 5 — Shotgun Surgery
- **Severity:** P2
- **What's wrong:** Four bus listeners each rebuild the "live members of this group" id list with the same `O(n)` scan over `launcher.listSessions()`. The lookup is pure (input: `sessionGroupId`, launcher; output: `string[]`) so extraction is universally safe. Today the cost is a few cache lines; tomorrow when a fifth `group:*` event lands (e.g. `group:reconnected`, `group:resumed`) the implementer will pattern-match on three siblings and copy the same loop a fifth time. The "is this listener correctly handling missing halves?" question already has four answers when it should have one.
- **Consequence:** Adding a new `group:*` event variant becomes shotgun surgery across `initialize()`. Worse, when the launcher gets a reverse index (`groupBySessionId`), the migration has to touch four sites — and any one missed is silently slower. Coordinator-side group membership is the natural source; the orchestrator shouldn't be the one re-deriving it per event.
- **Fix:** Add a single `private getGroupMemberIds(sessionGroupId: string): string[]` helper (or expose it on the coordinator, which already owns the group record). All four listeners call the helper. Optionally promote the four `wsBridge.broadcastToGroup(...)` calls into one `broadcastGroupEvent(sessionGroupId, msg)` helper that fetches members and broadcasts — this also localises the "group with both halves dead" no-op story.

---

## F3. Sidebar re-implements the `findUnresolvedStops` predicate inline rather than calling the existing pure helper

- **Title:** `councilInfoFor` re-implements unresolved-STOP counting; one of three places that know the rule
- **File:** `/root/aura-companion/web/src/components/Sidebar.tsx` lines 564-582
- **Principle:** Principle 4 — Inconsistent vocabulary across modules / Principle 5 — Feature Envy
- **Severity:** P2
- **What's wrong:** The unresolved-STOP definition ("severity === STOP && !wasDowngraded && !dismissedStopIds.has") already lives in `observer-panel-state.ts:findUnresolvedStops` and is reused by `ObserverPanel`, `ChatView`, and `use-browser-title-alert` via `countUnresolvedStopsAcrossGroups`. Sidebar `councilInfoFor` writes the same predicate by hand (lines 575-580). Two surfaces will drift the moment severity semantics change (e.g. a new severity tier, a "snoozed" state, or a future grace-window on freshly-arrived STOPs) — Sidebar will report a count that disagrees with the panel and the browser title.
- **Consequence:** The "unread STOPs" number on a sidebar session badge is load-bearing UX (it's the at-rest blocker affordance for backgrounded sessions). When it disagrees with `ObserverPanel`'s "N unresolved" status pill or the title-tab counter, users will report it as a bug and a refactor will then have to chase three call-sites — exactly the kind of vocabulary drift Principle 4 flags.
- **Fix:** Replace the inline loop with `findUnresolvedStops(groupFindings, dismissedStopIds).length`. The helper already exists, is pure, has direct unit tests for both the "no findings" and "live STOPs" branches, and is imported elsewhere in the same module graph — there is no economic cost to the change and it removes a future fear-zone.

---

## F4. `createCouncilGroup` inlines a label parser whose responsibility belongs to `backend-provider.ts` (where the allow-list lives)

- **Title:** `parsePairingLabel` defined as a closure inside `createCouncilGroup` rather than co-located with `SUPPORTED_PAIRINGS`
- **File:** `/root/aura-companion/web/server/session-orchestrator.ts` lines 511-526 (especially the inline `parsePairingLabel` lambda inside the `Promise.all` import)
- **Principle:** Principle 6 — Architecture earns its boundaries / Principle 4 — Names reveal design
- **Severity:** P3
- **What's wrong:** Parsing `"claude+codex"` into `{ primary, observer }` is the same concept as `SUPPORTED_PAIRINGS` validates against — the two-half discriminated label IS the wire form of a `BackendPairing`. Today the parser is wrapped in an `import` adapter and apologised for via comment ("parsePairingLabel is defined inline below — backend-provider exports the supported pairings list but not a label parser since the label format is a routes-layer concern"). The comment itself is the smell: the orchestrator is shouldering "label format" knowledge that belongs next to the allow-list it gates. The split-by-`+`, length-2, both-halves-known-backend logic is exactly what `backend-provider` should own — `routes.ts` would then use the same parser when validating the public request shape.
- **Consequence:** Adding a third backend means editing two files in lock-step: append to `SUPPORTED_PAIRINGS` AND add a clause to the inline parser. Adding a third pairing dimension (e.g. provider+model) means rewriting the parser inside the orchestrator's `createCouncilGroup` — a function whose responsibility should be "coordinate the spawn", not "decode the wire label". This is the sort of low-grade coupling that compounds: each new feature finds another inline label-handling site.
- **Fix:** Export a `parsePairingLabel(label: string): BackendPairing | null` from `backend-provider.ts` next to `isSupportedPairing` and `SUPPORTED_PAIRINGS`. The orchestrator imports it like any other helper. `routes.ts` reuses it for input validation. No comment apology needed.

---

## F5. `session-orchestrator.ts` initialize() now packs eight bus subscriptions plus four group listeners plus tear-down into one 160-line method — multi-concern god-method risk

- **Title:** `initialize()` is now ~160 lines spanning single-session lifecycle, auto-relaunch, idle-kill, naming, group fanout, watcher teardown, and watchdog start
- **File:** `/root/aura-companion/web/server/session-orchestrator.ts` lines 199-357
- **Principle:** Principle 6 — Missing boundaries where they matter / Principle 5 — Smells that compound
- **Severity:** P2
- **What's wrong:** The orchestrator's `initialize()` was already a long sequence of `companionBus.on(...)` subscriptions for the single-session machinery. Phase D-G added five more (`group:created`, `group:exited`, `group:degraded`, `group:checkpoint`, `group:review`, plus a second `group:exited` listener for watcher teardown). They are interleaved with the existing single-session listeners — the council bag and the solo bag don't have visible boundaries. The file's overall LOC has crossed 1100; the watcher lifecycle, listener wiring, and Council fanout share gravity. The convention compliance is excellent (AP-1 holds, group fanout uses the bus, watchers obey AbortController) — so the issue isn't logic correctness, it's that **the next change to council-mode-specific listeners will require reading 160 lines of mixed concerns to be sure no single-session subscription was accidentally affected**.
- **Consequence:** This is the textbook `ws-bridge.ts` precedent — the orchestrator is the corresponding hub on the spawn/lifecycle side, and Council Mode has now started loading it the same way. Each future incident (e.g. group:reconnected, group:resumed-on-restart, council kill-confirmation acks) will tempt the implementer to thread one more listener into the same method. Once five mixed concerns reach seven or eight, the file becomes the next fear-zone.
- **Fix:** Extract `private wireGroupListeners()` (the five group:* + watcher-teardown listeners) and call it from `initialize()`. Optional but cheap: a parallel `private wireSessionListeners()` for the existing eight `session:*` subscriptions. The body of `initialize()` becomes a two-line manifest. No behaviour change; tests don't move; the next reviewer can scan one method and know which family of events the change touches.

---

## F6. `Playground.CouncilModeSection` mutates real Zustand store state to seed demos, with cleanup-only-on-unmount — playground side-effects leak across navigation

- **Title:** Playground council demo writes to the live `useStore` (`upsertGroup`, `appendObserverReview`, `setGroupStatus`) instead of using local/isolated demo state
- **File:** `/root/aura-companion/web/src/components/Playground.tsx` lines 2901-2949 (and the parallel `CouncilDegradedPanelDemo` 3057-3076)
- **Principle:** Principle 3 — Mutable Data / Principle 4 — Functions that lie about side effects
- **Severity:** P3
- **What's wrong:** The playground is a development-time fixture surface, but it dispatches `upsertGroup` and `appendObserverReview` against the production Zustand store. The cleanup uses `removeGroup` in the `useEffect` return — which works if the component unmounts cleanly, but any navigation interrupt, error-boundary trip, or HMR reload between Playground mount and unmount leaves `playground-council-grp` and a few mock findings ("Race condition: session-orchestrator opens before worktree exists." against real filenames) sitting in the live store. The sidebar's `councilInfoFor` will then surface a council badge on the playground-only session id (which won't be present on the server) — confusing for the rare case where the user navigates away while the panel is mounted.
- **Consequence:** Mostly a developer-ergonomics smell today (the session id `playground-council-orch` doesn't collide with real UUIDs, so the badge is harmless). But the precedent is the problem: every future playground demo for a stateful slice will think "just call the real action" is the pattern. Stateful demo seeding belongs in a sandboxed store (or component-local mock state passed via props), not in the production store. The components themselves are already prop-driven except for `ObserverPanel`; `ObserverPanel` is the only forced read.
- **Fix:** Option A — render `ObserverPanel` inside a `StoreProvider` that scopes a per-card store instance (clean, requires a small wrapper). Option B — extract a `<ObserverPanelView>` that takes `group`, `findings`, `dismissed` as props and have `ObserverPanel` be a thin store-reader over it (recommended; it also makes the panel itself simpler to test). Option C (minimum-cost) — keep current behaviour but assert via test that the playground store-mutation cleanup is idempotent on the global store and the playground IDs do not collide with active sessions; raise a console warning if they do.

---

## Summary

| # | Severity | File | Theme |
|---|----------|------|-------|
| F1 | P1 | `cli-launcher.ts` | Missing boundary: observer-prompt loading only on Claude path |
| F2 | P2 | `session-orchestrator.ts` | Duplicated knowledge across four group:* listeners |
| F3 | P2 | `Sidebar.tsx` | Reimplements `findUnresolvedStops` inline |
| F4 | P3 | `session-orchestrator.ts` | Inline `parsePairingLabel` belongs in `backend-provider.ts` |
| F5 | P2 | `session-orchestrator.ts` | `initialize()` mixes single-session + council concerns |
| F6 | P3 | `Playground.tsx` | Council demos mutate live store |

**Not flagged (stable / non-economic):**
- `council-slice.ts` map-cloning pattern: heavy but consistent with the rest of the codebase's Zustand idiom; cost is bounded, no read-coupling to component internals. Will become an issue at thousands of findings, not at the v1 scale.
- `ObserverPanel` reads eleven `useStore` selectors: each is narrow; pattern is correct (no monolithic selector); other council components are pure props-driven. Composition is healthy here — flagging would be cleanliness, not economics.
- The `councilWatchers` Map + AbortController lifecycle is the same shape as other orchestrator-owned per-session resources; teardown on `group:exited` is wired correctly.
- 1100-LOC orchestrator overall: addressed via F5 (the relevant lever is `initialize()`, not the whole file).
- `observer-panel-state.ts` derivation has clean, named states and a documented priority ladder — no findings.
- The barrel `components/council/index.ts` re-exports cleanly; no missing or duplicated exports.

The council code is well-encapsulated at the component layer (single store reader, pure helpers shared across surfaces). The remaining structural debt lives in the **backend boundary between cli-launcher's two spawn paths** (F1) and in **orchestrator's group-event fanout** (F2, F5) — both of which compound the moment a third backend or a fifth group event lands.
