# CI Context — Known State for Autonomous Pairs

**Updated:** 2026-05-13 (end of day)
**Maintainer:** humans update this file when CI state changes; agents READ it before opening a PR.

This file is the **first thing an autonomous council pair (Deep Falcon, Warm Delta, etc.) should read** when picking up work in this repo. It captures CI quirks, known flakes, and admin-merge policy so an agent does not get stuck thinking the pipeline is broken when in fact a known flake is firing.

---

## Known-flake test (active as of 2026-05-13)

**File:** `web/server/review-watcher.test.ts`
**Platform:** macOS only (Ubuntu is reliably green)
**Test names that flake:**
- "drops files with an invalid filename pattern" (line ~74)
- "drops files whose content fails parseObserverReviewPayload" (line ~90)
- "logs `superseded` when two distinct writes land on the same path inside the debounce window" (line ~146)

**Root cause:** Node.js `fs/promises.watch` on macOS uses **FSEvents under the hood, which is directory-granular**. Under rapid-write conditions in a fresh tmpdir, `ev.filename` can arrive as the **watched directory's basename** instead of the changed file's basename. The watcher dispatches the wrong path through `onDropped(...)` and the test assertion fails. Linux uses inotify (file-granular) and does not see this.

**Partial fixes already in main:**
- **PR #20** (`fix(council): filter macOS fs.watch parent-dir-name events in review-watcher`) — filters dir-basename events. Closed one branch of the flake.
- **PR #21** (`fix(council): bump review-watcher test waits for macOS FSEvents headroom`) — bumped per-event waits to give FSEvents time to settle.

**Full structural fix (not yet shipped):** directory rescan on every watcher event — replaces filename-based dispatch with `readdir(dir)` lookup. Larger refactor; deferred. The current partial fixes leave residual flakiness on overlapping write batches.

## Admin-merge policy for the known flake

When a PR's CI shows:
- ✅ All other jobs green: `quality`, `coverage`, `a11y`, `test (ubuntu-latest)`, `platform (ubuntu-latest)`, `platform (macos-latest)`
- ❌ ONLY `test (macos-latest)` failed
- The annotation list shows failures at `web/server/review-watcher.test.ts` (any line above)
- The PR does NOT touch `review-watcher.ts` or its tests

→ **Admin-merge is acceptable.** Use:
```bash
export TMPDIR=$HOME/.cache/gh-fresh && gh pr merge <N> --repo antonioshaman/aura-companion --admin --squash --delete-branch
```

When the macOS failure is in a DIFFERENT test file, or the PR touches the watcher → investigate; do not admin-merge.

## CI gates summary (as of today)

| Gate | What it checks | Pass-threshold |
|---|---|---|
| `quality` | `bun run typecheck` + lint | exit 0 |
| `coverage` | New/changed `.ts` files in `web/server/` and `web/src/` must reach ≥80% line coverage | per-file via `coverage-summary.json` |
| `a11y` | Vitest tests passing `toHaveNoViolations()` | exit 0 |
| `test (ubuntu-latest)` | Full Vitest suite | exit 0 |
| `test (macos-latest)` | Full Vitest suite | exit 0 OR flake-only (see above) |
| `platform (ubuntu/macos)` | Quick smoke checks | exit 0 |

**Coverage gate is the most common blocker for AI-implemented PRs.** New code lands at low coverage when tests cover only the happy path. To anticipate:

```bash
# Run coverage locally before pushing
cd /root/aura-companion/web && /home/auracomp/.bun/bin/bun run test -- --coverage
# Look at coverage-summary.json for your changed files; target ≥80% per file.
```

If you ship a PR that's 0.x% under 80% on a file that wasn't fully your work (god-module cascade), prefer:
- Adding direct unit tests for your new symbols rather than acquiescing to "leave the gate failing — admin merge"
- See `feedback_file_level_coverage_gate_cascade` in user memory for prior pattern.

## Build / runtime quirks affecting verification

1. **Service worker cache:** Aura is PWA-enabled. After `bun run build`, the user must explicitly unregister the SW in browser DevTools Console to see new code. Hard refresh alone is insufficient. See `feedback_pwa_sw_cache_hard_refresh_insufficient`.
2. **systemd vs build:** Systemd `aura-companion` service restart picks up server-side TS changes but does NOT rebuild the frontend bundle. Frontend changes require explicit `cd web && bun run build`. See `feedback_build_vs_source_vs_branch_divergence` for the 3-layer staleness pattern.
3. **Git dubious ownership:** `/root/aura-companion` has mixed root/auracomp ownership; git refuses ops with `fatal: detected dubious ownership` for any new user. Run `git config --global --add safe.directory /root/aura-companion` once per user before first use.

## How to open a PR (autonomous-pair-friendly)

When you finish a task in this repo:

1. **Push to a new branch** named per the task spec, or `fix/<short-slug>` if none.
   - SSH push (root user, requires `/root/.ssh/claude-code-deploy` mode 600): `git push -u origin <branch>`
   - HTTPS push via gh credential helper (any user): `git push https://github.com/antonioshaman/aura-companion.git <branch>`

2. **Create PR via `gh`** with explicit `--repo` flag (see `feedback_gh_pr_create_repo_flag`):
   ```bash
   export TMPDIR=$HOME/.cache/gh-fresh
   gh pr create --repo antonioshaman/aura-companion \
     --base main --head <branch> \
     --title "<commitizen-style title>" \
     --body-file /tmp/pr_body.md
   ```

3. **Check CI status before requesting merge:**
   ```bash
   gh pr view <N> --repo antonioshaman/aura-companion --json statusCheckRollup
   ```
   - All green except known-flake macOS test → admin-merge OK per policy above
   - Any other failure → investigate before merging

4. **DO NOT** open a PR for work without running:
   - `bun run typecheck` (must be clean)
   - `bun run test` (full suite, must pass on linux)
   - Visual smoke on Playground for component changes

## Open tasks in this repo (as of 2026-05-13 night)

1. **TASK-sidebar-chip-redundancy-full-suppression.md** — extend PR #27 to also suppress the pair-chip half that duplicates the backend indicator. Self-contained spec; ready to pick up.
2. **Folder picker systemd override** (`COMPANION_FS_ALLOWED_BASES=/root` for service env) — NOT a code change; needs human with sudo. See `feedback_systemctl_edit_drops_below_marker` for the `tee` runbook.
3. **macOS review-watcher full structural fix** — directory rescan on every event. Deferred. Don't pick up unless explicitly tasked.

## When to ask for human help (not silently push past)

- CI failure on a NEW test file (not the known flake)
- Coverage gate fails on a file you didn't touch
- Build step fails locally with EACCES or similar permission errors → root vs auracomp ownership mismatch (`feedback_service_user_vs_config_user_divergence`)
- `gh pr create` fails with cryptic error → check `feedback_gh_pr_create_repo_flag` first; if `--repo` doesn't help, surface to human
- Anything in `🚫 Never` of an active task spec

---

## Cross-references (user-memory)

Anything you (the agent) encounter that surprises you, check these memories first — many of today's specific quirks are documented:

- `feedback_build_vs_source_vs_branch_divergence.md` — 3-layer stale build diagnosis
- `feedback_pwa_sw_cache_hard_refresh_insufficient.md` — PWA SW cache busting
- `feedback_service_user_vs_config_user_divergence.md` — auracomp vs root config dirs
- `feedback_systemctl_edit_drops_below_marker.md` — systemctl override.conf gotcha
- `feedback_git_dubious_ownership_safe_directory.md` — git safe.directory
- `feedback_stash_loss_across_branch_switches.md` — commit small WIPs immediately
- `feedback_partial_fix_passed_as_complete.md` — RESTATE the full boundary table before implementing
- `feedback_user_factual_certainty_is_evidence.md` — user-stated facts ARE evidence
- `feedback_gh_pr_create_repo_flag.md` — always pass `--repo` to gh
- `feedback_file_level_coverage_gate_cascade.md` — coverage gate per-file mechanics
- `feedback_running_build_vs_disk_build.md` — running ≠ disk source

These live at `/home/auracomp/.claude/projects/-root-aura-companion/memory/*.md` if you can read that path.
