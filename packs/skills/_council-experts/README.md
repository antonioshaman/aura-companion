# Council experts catalog

Shared catalog of council subagent prompts. Consumed by the four dispatcher
skills (`council-plan`, `council-plan-aura`, `council-review`,
`council-review-aura`) instead of inlining 30-line prompt blocks in each
SKILL.md.

## Layout

```
_council-experts/
├── .verify/
│   ├── verify-catalog.sh          # runner: P0, C1–C6, C10–C13
│   ├── pre-commit.sh              # tracked body of the repo's pre-commit gate
│   ├── c6-panel-count.py          # C6 — stated panel counts vs the panel list
│   ├── c10-coverage.py            # C10 — merged docs still carry each source expert's tokens
│   ├── c13-implement-parity.py    # C13 — implement tables cover every seat their planner dispatches
│   ├── verify-lock.py             # C12 — pinned sha256 + dispatch-surface coverage floor
│   ├── cp-mirrors.py              # materialises mirrors; --check is C11
│   ├── _phase2-merges.yml         # build recipe for the seat consolidation
│   ├── _phase2-coverage-tokens.yml # C10 ground truth (tokens/anchors per merged doc)
│   └── _ref-mirrors.lock          # sha256 of every attested file in the dispatch surface
├── .gitignore                     # excludes secrets that may appear under sibling skill dirs
├── README.md                      # this file
└── <expert-id>/
    ├── meta.yaml                  # creator, stack, paired_with, unpaired_reason
    ├── references/                # quality-<id>.md — mirrored into consumer skills
    ├── plan.md                    # for /council-plan       (if seated in Python plan panel)
    ├── plan-aura.md               # for /council-plan-aura  (if seated in Aura plan panel)
    ├── review.md                  # for /council-review     (if seated in Python review panel)
    └── review-aura.md             # for /council-review-aura (if seated in Aura review panel)
```

Not every expert has all 4 phase files — only those for the skill panels they're seated in.

## Expert IDs

Expert IDs are creator surnames (v2 convention). The ratified cap is **16**.

**Cross-stack (in both Python and Aura panels):** `hunt`, `fowler`, `saarinen`, `friedman`, `willison`, `hashimoto`, `beck` (review panels only).

**Aura-only:** `dahl` (Bun/Hono/TS + NDJSON/WS), `ritchie` (§A process lifecycle + §B filesystem persistence), `abramov` (React/Web UI), `watson` (accessibility).

**Python-only:** `durov` (Telegram UX), `vanrossum` (aiogram/async backend), `brandur` (PostgreSQL/Alembic).

**Ratified but not yet seated:** `lerdorf` (PHP), `colvin` (Pydantic/MCP), and the six
tension-pair seats `evans`, `hickey`, `majors`, `sridharan`, `torvalds`, `unclebob`. Each
of the eight names a `paired_with` seat in its `meta.yaml` — it exists to argue against a
seat that IS dispatched, so seating one without its pair loses the argument it was authored
for. All eight are listed in `.verify/unseated.allow`; C2b fails if a directory is neither
seated nor listed there, so an unseated seat is now a recorded decision rather than a state
a directory can drift into.

Three v1 seats were merged and four were renamed — see `.verify/_phase2-merges.yml` for the
mapping and the reason each consolidation is not lossy. The v1 IDs (`backend-ts`,
`realtime-ndjson`, `subprocess`, `persistence-fs`, `deploy-docker-gha`, `deploy-vps`, `a11y`,
`backend-python`, `frontend-react`, `telegram-ux`) are retired; `council-v1-archive-20260516`
is the rollback point.

Directories present in the catalog but seated in no panel are inert — the Chair dispatches
only IDs listed in a consumer's `### Council panel` block (or, for the implement
dispatchers, its expert reference table). Inert is permitted but not free: C2b requires
every such directory to be named in `.verify/unseated.allow`, and fails on an allow-list
entry whose directory is gone or that a dispatcher actually seats.

### Recorded disposition: reference-doc naming is two corpora, not one migration

Reference documents come in two families and the difference is load-bearing, so
do not "finish the migration" by mass-repointing one to the other.

- **Domain-named** (`security.md`, `refactoring.md`, `quality-llm.md`,
  `quality-ui.md`, `quality-ux.md`, `quality-testing.md`, `quality-a11y.md`,
  `quality-frontend.md`) — **stack-split**. Each dispatcher carries its own
  differently-tuned copy; the Python `refactoring.md` and the Aura one are
  different documents that happen to share a filename.
- **Expert-named** (`quality-<id>.md`) — **single-canonical**, one file in
  `_council-experts/<id>/references/` mirrored byte-identically into every
  dispatcher that seats the expert.

Repointing a seat that is dispatched in BOTH stacks from its domain-named doc to
its expert-named one silently collapses the stack tuning into one document. That
is why `hunt`, `fowler`, `willison`, `friedman`, `saarinen`, `beck`, `abramov`
and `watson` deliberately still cite domain-named docs even though a
`quality-<id>.md` exists for them.

Seats dispatched in only ONE stack have nothing to collapse, so for them the
expert-named doc is strictly better. `durov`, `vanrossum` and `brandur` (all
Python-only) were repointed on 2026-09-06. `durov` was the load-bearing case: it
cited `quality-frontend.md`, a Next.js / tRPC / Prisma / Clerk / CSS-Modules
document, for a Telegram-UX seat in an aiogram stack. C13 could not catch it —
that canary asserts a seat's row names a file that exists, not that the file is
about the seat's domain.

Consequence to know about: the Python copies of `quality-frontend.md`,
`quality-backend.md` and `quality-postgres.md` now have no consumer. They are
retained and still attested rather than deleted, because deleting them is the
same question as Fowler's "delete the mirror subsystem" proposal and belongs
with that decision, not ahead of it.

### Recorded disposition: Co-Pilot incubation seats

`backend-python-ptb`, `deploy-copilot` and `firestore-doc` are seats for a **third stack**
("Co-Pilot": python-telegram-bot v20 + FastAPI webhook + Firestore + Cloud Run/VPS hybrid).
They are deliberately retained, and deliberately inert: no dispatcher in this catalog has a
Co-Pilot panel, so no Chair can reach them. They are NOT part of the ratified 16-ID cap —
that cap governs seats a panel can dispatch, and these cannot be dispatched at all.

They are kept rather than deleted because the Co-Pilot stack is a real target and these three
prompts are the only surviving statement of its domain boundaries. Wiring them in later
requires a `council-*-copilot` dispatcher and a panel block; until that exists, treat this
directory set as incubation.

`firestore-doc/plan.md` cites `references/quality-firestore.md`, which exists nowhere in the
tree. The citation is left in place with an inline unresolved-reference marker rather than
silently deleted: deleting it would make a seat that cannot work look ready, which is the
same "confident empty result" failure this catalog's gates exist to prevent. Anyone seating
`firestore-doc` must author that document first.

## Contract

- Expert IDs MUST match `^[a-z][a-z0-9-]{1,31}$` (security canary).
- Reference citations in phase files MUST be anchored: `~/.claude/skills/<dispatcher>/references/<doc>`,
  never a bare `references/<doc>`. A phase filename determines its dispatcher exactly — `plan.md` is only
  ever read by `/council-plan`, `review-aura.md` only by `/council-review-aura` — so the correct anchor is
  never ambiguous. Enforced by C14. A bare path resolves by model guess, and six filenames
  (`quality-llm.md`, `quality-testing.md`, `quality-ui.md`, `quality-ux.md`, `refactoring.md`,
  `security.md`) name materially different documents in the two stack families, so the guess silently
  decided which principle set an expert applied.
- Catalog files MUST pass `.verify/verify-catalog.sh`, which the repo's pre-commit hook runs.
  Byte-identity is attested two ways: C11 compares each mirror to its canonical's current
  bytes, C12 compares both to the sha256 pinned in `_ref-mirrors.lock` and fails on any file
  in the dispatch surface the lock does not attest.
- Adding a new expert ID requires:
  1. New subdir under `_council-experts/<id>/`
  2. One or more phase files (`plan.md`, `plan-aura.md`, `review.md`, `review-aura.md`)
  3. Either seat it — edit each consumer SKILL.md's `### Council panel` list (and the
     implement dispatchers' expert table) to add the ID, updating the stated panel count
     C6 checks — or record it as deliberately inert in `.verify/unseated.allow`. C2b
     rejects a directory that is neither.
  4. Re-run `verify-catalog.sh`. C2 catches a panel naming a seat that does not exist;
     C2b catches the reverse, a directory no dispatcher can reach.
- Removing or renaming an existing expert is breaking — coordinate with all 6 consumer
  skills (`council-{plan,review,implement}{,-aura}`) in the same commit, and drop any
  `unseated.allow` entry for it: C2b fails on an allow-list name whose directory is gone.

## Origin

Created per `specs/council-experts-catalog.md` (Aura Companion repo) — β refactor 2026-05-15.
Council plan: `PLAN-aura-beta-catalog-refactor.md`. Council findings:
`/root/aura-companion/.council/review-output/2026-05-15-beta-catalog/`.

Expanded to the 16-ID creator-surname panel per
`specs/council-experts-catalog-v2-expansion.md` — completed 2026-09-05. The expansion was
folded into the live skills rather than swapped in wholesale: the `-v2` forks predated both
the Phase 0 stack-detection router and the `council/checkpoint` emit phases, so an atomic
`mv` would have regressed them.

## Threat model — what this catalog defends against

- **Inline-block duplication drift** (Fowler) — historically each consumer SKILL.md held its own copy of every expert prompt, so the 13 experts had 52 inline copies across 4 dispatcher skills. Edit Hunt's prompt → 4 edits, easy to miss one. Now: one edit per (expert, phase) at most.
- **Catalog content poisoning** (Hunt) — every file a dispatched agent reads or obeys (expert prompts, reference docs, mirrors, and each dispatcher's own `SKILL.md`) carries a pinned sha256 in `_ref-mirrors.lock`, checked by C12. The attested set is defined in code, not in the lock, so deleting an entry fails the coverage floor rather than shrinking the scope of the check.
- **Semantic hollowing** (Fowler) — hash checks are blind to meaning: a reference doc rewritten wholesale, with its lock hash regenerated in the same commit, passes C11 and C12. C10 asserts each merged doc still carries the tokens of every expert merged into it.
- **Plan→implement seat drift** (Chair) — `/council-plan` may attribute a task to any seat in its panel, but the implement skills resolve seats through a reference table, not the panel, and C2 is scoped away from them. A seat with no row makes the Builder's "non-negotiable" reference read a silent no-op while the implementation log still records the attribution. C13 asserts every panel seat has a table row naming a file that exists (subset, not equality — review-only seats like `beck` are legitimate extras).
- **Expert-name injection** (Hunt) — consumer SKILL.md names experts by ID, and the ID becomes a path segment, so a panel entry like `../../../tmp/evil` is a traversal. The regex `^[a-z][a-z0-9-]{1,31}$` is checked in three places, not one: C3 over catalog directory names, C2 over every bullet in a panel block (shape-checked *before* the existence check, so a malformed entry fails rather than being skipped), and the Chair's own pre-dispatch assertion. The first two are mechanical and survive a tampered prompt; the third does not, and is a convenience, not the defence.
- **Unreachable-seat drift** (Beck) — a directory that no dispatcher names is invisible to C2, which only walks panel → catalog. Such a seat rots unnoticed: its prompt is never dispatched, so nothing exercises its citations or its merge tokens, yet it still reads as part of the catalog. C2b walks the other direction and requires every unseated directory to be named in `.verify/unseated.allow` — inert has to be a decision on the record. The allow-list is checked in both directions too: an entry for a directory that is gone, or for a seat a dispatcher actually seats, fails.
- **Symlink traversal** (Hunt) — catalog files are plain markdown; the Chair reads with `Read` tool which respects absolute paths. Catalog files MUST NOT be symlinks (mode-canary in `.verify/verify-catalog.sh`).
