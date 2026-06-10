# CLAUDE.md

This file provides guidance to Claude Code & Codex when working with code in this repository.

## What This Is

Aura Companion — a self-learning web UI for Claude Code & Codex.
Forked from [`The-Vibe-Company/companion`](https://github.com/The-Vibe-Company/companion) by [The Vibe Company](https://thevibecompany.co) (MIT), it adds an adaptive knowledge base, Council Mode (orchestrator + observer paired sessions), and self-improvement skills that make every development session smarter than the last.

It reverse-engineers the undocumented `--sdk-url` WebSocket protocol in the Claude Code CLI to provide a browser-based interface for running multiple Claude Code sessions with streaming, tool call visibility, and permission control.

## Development Commands

```bash
# Dev server (Hono backend on :3456 + Vite HMR on :5174)
cd web && bun install && bun run dev

# Or from repo root
make dev

# Type checking
cd web && bun run typecheck

# Production build + serve
cd web && bun run build && bun run start

# Auth token management
cd web && bun run generate-token          # show current token
cd web && bun run generate-token --force  # regenerate a new token

# Landing page (thecompanion.sh) — idempotent: starts if down, no-op if up
# IMPORTANT: Always use this script to run the landing page. Never cd into landing/ and run bun/vite manually.
./scripts/landing-start.sh          # start
./scripts/landing-start.sh --stop   # stop
```

## Testing

```bash
# Run tests
cd web && bun run test

# Watch mode
cd web && bun run test:watch
```

- All new backend (`web/server/`) and frontend (`web/src/`) code **must** include tests when possible.
- **Every new or modified frontend component** (`web/src/components/`) **must** have an accompanying `.test.tsx` file with at minimum: a render test, an axe accessibility scan (`toHaveNoViolations()`), and tests for any interactive behavior (clicks, keyboard shortcuts, state changes).
- Tests use Vitest. Server tests live alongside source files (e.g. `routes.test.ts` next to `routes.ts`).
- A husky pre-commit hook runs typecheck and tests automatically before each commit.
- **Never remove or delete existing tests.** If a test is failing, fix the code or the test. If you believe a test should be removed, you must first explain to the user why and get explicit approval before removing it.
- When creating test, make sure to document what the test is validating, and any important context or edge cases in comments within the test code.

## Component Playground

All UI components used in the message/chat flow **must** be represented in the Playground page (`web/src/components/Playground.tsx`, accessible at `#/playground`). When adding or modifying a message-related component (e.g. `MessageBubble`, `ToolBlock`, `PermissionBanner`, `Composer`, streaming indicators, tool groups, subagent groups), update the Playground to include a mock of the new or changed state.

## Architecture

### Data Flow

```
Browser (React) ←→ WebSocket ←→ Hono Server (Bun) ←→ WebSocket (NDJSON) ←→ Claude Code CLI
     :5174              /ws/browser/:id        :3456        /ws/cli/:id         (--sdk-url)
```

1. Browser sends a "create session" REST call to the server
2. Server spawns `claude --sdk-url ws://localhost:3456/ws/cli/SESSION_ID` as a subprocess
3. CLI connects back to the server over WebSocket using NDJSON protocol
4. Server bridges messages between CLI WebSocket and browser WebSocket
5. Tool calls arrive as `control_request` (subtype `can_use_tool`) — browser renders approval UI, server relays `control_response` back

### All code lives under `web/`

- **`web/server/`** — Hono + Bun backend (runs on port 3456)
  - `index.ts` — Server bootstrap, Bun.serve with dual WebSocket upgrade (CLI vs browser)
  - `ws-bridge.ts` — Core message router. Maintains per-session state (CLI socket, browser sockets, message history, pending permissions). Parses NDJSON from CLI, translates to typed JSON for browsers. Also carries `broadcastToGroup` for Council Mode fanout.
  - `cli-launcher.ts` — Spawns/kills/relaunches Claude Code CLI processes. Handles `--resume` for session recovery. Persists session state across server restarts. Council Mode observer-role spawn pulls the system prompt via `applyCouncilObserverSpawnConfig` (Claude + Codex backends both wired).
  - `session-orchestrator.ts` — Session create/archive/relaunch lifecycle. Owns `createCouncilGroup`, per-group `councilWatchers` map (checkpoint + review filesystem watchers), and `wireGroupListeners()` for `group:created`/`group:exited`/`group:degraded`/`group:checkpoint`/`group:review` bus fanout.
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
    - `observer-grounding.ts` — STOP-only grounding gate: STOPs whose `evidence_path` isn't in modifiedFiles OR missing on disk → downgrade to NOTE. EC-7 idiom: integrated wrapper does realpath + bounds-check; pure `checkStopGrounding` takes injected predicate.
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

### WebSocket Protocol

The CLI uses NDJSON (newline-delimited JSON). Key message types from CLI: `system` (init/status), `assistant`, `result`, `stream_event`, `control_request`, `tool_progress`, `tool_use_summary`, `keep_alive`. Messages to CLI: `user`, `control_response`, `control_request` (for interrupt/set_model/set_permission_mode).

Full protocol documentation is in `WEBSOCKET_PROTOCOL_REVERSED.md`.

### Session Lifecycle

Sessions persist to disk (`$TMPDIR/vibe-sessions/`) and survive server restarts. On restart, live CLI processes are detected by PID and given a grace period to reconnect their WebSocket. If they don't, they're killed and relaunched with `--resume` using the CLI's internal session ID.

### Raw Protocol Recordings

The server automatically records **all raw protocol messages** (both Claude Code NDJSON and Codex JSON-RPC) to JSONL files. This is useful for debugging, understanding the protocol, and building replay-based tests.

- **Location**: `~/.companion/recordings/` (override with `COMPANION_RECORDINGS_DIR`)
- **Format**: JSONL — one JSON object per line. First line is a header with session metadata, subsequent lines are raw message entries.
- **File naming**: `{sessionId}_{backendType}_{ISO-timestamp}_{randomSuffix}.jsonl`
- **Disable**: set `COMPANION_RECORD=0` or `COMPANION_RECORD=false`
- **Rotation**: automatic cleanup when total lines exceed 1M (configurable via `COMPANION_RECORDINGS_MAX_LINES`)

Each entry captures:
```json
{"ts": 1771153996875, "dir": "in", "raw": "{\"type\":\"system\",...}", "ch": "cli"}
```
- `dir`: `"in"` (received by server) or `"out"` (sent by server)
- `ch`: `"cli"` (Claude Code / Codex process) or `"browser"` (frontend WebSocket)
- `raw`: the exact original string — never re-serialized, preserving the true protocol payload
- `origin` (optional, on `"out"` frames only): provenance of the send. One of `"browser"` (default; field usually omitted on-disk to keep entry size minimal — browser-relayed sends are the common case), `"server:council-wake"` (synthesised by the Council Mode auto-wake dispatcher), or `"server:auto-proceed"` (synthesised by the orchestrator-idle auto-proceed pipeline on idle-timeout). Inbound (`"in"`) frames never carry `origin` — provenance is implicit from the CLI subprocess.

**REST API**:
- `GET /api/recordings` — list all recording files with metadata
- `GET /api/sessions/:id/recording/status` — check if a session is recording + file path
- `POST /api/sessions/:id/recording/start` / `stop` — enable/disable per session

**Code**: `web/server/recorder.ts` (recorder + manager), `web/server/replay.ts` (load & filter utilities).

### Council Mode (paired orchestrator + observer sessions)

A user-opt-in flag on the New Session form (`councilMode: "council"` + `councilPairing: "claude+claude" | "claude+codex"`) spawns two linked CLI sessions sharing one workspace — an **orchestrator** that the user drives via the main chat surface, and an **observer** that wakes on filesystem checkpoint sentinels, reads a manifest of paths, emits a structured review file, and the server fans grounded findings back into the orchestrator's UI as `BlockerBanner` + side-panel `ObserverPanel`.

**Cross-process protocol** lives entirely on the filesystem under `<workspace>/.council/`:
- `.council/prompts/observer-system.md` — versioned (`<!-- observer-system-prompt v1 -->`) CLI-agnostic role definition. Loaded at observer spawn time; hash stamped on `SdkSessionInfo.observerPromptSha256`. **OPTIONAL per-workspace override** — if absent, the bundled fallback (`observer-prompt-bundled.ts`, generated from this repo's canonical artifact) is used and `SdkSessionInfo.observerPromptSource` reflects `"bundled"` vs `"workspace"`. Malformed-but-present STILL throws — the explicit-intent contract is preserved at the loader layer.
- `.council/checkpoints/<phase>.json` — written by the orchestrator via `writeAtomicJson` after each Carmack-Council phase. Schema: `CheckpointPayload` in `council-types.ts`. Producer-side REST: `POST /api/sessions/:id/council/checkpoint` with the JSON payload as the body — server validates via `parseCheckpointPayload`, cross-checks `session_group_id` against the caller's actual group (orchestrator-half only), then atomically writes into the workspace's `.council/checkpoints/` directory.
- `.council/reviews/<phase>-<provider>-observer.md` — written by the observer (content is JSON despite `.md` extension). Filename MUST carry the `<provider>` segment (`claude` | `codex`) so the `claude+codex` pairing produces two distinct review files per checkpoint rather than colliding under the watcher's debounce window.

**Server pipeline:**
1. `routes.ts /sessions/create` (or `/sessions/create-stream`) branches on `councilMode === "council"` → `orchestrator.createCouncilGroup`.
2. `SessionGroupCoordinator` calls injected spawn callback twice (orchestrator + observer) with shared `sessionGroupId` and respective `sessionGroupRole`. Atomic rollback — observer-spawn failure kills the orchestrator half before propagating.
3. `cli-launcher.applyCouncilObserverSpawnConfig` loads the prompt artefact, applies `getObserverSpawnOverrides()` (allowed/disallowed tools + permission mode intersected with caller-supplied lists), and injects `--append-system-prompt` (Claude) or `systemPrompt` option (Codex).
4. `session-orchestrator.startCouncilWatchers` arms `watchCheckpoints` + `watchReviews` on the workspace's `.council/` subtree (recursive `mkdirSync` ensures the dirs exist before watch attach).
5. On each checkpoint: `handleCouncilCheckpoint` rejects stale sequences, captures the prior checkpoint, emits `group:checkpoint`.
6. On each review file: `handleCouncilReview` runs `validateObserverFindings` against the manifest's delta paths (via `buildObserverContextManifest`); STOPs outside the modified set OR missing on disk are downgraded to NOTE server-side. Findings get deterministic `fnd_<hex>` ids derived from `(sessionGroupId, checkpointId, observerProvider, findingIndex, evidence_path, claim)` — restart-replay produces stable ids, browser dedup catches it. Emits `group:review` with both findings + downgrades.
7. `wireGroupListeners` in `initialize()` fans `group:created` / `group:exited` / `group:degraded` / `group:checkpoint` / `group:review` out to both halves' browsers via `wsBridge.broadcastToGroup`.
8. `applyEvent` on the coordinator's state machine is the **sole** lifecycle mutator: a pure `deriveSideEffects(prev, next, event)` table decides which `group:*` bus events fire and which EC-9 log entries land; `applyEvent` drains both. `archiveGroup` routes through `applyEvent({type:"user_archived"})` so the `group:exited` emit comes from the same channel, still firing BEFORE the kills proceed so the browser cleans its store first.
9. Unintentional `session:exited` against a council-tracked half drives `coordinator.armReconnect` (45s grace, env-overridable via `COMPANION_GROUP_RECONNECT_GRACE_MS`) instead of immediate `group:degraded`. If the half re-handshakes via `session:cli-id-received` within the window → `reconnect_ok` → `group:created` re-broadcast (active). Otherwise → `reconnect_failed` → `group:degraded`. `relaunchExhaustedNotified` or `intentionalKills` short-circuit the grace; cascading second-half death also short-circuits. EC-2 invariant is preserved on the kill paths (archive/delete still mark both intentional first).

**Browser pipeline:**
1. `ws.ts` switch dispatches `group_*` / `observer_review` to council slice actions.
2. `observer-panel-state.deriveObserverPanelState` derives the discriminated-union status from `(group, findings, dismissedStopIds)` — priority ladder degraded > blocker-found > reconnecting > reviewing > spawning > sleeping > never-checkpointed-yet.
3. `BlockerBanner` renders the most-recent unresolved STOP in the same DOM slot as `PermissionBanner` (permission-first stacking); `ObserverPanel` (sibling of ChatView) renders the status pill + collapsible rail + FindingsLog; `Sidebar` shows per-session ProviderBadges + unread STOP counter.
4. `useBrowserTitleAlert` prepends `(N)` to `document.title` aggregated across all groups; `useCouncilShortcuts` provides `Cmd/Ctrl+Shift+O` (toggle panel) and `Cmd/Ctrl+Shift+B` (focus blocker primary action).

**Convention floor (do not re-flag in council reviews):**
- `AP-1` Coordinator decoupled from session-orchestrator via DI.
- `AP-2` `group-state-machine.ts` is single source of truth for group lifecycle status.
- `AP-3` `council-types.ts` hosts both writer and reader schemas in one file.
- `EC-1` Observer SDK permission profile applied at spawn argv (`applyCouncilObserverSpawnConfig`).
- `EC-2` Group-aware kills mark BOTH session ids intentional BEFORE either kill executes.
- `EC-3` Coordinator types distinguish Companion `sessionId` from CLI `cliSessionId`.
- `EC-4` Filesystem watcher debounce never silently coalesces distinct payloads (use `(file, mtimeNs)` keying + `onDropped("superseded")`).
- `EC-5` Protocol parsers reject unknown methods/frame shapes; tolerate polymorphic-by-spec fields.
- `EC-6` Load-bearing protocol parsers require replay-based regression tests.
- `EC-7` Filesystem-access predicates inline path resolution OR are exposed only via resolving wrapper.
- `EC-8` Reconciliation actions require sentinel-before-sweep helpers.
- `EC-9` Group-lifecycle log lines must be structured JSON with `event` + `sessionGroupId` + (where applicable) `sessionId` + `role`.
- `EC-13` Observer failsafe: server schedules a 5-min recurring tick per observer that scans `.council/checkpoints/` and synthesises a wake for any unprocessed checkpoint. The observer's system prompt (`.council/prompts/observer-system.md` → `Failsafe` section) documents the matching observer-side behaviour. Pair with `scanForMissedObserverWakes` reconcile on init.

Full conventions list in `conventions.md`. Council review artefacts (per-expert findings + synthesised `FINAL-REVIEW.md`) in `.council/review-output/<TIMESTAMP>/`.

## Browser Exploration

Always use `agent-browser` CLI command to explore the browser. Never use playwright or other browser automation libraries.

## Pull Requests

When submitting a pull request:
- use commitizen to format the commit message and the PR title
- Add a screenshot of the changes in the PR description if it's a visual change
- Explain simply what the PR does and why it's needed
- Tell me if the code was reviewed by a human or simply generated directly by an AI. 
- The `Co-Authored-By` commit trailer MUST be version-less — use `Co-Authored-By: Claude <noreply@anthropic.com>`. Never append a model version (e.g. "Opus 4.7"): the harness default hardcodes a stale version that does not track the running model.

## Linear Issues

When creating or updating Linear issues:
- do not use commitizen-style titles in Linear
- use clear product-style titles that describe user value/outcome

### How To Open A PR With GitHub CLI

Use this flow from the repository root:

```bash
# 1) Create a branch
git checkout -b fix/short-description (commitizen)

# 2) Commit using commitizen format
git add <files>
git commit -m "fix(scope): short summary" (commitizen)

# 3) Push and set upstream
git push -u origin fix/short-description

# 4) Create PR (title should follow commitizen style)
gh pr create --base main --head fix/short-description --title "fix(scope): short summary"
```

For multi-line PR descriptions, prefer a body file to avoid shell quoting issues:

```bash
cat > /tmp/pr_body.md <<'EOF'
## Summary
- what changed

## Why
- why this is needed

## Testing
- what was run

## Review provenance
- Implemented by AI agent / Human
- Human review: yes/no
EOF

gh pr edit --body-file /tmp/pr_body.md
```

## Codex & Claude Code
- All features must be compatible with both Codex and Claude Code. If a feature is only compatible with one, it must be gated behind a clear UI affordance (e.g. "This feature requires Claude Code") and the incompatible option should be hidden or disabled.
- When implementing a new feature, always consider how it will work with both models and test with both if possible. If a feature is only implemented for one model, document that clearly in the code and in the UI.

## Self-Learning System

This project uses a file-based knowledge system that improves with every session. The knowledge base lives in `.agents/knowledge/` and accumulates patterns, gotchas, decisions, and anti-patterns discovered during development.

### Knowledge Base

```
.agents/knowledge/
├── patterns.jsonl        # Reusable approaches that work well
├── gotchas.jsonl         # Surprising behaviors and tricky edge cases
├── decisions.jsonl       # Architectural choices and rationale
├── anti-patterns.jsonl   # Approaches to avoid
├── codebase-facts.jsonl  # Structural knowledge about the repo
└── api-behaviors.jsonl   # Model/tool/API quirks
```

Each file contains one JSON object per line (JSONL format) with: `id`, `type`, `fact`, `recommendation`, `confidence`, `provenance`, `tags`, `affectedFiles`, `createdAt`.

### Skills

- `/prime [focus]` — Load relevant knowledge before starting work. Auto-filters by branch, modified files, or provided keywords. Run at session start.
- `/learn <insight>` — Quick-capture a learning mid-session without breaking flow. Auto-classifies and appends to the right knowledge file.
- `/self-reflect [scope]` — End-of-session reflection. Reviews what happened, extracts learnings, prunes stale entries. Run after completing significant work.

### Self-Learning Protocol

1. **Session start**: Automatically scan the last 3 entries from each knowledge file. If any are relevant to the current branch/task, surface them.
2. **During work**: When you encounter surprising behavior, test failures, or user corrections — capture them immediately via `/learn`.
3. **Session end**: Run `/self-reflect` to consolidate learnings. This is the most important step — it closes the feedback loop.

### Evolution

The knowledge base grows organically. Over time:
- Recurring gotchas → get promoted to patterns or CLAUDE.md rules
- Low-confidence entries that get re-confirmed → get bumped to high confidence
- Stale entries (fixed bugs, reversed decisions) → get pruned during `/self-reflect`
- Cross-cutting patterns → may spawn new skills

## Production deployment

For self-hosting on a Linux VPS or any non-loopback origin, two things matter beyond the dev setup:

1. **Run under a systemd unit with `KillMode=process`** — see [`docs/deploy/vps-systemd.mdx`](docs/deploy/vps-systemd.mdx) for a minimal recipe. `KillMode=process` ensures that when the bun parent is restarted, the long-lived `claude` / `codex` child subprocesses survive and reconnect over the local WebSocket; without it every restart kills in-flight agent work.

2. **Set `COMPANION_ALLOWED_ORIGIN`** to the exact origin (`scheme://host:port`, no trailing slash) the browser will use. Localhost dev origins (`http://localhost:5173`, `http://localhost:5174`) are always allowed; everything else — public IP, LAN host, tailscale `*.ts.net`, reverse-proxy domain — must appear in the comma-separated value, or the WS upgrade is rejected and the UI surfaces `Connection timeout` after `Session started`. The gate is enforced in `web/server/middleware/origin-allowlist.ts` and applied to `/ws/browser`, `/ws/terminal`, `/ws/novnc`. CLI subprocess WS (`/ws/cli/:id`) is exempt because it always comes from loopback.

If a user reports timeouts at the last step of session creation while earlier steps (`Environment resolved` / `Fetch complete` / `Session started`) report green, the first canary is the producer-side fanout count in periodic `[diagnostics]` log lines: `browsers=0` with active sessions means the Origin allowlist is rejecting the UI, not a subprocess problem.

## Cursor Cloud specific instructions

### Services
- **Hono backend** (port 3457 in dev): `cd web && bun run dev:api` or via `./scripts/dev-start.sh`
- **Vite frontend** (port 5174 in dev): `cd web && bun run dev:vite` or via `./scripts/dev-start.sh`
- Both start together with `cd web && bun run dev` (or `make dev`), but that runs in foreground. Use `./scripts/dev-start.sh` for background mode.

### Caveats
- `./scripts/dev-start.sh` health-checks the backend on `/` which returns 404. If the script times out, the backend is still running — verify with `curl http://localhost:3457/api/sessions`. You can start the servers manually as background processes instead.
- The app requires Claude Code CLI or Codex CLI to create functional sessions. Without them, the UI loads but session creation will fail. The component playground at `#/playground` works without any CLI.
- No external databases or services are needed. Session state persists to `$TMPDIR/vibe-sessions/` as JSON files.
- The pre-commit hook (`.husky/pre-commit`) runs `cd web && bun run typecheck && bun run test -- --coverage`. Run these before committing.
- Two blocked postinstalls (`core-js`, `protobufjs`) are harmless and do not affect functionality.
