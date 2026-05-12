# Spec: Aura Companion documentation rebrand + Council Mode coverage

**Date:** 2026-05-12
**Status:** Draft

## Objective

Land a single PR that brings the project's user-facing documentation up to date with the current product: rename leftover "Vibe Companion" surface copy to "Aura Companion" (keeping only MIT-required attribution to the upstream fork), and document Council Mode (orchestrator + observer paired sessions) end-to-end — user guide for `/docs/guides/`, architecture reference for `/docs/reference/`, and feature card on the docs index. Council Mode is now the project's flagship differentiator; today a new visitor cannot discover it from `README.md`, the docs site, or the landing page.

## Context

Three reader entry points must agree on the brand and the feature set: `README.md` (GitHub landing), the `docs/` Mintlify site, and the `landing/` marketing site. None of them currently mentions Council Mode, and the landing site's Nav + Footer still link to the upstream `The-Vibe-Company/companion` repo.

Branding replacement is automated via `branding.config.json` + `web/scripts/apply-aura-branding.ts`. Remaining "Vibe-Companion" strings fall in three buckets: intentional MIT attribution lines (per `aura/CONFLICT_WATCHLIST.md:46` — these stay), landing-site external links (must change), and `CHANGELOG.md` upstream history (protected — untouched). Council Mode is implemented on `feat/council-mode-paired-sessions`; `specs/council-mode-paired-sessions.md` is the behaviour source of truth.

## Scope

### In scope
- Rewrite `README.md`: add a Council Mode section above the skills inventory; consolidate Vibe-Companion mentions into a single Attribution line; lead the feature-grid with Council Mode.
- New `docs/guides/council-mode.mdx` — when to enable, orchestrator/observer split, BlockerBanner vs ObserverPanel vs ProviderBadges, keyboard shortcuts (`Cmd/Ctrl+Shift+O`, `Cmd/Ctrl+Shift+B`), `claude+claude` vs `claude+codex` tradeoffs, degraded mode + manual respawn, troubleshooting.
- New `docs/reference/council-mode-architecture.mdx` — `.council/` filesystem protocol, 5-status state machine, AP-/EC- convention floor (link to `conventions.md`), restart-recovery semantics.
- Update `docs/index.mdx` `<CardGroup>` with a Council Mode card; extend `docs.json` navigation.
- Patch `landing/src/components/Nav.tsx` + `Footer.tsx`: four `github.com/The-Vibe-Company/companion` hrefs → `github.com/antonioshaman/aura-companion`; "the-companion" UI label → "Aura Companion".
- Capture an ObserverPanel screenshot via `agent-browser` for the PR description.
- Ship as one PR, commitzen-style title, body via heredoc (per CLAUDE.md PR flow).

### Out of scope
- Editing `CHANGELOG.md` / `web/CHANGELOG.md` (release-please managed; in protected paths).
- Editing `WEBSOCKET_PROTOCOL_REVERSED.md`, `aura/`, `conventions.md`, or `specs/council-mode-paired-sessions.md`.
- Russian translation; migration guide for upstream users; code changes beyond the four landing-site hrefs; release tagging.

### Non-goals
- Restructuring `README.md` for aesthetics where the existing structure works.
- Documenting unimplemented Council Mode v2 ideas — only what ships on `feat/council-mode-paired-sessions`.

## Stories

### Story 1: New visitor lands on the GitHub repo

**When** a developer first opens `github.com/antonioshaman/aura-companion`, **I want to** understand what Aura Companion is and what Council Mode does within two minutes, **so I can** decide whether to install it.

**Acceptance Criteria:**

- Given a reader on `README.md`, when they read the first three paragraphs, then they encounter Council Mode (orchestrator + observer) as a first-class capability — not as a footnote.
- Given a reader scanning the README, when they search the page for "Vibe Companion" or "Vibe-Companion", then the only matches are inside an "Attribution" section that credits the upstream MIT fork.
- Given a reader who wants to try Council Mode, when they reach the Quick Start, then a link points them to `docs/guides/council-mode.mdx`.

### Story 2: Existing user wants to enable Council Mode

**When** a user opens the docs site looking for "how to use Council Mode", **I want to** find a step-by-step guide plus an architecture reference, **so I can** turn it on confidently and debug it when something goes wrong.

**Acceptance Criteria:**

- Given a user on the docs site index, when the page renders, then a Council Mode card is visible in the feature `<CardGroup>` and links to the new guide.
- Given a user on `docs/guides/council-mode.mdx`, when they read top-to-bottom, then they learn (in order): what the feature does, how to enable it on New Session, what the two provider pairings mean, the ObserverPanel states, the two keyboard shortcuts, and what to do when the observer enters Degraded.
- Given a user whose observer just degraded, when they consult the troubleshooting section, then the "Respawn observer" UI action is documented with its expected outcome.
- Given a developer wanting to understand the wire protocol, when they open `docs/reference/council-mode-architecture.mdx`, then they find the filesystem layout (`.council/checkpoints/`, `.council/reviews/`), the 5-status state machine, and a pointer to `conventions.md` for the AP-/EC- floor.

### Story 3: Visitor on the landing site

**When** someone clicks through from the landing page to the source repo, **I want** every "GitHub" / "source" link to resolve to `antonioshaman/aura-companion`, **so I can** trust the brand consistency.

**Acceptance Criteria:**

- Given a visitor on `landing/` Nav or Footer, when they click any GitHub link, then the destination is `https://github.com/antonioshaman/aura-companion` (no remaining upstream `The-Vibe-Company` URLs).
- Given a visitor reading landing copy, when the page renders, then no visible product name reads as "the-companion" or "Vibe Companion" — only "Aura Companion".

## Boundaries

### ✅ Always
- Run `cd web && bun run typecheck && bun run test` before opening the PR (husky pre-commit also enforces this).
- Use commitzen format for all commits and the PR title (e.g. `docs(council): add Council Mode guide + rebrand README`).
- Pass the PR body via a heredoc to a `/tmp/pr_body.md` file per the CLAUDE.md flow.
- State explicitly in the PR body: "Implemented by AI agent" + whether a human reviewed.

### ⚠️ Ask first
- Any change to `branding.config.json` (the `protectedPaths` list is load-bearing for upstream sync).
- Removing or rewording the existing MIT attribution line to Vibe-Companion (legal obligation; current wording was deliberate).
- Adding screenshots beyond the one ObserverPanel capture (binary asset size in the docs repo).

### 🚫 Never
- Modify `CHANGELOG.md` or `web/CHANGELOG.md` (release-please owns them; in the protected-paths list).
- Edit `WEBSOCKET_PROTOCOL_REVERSED.md`, `aura/`, `conventions.md`, or `specs/council-mode-paired-sessions.md` as part of this PR (out of scope).
- Touch any file under `web/server/`, `web/src/`, `web/scripts/apply-aura-branding.ts`, or test files (this is a docs PR; no code changes).
- Delete the upstream attribution line entirely (MIT licence requires it).
- Skip the screenshot — Council Mode is a visual feature; reviewers need to see the ObserverPanel.

## Success Metrics

- Zero "Vibe Companion" / "Vibe-Companion" strings outside MIT-attribution lines and `branding.config.json`'s protected paths (`grep`-verifiable).
- Two new `.mdx` files exist, listed in `docs.json` nav, and render in the Mintlify sidebar.
- All four landing-site `The-Vibe-Company` hrefs rewritten to `antonioshaman/aura-companion`.
- PR body embeds an ObserverPanel screenshot in `blocker-found` or `reviewing` state.
- Husky pre-commit (typecheck + test) passes before push.

## Assumptions

- (confirmed) Landing-site upstream hrefs should be rewritten, not preserved as fork attribution.
- (confirmed) Council Mode card belongs on the docs index feature grid.
- (confirmed) Single PR, not a stacked series.
- (confirmed) Screenshot is captured via `agent-browser` against the running UI; no pre-existing image is reused.
- (unconfirmed) Council Mode is stable enough on `feat/council-mode-paired-sessions` for the docs to commit to its current shape; if breaking changes are still in flight, this PR may need to wait for that branch to land on `main` first.

---

*After implementing, compare results against each acceptance criterion above and list any unmet requirements.*
