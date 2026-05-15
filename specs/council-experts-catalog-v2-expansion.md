# Spec: Council Experts Catalog v2 — multi-stack expansion + chair-side panel selection

**Date:** 2026-05-15
**Status:** Draft

## Vision

Aura Companion's council pipeline (`/council-plan`, `/council-plan-aura`, `/council-review`, `/council-review-aura`, `/council-implement*`) currently seats a fixed stack-specific panel: Aura skills seat 12-13 Aura-stack experts; Python skills seat 9-10 Python-stack experts. The β refactor (just landed) consolidated those inline prompts into the shared `_council-experts/` catalog at 17 unique expert IDs. v2 makes **three** connected moves: **(1) consolidate the catalog to 16 IDs total** (drop per-stack silos, merge overlapping lenses); **(2) rename every ID to the surname of the technology's iconic creator** (Hunt/Fowler/Beck already follow this; extend to all — van Rossum for Python, Dahl for Node/TS, Abramov for React, Lerdorf for PHP, Colvin for pydantic-ai/MCP, etc.); **(3) upgrade the prompt content** for the consolidated/renamed experts so each merged lens covers its broadened domain, plus stack-detection helper + chair-side panel selection. "Why now": β proved the catalog shape works (44/44 byte-identical at first commit, −29% SKILL.md LOC); v2 makes the catalog *legible* (every expert is named after a real person) and *tight* (16 entries covers the full multi-stack matrix without redundant silos). The companion spec `council-mode-bidirectional-pipeline.md` covers the Orchestrator↔Observer workflow that consumes this catalog.

## Problem Statement

Today the council pipeline cannot tell PHP from Python from Node. Operators in non-Aura, non-Python-aiogram projects either (a) get the wrong panel (Aura experts dispatched on a PHP project — 100% no-recs noise) or (b) lack a panel entirely (no PHP, NodeJS, or generic-frontend expert exists in the catalog). The β catalog's `### Council panel` lists are hard-coded per consumer skill — there is no chair-side selection step that reads project anchors (package.json, composer.json, requirements.txt, Cargo.toml, etc.) and prunes the panel to relevant experts. Operators are paying for council subagent dispatches (wallclock + LLM tokens) that return "no findings in my lane" 40-60% of the time on the wrong stack. The original AC-5.2 simplification goal from the β spec is silently undermined by the panel-mismatch tax.

## Target Users

### User segment 1: Aura developer
- **Context:** Working in `/root/aura-companion` itself or another Bun/Hono/TS+React project. Already gets the right panel today via `-aura` skills.
- **Primary need:** v2 must not regress today's Aura experience — same 12-13 experts seated for an Aura review/plan, byte-identical prompts.
- **Success looks like:** No change to the Aura developer's UX. Council panel sizes and outputs unchanged for Aura projects.

### User segment 2: Multi-stack operator
- **Context:** Driving Claude Code sessions across 13+ sibling projects (rapesha, om-event-bot, brahmanos, auraengine, …) — Python+aiogram+Postgres, future PHP/Laravel, future NodeJS services. Today must remember which `/council-*` to invoke per project.
- **Primary need:** One council command. The chair reads the project's stack anchors and picks the relevant subset. PHP project → PHP+cross-stack experts, not Aura's Realtime/NDJSON Protocol expert.
- **Success looks like:** Invokes `/council-review` from anywhere; the seated panel matches the project's actual stack with ≥80% in-lane findings.

## Scope

### In scope (v1)

- **Catalog consolidation to 16 IDs** — current 17 → 16 via 6 renames + 3 merges + 2 adds. See Proposed rename + merge map below.
- **Legendary-creator naming** — every catalog ID is the surname of the technology's iconic creator or canonical contributor. The 7 existing creator-named experts stay. 7 anonymous IDs gain creator names. 2 new IDs added (Lerdorf for PHP, Colvin for pydantic-ai/MCP).
- **Prompt upgrade** — content evolution beyond β's byte-identity floor. Each merged/renamed expert's prompt is rewritten to cover its broadened scope (e.g., `dahl` covers Node + Bun + TS + generic JS, absorbing today's separate `backend-ts` + `realtime-ndjson` lenses). β AC-3.2 byte-identity is **intentionally broken** for the 8 affected IDs; semantic coverage is the new floor.
- **Stack-detection helper** — a shared shell script + documented contract that scans the workspace for canonical anchor files (package.json, composer.json, pyproject.toml/requirements.txt, Cargo.toml, go.mod, Gemfile, etc.) and emits a deterministic list of stack tags.
- **Chair-side panel selection** — the four dispatcher SKILL.md gain a new Phase 0.5 step: "Detect stack tags → filter the Panel list → only dispatch experts whose `meta.yaml` declares an overlapping tag OR `stack: common`."
- **Per-expert `meta.yaml`** — every catalog entry gains a frontmatter file naming its applicable stack tags + creator name. Cross-stack experts (Hunt, Fowler, Beck, Willison, Saarinen, Friedman, Watson) tag `common`. Stack-specific experts tag one or more.
- **Documentation** — `conventions.md` gains EC-25 ("panel selection by stack-tag intersection") and EC-26 ("catalog IDs are creator surnames"). `_council-experts/README.md` updated with the rename map + creator attribution. **Note:** Council Mode pipeline behaviour (Orchestrator↔Observer workflow) is specified separately in `specs/council-mode-bidirectional-pipeline.md` — that spec consumes this catalog but is otherwise independent.

### Proposed rename + merge map (16 final IDs)

**Kept as-is (7 — already creator-named):**
| ID | Creator | Domain |
|---|---|---|
| `hunt` | Troy Hunt | Security |
| `fowler` | Martin Fowler | Refactoring |
| `beck` | Kent Beck | Test quality |
| `willison` | Simon Willison | LLM pipelines (recordings, model/CLI portability, validator discipline, AI-second rendering) — MCP/pydantic moved to `colvin` |
| `saarinen` | Karri Saarinen | UI quality |
| `friedman` | Vitaly Friedman | UX quality |
| `brandur` | Brandur Leach | Postgres |

**Renamed (4 — pure ID rename, prompt content stays modulo upgrade):**
| Old ID | New ID | Creator | Domain |
|---|---|---|---|
| `a11y` | `watson` | Léonie Watson | Accessibility |
| `backend-python` | `vanrossum` | Guido van Rossum | Python |
| `frontend-react` | `abramov` | Dan Abramov | React + generic frontend principles (absorbs frontend-generic scope) |
| `telegram-ux` | `durov` | Nikolay Durov | Telegram |

**Merged (3 new consolidated IDs absorbing 6 old IDs):**
| New ID | Creator | Absorbs | Domain |
|---|---|---|---|
| `dahl` | Ryan Dahl | `backend-ts` + `realtime-ndjson` | Node/Bun/TS/JS broadly — WebSocket/NDJSON concerns absorbed |
| `ritchie` | Dennis Ritchie | `subprocess` + `persistence-fs` | Unix process lifecycle + filesystem persistence |
| `hashimoto` | Mitchell Hashimoto | `deploy-docker-gha` + `deploy-vps` | DevOps broadly — Docker + CI/CD + VPS systemd + Vagrant/Terraform lineage |

**Added (2 — net new):**
| New ID | Creator | Domain |
|---|---|---|
| `lerdorf` | Rasmus Lerdorf | PHP |
| `colvin` | Samuel Colvin | Pydantic / pydantic-ai / strict tool schemas / MCP structured outputs |

**Math:** 7 kept + 4 renamed + 3 merged-from-6 + 2 added = **16**. Drops: 6 old IDs (`backend-ts`, `realtime-ndjson`, `subprocess`, `persistence-fs`, `deploy-docker-gha`, `deploy-vps`) eliminated via merge. 4 IDs renamed in-place. Cap raised from 15 → 16 to make room for `colvin` as a distinct lens separate from `willison` (LLM pipeline orthogonal to strict schema validation).

### Out of scope (v1) — future consideration

- **Layer 1 Brahman Orchestrator on LangGraph** — full DAG-based council orchestration replacing the current Chair model. Future spec; current Chair stays.
- **Layer 2 Specialist Agent Runtime on CrewAI / AutoGen** — multi-agent debate loops (planner↔reviewer, coder↔reviewer, critique cascades). Today's council fan-out + synthesis is single-round; debates are a separate vision.
- **Layer 3 Coding Executors** (OpenDevin shell/browser/editor, local Ollama/Qwen, Codex CLI passthrough beyond what `cli-launcher.ts` already does). Out of catalog scope; spec separately when prioritised.
- **Layer 5 Memory layers** (vector, session, project, per-agent). Today's `.agents/knowledge/` + `~/.claude/projects/<x>/memory/` mechanisms stand; vector memory is a separate product.
- **Layer 6 MCP runtime integration** — MCP servers, MCP tools, shared context across agents at RUNTIME. The MCP lens lives inside `willison`'s upgraded prompt; the runtime integration is separate.
- **Adding new IDs beyond Lerdorf** — `qa-generic`, `refactor-generic`, `frontend-vue`, etc. Beck/Fowler/Walke cover those domains adequately at v1. Adding more would push catalog past 15.
- **Flavor names** ("Python Sage", "PHP Monk") — using *technology creator surnames* is the convention, not branded flavor names. Operators grep `vanrossum` (a real person) easier than `python-sage`.

### Non-goals

- **Not a runtime registry / plugin loader.** β spec's 🚫 No plugin loaders constraint is inherited. The "selection" is text-instructions to the Chair to filter the Panel list using a single stack-detection script's output; no code dynamically loads catalog entries.
- **Not a 16-cap on per-dispatch seated panel** — the 16 cap is on TOTAL catalog entries. A given dispatch seats fewer (only experts whose tags intersect the project's detected stack + all `common`-tagged). Today's biggest seated panel is 13 (council-review-aura); after consolidation it'll be 9-10.
- **Not byte-identity-preserving for the consolidated 8 IDs.** β's AC-3.2 byte-identity floor is intentionally broken for `dahl` (absorbs `backend-ts` + `realtime-ndjson`), `ritchie` (absorbs `subprocess` + `persistence-fs`), `hashimoto` (absorbs `deploy-docker-gha` + `deploy-vps`), and the 4 pure renames where prompts are upgraded in the same commit. New floor: **semantic coverage** — every concern listed in the old prompts must appear in the new merged prompt.

## Stories

### Catalog consolidation & creator naming

#### Story 1.1: Catalog reaches 16 IDs via documented rename + merge map

**When** a developer runs the post-v1 catalog inventory, **I want** the catalog to contain exactly 16 expert IDs matching the rename+merge map in the Scope section, **so I can** keep the catalog scannable and bounded against future bloat.

**Acceptance Criteria:**

- Given the catalog at `~/.claude/skills/_council-experts/`, when the catalog-canary counts immediate subdirectories (excluding `.verify`), then the count is exactly 16.
- Given the rename map, when a reviewer checks IDs, then the 16 directories are: `hunt`, `fowler`, `beck`, `willison`, `saarinen`, `friedman`, `brandur`, `watson`, `vanrossum`, `abramov`, `durov`, `dahl`, `ritchie`, `hashimoto`, `lerdorf`, `colvin`.
- Given the 6 dropped IDs (`backend-ts`, `realtime-ndjson`, `subprocess`, `persistence-fs`, `deploy-docker-gha`, `deploy-vps`), when the catalog-canary runs after v1, then NONE of those directories exist.
- Given a future PR proposing a 17th catalog ID, when the catalog-canary runs, then it fails with a structured error naming the over-cap state (forces an explicit "drop or consolidate" decision before merge).

#### Story 1.2: Every ID is a technology creator's surname

**When** an operator scans the catalog directory, **I want** every directory name to be the surname of a real person who created or canonically shaped the represented technology, **so I can** map intuitively from name to domain (Hejlsberg → TypeScript, Lerdorf → PHP) without reading READMEs.

**Acceptance Criteria:**

- Given any catalog subdirectory `_council-experts/<id>/meta.yaml`, when the file is parsed, then `creator: "<Full Name>"` is present (e.g., `creator: "Anders Hejlsberg"`).
- Given the 16 IDs, when reviewed against a public source (Wikipedia or canonical attribution), then each name maps to a real person who created or canonically represents the technology.
- Given a proposed new ID that is NOT a creator surname (e.g., `php-monk`, `frontend-wizard`), when the catalog-canary runs, then it fails with a structured error naming the convention violation.
- Given a domain with multiple plausible creators, when the spec is written, then the chosen attribution is documented in the catalog README with a 1-line rationale.

#### Story 1.3: Consolidated experts preserve semantic coverage from all merged sources

**When** an expert ID absorbs multiple old IDs (e.g., `dahl` absorbs `backend-ts` + `realtime-ndjson`), **I want** the merged prompt to cover every domain concern listed in the originals, **so I can** trust that the consolidation didn't drop quality signal.

**Acceptance Criteria:**

- Given the merged `dahl/plan-aura.md`, when a reviewer compares against the pre-merge `backend-ts/plan-aura.md` + `realtime-ndjson/plan-aura.md` concerns lists, then every named concern from both originals appears (verbatim or paraphrased) in the new prompt.
- Given the merged `ritchie/review-aura.md`, when checked against `subprocess/review-aura.md` + `persistence-fs/review-aura.md`, then both lifecycle (signal/exit/spawn) AND filesystem (atomic write, sentinel, rotation) concerns appear.
- Given the merged `hashimoto/review.md`, when checked against `deploy-docker-gha/review-aura.md` + `deploy-vps/review.md`, then both Docker (Dockerfile, GHA workflow, secrets) AND VPS (systemd unit, ports, HEALTHCHECK) concerns appear.
- Given a merge that drops a concern (e.g., new `ritchie` prompt omits zombie reaping that was in old `subprocess`), when the semantic-coverage canary runs, then it fails naming the dropped concern.

### New IDs

#### Story 2.1: PHP project gets a real PHP lens

**When** running `/council-review` in a PHP project (composer.json present), **I want** Lerdorf seated, **so I can** get framework-aware feedback (Laravel/Symfony idioms, PSR conformance, Composer dep hygiene, opcache awareness) instead of zero PHP coverage.

**Acceptance Criteria:**

- Given `_council-experts/lerdorf/{plan,review}.md` exist with `meta.yaml { stack: [php], creator: "Rasmus Lerdorf" }`, when the catalog-canary runs, then validation passes.
- Given a workspace with `composer.json` at the root, when stack-detection runs, then output includes the `php` tag.
- Given a workspace without `composer.json`, when stack-detection runs, then output does NOT include the `php` tag.
- Given `/council-review` dispatched in a PHP project, when the Chair filters the Panel list, then the seated panel includes `lerdorf` AND all `common`-tagged experts AND excludes Aura-only and Python-only experts.

### Chair-side panel selection

#### Story 3.1: Stack-detection is deterministic and inspectable

**When** the Chair starts a council pipeline, **I want** the stack-detection step to produce a deterministic, human-readable tag list, **so I can** audit which experts will be seated before any subagent dispatches.

**Acceptance Criteria:**

- Given a workspace with multiple stack anchors, when stack-detection runs, then the emitted tag list is sorted and deduplicated.
- Given the same workspace run twice, when stack-detection runs each time, then both runs emit byte-identical output.
- Given an empty workspace (no anchor files), when stack-detection runs, then the output is empty (only `common`-tagged experts will be seated downstream).
- Given a workspace with an unknown anchor file (e.g., `Gemfile` when Ruby isn't in the v1 stack list), when stack-detection runs, then the unknown anchor is silently ignored (forward-compat — no crash, no false tag).

#### Story 3.2: Chair filter is text-only, not runtime code

**When** the Chair filters the catalog Panel list against detected stack tags, **I want** the filter to be expressible as plain text instructions inside SKILL.md (not a runtime registry), **so I can** preserve the β spec's 🚫 No plugin loaders constraint.

**Acceptance Criteria:**

- Given a dispatcher SKILL.md, when a reader scans Phase 3, then the panel-filter logic is visible as Markdown instructions naming the helper script and the filter rule.
- Given a council pipeline run, when the Chair applies the filter, then no executable code outside `_council-experts/.verify/*` is invoked.
- Given a new stack tag not yet in any expert's `meta.yaml`, when the Chair filters, then experts with no matching tag are skipped silently AND a single log line names the unseated experts (operator can audit gaps).
- Given a workspace where ALL detected tags match zero non-common experts, when the Chair filters, then only `common`-tagged experts are seated (degraded panel — operator gets a visible warning, not a crash).

#### Story 3.3: Every catalog entry declares its applicable stacks via `meta.yaml`

**When** a new expert is added to the catalog, **I want** their stack applicability to be discoverable via a single file (`meta.yaml`), **so I can** add an expert without editing the Chair's selection logic.

**Acceptance Criteria:**

- Given any subdirectory under `_council-experts/`, when the catalog-canary runs, then `meta.yaml` exists with `creator: <Full Name>` and at least one `stack:` entry from the enum `common | aura | python | php | postgres | telegram`.
- Given an expert tagged `common`, when the Chair filters for any stack tags, then this expert is always seated.
- Given an expert tagged with a stack value not in the enum, when the catalog-canary runs, then it fails with a clear error naming the offending file and the unknown value.
- Given the enum extension (a new stack value added), when the enum changes, then both `meta.yaml` parser AND `verify-catalog.sh` canary update in the same commit.

#### Story 3.4: Seated panel size grows organically, NOT capped at 16 per-dispatch

**When** a multi-stack monorepo triggers many stack tags (rare — PHP + Python + Aura mixed), **I want** the Chair to seat ALL matching experts up to the natural catalog cap of 16, **so I can** get full multi-lens coverage in mixed-stack projects.

**Acceptance Criteria:**

- Given a catalog of 16 IDs and a workspace matching all stack tags, when the Chair filters, then up to 16 experts can be seated (catalog max).
- Given a workspace matching only the `common` tags AND no stack-specific tags, when the Chair filters, then exactly 7 experts (the `common`-tagged ones) are seated.
- Given a workspace matching `aura` only, when the Chair filters, then approximately 9-10 experts are seated (7 `common` + Aura-tagged: abramov, watson, dahl, ritchie, hashimoto — depending on Aura's overlap).
- Given the catalog post-v1, when any single dispatch executes, then the seated count NEVER exceeds 16 (because catalog itself doesn't exceed 16 — the cap is structural, not per-dispatch trim).

### Council Mode bidirectional pipeline — MOVED

The four stories about the Orchestrator↔Observer workflow + cross-half sync + convergence detection have moved to the sibling spec `specs/council-mode-bidirectional-pipeline.md`. They depend on this catalog (16 IDs + stack-detection + chair-side filter) but are otherwise independent and warranted a separate spec to keep both readable. See that file for stories 4.1-4.4 + the cross-half sync architecture discussion.

## v2 deployment isolation (CRITICAL — read before any implementation)

We will use Aura Companion's CURRENT Council Mode (β catalog at `~/.claude/skills/_council-experts/`, 4 dispatcher skills) to DEVELOP v2 of itself. Touching the catalog or dispatcher SKILL.md files mid-session creates recursive collisions:

- Rename `a11y → watson` mid-session: the running Council pair already has `a11y` in its loaded Panel; next dispatch breaks.
- Delete `backend-ts/review-aura.md` mid-flight: Observer's in-progress dispatch sees an empty prompt.
- Catalog regression: rolling back a v2 prompt change reaches into the live system that's currently using v1.
- The shared global `~/.claude/skills/` is used by 13+ sibling projects (memory: `feedback_shared_global_infra_refactor_requires_dedicated_window`).

**Isolation pattern (mandatory for v1):**

| Layer | v1 (live) | v2 (in-development) |
|---|---|---|
| Catalog | `_council-experts/` | `_council-experts-v2/` |
| Plan dispatcher | `council-plan/`, `council-plan-aura/` | `council-plan-v2/`, `council-plan-aura-v2/` |
| Review dispatcher | `council-review/`, `council-review-aura/` | `council-review-v2/`, `council-review-aura-v2/` |
| Implementer | `council-implement/`, `council-implement-aura/` | `council-implement-v2/`, `council-implement-aura-v2/` |
| Aura code | `main` branch of `/root/aura-companion` | `feat/council-v2-pipeline` branch (git-native isolation) |

During v2 development:
- All v2 work lands in `_council-experts-v2/` + `council-*-v2/` directories. v1 is read-only.
- v1 (current β) drives Council Mode for the development sessions themselves — no recursive collision.
- v2 dispatchers are invocable as `/council-plan-v2`, `/council-review-v2`, etc. for testing the v2 pipeline before promotion.
- `verify-catalog.sh` and `verify-panels.py` run against `_council-experts-v2/` to validate v2 state without disturbing v1.

**Atomic promotion (when v2 is complete and tested):**

1. Wait until v2 development complete + all canaries green AND a converged Council Mode test session against `*-v2` passes.
2. Backup: `git tag council-v1-archive` on `~/.claude/skills/.git`.
3. Atomic swap:
   - `mv _council-experts _council-experts-v1-archive`
   - `mv _council-experts-v2 _council-experts`
   - Same for each `council-*-v2/` → `council-*/` (after archiving v1).
4. Run verify-catalog.sh + verify-panels.py on the swapped state.
5. Commit promotion in `~/.claude/skills/.git`.
6. 30-day archive watch — if v2 regresses, `git checkout council-v1-archive` reverts atomically.

**Rollback contract:** any v2 promotion must be reversible to v1 by a single `git checkout` within 30 days of promotion. After 30 days the v1-archive directories may be pruned.

## Technical Context

- **Catalog location:** `~/.claude/skills/_council-experts/` (established in β; not changing).
- **Stack-detection helper:** `~/.claude/skills/_council-experts/.verify/detect-stack.sh` (new file). Reads anchor files; emits `\n`-separated tag list to stdout.
- **Dispatcher skills:** the four `/council-{plan,plan-aura,review,review-aura}` SKILL.md gain a Phase 0.5 step naming the detector script.
- **Constraint inheritance from β:** AC-3.2 byte-identity for existing 17 experts, EC-24 (catalog-resolved panel) convention floor.
- **Existing convention floor:** AP-1..AP-4, EC-1..EC-24. Must not regress.
- **Aura repo coupling:** `conventions.md` gains EC-25; spec lives in Aura repo; the actual catalog edits land in `~/.claude/skills/.git` (separate repo, established in β).

## Boundaries

### ✅ Always

- Add expert via single subdir under `_council-experts/<id>/` with `meta.yaml` (creator + stack enum) + at least one of `{plan,plan-aura,review,review-aura}.md`.
- Use the **technology creator's surname** as the ID — never flavor names, never role descriptions.
- Stack-detection reads canonical anchor files (top-level only, no recursive walk).
- Preserve **semantic coverage** during consolidation: every concern in a merged-source prompt must appear in the new merged prompt.
- Update `_council-experts/README.md`, `~/.claude/skills/_council-experts/.verify/verify-catalog.sh`, AND the 4 dispatcher SKILL.md `### Council panel` lists in the same commit as the rename/merge.
- Update all 4 SKILL.md `### Council panel` lists with the new ID names atomically.

### ⚠️ Ask first

- Adding any new ID beyond the 16 documented in the rename+merge map (forces structural decision: drop an existing ID OR raise the cap).
- Renaming any of the 16 IDs to a name OTHER than the technology's creator surname.
- Changing the stack enum (impacts every `meta.yaml`).
- Introducing a new dispatcher skill (`/council-foo`) beyond the existing 4.
- Adopting any Layer 1-6 v2 architectural component (LangGraph, CrewAI, AutoGen, OpenDevin, vector memory, MCP runtime).

### 🚫 Never

- Introduce a runtime registry, plugin loader, or dynamic-eval layer for catalog discovery (β spec constraint inherited).
- Hardcode stack detection in any expert prompt or dispatcher SKILL.md prose — the detector script is the single source of truth.
- Exceed 16 catalog IDs (structural cap; breach signals "consolidate or drop", not "raise cap").
- Drop semantic coverage during a merge (every named concern from old sources MUST be in the new merged prompt — `verify-catalog.sh` semantic-coverage canary enforces).
- Use flavor names (`python-sage`, `php-monk`, `frontend-wizard`) — only real-person surnames.
- Couple Aura repo code to specific catalog file paths via runtime require/import — catalog is purely Claude-Code-skill state, no production code reads it.

## Success Metrics

### Launch criteria (v1 is done when)

- 4-6 new expert IDs landed: `php`, `nodejs`, `frontend-generic`, `qa-generic`, `refactor-generic` (optional), `tool-schemas`.
- Every catalog entry has a `meta.yaml` with a valid `stack:` enum value.
- `detect-stack.sh` exists, emits deterministic output across 5 sample workspaces (Aura/Python/PHP/Node/Mixed).
- Stack-detection canary in `verify-catalog.sh` validates output shape.
- All 4 dispatcher SKILL.md have an explicit Phase 0.5 step naming the detector + filter rule.
- `verify-panels.py` still reports 44/44 byte-identical against pre-v2 baseline (existing experts unchanged).
- `conventions.md` updated with EC-25.

### 30-day success

- Council dispatched on a non-Aura, non-Python project (e.g., PHP) seats ≥1 stack-specific expert AND all `common`-tagged experts.
- Multi-stack monorepo dispatch produces a deduplicated panel ≤15 in size.
- Operator-reported "no-recs noise" drops to ≤20% of dispatched experts on stack-correct projects (down from today's 40-60% on cross-stack invocations).

## Recommended Decomposition

### Phase 0: Set up v2 isolation (no v1 touched)

- Create empty `_council-experts-v2/` directory in `~/.claude/skills/`.
- Fork dispatcher skills: `cp -r council-plan council-plan-v2`, same for the 5 other council-* dirs (4 dispatchers + 2 implementers). All forks point at `_council-experts/` initially (placeholder until Phase 3).
- Verify all `*-v2` invocations work as drop-in replacements for v1 (sanity test before content changes start).
- **Why first:** establishes isolation. Every subsequent phase modifies ONLY the `-v2` paths. v1 is read-only during development.

### Phase 1: Pure renames + `meta.yaml` (no content change) — INSIDE `_council-experts-v2/`

- Copy current `_council-experts/` content INTO `_council-experts-v2/` as the starting point (post-Phase-0 it's empty).
- Story 1.2 (partial) — rename 4 directories WITHIN v2: `a11y → watson`, `backend-python → vanrossum`, `frontend-react → abramov`, `telegram-ux → durov`. File content unchanged.
- Story 3.3 — add `meta.yaml` (creator + stack enum) to all 11 existing creator-named experts (Hunt, Fowler, Beck, Willison, Saarinen, Friedman, Brandur + the 4 just renamed) — all in v2 catalog.
- Update 4 dispatcher SKILL.md `### Council panel` lists with new IDs — in the `*-v2` forks only.
- Run `verify-panels.py` with renamed-aware logic to assert byte-identity of moved files (compares v1 catalog content against v2 catalog content via the rename map).
- **Why second (after isolation setup):** lowest-risk content piece. No content changes; just `git mv` within v2 + metadata. v1 untouched.

### Phase 2: Merges + prompt upgrades (content evolution)

- Story 1.3 — write upgraded prompts for the 3 new merged IDs:
  - `dahl/{plan-aura,review-aura}.md` — TypeScript broadly, absorbing `backend-ts` + `realtime-ndjson` concerns (Bun.serve, Hono middleware, WS upgrade, NDJSON dedup window, sequence/replay)
  - `ritchie/{plan-aura,review-aura}.md` — Unix systems, absorbing `subprocess` + `persistence-fs` concerns (spawn argv validation, PID reconnect, signal grace, atomic write, sentinel-before-sweep, JSONL discipline)
  - `hashimoto/{plan,plan-aura,review,review-aura}.md` — Deploy broadly, absorbing `deploy-docker-gha` + `deploy-vps` concerns (Dockerfile, GHA workflow, secrets, systemd unit, HEALTHCHECK)
- Delete the 6 old directories (`backend-ts`, `realtime-ndjson`, `subprocess`, `persistence-fs`, `deploy-docker-gha`, `deploy-vps`) AFTER updating Panel lists.
- Add `semantic-coverage` canary to `verify-catalog.sh` asserting every concern from baseline prompts appears in merged prompts.
- Update 4 dispatcher SKILL.md `### Council panel` lists to reflect the new IDs.
- **Why second:** biggest single chunk of content evolution; isolated from selection logic.

### Phase 3: Add Lerdorf (PHP) + Colvin (pydantic-ai) + chair-side selection — INSIDE v2

- Story 2.1 — add `lerdorf/` in v2 catalog with `meta.yaml { stack: [php], creator: "Rasmus Lerdorf" }` + `plan.md` + `review.md`.
- Add `colvin/` in v2 catalog with `meta.yaml { stack: [common, mcp], creator: "Samuel Colvin" }` + `plan.md` + `review.md` covering pydantic-ai, strict tool schemas, MCP structured outputs.
- Stories 3.1, 3.2, 3.3, 3.4 — implement `detect-stack.sh` (lives in `_council-experts-v2/.verify/`) + Phase 0.5 step in all 4 `*-v2` dispatcher SKILL.md.
- Test `*-v2` dispatchers against the new catalog + filter on representative workspaces (Aura, Python, PHP, multi-stack).

### Phase 4: Atomic promotion v2 → v1

- Pre-promotion: all v2 canaries green; at least 1 converged Council Mode test session using `*-v2` skills against the v2 catalog.
- `git tag council-v1-archive` on `~/.claude/skills/.git`.
- Atomic swap (single commit):
  - `mv _council-experts _council-experts-v1-archive`
  - `mv _council-experts-v2 _council-experts`
  - For each of 6 forked council-* dispatcher/implementer skills: `mv council-foo council-foo-v1-archive && mv council-foo-v2 council-foo`
- Re-run verify scripts against the swapped state.
- 30-day archive watch — if v2 regresses, `git checkout council-v1-archive` reverts atomically.
- **Why last:** mechanical swap; high-stakes (touches global infra for 13+ projects). Cannot run inside a Council session that uses these skills — must be done in a fresh terminal not mid-pipeline.

### Phase 4 (and beyond) — see sibling spec

Council Mode bidirectional pipeline (workflow sequence, cross-half sync, convergence detection) lives in `specs/council-mode-bidirectional-pipeline.md`. It depends on Phase 3 of this spec landing first (catalog + stack-detection + chair-side filter all working).

Each phase here can be extracted into its own Feature-tier spec when ready for implementation. Phase 1 is the lowest-risk pilot; Phase 2 is the highest-risk piece (semantic coverage drop is the failure mode).

## Assumptions

- **(confirmed)** 16-cap is on TOTAL catalog (not per-dispatch). Current 17 → 16 via the documented rename + merge + add map. Catalog NEVER exceeds 16 without a "drop or consolidate" decision.
- **(confirmed)** Every catalog ID is a technology creator's surname — no flavour names. 7 existing creator-named experts stay; 7 anonymous ones rename; 2 new (Lerdorf, Colvin) added.
- **(confirmed)** Prompts get upgraded during consolidation — β AC-3.2 byte-identity floor is intentionally broken. New floor is semantic-coverage (every old concern present in merged new prompt).
- **(confirmed)** v2 architecture (LangGraph Brahman, CrewAI runtime, AutoGen debates, OpenDevin executors, vector memory, MCP RUNTIME) is roadmap context only; out of v1 scope. MCP/pydantic-ai LENS becomes its own ID (`colvin`), separate from `willison` (LLM pipeline).
- **(confirmed)** Rename picks: `a11y→watson` (Léonie Watson), `frontend-react→abramov` (Dan Abramov, absorbing generic frontend), `subprocess+persistence-fs→ritchie` (Dennis Ritchie), `deploy-docker-gha+deploy-vps→hashimoto` (Mitchell Hashimoto), `backend-ts+realtime-ndjson→dahl` (Ryan Dahl), `backend-python→vanrossum` (Guido van Rossum), `telegram-ux→durov` (Nikolay Durov).
- **(confirmed)** Council Mode runs the canonical 9-step sequence (`/prime → /spec-writer → /council-plan → /council-implement → /council-review → /test-architect → /self-improvement → /learn → /self-reflect`) with Orchestrator + Observer pair operating bidirectionally — Observer reviews task N's commit in parallel with Orchestrator's task N+1 plan. Convergence after 2-3 cycles + green CI.
- **(confirmed)** Stack detection uses BOTH anchor-file presence AND content inspection. Two-phase detector:
  - **Phase A (anchor):** file presence → first-pass tags (e.g. `package.json` exists → `js`).
  - **Phase B (content):** parse anchor files for richer signals — `react`/`vue`/`svelte` in `package.json` deps → `react`/`frontend-other`; `pydantic-ai` in `pyproject.toml` → `mcp`; `laravel/framework` in `composer.json` → `php-laravel`; `@modelcontextprotocol/sdk` → `mcp`.
  - **Determinism floor:** Phase B reads ONLY top-level dependency declarations; no recursive evaluation, no remote network calls.
- **(unconfirmed)** Convergence signalling format (banner vs filesystem checkpoint vs both) — Story 4.4 leaves this open. Implementation decides.

## Open Questions

- **Phase 1 byte-identity scope** — pure renames preserve byte-identical prompt body content but break file PATHS. `verify-panels.py` proves byte-identity via **SHA-256 checksum comparison** (cheaper than full byte-diff while functionally equivalent). For each (old-id, new-id) rename pair:
  1. Compute `sha256(baseline_file_bytes)` where baseline = `_council-experts/<old-id>/<phase>.md` from v1 OR `git show council-v1-archive:_council-experts/<old-id>/<phase>.md`.
  2. Compute `sha256(v2_candidate_bytes)` where candidate = `_council-experts-v2/<new-id>/<phase>.md`.
  3. Compare hashes. Mismatch = test failure with both hex digests printed; operator can then run `diff -u` manually for offset-level inspection.
- File size pre-check: if sizes differ, hash comparison is skipped (already known to differ); test fails immediately with `size mismatch: baseline=N, candidate=M`. This catches `git mv` truncation cleanly.
- NOTE: `meta.yaml` files are NEW in v2 — they're NOT byte-compared (didn't exist in v1).
- **Convergence UX** — the "Converged — ready to ship" banner is a new UI surface. Frontend integration scope?
- **Cross-half memory sync** — Story 4.3 says both halves share memory. Today's Aura Council Mode has per-half memory dirs; how does the Observer see the Orchestrator's `/learn` writes promptly? Filesystem-watch on `.agents/knowledge/` from both halves?
- **OpenDevin / LangGraph integration roadmap** — explicitly out of v1, but should `conventions.md` document the deferred Layer 1-6 architecture as future state, OR keep that vision only in this spec?

---

*After implementing each phase, compare results against the acceptance criteria for that phase's stories and list any unmet requirements.*
