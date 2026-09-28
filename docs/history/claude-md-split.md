# CLAUDE.md split — rule → new location (P2/A3, 2026-09-28)

`CLAUDE.md` went from **33 527 bytes / 383 lines** to a load-bearing core of **9 048 bytes** (budget 15 360, guarded by `web/server/claude-md-budget.test.ts`) plus
on-demand docs. `AGENTS.md` is a symlink to `CLAUDE.md`, so it stays in sync automatically.
Every section of the old file is accounted for below: **core** (still in `CLAUDE.md`),
**moved** (verbatim into a doc that `CLAUDE.md` links with one line), or **removed/corrected**
(with the reason).

## Section map

| Old section (old line range) | Fate | New location |
|---|---|---|
| Header + What This Is (1–10) | core, condensed | `CLAUDE.md` § What This Is (fork link + MIT kept; full attribution with thevibecompany.co in `README.md`) |
| Transport note (12–16) | core, condensed | `CLAUDE.md` § What This Is |
| Development Commands (18–41) | core | `CLAUDE.md` § Development Commands (dev port corrected, see below) |
| Testing rules (43–58) | core, verbatim bullets | `CLAUDE.md` § Testing |
| Task reporting discipline (60–82) | moved; habit rule kept in core | `docs/conventions/task-reporting.md`; `CLAUDE.md` § Task reporting keeps "call `TodoWrite` on every transition" |
| Component Playground (84–86) | core, verbatim | `CLAUDE.md` § Component Playground |
| Architecture › Data Flow (90–108) | moved; diagram kept in core | `docs/architecture/overview.md` § Data Flow |
| Architecture › All code lives under `web/` (110–153) | moved; one-paragraph summary in core | `docs/architecture/overview.md` |
| Architecture › WebSocket Protocol (155–159) | moved; pointer to `WEBSOCKET_PROTOCOL_REVERSED.md` in core | `docs/architecture/overview.md` § WebSocket Protocol |
| Session Lifecycle + Process identity (161–177) | moved | `docs/architecture/session-lifecycle.md` |
| Raw Protocol Recordings (179–203) | moved | `docs/architecture/recordings-and-eval-sidecar.md` |
| Eval Sidecar (205–215) | moved | `docs/architecture/recordings-and-eval-sidecar.md` |
| Council Mode: protocol, server + browser pipelines (217–241) | moved | `docs/architecture/council-mode.md` |
| Council Mode convention floor AP-1..3, EC-1..9, EC-13 (243–256) | core, verbatim | `CLAUDE.md` § Council Mode convention floor (reviewers must always see it; not duplicated in the doc) |
| `conventions.md` / review-output / `docs/history/` pointers (258–259) | core, verbatim | `CLAUDE.md` § Council Mode convention floor |
| Browser Exploration (261–263) | core, verbatim | `CLAUDE.md` § Browser Exploration |
| Pull Requests bullets incl. version-less `Co-Authored-By` (265–272) | core, verbatim | `CLAUDE.md` § Pull Requests & Linear |
| Linear Issues (274–278) | core, merged into one bullet | `CLAUDE.md` § Pull Requests & Linear (full text also in the doc) |
| How To Open A PR With GitHub CLI + body template (280–318) | moved | `docs/conventions/pull-requests.md` |
| Codex & Claude Code (320–322) | core, verbatim | `CLAUDE.md` § Codex & Claude Code |
| Self-Learning System: KB layout, schema, skills, protocol, evolution (324–360) | moved; 3-skill protocol kept in core | `docs/conventions/self-learning.md` (+ new "Lifecycle tooling" section for `kb:health/record/prune` from P1/A2) |
| Production deployment (362–370) | moved; the two must-dos kept in core | `docs/architecture/production-deployment.md` |
| Cursor Cloud specific instructions (372–383) | moved | `docs/conventions/dev-environment.md` |

## Removed or corrected as outdated

| Old text | Why | Action |
|---|---|---|
| "Dev server (Hono backend on :3456 …)" (line 21) | `web/server/constants.ts`: `DEFAULT_PORT_DEV = 3457`, prod is 3456; the Cursor section already said 3457 — the old file contradicted itself | Core now says :3457 dev / :3456 prod; `overview.md` carries a port note above the diagram |
| "Landing page (thecompanion.sh)" (line 37) | Upstream domain label; the script itself is unchanged and domain-agnostic | Domain label dropped, script rule kept verbatim |
| Production deployment item 1: children "survive and reconnect over the local WebSocket" (line 366) | True only for the legacy WS transport. Under default stdio the pipes die with the parent; boot recovery SIGTERMs the survivor and the next message resumes with `--resume` (old file's own Session Lifecycle section) | Moved verbatim with a correction banner in `production-deployment.md`. `docs/deploy/vps-systemd.mdx` lines 15/74 carry the same stale wording — **not fixed in this step** (user-facing docs, separate change) |
| Self-Learning Protocol step 1 "Automatically scan the last 3 entries from each knowledge file" | Superseded in practice by `/prime`, which filters by branch/files and records usage (P1/A2) | Kept verbatim in `self-learning.md`; core points to `/prime` instead |

No other rule was dropped.
