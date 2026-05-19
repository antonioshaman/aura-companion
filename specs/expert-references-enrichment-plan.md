# Spec: Expert References Enrichment — Phase 3α implementation plan

**Date:** 2026-05-16
**Status:** Draft
**Scope tier:** Feature (machine-actionable; consumed by `/council-plan-aura-v2` → `/council-implement-aura-v2`)

## Objective

Phase 3α delivers a uniform deliverable: every one of the 14 v2 expert IDs ends with a canonical `references/quality-<id>.md` containing external-source enrichment paraphrased from user dumps #1 + #3 of `specs/external-knowledge-enrichment-sources.md`. Three experts (dahl, ritchie, hashimoto) gain an appended `## §Z External-source enrichment` section on their existing Phase-2b canonicals. Eleven experts get a newly seeded canonical file authored from dump material. All 14 are registered in `_ref-mirrors.lock` with C12 sha256 attestation and C10 semantic-coverage tokens.

## Context

Phase 2 closure left a catalog asymmetry: only dahl, ritchie, hashimoto have authored `references/quality-<id>.md` files (Phase 2b/2d output, registered in `_ref-mirrors.lock`). The remaining 11 experts have `plan*.md`/`review*.md` subagent prompts but no reference doc. Existing canaries (verify-catalog C1-C12 + cp-mirrors --check) are working; C10 manifest currently covers 3 targets, Phase 3α extends to 14. Skills repo HEAD `fd5b645`, master, no remote. Aura-companion HEAD `9e36aa1`, branch `feat/council-v2-pipeline`, canonical input spec committed.

## Scope

### In scope
- 14 atomic commits in skills repo `~/.claude/skills`, one per existing v2 expert ID
- 3 **append-existing** commits: dahl, ritchie, hashimoto — extend existing canonical with `## §Z External-source enrichment` section preserving all existing §A/§B sections
- 11 **seed-new-file** commits: fowler, beck, hunt, willison, saarinen, friedman, watson, brandur, durov, abramov, vanrossum — create new canonical at `_council-experts-v2/<id>/references/quality-<id>.md` (B2 hashimoto-style)
- `_ref-mirrors.lock`: 3 existing entries get `canonical.sha256` bumps; 11 NEW entries added with `canonical` + `mirrors[]` set per expert's dispatcher cite-sites
- `_phase2-coverage-tokens.yml`: per-expert ~5-10 new tokens registered under `targets.<id>.tokens` with `source: external-enrichment`; seed-new entries also add `structural_anchors`
- Mirrors materialized via `cp-mirrors --apply`; byte-identity verified via `cp-mirrors --check` before commit; verify-catalog C1-C12 green before commit

### Out of scope
- Phase 3β new experts (lerdorf, colvin, torvalds, unclebob, evans, hickey, majors, sridharan)
- Phase 3γ chair-side panel selection / stack detection
- Phase 3-A implement-*-v2 panel cutover (HANDOFF candidate, separate workstream)
- Phase 3-C housekeeping: existing topic-named refs (`quality-a11y.md`, `quality-backend.md`, `quality-ui.md`, etc.) in v1 catalog and v2 dispatcher dirs — left untouched in Phase 3α; rename or delete deferred
- Rewriting existing §A/§B sections of dahl, ritchie, hashimoto canonicals
- EC-34 codification (Section F tension-pair principle — separate convention round)

### Non-goals
- NOT mirroring v1 `plan*.md`/`review*.md` content into v2 canonicals (subagent-instruction ≠ external-principle reference)
- NOT optimizing for uniform length per expert; each enrichment sized to its source material

## Strategy table

| # | Expert | Strategy | Canonical path | Lock action |
|---|---|---|---|---|
| N1 | dahl | append-existing | `council-review-aura-v2/references/quality-dahl.md` | bump sha256, regen 2 mirrors |
| N2 | ritchie | append-existing | `council-review-aura-v2/references/quality-ritchie.md` | bump sha256, regen 2 mirrors |
| N3 | hashimoto | append-existing | `_council-experts-v2/hashimoto/references/quality-hashimoto.md` | bump sha256, regen 4 mirrors |
| N4-N7 | fowler, beck, hunt, willison | seed-new-file (domain-neutral) | `_council-experts-v2/<id>/references/quality-<id>.md` | NEW canonical + mirror set |
| N8-N11 | saarinen, friedman, watson, abramov | seed-new-file (UI cluster) | `_council-experts-v2/<id>/references/quality-<id>.md` | NEW canonical + mirror set |
| N12-N14 | brandur, durov, vanrossum | seed-new-file (language/platform) | `_council-experts-v2/<id>/references/quality-<id>.md` | NEW canonical + mirror set |

**Canonical-path policy for 11 new files: B2 hashimoto-style.** Justification: uniform path shape, avoids aura-vs-non-aura asymmetry that B1 dahl-style forces per expert, decoupled from dispatcher panel composition (panel re-shuffle moves cite-sites, not canonicals), `cp-mirrors --apply` works uniformly across all 14.

**Mirror set per expert** determined at `/council-plan-aura-v2` stage from each dispatcher's panel-list. Mirrors materialized under `council-{plan,review,implement}{,-aura}-v2/references/quality-<id>.md` at each cite-site; sha256 == canonical at commit time (C11 + C12 gates).

## Section structure templates

### Append-existing (dahl, ritchie, hashimoto)
Insert at end of canonical file, below all existing §A/§B/etc. sections:

```markdown
## §Z External-source enrichment

Sources:
- <URL from dump>
- <URL from dump>

### Additional principles
- <Concept paraphrased into one declarative sentence with rationale>

### Tone characteristics
<Paraphrased tone descriptors, one paragraph>

### Anti-patterns to detect
- <Declarative anti-pattern>
```

### Seed-new-file (11 experts)
New file structure (B2 canonical at `_council-experts-v2/<id>/references/quality-<id>.md`):

```markdown
<!-- canonical-source: _council-experts-v2/<id>/references/quality-<id>.md -->

# quality-<id>.md — <Expert Display Name>

<One-paragraph intro: domain + seed context for the <id> subagent>

## §A <Primary topic from dump concepts cluster 1>

Sources: …

### Principles
- …

### Tone characteristics
…

### Anti-patterns to detect
- …

## §B <Secondary topic from dump concepts cluster 2>
[same shape; additional §C/§D as concepts warrant]
```

Each seed-new file has ≥1 `## §A …` structural anchor registered in `_phase2-coverage-tokens.yml` under `targets.<id>.structural_anchors`. Concrete §A/§B topic splits proposed at `/council-plan-aura-v2` stage from each dump's concepts list.

## License / attribution policy

- **URLs** = source pointers, cited verbatim in "Sources:" header — not copyrighted content.
- **Concepts** = paraphrased into our own declarative sentences; no verbatim block quotes.
- **Tone characteristics** = paraphrased from dump's tone-axis list; treated as our synthesis.
- **Verbatim threshold:** any contiguous external-text block >50 characters requires explicit MIT/CC-BY/equivalent attribution inline. Default policy: no verbatim >50 chars; paraphrase always.
- **Per-file attribution:** the `Sources:` URL list per section is the attribution mechanism; no additional license headers required.

## Stories

### Story 1: Writer commits one expert enrichment atomically

**When** implementing a Phase 3α NN commit, **I want to** touch only the canonical `quality-<id>.md` plus `_phase2-coverage-tokens.yml` plus `_ref-mirrors.lock` plus regenerated mirror files for ONE expert, **so I can** keep blast radius small and gated by deterministic canaries.

**Acceptance criteria:**

Given a clean working tree with verify-catalog C1-C12 + cp-mirrors --check green
When the writer commits a single expert per the strategy table
Then `verify-catalog.sh` exits 0 with C1-C12 green AND `cp-mirrors.sh --check` exits 0

Given a seed-new-file commit
When the writer adds the new canonical
Then the commit also adds (a) a `_ref-mirrors.lock` entry with canonical path + sha256 + mirror paths, (b) the mirrors materialized via `cp-mirrors --apply`, (c) ≥1 new entry under `targets.<id>` in `_phase2-coverage-tokens.yml` including ≥1 `structural_anchors`

Given a commit that stages files from two distinct `_council-experts-v2/<id>/` dirs
When the writer attempts the commit
Then it is rejected as atomic-per-expert violation (EC-31)

Given a seed-new-file commit that touches v1 catalog (`_council-experts/`)
When the writer stages files outside `_council-experts-v2/` or dispatcher dirs
Then the commit is rejected as out-of-scope drift (v1 read-only per Phase 0/1 isolation)

### Story 2: Validator verifies the commit before next starts

**When** the writer pauses after a Phase 3α NN commit and writes `/tmp/phase-3-α-NN-validator-brief.md`, **I want to** run the brief's verify commands and PASS/FAIL deterministically, **so I can** unblock the next commit or block on a real defect.

**Acceptance criteria:**

Given a brief claiming N new tokens added to `_phase2-coverage-tokens.yml`
When the validator runs `grep -F` for each claimed token against the canonical
Then each token appears ≥1 time (C10 ground truth)

Given a brief claiming canonical sha256 = X
When the validator runs `sha256sum` on the canonical and reads `_ref-mirrors.lock`
Then both digests equal X

Given a brief claiming N tokens registered but one doesn't grep-match
When the validator counts non-matching tokens
Then count > 0 → FAIL with the offending token + expected path

Given a brief claiming "v1 catalog untouched"
When the validator runs `md5sum` against the pre-Phase-3 v1 baseline list
Then all v1 file digests are unchanged

### Story 3: Phase 3α closes with HANDOFF capturing 14 commit SHAs

**When** the 14th commit lands and validator PASSes, **I want to** write `HANDOFF-phase-3-α-CLOSURE.md` per EC-32, **so I can** hand off to Phase 3β/γ planning with attributed commit list and closure state.

**Acceptance criteria:**

Given 14 PASSed Phase 3α NN briefs
When the writer authors the closure HANDOFF
Then the HANDOFF lists all 14 commit SHAs with strategy (append-existing vs seed-new-file), skills-repo HEAD, aura-companion HEAD, verify-catalog summary

Given a Phase 3α commit that touched a topic-named ref (e.g., `quality-a11y.md`)
When the closure HANDOFF is being written
Then this is flagged as out-of-scope drift; raise to user before HANDOFF commit

## Boundaries

### ✅ Always
- Append §Z UNDER existing §A/§B/etc. for dahl/ritchie/hashimoto; never rewrite or reorder existing content
- Seed-new files include `<!-- canonical-source: ... -->` HTML marker matching `_ref-mirrors.lock` lineage convention
- Update `_phase2-coverage-tokens.yml` with new tokens in the SAME commit as the file edit/create
- Update `_ref-mirrors.lock` (sha256 bump for append; new entry for seed-new) in the SAME commit
- Run `cp-mirrors --apply` then `cp-mirrors --check` BEFORE commit
- Run `verify-catalog.sh` and confirm C1-C12 green BEFORE commit
- Cite source URLs in the appended/authored section's "Sources:" header
- Write per-commit validator brief; PAUSE for `/tmp/phase-3-α-NN-validator-report.md` PASS before next commit (EC-31)

### ⚠️ Ask first
- Adding a novel `structural_anchors` topic string to coverage manifest (cross-stack semantic surface change)
- Splitting Phase 3α into sub-phases (3α₁ append + 3α₂ seed) if EC-30 token budget probe at council-plan-aura-v2 stage indicates risk
- Reordering experts away from: 3 append-existing → 4 domain-neutral → 4 UI → 3 language/platform
- Diverging from B2 canonical-path policy for any of the 11 seed-new (e.g., putting fowler's canonical in a dispatcher dir)

### 🚫 Never
- Rewrite or remove existing §A/§B sections in dahl/ritchie/hashimoto canonicals
- Use verbatim quoted blocks >50 chars from external sources without explicit attribution
- Edit a mirror file directly — canonical-only; mirrors derived via `cp-mirrors --apply`
- Bundle two experts into one commit (atomic-per-expert non-negotiable per EC-31)
- Skip the validator PAUSE between commits (content-quality commits not covered by canary suite must serialise per EC-31)
- Add tokens to `_phase2-coverage-tokens.yml` that don't grep-match the file (C10 ground-truth contract)
- Touch v1 catalog (`_council-experts/`) — read-only per Phase 0/1 isolation pattern
- Touch v1 topic-named refs (`quality-a11y.md`, `quality-backend.md`, `quality-ui.md`, etc.) — deferred to Phase 3-C

## Success metrics

- 14 commits land at HEAD with C1-C12 + cp-mirrors --check green on every commit
- Zero validator FAIL across 14 briefs (serial pipeline)
- `_phase2-coverage-tokens.yml` grows by ~70-140 tokens (~5-10 per expert)
- `_ref-mirrors.lock` grows by 11 new canonical entries (with mirror sets); 3 existing entries get sha256 bumps
- Skills-repo HEAD sha advances 14 times; aura-companion `HANDOFF-phase-3-α-CLOSURE.md` committed
- EC-30 token-budget probe at /council-plan-aura-v2 stage: if ≤100k per phase, run 3α single phase; if exceeds, split 3α₁ (3 append) + 3α₂ (11 seed) with intermediate HANDOFF per EC-32

## Section D reconciliation

1. **Which experts get FIRST-PASS enrichment?** All 14. Order: 3 append-existing (dahl, ritchie, hashimoto) → 4 domain-neutral seed-new (fowler, beck, hunt, willison) → 4 UI seed-new (saarinen, friedman, watson, abramov) → 3 language/platform seed-new (brandur, durov, vanrossum).
2. **License/attribution policy?** See "License / attribution policy" section: URLs as pointers, paraphrase concepts/tone, verbatim >50 chars → explicit attribution.
3. **Per-language vs domain-neutral?** Same mechanical structure for both; topic strings differ but template is uniform.
4. **Append-only vs full rewrite?** Append-only for 3 existing files (`## §Z` added below all `## §A/§B`); seed-new-file for 11 (no preceding content exists — NOT a rewrite).
5. **C10 integration?** New tokens under `targets.<id>.tokens` with `source: external-enrichment`. Token grep-text must literally appear in the file. Seed-new files MUST also add ≥1 `structural_anchors` entry.

## Assumptions

- (confirmed) 3/11 strategy split: append-existing for dahl/ritchie/hashimoto, seed-new-file for the other 11
- (confirmed) `## §Z External-source enrichment` header for append-existing
- (confirmed) New canonicals registered in `_ref-mirrors.lock` with B2 mirror set
- (confirmed) v1 topic-named refs left as-is; Phase 3-C housekeeping
- (confirmed) Per-commit validator brief; serialised PASS per EC-31
- (unconfirmed) Mirror cite-site enumeration per expert deferred to `/council-plan-aura-v2`
- (unconfirmed) Phase 3α single-phase vs 3α₁/3α₂ split decided by EC-30 budget probe at council-plan stage

---

*After implementing, compare results against each acceptance criterion above and list any unmet requirements.*
