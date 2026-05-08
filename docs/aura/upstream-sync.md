# Aura Upstream Sync Workflow

How to absorb a new release of upstream `the-companion` into Aura. Designed so the second sync (and the third, and the tenth) takes ≤2 hours.

If you're reading this in 6 months — start here. Don't recall, read.

## Prerequisites

- `upstream` git remote configured: `git remote add upstream https://github.com/The-Vibe-Company/companion.git` (one-time).
- `gh` CLI installed and authenticated against the Aura repo (for the drift detector and PR creation).
- A clean working tree (`git status` shows no staged or unstaged changes). The branding script refuses to run otherwise.

## The five steps

### 1. Drift signal → triage doc

When the drift detector fires (`scripts/aura-drift-check.ts` opens a GitHub issue, or you decide to sync proactively):

```bash
git fetch upstream --tags
git log --oneline --no-merges the-companion-v<previous>..the-companion-v<new>
```

Skim subjects in 30–60 minutes. Tag each commit `🟢 clean / 🟡 overlap / 🔴 risky / ⚪ skip` in a new `aura/UPSTREAM-<new>-TRIAGE.md` (copy the structure from `aura/UPSTREAM-0.95.0-TRIAGE.md`). Don't write paragraphs — the real assessment happens at conflict resolution time.

### 2. Branch + integration

```bash
git checkout -b sync/upstream-<new> main
```

The branch is **disposable**. If anything goes sideways past the halfway mark of the merge, `git checkout main && git branch -D sync/upstream-<new>` and start over. Do not try to "salvage" a half-merged branch by reverting individual commits — re-doing it from scratch is faster and safer.

### 3. Land in batches, blast-radius first

Per Carmack — boring stuff first, scary stuff last:

| Batch | What goes in | Why first/last |
|-------|--------------|----------------|
| **A** | `🟢` clean fixes, isolated additions | Safe ground; if something breaks here, it's environmental |
| **B** | `🟡` overlap with Aura-modified files (`ws-bridge`, `Sidebar`, `claude-adapter`, `cli-launcher`) | Needs hand-merge per `aura/CONFLICT_WATCHLIST.md`; use the conflict rule of thumb |
| **C** | `🔴` state-machine + protocol changes | Highest-risk; full diff read required |
| **D** | `⚪` quarantine inert (Railway/Postgres/Docker that don't apply) | One commit with rationale in body; gate behind env flag if kept |

Per chunk:

```bash
git cherry-pick <upstream-sha>
# resolve conflicts using aura/CONFLICT_WATCHLIST.md
bun --filter web run branding   # re-apply Aura strings
bun --filter web run typecheck && bun --filter web run test
git commit --amend  # keep cherry-pick message but add fit annotation
```

Commit message format:

```
sync: <upstream-sha> — <subject>

[fit: clean | adapted | skipped+reason]

<one-line rationale if non-mechanical decision>
```

### 4. Conflict rule of thumb (apply per file in <1 minute)

- **(a)** Conflict in Aura-only territory (branding strings, `.agents/`, knowledge skills, self-learning code, `auraIsActiveSession`, `AURA_EXTRA_READY_TRANSITIONS`, browser heartbeat block) → **keep ours**, period.
- **(b)** Conflict in shared infra + upstream is fixing a bug we also have → **take theirs**, then re-apply our local fix on top if the symptom test still requires it.
- **(c)** Conflict in shared infra + both sides changed behavior intentionally → **stop**, read both diffs end-to-end, write a 2-line note in the commit message explaining the choice.

### 5. After all batches land

1. **Bump version** in `web/package.json`. Rule: strictly greater than upstream's new release. The first sync (0.90→0.95) goes to `1.1.0`; subsequent minor-only upstreams get a patch bump on Aura's side; protocol-or-state-machine breaking upstreams get a minor bump on Aura's side.
2. **Re-run branding script** one more time: `bun --filter web run branding`.
3. **Walk visual-asset checklist** printed by the branding script — favicons, manifest.json, theme colors. Manual inspection.
4. **Run full tests:** `bun --filter web run typecheck && bun --filter web run test`. **All sentinel/symptom/guard tests must pass.**
5. **Refresh the drift pin:** `bun web/scripts/aura-drift-check.ts --pin`. This stops the GitHub issue from re-firing.
6. **Open ONE PR to `main`** with a body summarizing batches A–D and listing any non-mechanical decisions. Carmack: small commits inside the PR, single PR review.

## Things this workflow deliberately does NOT do

- **Auto-merge.** Every chunk passes through human eyes. Surfacing the signal is enough.
- **Cherry-pick across releases.** We commit to full-merge cadence so drift accumulates predictably.
- **Push back to upstream.** One-way fork — we never contribute changes upstream as part of this workflow.
- **Restructure directories during the sync.** Refactors land as separate post-sync PRs informed by which files actually conflicted (Carmack C5).

## Files this workflow relies on

- `branding.config.json` — replacement rules (single source of truth).
- `aura/CONFLICT_WATCHLIST.md` — file-by-file resolution rules for interleaved hotspots.
- `web/scripts/apply-aura-branding.ts` — the rewriter, idempotent.
- `web/scripts/aura-drift-check.ts` — the drift signal.
- `web/server/aura-watchlist-guard.test.ts` — sentinel guard for hotspots.
- `web/server/aura-knowledge-guard.test.ts` — JSONL integrity for `.agents/knowledge/`.
- `web/server/aura-skill-collision.test.ts` — skill-name uniqueness.
- `scripts/aura-restart.sh` — restart wrapper used after every deploy.

If any of these go missing, the workflow is broken — fix it before the next sync.

## When to call /council-plan again

If the next upstream window introduces:
- a major version bump (`1.x` → `2.x`),
- a breaking protocol change Aura has to adopt rather than passively accept,
- an architectural change (e.g. database introduced upstream),

…it's worth re-running `/council-plan` against the new triage. Otherwise this doc is the full instruction set.
