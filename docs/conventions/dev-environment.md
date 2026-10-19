# Dev environment (Cursor Cloud / background dev servers)

> Moved out of `CLAUDE.md` in P2/A3 (2026-09-28). `CLAUDE.md` links here with one line;
> this file is loaded on demand, not on every session start.


## Services
- **Hono backend** (port 3457 in dev): `cd web && bun run dev:api` or via `./scripts/dev-start.sh`
- **Vite frontend** (port 5174 in dev): `cd web && bun run dev:vite` or via `./scripts/dev-start.sh`
- Both start together with `cd web && bun run dev` (or `make dev`), but that runs in foreground. Use `./scripts/dev-start.sh` for background mode.

## Caveats
- `./scripts/dev-start.sh` health-checks the backend on `/` which returns 404. If the script times out, the backend is still running — verify with `curl http://localhost:3457/api/sessions`. You can start the servers manually as background processes instead.
- The app requires Claude Code CLI or Codex CLI to create functional sessions. Without them, the UI loads but session creation will fail. The component playground at `#/playground` works without any CLI.
- No external databases or services are needed. Session state persists to `$TMPDIR/vibe-sessions/` as JSON files.
- The pre-commit hook (`.husky/pre-commit`) runs `cd web && bun run typecheck && bun run test -- --coverage`. Run these before committing.
- Two blocked postinstalls (`core-js`, `protobufjs`) are harmless and do not affect functionality.
