# Spec: Universal, adaptive, Carmack-arbitrated council advisor selection (RC-2)

**Date:** 2026-09-20
**Status:** Draft

## Objective

Replace the council skills' hardcoded binary stack router + fixed per-stack advisor panels with a **universal, adaptive, Carmack-arbitrated** selection: detect a project's real technology fingerprint, score every advisor in the shared pool by relevance to the feature + stack, and let Carmack's chair seat an **adaptive-size** council drawn from the full pool — each advisor briefed on the actual detected stack. Any advisor can appear in any council; an unrecognized stack is planned for, never refused. This is the RC-2 workstream of `specs/cli-stability-council-universality-remediation.md`.

## Context

- `/council-plan` (suffixless) is a **router**: "Phase 0 Stack Detection" recognizes exactly two stacks — **Aura** (`web/package.json:name=aura-companion` / `dependencies.hono` / `web/server/ws-bridge.ts`) and **Python** (`pyproject.toml:aiogram` / `requirements.txt:^aiogram` + `bot/`). Any other project → **REFUSE loudly**; `.council-stack-override` only accepts `aura`|`python`.
- The advisor roster is a **fixed `Panel:` list** in each SKILL.md: Python-9 (hunt, fowler, durov, vanrossum, brandur, hashimoto, willison, saarinen, friedman), Aura-10 (hunt, fowler, dahl, ritchie, abramov, watson, saarinen, friedman, willison, hashimoto). The same fixed-panel pattern repeats in `council-review*` / `council-implement*` and their `-aura` variants.
- The catalog `~/.claude/skills/_council-experts/` (~25 advisors) **already** carries `meta.yaml` (`creator`, `stack`, `paired_with`, `unpaired_reason`), cross-stack advisors, and a latent third ("Co-Pilot") stack. **The pool is real** — only the detector and the panels are hardcoded.
- In-repo verifier `web/scripts/detect-stack.ts` mirrors the two-stack refusal headlines.
- Concrete failure (snowlevel): FastAPI + Alembic/Postgres + React Telegram Mini App + bot matches no marker → refused, or (with override) force-fed aiogram/sync advisors that don't fit async FastAPI.

## Scope

### In scope
- Universal, monorepo-aware **project fingerprinting** (languages / frameworks / infra / surfaces from files) replacing the binary marker checklist.
- Per-advisor **capability profiles** in `meta.yaml` (the domains / stack-signals each advisor covers).
- **Carmack-arbitrated adaptive composition**: score advisors by relevance to `(fingerprint × feature brief)`; the chair seats an adaptive number by economic value, bounded by min/max guardrails, from the full pool.
- **Stack-accurate briefing**: each seated advisor's dispatch prompt names the detected stack so advice fits the real code.
- Apply the SAME engine across `council-plan`, `council-review`, `council-implement`; make the `-aura` variants thin aliases (or retire them).
- Update `detect-stack.ts` + tests to the new fingerprint/selection contract.

### Out of scope
- Adding new advisor personas (use the existing pool; catalog growth is `specs/council-experts-catalog-v2-expansion.md`).
- The paired-session Council **Mode** runtime in the app (`web/server`) — this spec is about the `/council-*` **skills** only.
- Rewriting the `quality-*.md` reference docs' content (only their wiring/selection changes).

### Non-goals
- A fixed universal roster (defeats the purpose).
- ML/embedding ranking or any network call in detection — selection stays deterministic and file-driven.

## Stories

### Story 1: Universal fingerprint (no more binary refuse)
**When** I run a council plan on a project that is neither aiogram nor aura-companion, **I want to** get a real stack fingerprint, **so I can** be advised without being refused or misclassified.

- Given a FastAPI + React + bot repo, When detection runs, Then it emits a structured fingerprint (languages, frameworks, infra, surfaces) instead of a refusal.
- Given a monorepo (`api/`, `webapp/`, `bot/`), When detection runs, Then each subsurface's stack is captured depth-aware and merged into one fingerprint.
- Given a repo with genuinely no recognizable signals, When detection runs, Then it ASKS the developer to confirm the stack rather than refusing or guessing.
- Given the existing aura-companion or aiogram repos, When detection runs, Then their fingerprints resolve to advisor sets that are the same-or-superset of today's panels (no regression).

### Story 2: Advisor capability profiles (the pool is addressable)
**When** the selector loads the catalog, **I want** each advisor to declare what it covers, **so I can** score relevance instead of reading a hardcoded list.

- Given each advisor dir, When loaded, Then its `meta.yaml` declares capability domains/signals (e.g. brandur→postgres/alembic/sql, abramov→react/frontend, durov→telegram/mini-app).
- Given an advisor with no declared capabilities, When scoring runs, Then it is never silently seated (must match an explicit signal or cross-stack tag).
- Given the full catalog, When the verifier runs, Then every advisor referenced by any council skill exists with a schema-valid profile (zero dangling seats).

### Story 3: Carmack-arbitrated adaptive council
**When** Carmack chairs the composition, **I want** an adaptive roster seated by economic value, **so I can** get exactly the advisors this feature needs — no more, no less.

- Given a fingerprint + feature brief, When the chair composes, Then advisors are ranked by relevance and seated by "will this pay off for THIS feature," producing an adaptive-size roster (not fixed 9/10).
- Given a narrow feature (e.g. a copy tweak), When composed, Then a small council is seated (≥ min guardrail), not the whole pool.
- Given a broad feature (security + db + frontend + deploy), When composed, Then more seats are added, bounded by a max guardrail.
- Given two advisors overlapping on this feature, When composed, Then only the higher-relevance one is seated, or both with an explicit lane split — never a redundant duplicate.
- Given the composed roster, When presented before dispatch, Then each seat shows WHY it was chosen (matched signal/domain) so the developer can veto or add.

### Story 4: Stack-accurate briefing
**When** a pool advisor spans stacks, **I want** its brief tied to the detected stack, **so I can** avoid advice for the wrong framework.

- Given the backend/Python advisor seated on a FastAPI repo, When dispatched, Then its brief names FastAPI/async/SQLAlchemy-async — not aiogram/sync patterns.
- Given the detected stack contradicts an advisor's default reference doc, When dispatched, Then the brief points to stack-appropriate guidance or flags the mismatch — it never silently advises for the wrong framework.

### Story 5: One engine across skills + verifier
**When** any council skill runs, **I want** them to share one selection path, **so I can** trust plan/review/implement to agree.

- Given council-plan / -review / -implement, When any runs, Then all use the same fingerprint + selection engine (single source of truth).
- Given the `-aura` suffixed skills, When the engine ships, Then they are thin aliases or retired (one selection path).
- Given the in-repo verifier, When updated, Then it validates the new contract (advisor existence, capability schema, adaptive-size guardrails) — not the old "refuse if not 2 stacks" headlines.

## Boundaries

### ✅ Always
- Keep selection deterministic and reproducible (file-signal scoring, no network/ML).
- Brief every seated advisor with the detected stack.
- Preserve back-compat: the two current stacks get the same-or-superset advisors as today.

### ⚠️ Ask first
- Retiring vs aliasing the `-aura` skill variants.
- Changing the `meta.yaml` schema (touches every advisor dir).
- Setting the min/max seat guardrails.

### 🚫 Never
- Silently refuse an unrecognized stack — plan for it or ask.
- Seat an advisor whose lane doesn't match the fingerprint just to hit a quota.
- Emit framework-specific advice (aiogram/sync) that contradicts the detected stack.
- Add ML or network calls to detection.

## Success Metrics
- snowlevel (FastAPI+React+bot) gets a relevant, stack-accurate council with **zero** aiogram/sync references in the plan.
- The two existing stacks produce advisor sets that are the same-or-superset of today's panels (regression check against current `Panel:` lists).
- Council size scales with feature domain-count: narrow feature → ≤ ~4 seats; broad feature → more, ≤ max guardrail.
- Verifier: zero dangling seats; every referenced advisor has a valid capability profile.

## Assumptions
- (confirmed) Adaptive seat count, Carmack-arbitrated by economic value; any advisor composable into any council (pool, not partitions).
- (unconfirmed) `meta.yaml` per advisor can host capability fields (README shows `creator`/`stack`/`paired_with`/`unpaired_reason` — extend it).
- (unconfirmed) `-aura` variants become aliases vs full retire.
- (unconfirmed) Guardrails — propose min 3, max ~11 seats.
- (unconfirmed) Implementation lands in a FRESH session (this one is >10 MB and flagged to archive).

---

*After implementing, compare results against each acceptance criterion above and list any unmet requirements.*
