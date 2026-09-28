# AuraBench corpus (P5/D1)

Real tasks mined from merged PRs, used by the D2 ablation.

1. `gh pr list --repo antonioshaman/aura-companion --state merged --base main --limit 300 --json number,title,body,mergeCommit > prs.json`
2. `bun run eval:aurabench mine --prs prs.json --out candidates.jsonl` — candidates + `candidates.jsonl.excluded.jsonl` (reason for every rejected PR).
3. `bun run eval:aurabench validate --candidates candidates.jsonl --results results.jsonl --wt-root <scratch>` — hidden tests must pass on the merge commit and fail on its parent. Resumable: PRs that already have a verdict are skipped.
4. Validated candidates become `tasks/*.yaml` (schema: `task.ts`, an additive extension of the golden-task schema; loader: `loader.ts`). Prompts describe the problem and observable contract, never the fix.
5. `bun run eval:aurabench leak --tasks evals/aurabench/tasks` — deterministic prompt check (`leak.ts`): every new identifier/file from the PR diff that the hidden tests reference must be named in the prompt (else the task is unpassable); any other new name is a leak. A second, independent LLM review against the real diff covers semantic hints and under-specification.

The committed corpus and every exclusion (with its reason) are listed in [`CORPUS.md`](CORPUS.md).

Run steps 1–3 outside the repo (scratch dir); only the final `tasks/` are committed.

## Ablation harness (P6/D2)

`bun run eval:aurabench bench --bench-root $WORK/bench [--variants A,…,G] [--reps 5] [--task-ids …] [--max-cells N] [--state $WORK/STATE.json]` runs every task × variant × rep cell, one at a time (code: `harness/`).

| Variant | What runs |
|---|---|
| A naked Claude | `claude -p` with a fresh per-cell `CLAUDE_CONFIG_DIR` (only `.credentials.json` copied), `--strict-mcp-config --include-hook-events`; Aura files removed from the worktree |
| B naked Codex | `codex exec --json --ephemeral --ignore-user-config`; shared `~/.codex` is never copied or edited — what it still injects (global `AGENTS.md`, skills, memories) is recorded per cell as a confound |
| C / D / E | Claude through the bench Companion instance: KB → + Observer pair → + council skills and auto-proceed |
| F / G | Codex through the bench Companion instance: KB → + council skills. Council Mode has no Codex orchestrator, so G gets no observer |

- **Cell.** A fresh *sealed* checkout of the base commit (`git init` + `git fetch --depth=1 <repo> <base>`: no remote, no other refs), then `bun install`, then the agent (60-min wall clock; a timeout counts as a failure). The harness then fetches the merge commit (it is never in the checkout while the agent works), restores the hidden tests from it and runs them. It is deliberately not a `git worktree`: from a linked worktree Claude Code resolves the project to the main checkout — the pilot's naked cell saw the repo's `.claude/skills` and keyed auto-memory on it — and `git log --all` would expose the merge commit. Regressions are checked with `vitest related` on the files the agent changed, against a per-task pristine-base baseline, which is computed once and cached in `<bench-root>/baseline/`. Records go to `<bench-root>/results/cells.jsonl`; raw transcripts go to `<bench-root>/cells/`.
- **Resume.** Any cell that already has a record is skipped. A usage limit produces no record: the driver sleeps until the reset and then retries the same cell. Before each cell the driver waits while `MemAvailable` is below 1.5 GB.
- **Same model and CLI across variants.** `--claude-model` (default `claude-opus-5-5`) and `--codex-model` (default `gpt-5.5`; ChatGPT-account Codex auth rejects `gpt-5.4`), plus the absolute `claude`/`codex` binaries resolved once from the runner's PATH, are passed to every variant. Companion's own default model differs from the CLI's. The bench instance's HOME-derived PATH would pick up an older system `claude`.
- **Isolation.** The bench Companion runs from this clone on `127.0.0.1:3499`, never :3456. It has its own `HOME` (so its `~/.companion` sessions/auth/settings are separate from prod's), plus its own `TMPDIR`, recordings, council-stats and allowed origin. It also sets `COMPANION_ORPHAN_REAPER=off`: the orphan reaper scans all of `/proc` and would SIGTERM prod's orphaned CLIs. The bench HOME gets the Claude credentials and a copy of `~/.claude/skills`, but not `settings.json`, because its hooks write into the real `~/.claude`. Its `.codex` is a symlink to the real one, which matches how prod shares Codex auth.
- **Aura workspace.** Aura variants see the repo as it was at the base commit, including that commit's CLAUDE.md and `.agents/knowledge`. They get no future KB entries that could describe the fix. If a knowledge-on cell's base commit has no KB, that is recorded as a confound.
