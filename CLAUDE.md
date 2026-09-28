# CLAUDE.md

This file provides guidance to Claude Code & Codex when working with code in this repository.
It holds only the load-bearing rules; details live in the linked docs — open them when the task touches that area.

## What This Is

Aura Companion — a self-learning web UI for Claude Code & Codex (fork of [`The-Vibe-Company/companion`](https://github.com/The-Vibe-Company/companion), MIT). It adds an adaptive knowledge base, Council Mode (orchestrator + observer paired sessions), and self-learning skills (`/prime`, `/learn`, `/self-reflect`).

It drives the Claude Code CLI's `stream-json` protocol to run multiple sessions in the browser with streaming, tool-call visibility, and permission control. **stdio is the default transport** (Claude Code >= 2.1.121 rejects `--sdk-url` for non-Anthropic hosts); `COMPANION_CLAUDE_TRANSPORT=ws` restores the legacy WebSocket path for an older CLI. See `web/server/cli-transport.ts`.

## Development Commands

```bash
# Dev server (Hono backend on :3457 + Vite HMR on :5174; production backend is :3456)
cd web && bun install && bun run dev      # or `make dev` from repo root

cd web && bun run typecheck               # type checking
cd web && bun run build && bun run start  # production build + serve
cd web && bun run generate-token [--force]  # show / regenerate auth token

# Landing page — idempotent. IMPORTANT: always use this script; never cd into landing/ and run bun/vite manually.
./scripts/landing-start.sh [--stop]
```

Background dev servers, Cursor Cloud caveats: [docs/conventions/dev-environment.md](docs/conventions/dev-environment.md).

## Testing

```bash
cd web && bun run test          # or test:watch
```

- All new backend (`web/server/`) and frontend (`web/src/`) code **must** include tests when possible.
- **Every new or modified frontend component** (`web/src/components/`) **must** have an accompanying `.test.tsx` file with at minimum: a render test, an axe accessibility scan (`toHaveNoViolations()`), and tests for any interactive behavior (clicks, keyboard shortcuts, state changes).
- Tests use Vitest. Server tests live alongside source files (e.g. `routes.test.ts` next to `routes.ts`).
- A husky pre-commit hook runs typecheck and tests automatically before each commit.
- **Never remove or delete existing tests.** If a test is failing, fix the code or the test. If you believe a test should be removed, you must first explain to the user why and get explicit approval before removing it.
- When creating test, make sure to document what the test is validating, and any important context or edge cases in comments within the test code.

## Task reporting

Call `TodoWrite` on every task-state transition (when a task starts and the moment it completes). The Task Panel mirrors your last `TodoWrite`; its staleness badge semantics: [docs/conventions/task-reporting.md](docs/conventions/task-reporting.md).

## Component Playground

All UI components used in the message/chat flow **must** be represented in the Playground page (`web/src/components/Playground.tsx`, accessible at `#/playground`). When adding or modifying a message-related component (e.g. `MessageBubble`, `ToolBlock`, `PermissionBanner`, `Composer`, streaming indicators, tool groups, subagent groups), update the Playground to include a mock of the new or changed state.

## Architecture

```
Browser (React) ←→ WebSocket ←→ Hono Server (Bun) ←→ stdin/stdout (NDJSON) ←→ Claude Code CLI
     :5174              /ws/browser/:id     :3456 prod / :3457 dev   pipes         (stream-json)
```

All code lives under `web/`: `web/server/` (Hono + Bun backend; core router `ws-bridge.ts`, spawner `cli-launcher.ts`, lifecycle `session-orchestrator.ts`, types `session-types.ts`, REST `routes.ts`), `web/src/` (React 19 + Zustand; slices in `store/`, WS client `ws.ts`, components in `components/` and `components/council/`), `web/bin/cli.ts` (the `bunx the-companion` entry). Protocol reference: `WEBSOCKET_PROTOCOL_REVERSED.md`.

Read the matching doc before changing that area:
- [docs/architecture/overview.md](docs/architecture/overview.md) — data flow step by step, per-file map of `web/server` / `web/src`, CLI message types.
- [docs/architecture/session-lifecycle.md](docs/architecture/session-lifecycle.md) — restart recovery per transport, process identity (`argvSha256` anchor for stdio).
- [docs/architecture/recordings-and-eval-sidecar.md](docs/architecture/recordings-and-eval-sidecar.md) — raw protocol recordings (`~/.companion/recordings/`, JSONL, `origin` field) and the opt-in `COMPANION_EVAL_SIDECAR`.
- [docs/architecture/council-mode.md](docs/architecture/council-mode.md) — `.council/` filesystem protocol, server + browser pipelines, reconnect grace.
- [docs/architecture/production-deployment.md](docs/architecture/production-deployment.md) — systemd `KillMode=process`, `COMPANION_ALLOWED_ORIGIN`, the `browsers=0` diagnostic.

### Council Mode convention floor (do not re-flag in council reviews)

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

## Pull Requests & Linear

- use commitizen to format the commit message and the PR title
- Add a screenshot of the changes in the PR description if it's a visual change
- Explain simply what the PR does and why it's needed
- Tell me if the code was reviewed by a human or simply generated directly by an AI. 
- The `Co-Authored-By` commit trailer MUST be version-less — use `Co-Authored-By: Claude <noreply@anthropic.com>`. Never append a model version (e.g. "Opus 4.7"): the harness default hardcodes a stale version that does not track the running model.
- Linear issues: no commitizen-style titles; use clear product-style titles that describe user value/outcome.

`gh` flow and PR body template: [docs/conventions/pull-requests.md](docs/conventions/pull-requests.md).

## Codex & Claude Code
- All features must be compatible with both Codex and Claude Code. If a feature is only compatible with one, it must be gated behind a clear UI affordance (e.g. "This feature requires Claude Code") and the incompatible option should be hidden or disabled.
- When implementing a new feature, always consider how it will work with both models and test with both if possible. If a feature is only implemented for one model, document that clearly in the code and in the UI.

## Self-Learning System

The knowledge base in `.agents/knowledge/*.jsonl` (patterns, gotchas, decisions, anti-patterns, codebase-facts, api-behaviors) is the single source of truth for learnings.
- `/prime [focus]` at session start (loads relevant entries, records usage via `bun run kb:record`).
- `/learn <insight>` immediately on surprising behavior, test failures, or user corrections.
- `/self-reflect [scope]` at session end — the step that closes the feedback loop.

Entry schema, protocol, and lifecycle (`kb:health`, `kb:prune`): [docs/conventions/self-learning.md](docs/conventions/self-learning.md).

## Production deployment

Run under systemd with `KillMode=process`, and set `COMPANION_ALLOWED_ORIGIN` to every non-localhost origin the browser uses (else the WS upgrade is rejected → `Connection timeout` after `Session started`). Details: [docs/architecture/production-deployment.md](docs/architecture/production-deployment.md).
