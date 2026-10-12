---
title: "Experience packs"
description: "Lessons from real projects as executable checks: how a lesson becomes a check, and how to run aura-check."
---

# Experience packs

## Why checks and not notes

The corpus analysis of 19 real projects that agents worked on (`FULL-SYNTHESIS.md`, §6–7)
gave a clear answer about accumulated experience:

- **Prose does not change behaviour.** Lessons written into memory files or the knowledge
  base recurred in 10 projects after they were written. Example: auraengine wrote
  `LRN-20260728-002` "Alembic revision id ≤ 32 chars" the day a 35-char id rolled back a
  prod migration (`f6de1b7`); eight days later `2196cdf` shipped a 33-char id. snowlevel
  wrote down "Telegram caches the Mini App by URL, use `?v=`" on 15.09 and had the same
  stale-bundle outage on 28.09, 29.09 and 01.10.
- **Knowledge embedded in the process works.** Conventions referenced from the plan, a
  `_test` database guard in code, a runbook step, a FIX-SPEC that says "verify with curl" —
  these held.

So the unit of experience is not a paragraph but an executable check that runs where the
work happens (pre-commit, CI, before a restart) and shows a short "why" only when it fires.

## Format of a unit of experience

**Trigger → check → short why → provenance.**

| Part | In `aura-check` |
|---|---|
| Trigger | a diff pattern (`--changed`), a commit message, the tracked tree, or the runtime state (`--runtime`) |
| Check | a rule function in `packs/checks/aura_check/rules/<pack>.py` |
| Why | `title` + `hint` (what to do), printed with the finding |
| Provenance | `evidence`: projects, commits, incident — no secrets, no personal data |

Rules are grouped in **packs by stack** (`python-alembic`, `env`, `secrets`, `pii`,
`llm-output`, `fallback`, `deploy`, `telegram-miniapp`, `call-site-parity`). A project turns on the
packs that match its stack with `--pack`; packs are referenced, not copied into each repo.

Severity follows cost and certainty: **error** when the pattern is unambiguous and the damage
is real (a secret in git, a 33-char revision id, a tracked `.env`); **warn** for heuristics
(code-shape checks, personal data). Warnings never block a commit unless `--strict`.

## What v1 covers

| Lesson (FULL-SYNTHESIS §6) | Projects | Rule(s) |
|---|---|---|
| #1 Changed a guard → find **all** call sites | 11 | `call-site-parity.guard-missing` |
| #4 Migrations before code; ORM edit ≠ schema edit; Alembic id ≤ 32 | 8 | `alembic.revision-id-too-long`, `alembic.revision-id-duplicate`, `alembic.model-change-without-migration` |
| #5 Prod does not run from the working tree | 7 | `deploy.workdir-not-clean-main` (`--runtime`) |
| #7 Silent fallback inverts the invariant | 6 | `fallback.silent-model-fallback`, `llm-output.raw-on-parse-failure` |
| #16 Secrets / personal data: not in git, not in `Environment=` with 644 | 6 | `secrets.*`, `env.file-tracked`, `env.file-world-readable`, `deploy.systemd-inline-secret`, `pii.personal-data` |
| #17 LLM pipeline: output shape gate before a public write | 4 | `llm-output.raw-on-parse-failure` + the runtime publish guard snippets |
| §6.2 systemd/docker: compose interpolates `$` | 6 | `env.compose-dollar` |
| §6.2 Telegram Mini App: cache by full URL | 5 | `telegram.miniapp-url-unversioned` |
| §6.2 aiogram: state handler swallows /start and menu | 7 | `telegram.fsm-swallows-commands` |

Usage, install (git hooks, pre-commit, GitHub Actions) and the full rule table:
[`packs/checks/README.md`](https://github.com/antonioshaman/aura-companion/blob/main/packs/checks/README.md).

## The lesson → check loop

1. **Something goes wrong** (incident, review finding, user correction). Write down the
   failure class, not the story: what pattern in a diff/config/runtime state would have
   predicted it?
2. **Is it transferable?** A class that happened in ≥ 2 projects or stacks is a pack
   candidate. Facts about one prod box (hosts, which payment provider is live) are not —
   they belong in that project's fact sheet.
3. **Write the check.** Add a rule with the narrowest trigger that would have fired on the
   original commit. Put the commit/incident in `evidence`, the fix in `hint`. Choose `error`
   only when false positives are near zero; otherwise `warn`, `diff_scoped=True` so it only
   speaks about lines the change adds.
4. **Prove it with fixtures.** A positive fixture shaped like the original incident and
   negative fixtures for the obvious near-misses (`tests/test_<pack>.py`). Fake secrets
   only, generated at runtime.
5. **Embed it.** The rule ships in the pack; projects get it through their existing
   pre-commit/CI line. Nobody needs to read anything until it fires.
6. **Measure "fired and caught", not "written".** A rule that never fires for months is a
   candidate for removal; a rule that fires and is suppressed every time needs a narrower
   trigger.
7. **Recurrence escalates.** If the same lesson is written down a second time in prose,
   that is the signal to turn it into a check — not to write it "bolder".

## Not covered yet

From §6–7, candidates for the next packs: tests pointed at a non-`_test` database (pre-tool
hook), `alembic current == head` before restart, "live == HEAD" post-deploy verification,
webhook handlers without signature checks, `tg_id` columns that are not `BIGINT`, money
constant diff-guard, the "deploy as test" detector (> 5 commits to one file in an hour).
These need hooks or runtime probes rather than a static scan.
