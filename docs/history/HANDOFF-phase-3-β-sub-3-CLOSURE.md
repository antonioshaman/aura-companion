# HANDOFF — Phase 3β sub-3 closure (evans + hickey paired-tension cluster B)

**Branch:** `feat/council-phase-3-beta-sub-3-evans-hickey`
**Worktree:** `/tmp/aura-phase3beta-sub3/` (isolated from `/root/aura-companion/`)
**Skills repo head after sub-3:** `17f4eda` (N3.21 hickey) over `ee002ae` (N3.20 evans)
**Base:** `origin/main` at `089b692` (post PR #71 sub-1 squash-merge)
**Catalog state at sub-3 close:** **20 v2 expert seats** (was 18 post-sub-2).

---

## What sub-3 shipped

Sub-3 closes the **second paired-tension cluster** of Phase 3β — two non-Aura common-stack seats, each shipping the EC-34 wire-format 4-key meta.yaml shape (third + fourth applications since sub-2 empirical first).

### Commit 1 — `ee002ae` N3.20 evans seed-new

- **Seat:** `evans` (Eric Evans, *Domain-Driven Design*, 2003)
- **Paired with:** `fowler` (per PLAN dispatch)
- **Tension axis:** `strategic-DDD ↔ emergent-microservices`
- **Lens:** strategic DDD, bounded contexts, ubiquitous language, model-first thinking, anti-corruption layers, aggregate-root invariants, domain events as communication, knowledge-crunching collaboration
- **Cross-refs:** 8 of 8 principles bridge to fowler (maximum doc-layer encoding of the axis):
  - §A E1 bounded-context             → fowler §B bounded context awareness
  - §A E2 ubiquitous-language         → fowler §C code smell vocabulary
  - §A E3 context-map-before-extract  → fowler §B strangler-fig + microservices justification
  - §A E4 model-first-thinking        → fowler §A YAGNI
  - §B E5 anti-corruption-layer       → fowler §B feature-toggle
  - §B E6 aggregate-root              → fowler §C smell taxonomy (Data Clumps)
  - §B E7 domain-event                → fowler §B microservices-justification-gate
  - §B E8 knowledge-crunching         → fowler §A economic refactoring
- **Files:** 9 atomic (meta.yaml + plan.md + review.md + canonical + 2 B1 mirrors + 3 `.verify` mods)
- **Canonical sha256:** `71e2a58b2f010ad18414b1185a02f9d49208563af313ca912ee90e4c91f26ae3` (151L)

### Commit 2 — `17f4eda` N3.21 hickey seed-new

- **Seat:** `hickey` (Rich Hickey, Clojure / "Simple Made Easy")
- **Paired with:** `beck` (meta-only declaration — see note below)
- **Tension axis:** `fundamental-simplification ↔ incremental-TDD`
- **Lens:** simple-vs-easy decomplection, values-not-places, incidental-complexity recognition, hammock-driven thinking, data-as-first-class, orthogonal decomposition, minimum-information APIs, critique of easy-by-default
- **Cross-refs:** 8 of 8 principles bridge to beck (closes the cluster with maximum doc-layer axis encoding):
  - §A H1 simple-as-decomplected      → beck §B make-the-change-easy
  - §A H2 values-not-places           → beck §B locality-of-behaviour
  - §A H3 incidental-complexity       → beck §A test-infect
  - §A H4 hammock-driven              → beck §B small-safe-steps
  - §B H5 data-as-first-class         → beck §A empirical test design
  - §B H6 orthogonal-decomposition    → beck §B make-the-change-easy
  - §B H7 minimum-information-needed  → beck §A TDD microcycle
  - §B H8 critique-of-easy-by-default → beck §B optimistic-programming
- **Files:** 9 atomic (same shape as N3.20)
- **Canonical sha256:** `f231a9cbbccd998ee69d1933466d10eb75f69e37469247f17f68e65601d0ce77` (151L)

**beck-pairing note:** beck is review-only mirror per dec-008 — beck has `quality-beck.md` + `review.md` but no `plan-aura.md` / `plan.md` beyond review.md (sub-0 PLAN dispatch dropped beck plan-side). The `paired_with: beck` declaration is a **meta-only catalog field** per PICKUP-sub-3 override — it does not require beck to be on the planning-side dispatch, only that the axis tension be encoded at the doc layer via cross-refs. C7 schema (extended in N3.17) allows the field unconditionally so this is structurally clean.

---

## Catalog state at sub-3 close (verify-catalog.sh — 12 gates green)

```
EXPECTED_COUNT       20  (was 18 post-sub-2)
C6  catalog dirs     20 / 20 with meta.yaml
C7  meta.yaml conform 20 / 20  (4 paired / 0 explicit-unpaired / 16 legacy-2-key)
C9  case-insensitive uniqueness  20 / 20
C10 tokens / anchors  190 / 41   (was 174 / 37 post-sub-2)
C11 B2 byte-identity  1 / 4 mirrors
C12 lock attestation  20 mirror sets / 52 mirrors / 20 canonicals
```

**4 paired seats** with EC-34 wire-format after sub-3 (was 2 post-sub-2):
- torvalds ↔ ritchie  ("Linux pragmatism ↔ Unix purity")     — sub-2 N3.18
- unclebob ↔ fowler   ("principle-purity ↔ economic-pragmatic") — sub-2 N3.19
- evans    ↔ fowler   ("strategic-DDD ↔ emergent-microservices") — sub-3 N3.20
- hickey   ↔ beck     ("fundamental-simplification ↔ incremental-TDD") — sub-3 N3.21

**16 legacy-2-key seats** retain the 2-key shape (creator + stack only) — retro-population to 4-key is deferred to sub-4 EC-34/EC-35 amendment per fowler REC-2 two-hat discipline (one axis per commit; retro-population is a separate refactor commit from the new-seat-data commits).

---

## EC-34 wire-format state

**Schema (N3.17 f1a58e2):** `meta.yaml` allowlist extended to `{creator, stack, paired_with?, tension_axis?}`. Validators per semantic category (per `feedback_validator_per_semantic_category`):
- `paired_with`: nullable, expert-ID shape `^[a-z][a-z0-9-]{1,31}$`
- `tension_axis`: nullable, ≤80 chars, no control chars
- Invariant: both present or both absent (not just one).

**Empirical applications:**
- sub-2 first    (N3.18 torvalds + N3.19 unclebob)
- sub-3 second   (N3.20 evans + N3.21 hickey)

**Sub-4 codification:** EC-34 stays in the per-commit comment block at the C7 gate; the formal `conventions.md` codification (with the canonical wire-format paragraph + the two retro-population guidance bullets) ships as part of sub-4 closure scope. EC-35 (D7 shell-paste / `dec-009`) ditto.

---

## Discipline carried forward (do not re-flag)

- **No runtime probe / no checkpoint-emit** — Council Mode runtime untouched in sub-3 (same as sub-0..sub-2). Operator's live `/root/aura-companion/.council/checkpoints/` not written.
- **6 pre-existing SKILL.md mods** still deferred in skills repo (`council-{plan,plan-aura,review,review-aura,implement,implement-aura}-v2/SKILL.md` — Phase 0 router refinements). Continue to use `git add <specific paths>`, NEVER `git add -A`.
- **No `bun run dev`** in sub-3 (would race operator's :3457).
- **Apostrophe→`commit -F` pivot** — used for both N3.20 + N3.21 commit messages (sub-2 N3.18 first-attempt with `-m` failed on `Don't break userspace`; file-based pivot is the default now and worked cleanly here).
- **Single per-expert atomic commit** — matched sub-1/sub-2 precedent; 9 files per commit (meta + plan + review + canonical + 2 mirrors + 3 .verify mods).
- **Token budget** — sub-3 spent approximately the same envelope as sub-2 (~128k for 2 paired seed-news) per the heavy-LLM-dispatch-per-100k discipline (`feedback_phase_decomposition_by_token_budget`).

---

## Sub-4 scope handoff

**Per PLAN-phase-3-β-implementation.md remaining:**

1. **`majors` (David Majors)** — observability + telemetry expert (paired with someone TBD per sub-4 PLAN-side dispatch).
2. **`sridharan` (Cindy Sridharan)** — distributed-systems observability author (likely paired with majors as the observability cluster — sub-4 will confirm the axis).

**Plus closure scope:**

3. **`conventions.md` codification of EC-34** — formal wire-format paragraph + retro-population guidance for the 16 legacy-2-key entries (paired_with: null + tension_axis: null OR omit both).
4. **`conventions.md` codification of EC-35** — D7 shell-paste discipline already in `dec-009`; promote to convention floor as EC-35.
5. **Optional retro-population sweep of the 16 legacy-2-key entries** — per fowler REC-2 two-hat discipline, this lands as ONE refactor commit separate from any new-seat-data commit. Defer to sub-4 OR sub-5 depending on token budget.

**Expected catalog state at sub-4 close:** **22 v2 expert seats** (20 + majors + sridharan). C7 verdict: `5–6 paired / 0 explicit-unpaired / 14–16 legacy-2-key` depending on how many of the 16 legacy entries get retro-populated.

---

## Branch + push status

- Local branch: `feat/council-phase-3-beta-sub-3-evans-hickey` (this worktree) with the HANDOFF commit landing on top of base `089b692`.
- Skills repo `master`: ahead of operator-machine HEAD by 2 commits (`ee002ae` + `17f4eda`).
- **PR NOT opened** — operator decides timing per PICKUP "DO NOT open PR yet — operator decides timing".
- Push intent: `git push origin feat/council-phase-3-beta-sub-3-evans-hickey` once HANDOFF commit is in.

---

## Artefacts for orchestrator audit

- `/tmp/phase-3-beta-sub3-N3.20-validator-brief.md` — evans EC-31 brief
- `/tmp/phase-3-beta-sub3-N3.21-validator-brief.md` — hickey EC-31 brief
- `/tmp/commit-msg-N3.20.txt` — evans commit body (apostrophe-safe via `-F`)
- `/tmp/commit-msg-N3.21.txt` — hickey commit body (apostrophe-safe via `-F`)
- `HANDOFF-phase-3-β-sub-3-CLOSURE.md` — this file (EC-32 closure marker)

`/tmp/phase-3-beta-sub3-writer-status.md` was NOT used — no blockers occurred (gate green pre-commit on both N3.20 and N3.21; no API errors; no SHIP-blocker findings).
