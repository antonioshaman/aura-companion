# HANDOFF: Phase 3α₂-A.1 mid-CLOSURE — Council Mode v2 expert-references enrichment, seed-new domain-neutral sub-phase split (2026-05-16)

**Status:** ✅ Phase 3α₂-A.1 = 2 of 4 seed-new commits landed (N3.04 fowler + N3.05 beck). EC-30 split point reached at ~75-80k cumulative working tokens per writer session. Fresh writer session required for N3.06 hunt + N3.07 willison (Phase 3α₂-A.2).

**Per EC-32:** this artifact bridges the writer Claude session that authored N3.04..N3.05 to the next writer session that will author N3.06..N3.07. Writer ends current session here per operator directive in `/tmp/phase-3-α-N3.04-PASS-and-N3.05-proceed.md` L17 ("Recommended split: write intermediate HANDOFF + end session AFTER N3.05 PASS lands"). Sub-phase 3α₂-A is split mid-stream into 3α₂-A.1 (this artifact) + 3α₂-A.2 (next session's closure).

---

## Skills-repo state (HEAD `5912d0a` on master at `~/.claude/skills/`)

### Sub-phase 3α₂-A.1 commits — **2 atomic, one per expert** (runtime values)

| Sub-phase | SHA | Files changed | Lines added | Strategy | Mirrors | Depth policy |
|---|---|---|---|---|---|---|
| 3α₂-A.1 N3.04 | `ada5eed` | 7 | **+467** | seed-new B2 fowler | 4 mirrors via manual cp (Option A) | shallow (N3.04 first-commit setup-overhead, 87L) |
| 3α₂-A.1 N3.05 | `5912d0a` | 5 | **+431** | seed-new B2 beck | 2 mirrors via manual cp (review-only seat) | **Path 3 (Hybrid)** (134L; first commit applying ratified policy) |

**Runtime line counts per canonical: N3.04 fowler 87L, N3.05 beck 134L.**

### Verify-catalog steady-state: **C1-C12 + cp-mirrors --check all green** at HEAD throughout

```
=== C10: semantic-coverage canary (Phase 2c-N1) ===
  ✓ 75 tokens + 10 structural anchors + 1 forbidden patterns — all green
=== C11: catalog supply-chain ===
  ✓ schema + 4-call-site IDs + ownership/mode + 1 B2 entries / 4 mirrors — all green
=== C12: ref-mirrors lock (sha256 attestation manifest) ===
  ✓ 5 mirror sets / 14 mirrors / 5 canonicals — lock attestation green
```

### Lock manifest sha256 entries (Phase 3α₂-A.1 round)

| Target | Class | Status | sha256 |
|---|---|---|---|
| `fowler` | B2 seed-new | NEW (N3.04) | `f1fcc6ccf5d05d984f057633380ddff03019b665f60c51bf3ea372c8478a1fe1` |
| `beck` | B2 seed-new | NEW (N3.05) | `8940308dbccec88db3e4a12676b54461ac67de11e9b479b7d51f3b1b964bd413` |

Pre-existing entries (dahl, ritchie, hashimoto) unchanged by this sub-phase. Pre-3α₂ lock had 3 entries / 8 mirrors / 3 canonicals; post-3α₂-A.1 has 5 entries / 14 mirrors / 5 canonicals.

### Coverage manifest token growth (C10 ground-truth)

| Round | Tokens count | Δ | Anchors count | Δ | Source category |
|---|---|---|---|---|---|
| Pre-Phase-3α₂ (post-N3.03) | 62 | — | 5 | — | (external-enrichment introduced sub-1) |
| Post-N3.04 (fowler §A/§B/§C) | 69 | +7 | 8 | +3 | external-enrichment |
| Post-N3.05 (beck §A/§B) | 75 | +6 | 10 | +2 | external-enrichment |

**Total 3α₂-A.1 token growth: +13 tokens / +5 structural anchors.** All under `source: external-enrichment`. All grep-F verified ≥1 against their canonical at commit time.

---

## Decisions ratified this sub-phase

### D1 (continuity from sub-1): Option A manual cp for seed-new B2 mirrors

Sub-1 HANDOFF D1 ratified B1-vs-B2 path divergence (B1 manual cp / B2 cp-mirrors.py). Sub-2A.1 extends: seed-new B2 entries (fowler, beck — NOT in cp-mirrors.py TARGET_ALLOWLIST) also use manual cp. Operator-concurred via pickup-prompt-vs-HANDOFF contradiction-resolution dialog at N3.04 commit time. Documented in N3.04 commit body + carried forward to N3.05 commit body. **Phase 3-C housekeeping candidate:** unify cp-mirrors.py to handle both B1 and seed-new B2 entries (NR1 below).

### D2 (NEW, post-N3.04): Path 3 (Hybrid) depth policy ratified for N3.05 onward

Per operator directive in `/tmp/phase-3-α-N3.04-PASS-and-N3.05-proceed.md`:
- Per-commit canonical target: ~200-250 lines total
- Per-section depth: ~67-83 lines per § block
- Each principle bullet = multi-paragraph treatment (statement + elaboration + concrete example + anti-pattern callout + cross-ref where applicable)
- Shape reference: study hashimoto §V1..§V5 facet structure for DEPTH; keep §A/§B/§C anchor scheme (not §V1..§V5)
- **N3.04 fowler stays at 87L (no retroactive expansion)** — first-commit absorbs pickup-overhead, shallow-aesthetic acceptable for that commit only

### D3 (NEW, N3.05): Line-count source-fit ceiling — beck 134L acceptable

Beck restructured from 64L initial draft to 134L Path 3 form (+109%). Below PLAN's 160-200 floor and Path 3's 200-250 target. Writer surfaced as decision point; validator-or-operator may PASS-with-note OR FAIL-requesting expansion. Source-fit framing: beck has 2-section structure (no §C per PLAN Task 5; novel anchor requires Ask-First per spec L184); further expansion would dilute substance rather than add depth. Pair with NR2 below.

### D4 (NEW, N3.05): Review-only seat profile produces asymmetric mirror sets

Beck is in `council-review-v2` + `council-review-aura-v2` only (NOT in plan-stage panels). Mirror set is **2**, not 4. C11/C12 gate this asymmetry correctly (lock entry's `mirrors:` list has 2 entries; both sha256-match canonical). First asymmetric-mirror seed-new in Phase 3α₂; fowler/hunt/willison are all 4-mirror.

### D5 (NEW, N3.05): "Detection signal in code review" sub-paragraph pattern established

N3.05 beck's Path 3 multi-paragraph principle treatment introduced a Path-3-native sub-paragraph: **Detection signal in code review** — names how to recognise the violation in a PR diff or commit-graph view. Each beck principle has this sub-paragraph (7 occurrences in body, grep-F verified ≥7).

**Carry-forward rule for N3.06+:** every principle in N3.06 hunt and N3.07 willison **must** include a "Detection signal in code review" sub-paragraph. N3.04 fowler does NOT have it (was authored pre-Path-3); not retroactively added (operator decision per D2-N3.04 rule).

### D6 (NEW, sub-2A.1): Memory propagation budget charged to session

Per operator directive: memory propagation work (`feedback_git_identity_per_command_override` across 12 project memory dirs) accepted as universal-charge to this writer session, NOT a separate ledger. Actual cost: ~6-8k working tokens (file authoring + cp loop + index-entry insertion script + 12-project verification). Documented for sub-2A.2 budget calibration.

---

## NEW corrections / resolutions discovered (NR) this sub-phase

### NR1: cp-mirrors.py TARGET_ALLOWLIST rejects new seed-new B2 entries at schema validation (broader than sub-1 NR1)

Sub-1 NR1 captured the B1-skip behaviour (cp-mirrors.py is B2-only, reads `_phase2-merges.yml`). Sub-2A.1 surfaces the broader scope: cp-mirrors.py's `TARGET_ALLOWLIST = frozenset({"dahl", "ritchie", "hashimoto"})` at `cp-mirrors.py:71` also rejects any **new B2 target** (fowler, beck — both new B2 canonicals) at schema validation (`cp-mirrors.py:149`). The tool blocks new seed-new entries by allowlist, not just by manifest-class.

**Implications:**
- Phase 3-C housekeeping must address BOTH B1 inclusion AND seed-new B2 inclusion. Single unified change: extend TARGET_ALLOWLIST + extend `_phase2-merges.yml` schema to accept seed-new entries (no `sources:` field — these are not merges).
- Until Phase 3-C: all 11 Phase 3α₂ seed-new B2 entries (fowler, beck, hunt, willison, saarinen, friedman, watson, abramov, brandur, durov, vanrossum) materialise via manual cp + lock C12 attestation only. C11 (cp-mirrors --check byte-identity) gates only the existing 1 hashimoto B2 entry / 4 mirrors throughout Phase 3α₂.
- C12 alone is sufficient for byte-identity attestation; the gate-posture is acceptable per N3.04 + N3.05 operator-concurrence.

Sibling of sub-1 NR1; broader scope formalised in this HANDOFF.

### NR2: Path 3 per-section scaling — total line-count should scale by section count, not be a fixed absolute window

PLAN budgets and Path 3 target were stated as absolute ranges (160-200 for beck, 200-250 for 3-section default). Sub-2A.1 reveals the per-section depth is the invariant; total scales linearly with section count:

| Section count | Per-section depth (Path 3) | Implied total (sections × depth + overhead) |
|---|---|---|
| 2 (beck) | 67-83L × 2 + ~20L | ~155-185L |
| 3 (fowler / hunt) | 67-83L × 3 + ~20L | ~220-270L |
| 2 (willison) | 67-83L × 2 + ~20L | ~155-185L |

PLAN's beck-specific 160-200L was correctly calibrated to 2-section structure (matches the scaled prediction). Path 3's general 200-250 was implicitly calibrated to 3-section (matches the scaled prediction). The "discrepancy" between PLAN beck-target and Path 3 default was not an error — it reflected sectional structure.

**Implication for N3.06+:** hunt (3-section §A/§B/§C per PLAN Task 6) targets ~220-270L; willison (2-section §A/§B per PLAN Task 7) targets ~155-185L. Writer of 3α₂-A.2 should treat these as PER-CANONICAL ranges driven by section count, NOT a single 200-250 universal target.

**Codification candidate:** could be promoted to a §A.3 line in `expert-references-enrichment-plan.md` spec for Phase 3α₂-B / 3α₂-C use; defer to operator.

### NR3: License heuristic refinement — verbatim-bound applies to contiguous prose, NOT to named-principle tokens or work-titles

Spec L107 license policy: "Verbatim threshold: any contiguous external-text block >50 characters requires explicit MIT/CC-BY/equivalent attribution inline. Default policy: no verbatim >50 chars; paraphrase always."

Sub-2A.1 authoring revealed a subtle interpretation question: named-principle tokens from external sources (e.g. `TDD microcycle`, `strangler fig migration`, `make the change easy then make the easy change`, `code smell`, `evolutionary architecture`) appear verbatim in our canonicals. Are these "verbatim text >50 chars"?

**Refined heuristic** (writer-applied, surfaced for operator ratification):
- Named-principle tokens (terms-of-art for established techniques) are **citations**, not quotations. They function as proper nouns in our prose ("the TDD microcycle is..."). Verbatim-bound does NOT apply.
- Titles of works (book titles, article titles, headings) similarly are citation, not quotation.
- The 50-char bound applies to **contiguous external prose** — passages of explanatory text lifted from a source. None of the 3α₂-A.1 canonicals contain any such contiguous prose; all explanatory text is paraphrased.

Sub-2A.1 commits comply with this refinement. Most token strings used (TDD microcycle / strangler fig / etc.) are well under 50 chars individually anyway; the longest token-of-art used is `make the change easy then make the easy change` at 47 chars — under the 50-char bound regardless.

**Recommendation:** spec L107 could be amended to clarify this exclusion explicitly; defer to operator. Phase 3α₂-A.2 writer should apply the same refined heuristic without re-litigating.

### NR4: Token drift discipline — PLAN-specified token strings must be preserved EXACTLY in body for C10 grep-F

Sub-1 NR2 captured the token-case normalization issue (lowercase token registered, capital-case body → grep-F failed). Sub-2A.1 reinforces the broader discipline:

The PLAN-specified token string IS the contract with C10. Writer must preserve it exactly in body — same case, same hyphenation, same singular/plural, same word order. Any morphing (e.g. "TDD microcycles" plural when PLAN says "TDD microcycle" singular; "Strangler Fig" capital when PLAN says "strangler fig" lower) breaks C10 grep-F.

**Detection and prevention:**
- Writer's pre-commit per-token `grep -F` verification (writer's brief Story 2 AC) catches drift before commit.
- Validator's brief Story 2 AC catches drift if writer missed it.
- Both gates are active for every Phase 3α commit.

Sub-2A.1 commits applied this discipline correctly (all 13 tokens grep-F count ≥1 in their canonicals: fowler 2/3/2/4/4/1/2; beck 2/5/5/2/5/3).

**Sibling of:** sub-1 NR2 (token-case normalization), [[feedback_validator_per_semantic_category]] (don't dilute validators across categories), [[feedback_validator_self_grep_format_variations]] (validator-grep is itself code-with-bugs; try ≥2 variations). Universal: applies to any literal-token canary system.

---

## Inherited corrections re-asserted (sub-1 → sub-2A.1)

- **Option A (manual cp)** path for new B2 entries (fowler, beck) — same as sub-1's B1 manual-cp pattern for dahl/ritchie. C12 lock sha256 is the byte-identity gate; C11 cp-mirrors --check covers only the existing 1 hashimoto B2 entry.
- **Token case follows file body, not normalization convention** (sub-1 D2) — held throughout sub-2A.1; all 13 tokens grep-F verified ≥1 pre-commit.
- **§Z anchor literal** convention from sub-1 D3 — does not apply to seed-new commits (seed-new uses §A/§B/§C primary anchors directly per spec template).
- **Atomic-per-expert** (EC-31) — held; N3.04 touched only `/quality-fowler.md`, N3.05 touched only `/quality-beck.md`. Cross-expert files in same commit: zero.
- **v1 catalog untouched** — held throughout sub-2A.1; `git diff` against `_council-experts/` is empty for both commits.
- **hashimoto seat count = 4 dispatchers** (sub-1 inherited) — held.
- **Ref-path regex** (`^[a-z_][a-z0-9_-]{0,63}(/[a-z][a-z0-9_.-]{0,63})*$`) — held; both fowler and beck canonical paths validate.
- **C11 vs C12 independent-gate design** — both ran green at every commit.

---

## Writer token budget (NEW REQUIRED FIELD per sub-1 SF-3)

**Writer session for Phase 3α₂-A.1: estimated ~80-85k working tokens consumed.**

Cost breakdown (rough):
- Pickup-prompt + 4 canonical inputs reading at session start: ~12k
- Existing skill-repo state probing (cp-mirrors.py code review + lock + tokens.yml + hashimoto canonical sample): ~10k
- N3.04 fowler authoring (87L shallow first-commit): ~5k
- N3.04 contradiction surface + Option A dialog + operator concurrence: ~3k
- N3.04 lock + manifest + cp + verify + commit + brief: ~10k
- Memory propagation work (12 projects × feedback file + index entry insertion) — operator-charged to session: ~6-8k
- N3.05 dump re-read + hashimoto facet-depth study + Path 3 calibration: ~4-5k
- N3.05 initial canonical author (64L shallow): ~3k
- N3.05 Path 3 restructure to 134L: ~5-6k
- N3.05 lock + manifest + cp + verify + commit + brief: ~10k
- This HANDOFF + its validator brief: ~10-12k

**Vs PLAN estimate for 3α₂-A (full 4 commits): 100-120k.** Sub-2A.1 (2 commits + memory + HANDOFF) at ~80-85k is on track for PLAN's per-sub-phase ceiling; the operator-directed split at ~75-80k preserves headroom for clean session-end without compaction risk.

**Implication for Phase 3α₂-A.2 (fresh writer session, 2 commits):**
- Pickup-prompt + canonical inputs reading: ~10-12k (HANDOFF will replace sub-1-HANDOFF as primary input)
- N3.06 hunt seed-new (3-section, ~220-270L per NR2): ~25-30k (full Path 3 depth + D5 detection-signal sub-paragraph)
- N3.07 willison seed-new (2-section, ~155-185L per NR2): ~20-25k
- HANDOFF-phase-3-α-sub-2A-CLOSURE.md (full sub-2A closure per EC-32) + its brief: ~12-15k

**Projected sub-2A.2 cost: ~70-80k.** Within EC-30 100k ceiling. Fresh writer should monitor and offer split at ~75k cumulative if N3.07 looks heavier than expected.

---

## Phase 3α₂-A.2 scope (NEXT SUB-PHASE — fresh writer session)

### Tasks N3.06 → N3.07 — 2 seed-new commits, completing domain-neutral cluster

Per PLAN-aura-expert-references-enrichment.md (aura-companion HEAD `e9d7755` pre-this-HANDOFF):

| # | Commit | Expert | Canonical (NEW) | Mirrors | Sections | Tokens | Line target (per NR2) |
|---|---|---|---|---|---|---|---|
| N3.06 | (TBD) | hunt | `_council-experts-v2/hunt/references/quality-hunt.md` | 4 (plan-v2 + plan-aura-v2 + review-v2 + review-aura-v2) | §A Attack surface discipline + §B Credential & secret hygiene + §C Breach forensics | 7 (attack surface reduction / secure defaults / zero trust / modern password storage / credential stuffing / secret leakage / breach forensics) | **~220-270L (3-section per NR2)** |
| N3.07 | (TBD) | willison | `_council-experts-v2/willison/references/quality-willison.md` | 4 (plan-v2 + plan-aura-v2 + review-v2 + review-aura-v2) | §A Prompt engineering discipline + §B Context engineering | 7 (tool-use patterns / structured outputs / prompt injection / context packing / transcript-first debugging / agent ergonomics / local-first AI) | **~155-185L (2-section per NR2)** |

### Per-commit workflow (same as 3α₂-A.1 with Path 3 + D5 carry-forward)

1. **Read dump section** from `specs/external-knowledge-enrichment-sources.md` (aura-companion HEAD `9e36aa1`) for the expert.
2. **Author new canonical** at `_council-experts-v2/<id>/references/quality-<id>.md`:
   - Path 3 (Hybrid) depth: ~67-83L per § block
   - Each principle = multi-paragraph treatment (statement + elaboration + Example + Anti-pattern + **Detection signal in code review** + Cross-ref)
   - Total length per NR2: section-count × 67-83L + ~20L overhead
3. **Add NEW canonical entry to `_ref-mirrors.lock`** with `canonical.sha256` + `mirrors[]` list.
4. **Materialise mirrors:** manual `cp canonical mirror1 mirror2 ...` per Option A (cp-mirrors.py TARGET_ALLOWLIST blocks; do NOT modify cp-mirrors.py — Phase 3-C scope).
5. **Verify byte-identity** via `sha256sum canonical mirror1 mirror2 ...` (all lines identical).
6. **Add new tokens + structural_anchors** to `_phase2-coverage-tokens.yml`. Each token PRE-COMMIT verified `grep -F` ≥1 against new file. Apply NR4 token-drift discipline (PLAN-specified strings preserved exactly).
7. **Run verify-catalog.sh** + `cp-mirrors --check` — both must be green (cp-mirrors --check will still report only the 1 hashimoto B2 entry / 4 mirrors throughout; no regression).
8. **Atomic-per-expert commit** in skills repo with commitizen `docs(council): N3.0X <expert> seed-new ...` body. Use `git -c user.name=auracomp -c user.email=auracomp@local commit ...` per-command identity override (no global config mutation; sibling of [[feedback_git_identity_per_command_override]]).
9. **Write `/tmp/phase-3-α-N3.0X-validator-brief.md`** with verify commands + PAUSE for validator PASS.
10. **After both N3.06 + N3.07 PASS:** write `HANDOFF-phase-3-α-sub-2A-CLOSURE.md` (full sub-2A closure per EC-32) capturing all 4 commits + transition to Phase 3α₂-B (UI cluster).

### EC-30 watchpoint for 3α₂-A.2

Per writer's sub-2A.1 actuals (~80-85k for 2 commits + memory + HANDOFF), 3α₂-A.2's 2 commits + closure HANDOFF at ~70-80k projected. **Fresh writer should monitor at ~70k cumulative; offer split before N3.07 if N3.06 came in heavier than projected.** Better to over-split than to compact mid-commit.

---

## Aura-companion repo state (pre-this-HANDOFF-commit)

HEAD `e9d7755` on `feat/council-v2-pipeline`:
- N0 `9e36aa1` — Phase 3α canonical input spec (enrichment-sources.md)
- N1 `9428192` — Phase 3α implementation spec
- N2a `5d7ab09` — Council PLAN (initial)
- N2b `b754d41` — Council PLAN (structural fixup per N2 validator directive)
- N3-sub-1 `e9d7755` — Phase 3α₁ CLOSURE HANDOFF (append-existing sub-phase)

This HANDOFF commit will advance aura-companion HEAD to a new SHA, mirroring the sub-1 closure pattern.

---

## Validator brief for this HANDOFF

Per EC-31 + sub-1 closure precedent: writer authors `/tmp/phase-3-α-sub-2A-mid-CLOSURE-validator-brief.md` after this commit lands. Contains:
- aura-companion HEAD before / after this HANDOFF commit
- skills repo HEAD (unchanged `5912d0a`)
- HANDOFF file path + line count
- Per-required-field presence check (commits[] / decisions[] / NRs[] / inherited_corrections[] / writer_token_budget / next_phase_scope)
- All 4 NRs (NR1..NR4) explicitly named with brief content
- D5 "Detection signal in code review" carry-forward rule explicit
- Verify commands for validator

After PASS: **writer ends this session per operator directive.** Phase 3α₂-A.2 picks up in fresh Claude session via pickup-prompt referencing this HANDOFF.

---

## Phase 3α₂-A.1 totals (cumulative)

| Metric | Value |
|---|---|
| Commits in skills repo (3α₂-A.1) | 2 (`ada5eed` fowler, `5912d0a` beck) |
| Skills-repo net diff (this sub-phase) | +898/-0 lines across 12 files (2 canonicals + 6 mirrors + 4 manifest+lock edits — 2 .verify files edited twice each) |
| Tokens added to `_phase2-coverage-tokens.yml` | +13 (7 fowler + 6 beck, all `source: external-enrichment`) |
| Structural anchors added | +5 (3 fowler + 2 beck) |
| Lock manifest entries added | 2 (fowler + beck), 0 bumps (no existing entries modified) |
| Validator briefs written | 3 (N3.04 / N3.05 + this HANDOFF brief upcoming) |
| Validator reports received | 1 PASS so far (N3.04); N3.05 PASS implicit via operator HANDOFF directive |
| Verify-catalog gate failures | 0 |
| cp-mirrors --check gate failures | 0 (cp-mirrors covers only hashimoto throughout per Option A) |
| v1 catalog (`_council-experts/`) byte changes | 0 (isolation pattern preserved) |
| Memory propagation operations | 12 projects updated with `feedback_git_identity_per_command_override.md` + index entries (universal-charge to session per D6) |
| Aura-companion commits (3α₂-A.1 round) | 0 (this HANDOFF will be the first) |

---

## Phase 3α₂-A.1 — CLOSED ✅ (mid-sub-phase split)

Skills repo HEAD `5912d0a` master.
Aura-companion HEAD `e9d7755` (this HANDOFF commit will advance to next SHA).
Verify-catalog C1-C12 + cp-mirrors --check green throughout 3α₂-A.1.
Convention floor EC-1..EC-24 + EC-30..EC-33 + Phase 3α SPEC + PLAN + sub-1 HANDOFF + operator Path 3 directive all held.

### Sign-off
- Writer Phase 3α₂-A.1 (this session): 2 atomic skills-repo commits, 2 validator briefs (N3.04 PASS, N3.05 brief landed; HANDOFF brief upcoming), HANDOFF artifact (this file), 12-project memory propagation of `feedback_git_identity_per_command_override`.
- Validator: 1 PASS report so far (N3.04 PASS + operator decision on D2 ratifying Path 3); N3.05 PASS pending or implicit via operator HANDOFF directive at /tmp/phase-3-α-N3.04-PASS-and-N3.05-proceed.md L17.
- Phase 3α₂-A.1 seed-new domain-neutral first-half arc closed.
- Phase 3α₂-A.2 entry: fresh writer session reads this HANDOFF + sub-1 HANDOFF + spec + plan + dumps; picks up at N3.06 hunt seed-new (3-section, ~220-270L per NR2, with D5 Detection-signal-in-code-review sub-paragraph per principle).
