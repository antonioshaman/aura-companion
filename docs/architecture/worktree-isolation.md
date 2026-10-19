# Worktree isolation (one live session per working tree)

**Why.** Parallel agents sharing one working tree broke production twice:

- `om_event_bot` df8c0f68 — an agent's `git add` swept up a sibling agent's unfinished change; the service started with an `ImportError`.
- `aura-companion` — a sibling agent switched the branch of the shared prod checkout under another agent's uncommitted fix.

Services on these boxes run straight from the working tree, so a shared tree turns one agent's half-done edit into another agent's deploy.

## Pre-existing worktree support (before this change)

| Piece | Behaviour |
|---|---|
| `git-utils.ts` `ensureWorktree` | Opt-in from the New Session form's BranchPicker ("worktree" toggle, `useWorktree: true` + `branch`). Creates/reuses `~/.companion/worktrees/<repo>/<branch>`; if the branch is already checked out elsewhere it creates a unique `<branch>-wt-N` branch. |
| `worktree-tracker.ts` | Persists `sessionId → {repoRoot, branch, actualBranch, worktreePath}` in `~/.companion/worktrees.json`; `isWorktreeInUse` stops removal while another session uses the same worktree. |
| `session-orchestrator.ts` `cleanupWorktree` | On archive: removes the worktree only when clean unless `force`; on delete: always `force`. |
| Council pairs | Orchestrator + observer share ONE workspace by design (worktree provisioned against the orchestrator half). |

Nothing prevented two sessions from being started in the same tree — which is the failure mode above.

## New behaviour

Module: `web/server/worktree-isolation.ts`. Request field: `isolation: "auto" | "isolate" | "shared"` on `POST /api/sessions/create` and `/create-stream` (Claude Code **and** Codex — the decision is backend-agnostic).

| Mode | Effect |
|---|---|
| `auto` (default of the public create routes) | A dedicated worktree is created **only** when another LIVE Aura session (any backend; not exited, not archived) already has its cwd in the same working tree (compared by `git rev-parse --show-toplevel`, so a session already in a linked worktree counts as a different tree). A lone session is unchanged. |
| `isolate` | Always create a dedicated worktree. |
| `shared` | Legacy behaviour — work in the requested tree (the UI opt-out "Work in the same tree"). Also the default for internal callers that do not pass the field. |

Not applied to: council pairs, container sessions, or launches that already asked for a worktree (`useWorktree`).

Isolated worktree: branch `aura/<YYYYMMDD-HHMMSS>-<hex>` cut from the current `HEAD` commit, at `<base>/<repo>/<slug>`, where `<base>` = `COMPANION_WORKTREES_DIR` (supports `~/`) or `~/.companion/worktrees`. Uncommitted changes of the shared tree are **not** copied (they belong to whoever made them). The session keeps the same sub-directory it asked for. If a `branch` was requested while isolation applies, the branch is provisioned as a worktree (via `ensureWorktree`) instead of being `git checkout`-ed in the shared tree.

UI: the New Session form calls `GET /api/sessions/isolation-preview?cwd=` and, only when siblings exist, shows `WorktreeIsolationChoice` (default "Isolated worktree", opt-out "Work in the same tree"). The sidebar row shows a `wt` chip with path + branch (`wt kept` in amber when cleanup retained it).

## Safety rails

- **systemd.** Unit files (+ `*.service.d/*.conf` drop-ins) in the standard unit dirs (override: `COMPANION_SYSTEMD_UNIT_DIRS`, `:`-separated) are scanned for `WorkingDirectory=`. The preview names units that run from the repo, and warns (UI alert + creation progress + `worktree.isolation.service_dir_warning` log) when the worktree base dir lies inside a service's directory. A base dir inside the repo itself is refused (400).
- **Never lose work.** Isolated worktrees are never force-removed — the `force` flag of archive/delete is ignored for them. A worktree with modified or untracked files (or one whose `git status` fails) is kept and the mapping is flagged `retained: "dirty"` (`"error"` if `git worktree remove` failed). The `aura/*` branch is deleted only when it has no commits beyond the commit it was cut from; otherwise it is kept.
- **Failed launch.** If session creation fails after the worktree was created, it is cleaned up under the same rules (never forced).
- All git calls use `execFileSync` with argv arrays (no shell).

Log events (structured): `worktree.isolation.decided`, `worktree.isolation.service_dir_warning`, `worktree.isolation.cleanup`.

## Known limits

- Branch-promoted worktrees go through `ensureWorktree`, which always uses `~/.companion/worktrees` (ignores `COMPANION_WORKTREES_DIR`).
- Unarchiving a session whose isolated worktree was removed leaves it with a missing cwd (same as pre-existing worktree sessions).
- Detection only sees sessions launched by this Aura server; agents started outside Aura in the same tree are not detected.
