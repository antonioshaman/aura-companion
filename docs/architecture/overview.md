# Architecture overview

> Moved out of `CLAUDE.md` in P2/A3 (2026-09-28). `CLAUDE.md` links here with one line;
> this file is loaded on demand, not on every session start.

## Transport

**Transport note (2026-09):** the original implementation carried that protocol over the
undocumented `--sdk-url` WebSocket. Claude Code >= 2.1.121 rejects `--sdk-url` for any host
outside a compiled-in Anthropic allowlist, so **stdio is now the default transport** — the
same `stream-json` frames over the CLI's own stdin/stdout. `COMPANION_CLAUDE_TRANSPORT=ws`
restores the WebSocket path for a CLI pinned below 2.1.121. See `web/server/cli-transport.ts`.

## Data Flow

Ports: the backend listens on **3456 in production** and **3457 in dev** (`web/server/constants.ts`);
the diagram below shows the production port. Vite HMR is on 5174.

```
Browser (React) ←→ WebSocket ←→ Hono Server (Bun) ←→ stdin/stdout (NDJSON) ←→ Claude Code CLI
     :5174              /ws/browser/:id        :3456          pipes               (stream-json)
```

1. Browser sends a "create session" REST call to the server
2. Server spawns `claude --print --input-format stream-json --output-format stream-json`
   with piped stdio (no `--sdk-url`, no `-p ""` — an empty positional prompt would be
   consumed as the turn and the CLI would exit before reading stdin)
3. The server writes frames to the child's stdin and pumps its stdout, line-buffered
   (a pipe can split a JSON frame at any byte; a WebSocket message never could)
4. Server bridges messages between the CLI transport and the browser WebSocket
5. Tool calls arrive as `control_request` (subtype `can_use_tool`) — browser renders approval UI, server relays `control_response` back

Legacy WS transport (`COMPANION_CLAUDE_TRANSPORT=ws`, CLI < 2.1.121): the server instead
spawns `claude --sdk-url ws://localhost:3456/ws/cli/SESSION_ID` and the CLI dials back;
steps 3-5 are unchanged apart from where the bytes travel.

## All code lives under `web/`

- **`web/server/`** — Hono + Bun backend (runs on port 3456)
  - `index.ts` — Server bootstrap, Bun.serve with dual WebSocket upgrade (CLI vs browser)
  - `ws-bridge.ts` — Core message router. Maintains per-session state (CLI socket, browser sockets, message history, pending permissions). Parses NDJSON from CLI, translates to typed JSON for browsers. Also carries `broadcastToGroup` for Council Mode fanout.
  - `cli-launcher.ts` — Spawns/kills/relaunches Claude Code CLI processes. Handles `--resume` for session recovery. Persists session state across server restarts. Council Mode observer-role spawn pulls the system prompt via `applyCouncilObserverSpawnConfig` (Claude + Codex backends both wired).
  - `session-orchestrator.ts` — Session create/archive/relaunch lifecycle. Owns `createCouncilGroup`, per-group `councilWatchers` map (checkpoint + review filesystem watchers), and `wireGroupListeners()` for `group:created`/`group:exited`/`group:degraded`/`group:checkpoint`/`group:review` bus fanout.
  - `council-checkpoint-pipeline.ts` — Checkpoint → observer wake (gates, 1-slot queue, wake sentinel) → wake→review watchdog → observer reply capture → review grounding + `group:review` emit. Injected with the orchestrator's `councilWatchers`/`councilGroupMeta` maps and lazy getters (AP-1).
  - `session-group-coordinator.ts` — Council Mode pair lifecycle (spawn-with-rollback, archive, state-machine transitions). Decoupled from `session-orchestrator.ts` via injected `SessionSpawner`/`SessionKiller` — AP-1 convention.
  - `group-state-machine.ts` — Pure `transition(state, event)` for the 5 group statuses (`pairing | active | degraded | archived | reconnecting`). Single source of truth for group lifecycle.
  - `session-store.ts` — JSON file persistence to `$TMPDIR/vibe-sessions/`. Debounced writes.
  - `session-types.ts` — All TypeScript types for CLI messages (NDJSON), browser messages, session state, permissions. Includes 5 Council Mode wire variants (`group_*` + `observer_review`).
  - `routes.ts` — REST API: session CRUD, filesystem browsing, environment management. `POST /sessions/create` + `/sessions/create-stream` branch on `councilMode: "council"` to `orchestrator.createCouncilGroup`.
  - `env-manager.ts` — CRUD for environment profiles stored in `~/.companion/envs/`.
  - **Council Mode supporting modules:**
    - `atomic-write.ts` — `writeAtomicJson` (tmp+rename+fsync) for council artifact emission.
    - `checkpoint-watcher.ts` / `review-watcher.ts` — Filesystem watchers on `.council/checkpoints/` and `.council/reviews/`. Atomic-write contract + debounce + LRU dedup + `onDropped("superseded")` log for EC-4 compliance.
    - `council-types.ts` — `CheckpointPayload` + `ObserverReviewPayload` schemas. Both writer and reader live in one file (AP-3). `isBoundedToken` / `isBoundedText` / `isIsoTimestamp` validators per semantic category.
    - `observer-prompt.ts` — Loads `.council/prompts/observer-system.md` at observer spawn via `resolveObserverSystemPrompt(workspacePath)`. When the workspace file is absent (ENOENT only — EACCES/EISDIR/ELOOP still throw), falls back to the BUNDLED artifact in `observer-prompt-bundled.ts` (auto-generated from the repo's canonical `.council/prompts/observer-system.md` by `scripts/build-observer-prompt-bundle.ts`; CI canary `bun run build-observer-prompt-bundle && git diff --exit-code` enforces sync). Provenance is stamped on `SdkSessionInfo.observerPromptSource: "workspace" | "bundled"` and surfaced via a WARN log `council.observer-prompt.bundled-fallback` when fallback fires. Pure `buildObserverContextManifest` partitions `(current, previous)` checkpoints into `{delta, carried, dropped}` so observer reads delta-not-cumulative.
    - `observer-attribution.ts` — `wrapObserverFindingForInjection` (structured envelope + text-form for chat); `formatObserverInvocationLog` (EC-9 structured log entry with `promptSha256` + STOP counts + latency).
    - `observer-grounding.ts` — STOP-only grounding gate: STOPs whose `evidence_path` isn't in modifiedFiles OR missing on disk → downgrade to NOTE. EC-7 idiom: integrated wrapper does realpath + bounds-check; pure `checkStopGrounding` takes injected predicate. With line facts from `observer-line-snapshots.ts` (per-checkpoint content snapshots, diffed against the group's previous capture), `checkStopLines` also downgrades STOPs citing lines past EOF or lines the checkpoint did not change, and marks path-only / claim-not-on-cited-lines STOPs as `weakEvidence` (still STOP, but excluded from the BlockerBanner and unread-blocker counts). Unknown baseline (first capture, restart) → the unchanged check is skipped, never guessed.
    - `observer-permissions.ts` — Observer tool allow/deny lists. Module-load canary asserts disjoint. Applied at spawn via `applyCouncilObserverSpawnConfig`.
    - `observer-write-policy.ts` — `assertObserverWriteAllowed(path, root)` for the observer's write boundary (realpath + workspace bounds).
    - `group-authorization.ts` — Cryptographic group-id pattern + auth checks for council REST endpoints.
    - `group-reconciliation.ts` — Restart-recovery decisions (both-alive / orchestrator-only / observer-only / neither).
    - `group-shutdown.ts` — Graceful SIGTERM teardown of active groups during server shutdown.
    - `preflight-probe.ts` — Cached capability probe (`which codex` + `codex --version`) for the UI's pairing-availability gate.
    - `backend-provider.ts` — `BackendProvider` seam + `SUPPORTED_PAIRINGS` allow-list (`claude+claude`, `claude+codex`).
    - `codex-envelope.ts` — Strict typed parser for Codex JSON-RPC frames crossing the bridge.

- **`web/src/`** — React 19 frontend
  - `store.ts` (barrel) — Re-exports Zustand store from `store/` slices.
  - `store/council-slice.ts` — Council Mode state (groups, findings, dismissed STOPs, panel-open per session, first-run hint). Persisted preferences via `localStorage`.
  - `store/sessions-slice.ts` / `chat-slice.ts` / `permissions-slice.ts` / etc. — Per-domain slices.
  - `ws.ts` — Browser WebSocket client. Connects per-session, handles all incoming message types, auto-reconnects. Includes 5 new `group_*` / `observer_review` cases dispatching to council slice actions.
  - `types.ts` — Re-exports server types + client-only types (`ChatMessage`, `TaskItem`, `SdkSessionInfo`, `GroupRecord`, `ObserverFinding`, `ObserverPanelState`).
  - `observer-panel-state.ts` — Pure `deriveObserverPanelState({group, findings, dismissedStopIds, nowMs})` returns the discriminated union for the panel header (priority ladder: degraded > blocker-found > reconnecting > reviewing > spawning > sleeping > never-checkpointed-yet).
  - `use-browser-title-alert.ts` — Global hook prepending `(N)` to `document.title` when unresolved STOPs exist anywhere.
  - `use-council-shortcuts.ts` — Global hook: `Cmd/Ctrl+Shift+O` toggles Observer panel; `Cmd/Ctrl+Shift+B` focuses BlockerBanner primary action.
  - `api.ts` — REST client for session management. `CreateSessionOpts.councilMode + councilPairing` for council-mode spawn.
  - `App.tsx` — Root layout with sidebar, chat view, task panel, ObserverPanel (sibling of ChatView for Council pairs). Hash routing (`#/playground`).
  - `components/` — UI: `ChatView`, `MessageFeed`, `MessageBubble`, `ToolBlock`, `Composer`, `Sidebar`, `TopBar`, `HomePage`, `TaskPanel`, `PermissionBanner`, `EnvManager`, `Playground`.
  - `components/council/` — 6 Council Mode components: `CouncilToggle` (New Session toggle + provider dropdown with full APG listbox keyboard model), `ObserverPanel` (5-state status pill + collapsible rail + FindingsLog), `BlockerBanner` (destructive token in PermissionBanner slot, JSX-escaped claim), `DegradedBanner` (warning token in panel header), `ProviderBadges` (asymmetric chips for `claude+codex`), `FindingsLog` (`role="log"` + `aria-live="polite"`, server-assigned stable ids).

- **`web/bin/cli.ts`** — CLI entry point (`bunx the-companion`). Sets `__COMPANION_PACKAGE_ROOT` and imports the server.

## WebSocket Protocol

The CLI uses NDJSON (newline-delimited JSON). Key message types from CLI: `system` (init/status), `assistant`, `result`, `stream_event`, `control_request`, `tool_progress`, `tool_use_summary`, `keep_alive`. Messages to CLI: `user`, `control_response`, `control_request` (for interrupt/set_model/set_permission_mode).

Full protocol documentation is in `WEBSOCKET_PROTOCOL_REVERSED.md`.

