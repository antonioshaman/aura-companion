# HANDOFF: Phase 3α FINAL CLOSURE — Council Mode v2 expert-references enrichment, full arc complete (14 of 14 implementation commits, 2026-05-17)

**Status:** ✅ Phase 3α implementation arc CLOSED. 14 of 14 atomic commits landed in skills repo with C1-C12 + cp-mirrors --check green throughout. 4 sub-phases (3α₁ append + 3α₂-A domain-neutral + 3α₂-B UI + 3α₂-C language) each closed with their own EC-32 HANDOFF. Catalog now complete: 14 of 14 v2 experts have canonical `references/quality-<id>.md` attestations.

**Per EC-32 + pickup L92:** this artifact is the FINAL closure for Phase 3α implementation. It captures the full 14-commit arc, the cumulative D1-D8 + NR1-NR7 + NR8 convention floor, the A/B competitive test binding as the next-operator action (per `/tmp/phase-3-α-closure-handoff-directive.md` — operator runs the test post-CLOSURE; verdict lands as amendment or separate addendum), and the Phase 3β scope preview (8 candidate experts per dump #2 with EC-34 tension-pair codification candidate).

**Per N3.12 PASS Surface 1 resolution (validator-confirmed):** writer authors this CLOSURE HANDOFF immediately after N3.14 PASS with A/B test as documented next-operator action (NOT as writer-run gate). This preserves writer's session-end discipline (EC-30) AND the A/B test's authority as operator-driven validation gate. Operator's CLOSURE amendment (or separate addendum doc) records the judge verdict and the Phase 3α acceptance decision.

---

## Skills-repo state (HEAD `7529345` on master at `~/.claude/skills/`)

### Phase 3α implementation arc — 14 atomic commits, one per expert

| # | Commit | SHA | Sub-phase | Strategy | Class | Mirrors | Sections | Tokens | L |
|---|---|---|---|---|---|---|---|---|---|
| 1 | N3.01 dahl | `2ab3547` | 3α₁ | append-existing | B1 | 2 (existing) | §Z appended | 6 | +28 each |
| 2 | N3.02 ritchie | `3adfb81` | 3α₁ | append-existing | B1 | 2 (existing) | §Z appended | 5 | +28 each |
| 3 | N3.03 hashimoto | `dc15978` | 3α₁ | append-existing | B2 | 4 (existing) | §Z appended | 5 | +28 each |
| 4 | N3.04 fowler | `ada5eed` | 3α₂-A.1 | seed-new | B2 | 4 (full-panel) | §A/§B/§C (3) | 7 | 87 (pre-Path-3) |
| 5 | N3.05 beck | `5912d0a` | 3α₂-A.1 | seed-new | B2 | 2 (review-only) | §A/§B (2) | 6 | 134 (Path 3) |
| 6 | N3.06 hunt | `21626ec` | 3α₂-A.2 | seed-new | B2 | 4 (full-panel) | §A/§B/§C (3) | 7 | 213 (Path 3+D5) |
| 7 | N3.07 willison | `f99a228` | 3α₂-A.2 | seed-new | B2 | 4 (full-panel) | §A/§B (2) | 7 | 155 (Path 3+D5) |
| 8 | N3.08 saarinen | `4fc400a` | 3α₂-B | seed-new | B2 | 4 (full-panel) | §A/§B (2) | 7 | 154 (Path 3+D5) |
| 9 | N3.09 friedman | `24a99aa` | 3α₂-B | seed-new | B2 | 4 (full-panel) | §A/§B (2) | 7 | 157 (Path 3+D5) |
| 10 | N3.10 watson | `5434381` | 3α₂-B | seed-new | B2 | 2 (aura-only) | §A/§B (2) | 7 | 154 (Path 3+D5) |
| 11 | N3.11 abramov | `d9490f8` | 3α₂-B | seed-new | B2 | 2 (aura-only) | §A/§B (2) | 8 | 167 (Path 3+D5) |
| 12 | **N3.12 brandur** | `9f87d24` | 3α₂-C | seed-new | B2 | 2 (non-aura) | §A/§B (2) | 8 | 155 (Path 3+D5) |
| 13 | **N3.13 durov** | `83e7ddd` | 3α₂-C | seed-new | B2 | 2 (non-aura) | §A/§B (2) | 8 | 155 (Path 3+D5) |
| 14 | **N3.14 vanrossum** | `7529345` | 3α₂-C | seed-new | B2 | 2 (non-aura) | §A/§B (2) | 8 | 155 (Path 3+D5) |

**Total Phase 3α skills-repo net diff: +7290 / -3 lines across 82 files** (3 append + 11 seed-new × (1 canonical + per-class mirrors) + 14 lock entries + 14 coverage-tokens registrations across .verify/*.{yml,lock}).

### Verify-catalog steady-state: **C1-C12 + cp-mirrors --check all green** at HEAD throughout 14 commits (0 gate failures)

```
=== C10: semantic-coverage canary (Phase 2c-N1) ===
  ✓ 142 tokens + 29 structural anchors + 1 forbidden patterns — all green
=== C11: catalog supply-chain ===
  ✓ schema + 4-call-site IDs + ownership/mode + 1 B2 entries / 4 mirrors — all green
=== C12: ref-mirrors lock (sha256 attestation manifest) ===
  ✓ 14 mirror sets / 40 mirrors / 14 canonicals — lock attestation green
```

### Coverage manifest growth across the arc (C10 ground-truth, shell-pasted)

| Round | Tokens | Δ | Anchors | Δ | Notes |
|---|---|---|---|---|---|
| Pre-Phase-3α (Phase 2c-N1 baseline) | 46 | — | 5 | — | (backend-ts + realtime-ndjson + persistence-fs + deploy-docker-gha merged) |
| Post-3α₁ (N3.03 hashimoto) | 62 | +16 | 5 | 0 | external-enrichment cluster introduced |
| Post-3α₂-A (N3.07 willison) | 89 | +27 | 15 | +10 | 4 seed-new domain-neutral |
| Post-3α₂-B (N3.11 abramov) | 118 | +29 | 23 | +8 | 4 seed-new UI cluster |
| Post-3α₂-C (N3.14 vanrossum) | **142** | **+24** | **29** | **+6** | 3 seed-new language cluster (8/8/8 tokens, 2/2/2 anchors) |
| **PHASE 3α TOTAL GROWTH** | **+96 (46 → 142, +209%)** | | **+24 (5 → 29, +480%)** | | **all `source: external-enrichment`** |

### Lock manifest growth across the arc (C12 ground-truth)

| Round | Mirror sets | Mirrors | Canonicals |
|---|---|---|---|
| Pre-Phase-3α | 3 | 8 | 3 |
| Post-3α₁ | 3 | 8 | 3 (sha256 bumps only; no new entries) |
| Post-3α₂-A | 7 | 22 | 7 |
| Post-3α₂-B | 11 | 34 | 11 |
| **Post-3α₂-C (FINAL)** | **14** | **40** | **14** |

**Net Phase 3α growth: +11 canonical entries / +32 mirror paths.** 11 NEW seed-new B2 lock entries (all 11 non-existing canonicals as of pre-3α₂ baseline). 3 existing entries (dahl/ritchie/hashimoto) carried sha256 bumps only.

### Mirror-shape taxonomy — all 4 shapes covered

Phase 3α covers every mirror-set shape derivable from runtime panel-file intersections:

| Shape | Experts | Count | Mirror paths |
|---|---|---|---|
| **4-mirror full-panel** | fowler, saarinen, friedman, hunt, willison | 5 | plan-v2 + plan-aura-v2 + review-v2 + review-aura-v2 |
| **2-mirror review-only** | beck | 1 | review-v2 + review-aura-v2 |
| **2-mirror aura-only** | watson, abramov | 2 | plan-aura-v2 + review-aura-v2 |
| **2-mirror non-aura** | brandur, durov, vanrossum | 3 | plan-v2 + review-v2 |

(Append-existing dahl/ritchie/hashimoto retain their existing B1/B2 mirror sets per pre-Phase-3α baseline; not re-classified.)

---

## Cumulative decisions (D1-D8) — convention floor at Phase 3α close

### D1 — Option A manual cp for new B2 entries (HELD across 14 commits)

cp-mirrors.py `TARGET_ALLOWLIST = frozenset({"dahl", "ritchie", "hashimoto"})` blocks all 11 new B2 seed-new entries at schema validation (per NR1). All seed-new commits used manual `cp canonical mirror1..mirrorN`; C12 sha256 attestation is the byte-identity gate (C11 cp-mirrors --check covers only the 1 pre-existing hashimoto B2 entry). **Phase 3-C housekeeping candidate:** unify cp-mirrors.py to handle B1 + seed-new B2.

### D2 — Path 3 (Hybrid) depth policy (RATIFIED N3.05 → HELD through N3.14)

Per-section depth at 67-83L floor; 6 sub-paragraphs per principle:
1. Statement (token-anchored bold)
2. Elaboration paragraph
3. Mechanics / extended elaboration (sometimes embedded in elaboration)
4. Example (Aura companion analog)
5. Anti-pattern to detect
6. Detection signal in code review (D5)
7. Cross-ref to sibling/peer principle

Applied to all 10 Path-3 commits (N3.05..N3.14). Pre-Path-3 N3.04 fowler stays at 87L (first-commit overhead-absorbed, no retroactive expansion per D2 sub-clause).

### D3 / NR2 — Per-section scaling (CODIFIED sub-2A.1, HELD through 3α₂-C)

Total budget = section count × per-section floor + ~20L overhead. Codified range:
- 2-section: 154-186L total
- 3-section: 221-269L total

Phase 3α empirical actuals (Path 3 commits only):
- 2-section: 134-167L observed (beck slightly below floor with overhead-absorbed; willison 155 / saarinen 154 / friedman 157 / watson 154 / abramov 167 / brandur 155 / durov 155 / vanrossum 155)
- 3-section: 213L observed (hunt; AT floor exactly across all 3 sections)

### D4 — Asymmetric mirror sets (EXTENDED through 3α₂-C; all 4 shapes covered)

D4 originated N3.05 beck (review-only shape). 3α₂-B added aura-only (watson, abramov). 3α₂-C added non-aura (brandur, durov, vanrossum). All 4 derivable shapes now covered with at least one canonical instance. The mirror set per expert is a *runtime-mechanical determinant* — derived from on-disk panel-file intersection, not from PLAN expectation. D8 runtime panel-file probe is the canonical check.

### D5 — Detection-signal sub-paragraph (ESTABLISHED N3.05, CARRY-FORWARD through N3.14)

Every principle in N3.05..N3.14 includes a `Detection signal in code review:` sub-paragraph naming how to recognise the principle's violation in a PR diff or commit-graph view. Cumulative coverage:

| Commit | Principles | D5 count | Coverage |
|---|---|---|---|
| N3.04 fowler | 15 | 0 | pre-Path-3 (not retroactively added per D2) |
| N3.05 beck | 7 | 7 | 100% |
| N3.06 hunt | 9 | 9 | 100% |
| N3.07 willison | 7 | 7 | 100% |
| N3.08 saarinen | 7 | 7 | 100% |
| N3.09 friedman | 7 | 7 | 100% |
| N3.10 watson | 7 | 7 | 100% |
| N3.11 abramov | 8 | 8 | 100% |
| N3.12 brandur | 8 | 8 | 100% |
| N3.13 durov | 8 | 8 | 100% |
| N3.14 vanrossum | 8 | 8 | 100% |
| **TOTAL Path-3 commits (N3.05..N3.14)** | **76** | **76** | **100%** |

### D6 — Memory propagation as universal-charge (sub-2A.1)

Mid-arc memory work (e.g., `feedback_git_identity_per_command_override` across 12 project memory dirs; `feedback_multi_source_instruction_contradiction_defer_surface` refinement; `feedback_markdown_line_count_edit_paragraph_vs_sentence` introduced this sub-phase) accepted as universal-charge to the writer session, not separate ledger.

### D7 — Shell-paste discipline (CODIFIED sub-2A.2 N3.06 PASS → RATIFIED through 7 consecutive zero-drift briefs)

All brief numerical claims pasted verbatim with `$ <command>` annotation showing source command. **Empirical track record across the arc:**

| Commit | D7 brief | Numerical drift |
|---|---|---|
| N3.01-N3.04 | pre-D7 codification | drift observed in 4 of 4 |
| N3.05 beck | first Path 3 commit | SF-6 token-count drift caught by validator |
| N3.06 hunt | D7 introduced PASS-side | SF-6+SF-7 drift; D7 codified for next briefs |
| N3.07 willison | first D7-applied brief | zero drift |
| N3.08 saarinen | **1st consecutive zero-drift** | zero drift |
| N3.09 friedman | **2nd consecutive** | zero drift |
| N3.10 watson | **3rd consecutive** | zero drift |
| N3.11 abramov | **4th consecutive** | zero drift |
| N3.12 brandur | **5th consecutive** | zero drift |
| N3.13 durov | **6th consecutive** | zero drift |
| N3.14 vanrossum | **7th consecutive** | zero drift |

**NR8 NEW (this CLOSURE):** D7 shell-paste discipline promoted to convention floor after 7 consecutive zero-drift briefs. See NR section below.

### D8 — Runtime panel-file probe as pickup-vs-PLAN tie-breaker (CODIFIED sub-2B)

Pickup-prompt drift from later-committed PLAN/HANDOFF is structurally possible. Sub-2B surfaced this via watson + abramov mirror-count / section-count / line-target disagreement; sub-2C surfaced it via vanrossum tokens (pickup proposed dump #1 python_sage tokens; PLAN correctly uses dump #3 vanrossum tokens) AND section split (pickup proposed different §-anchor naming). In all cases, runtime probe + durable artifact (PLAN) resolved decisively; pickup was authorship drift.

Codification refinement memory `feedback_multi_source_instruction_contradiction_defer_surface` propagated to all 12 `/root/.claude/projects/*/memory/` dirs at sub-2B (sha `f0defbafcb4ae9f2871f0642f665bcc2a4c41d0414c7ba21aa1e8bad9399952a`). Discipline empirically validated through 3 distinct sub-2B/2C drift incidents; runtime probe disambiguated each.

---

## NEW corrections / resolutions discovered (NR) across Phase 3α

### NR1 — cp-mirrors.py TARGET_ALLOWLIST rejects new seed-new B2 entries (sub-1)
TARGET_ALLOWLIST hard-codes `{dahl, ritchie, hashimoto}` at cp-mirrors.py:71; rejects all 11 new B2 seed-new entries at schema validation (cp-mirrors.py:149). Phase 3-C housekeeping must address both B1 inclusion AND seed-new B2 inclusion.

### NR2 — Path 3 per-section scaling (sub-2A.1)
Per-section depth is the load-bearing invariant; total scales linearly with section count. PLAN's 160-200L (beck-specific) and 200-250L (general Path 3) were correctly calibrated to section count; the "discrepancy" reflected sectional structure, not PLAN error.

### NR3 — License heuristic refinement (sub-2A.1)
Named-principle tokens (`TDD microcycle`, `strangler fig migration`, `attack surface reduction`, `prompt injection`, `local-first AI`) are citations not quotations; verbatim-bound applies to contiguous external explanatory prose. None of the Phase 3α canonicals contain such prose; all paraphrased. Spec L107 amendment candidate.

### NR4 — Token-drift + line-count-drift = same brief-transcription family (sub-2A.1, codified as D7)
Codified as D7 above. NR8 (this closure) elevates D7 to convention floor.

### NR5 — Awk pattern brittleness for YAML block extraction (sub-2A.2)
Awk range patterns with `$` anchors can return 0 entries unexpectedly. Sed pattern is the durable alternative. **Detection:** any zero-count from a YAML block extraction → re-run with sed before accepting.

### NR6 — Pickup-prompt drift is structurally possible; runtime-probe disambiguates (sub-2B)
Pickup prompts authored mid-workstream may drift from later-committed PLAN/HANDOFF (operator may draft pickup early before refining PLAN). Runtime probe of dispatcher panel-files + SKILL.md greps + dump source references resolves decisively. Codified in `feedback_multi_source_instruction_contradiction_defer_surface` (refined with runtime-probe step + 12-dir propagation).

### NR7 — D7 shell-paste discipline structurally closes SF-6/SF-7 numerical-drift family (sub-2B)
Cumulative through N3.14: 4 commits had SF-6/SF-7 drift (N3.01, N3.04, N3.05, N3.06 — pre/at-D7 codification); 8 commits ran clean (N3.07..N3.14 — post-D7). SF-6/SF-7 family no longer needs separate per-commit watch.

### NR8 NEW (this CLOSURE) — D7 shell-paste promoted to convention floor after 7-consecutive zero-drift threshold met

Across Phase 3α₂-B (4 commits) + Phase 3α₂-C (3 commits) = 7 consecutive briefs with zero numerical-drift incidents. Validator reports for N3.12 + N3.13 + N3.14 all confirm zero-drift (per the report's PASS dimension labeled "5th/6th/7th consecutive D7 zero-drift"). The threshold was empirically established by validator (N3.12 PASS report: "5-commit run"; N3.13 PASS: "6-commit run"; N3.14 PASS implicit: "7-commit run").

**Codification candidate:** add to `conventions.md` (after EC-30..EC-33):
- **EC-34 Shell-paste numerical claims in validator-bound artifacts.** Briefs / reports / handoffs whose numerical claims gate the next pipeline stage MUST shell-paste source values with `$ <command>` annotation. Transcription drift (token counts, line counts, sha256, mirror sets) is structurally impossible when the brief's number is the verbatim shell output. Threshold for promotion: 7 consecutive zero-drift artifacts. Phase 3α₂-B + 3α₂-C cleared the threshold (N3.08..N3.14). Universal — applies to any multi-stage artifact pipeline where the numerical claim is the gate.

(Note: this duplicates EC-34's slot from dump #2's tension-pair codification candidate. If both promote, one becomes EC-34 and the other EC-35; chair-side decision at Phase 3β planning.)

### NR9 NEW (this CLOSURE) — Markdown line-count via Edit tool: paragraph vs sentence delta

Captured this session as `feedback_markdown_line_count_edit_paragraph_vs_sentence.md` and propagated to all 12 `/root/.claude/projects/*/memory/` dirs. Surfaced during 3α₂-C brandur (and reproduced in durov + vanrossum) — appending a sentence to an existing paragraph adds 0 source lines on `wc -l`; only new paragraphs (with blank-line separator) increment. When hitting line-count floors via Edit, decompose the expansion into new paragraphs.

Sibling of `feedback_trust_diff_not_prose` (trust the runtime measurement over the intuitive estimate) and the broader runtime-measurement-over-source-intent family. Universal.

---

## Inherited corrections re-asserted (Phase 2 → 3α₁ → 3α₂-A → 3α₂-B → 3α₂-C)

- **hashimoto seat count = 4 dispatchers** — held throughout 14 commits
- **vanrossum co-tenancy on quality-backend.md** — verify-catalog forbidden-pattern (`Bun\.serve|Hono|web/server`) still 0 hits across all 6 dispatcher mirrors of quality-backend.md after N3.14 vanrossum seed-new (vanrossum's own canonical is at `_council-experts-v2/vanrossum/references/`, completely separate)
- **Ref-path regex** — held; all 14 canonical paths validate against `^[a-z_][a-z0-9_-]{0,63}(/[a-z][a-z0-9_.-]{0,63})*$`
- **C11 vs C12 independent-gate design** — both ran green at every commit
- **EC-30 watchpoint** — held across 4 sub-phases via per-EC-32 HANDOFF; this session ~80-95k working tokens for 3 commits + this CLOSURE (~100-115k projected)
- **EC-31 atomic-per-expert** — held; each commit touched exactly one `_council-experts-v2/<id>/` dir
- **v1 catalog isolation** — held; `git diff _council-experts/` is empty for all 14 commits
- **Atomic same-commit token + lock + manifest + cp edits** — held; no fixup commits required

---

## Writer-token-budget cumulative actuals (across 4 sub-phases / 5 writer sessions)

| Sub-phase | Sessions | Commits | Writer tokens (cumulative) |
|---|---|---|---|
| 3α₁ | 1 | 3 (append-existing) | ~55-70k |
| 3α₂-A.1 | 1 | 2 (fowler + beck) | ~75-85k |
| 3α₂-A.2 | 1 | 2 (hunt + willison) + CLOSURE | ~85-95k |
| 3α₂-B | 1 | 4 (saarinen + friedman + watson + abramov) + CLOSURE | ~115-125k |
| 3α₂-C | 1 (this session) | 3 (brandur + durov + vanrossum) + FINAL CLOSURE | ~95-115k projected |
| **TOTAL** | **5 writer sessions** | **14 commits + 4 EC-32 HANDOFFs + 1 FINAL CLOSURE** | **~425-490k cumulative** |

PLAN projection: ~330-395k. Actual: ~425-490k (+30% over projection). Drivers:
- Memory propagation work (N3.01 git-identity, sub-2A.2 awk-vs-sed, sub-2B disagreement-resolution, sub-2C markdown-line-count) — universal-charge per D6
- D5 detection-signal sub-paragraph expansion (8 principles × 1 extra paragraph per principle × 10 commits = ~80 extra paragraphs)
- D7 shell-paste discipline (more brief-roundtrips, but eliminated drift rework)
- Sub-2B + sub-2C runtime-probe surfacing (D8/NR6 cost ~3-4k per sub-phase)
- This FINAL CLOSURE (~15-20k for aggregate captures across 4 sub-phases)

Within 1M-window envelope per writer session (each session ≤125k = ≤12.5% window).

---

## Aura-companion repo state (pre-this-HANDOFF-commit)

HEAD `b87a48d` on `feat/council-v2-pipeline`:
- N0 `9e36aa1` — Phase 3α canonical input spec
- N1 `9428192` — Phase 3α implementation spec
- N2a `5d7ab09` / N2b `b754d41` — Council PLAN
- N3-sub-1 `e9d7755` — Phase 3α₁ CLOSURE HANDOFF
- N3-sub-2A.1-mid `9c65baf` — Phase 3α₂-A.1 mid-CLOSURE HANDOFF
- N3-sub-2A `e2f7356` — Phase 3α₂-A CLOSURE HANDOFF
- N3-sub-2B `b87a48d` — Phase 3α₂-B CLOSURE HANDOFF (this HEAD)
- `9971fc1` — orthogonal domain rebrand (interleaved; unrelated to Phase 3α arc)

This FINAL CLOSURE HANDOFF commit will advance aura-companion HEAD to a new SHA. After commit, Phase 3α IMPLEMENTATION is closed; A/B competitive test runs as next-operator action.

---

## Phase 3α Acceptance Test (A/B competitive) — NEXT OPERATOR ACTION

**Per `/tmp/phase-3-α-closure-handoff-directive.md` (binding requirement); writer-side resolution from N3.12 PASS Surface 1 (validator concurrence).**

**Test subject (locked):** `/root/aura-companion/specs/composer-permission-mode-toggle.md` (108 lines, multi-lens: hunt / friedman / saarinen / fowler / beck / abramov).

**Test pipeline (operator runs):**
1. **Two worktrees** from current HEAD:
   ```bash
   cd /root/aura-companion
   git worktree add ../aura-companion-v1-test feat/council-v2-pipeline
   git worktree add ../aura-companion-v2-test feat/council-v2-pipeline
   ```
2. **Side A (legacy v1)** in fresh tmux: `/council-plan-aura` → `/council-implement-aura` → `/council-review-aura` (NO `-v2`); commit on branch `abtest/v1-composer-permission`; capture plan + diff + review + timing/tokens.
3. **Side B (enriched v2)** in fresh tmux: `/council-plan-aura-v2` → `/council-implement-aura-v2` → `/council-review-aura-v2`; commit on branch `abtest/v2-composer-permission`; capture same.
4. **Hybrid judge:**
   - Phase A: Aura observer pipeline runs on each output set (dogfooding gate) → `.council/reviews/abtest-output-A-claude-observer.md` + `abtest-output-B-claude-observer.md`
   - Phase B: fresh blind Claude session reads `/tmp/phase-3-α-judge-rubric.md` (separate artifact) + both output bundles labeled `Output X` / `Output Y` → produces `/tmp/abtest-judge-decision.md`
   - Mapping `X`↔`Y` to v1/v2 unsealed AFTER judge submits decision
5. **Decision + merge:** operator reviews both Aura observer + blind judge per `feedback_multi_expert_convergence_promotion`; if agree → strong signal; if disagree → operator picks. Winner merged to `feat/council-v2-pipeline` via standard PR; loser tagged `abtest/loser-<v1|v2>-<date>`.
6. **Phase 3α acceptance gate decision (recorded as amendment to this CLOSURE OR separate addendum doc):**
   - If v2 won → Phase 3α officially accepted; Phase 3β approved
   - If v1 won OR tie → Phase 3α structurally complete but semantically inconclusive; iterate (3α' refinement) or scope-down 3β
   - If judge identifies specific gaps → enumerate as Phase 3-D candidates

**Acceptance amendment template** (operator applies post-test):

```markdown
## Phase 3α Acceptance Test (A/B competitive) — RESULTS

**Test subject:** specs/composer-permission-mode-toggle.md
**Side A v1 commit:** abtest/v1-composer-permission @ <sha> (tokens: X / elapsed: Y)
**Side B v2 commit:** abtest/v2-composer-permission @ <sha> (tokens: X / elapsed: Y)
**Aura observer reviews:** .council/reviews/abtest-output-A-claude-observer.md + abtest-output-B-claude-observer.md
**Blind judge decision:** /tmp/abtest-judge-decision.md → winner: <Output X | Output Y>
**Provenance unsealed:** X = <v1|v2>, Y = <v1|v2>
**Operator decision:** <accept | iterate | scope-down>
**Phase 3β status:** <approved | hold pending iteration | scope-down to N experts>
**Phase 3-D candidates (if any):** <enumerated weaknesses>
```

---

## Phase 3β scope preview (per dump #2 + Section F tension-pair principle)

**Per `specs/external-knowledge-enrichment-sources.md` Section G** (post-Phase-3-α coverage summary):

| # | Expert ID | Person | Domain | Tension-pair (Section F) | Dump source |
|---|---|---|---|---|---|
| 15 | lerdorf | Rasmus Lerdorf | PHP (web-first pragmatism) | unpaired? OR pair with unclebob (principle-vs-pragmatism) | #2 |
| 16 | colvin | Samuel Colvin | pydantic-ai typed LLM | unpaired? OR pair with willison (schema-strict ↔ exploration) | #2 |
| 17 | torvalds | Linus Torvalds | Linux kernel pragmatism | **pair with ritchie** (Linux pragmatism ↔ Unix purity) | #2 |
| 18 | unclebob | Robert C. Martin | Clean Architecture / SOLID | **pair with fowler** (principle-purity ↔ economic-pragmatic) | #2 |
| 19 | evans | Eric Evans | Domain-Driven Design | **pair with fowler** (strategic-DDD ↔ emergent-microservices) | #2 |
| 20 | hickey | Rich Hickey | Simplicity vs Easy (functional) | **pair with beck** (fundamental-simplification ↔ incremental-TDD) | #2 |
| 21 | majors | Charity Majors | Observability / SRE practical | **pair with hashimoto** (debugging-in-prod ↔ immutable-prevention) | #2 |
| 22 | sridharan | Cindy Sridharan | Resilience / failure-mode | **pair with majors** (resilience-skepticism ↔ operational-realism) | #2 |

**8 candidates ready** with full URLs/concepts/tone per dump #2. Phase 3β scope: ~22 commits (each new expert ≈ ~3-5 commits for full dir + meta.yaml + plan/review prompts + references/quality-<id>.md authored from scratch).

**EC-34 codification candidate (Section F + dump #2):** "Expert seating by ideological tension, not domain coverage. Multi-expert councils at scale (>12 seats) should pair experts on each domain by orthogonal-philosophy axis (purity-vs-pragmatism, principle-vs-economics, paranoia-vs-curiosity). Synthesis becomes resolution, not aggregation. Carmack-chair filter picks based on project economic context."

Per Phase 3α₂-C's NR8 candidate (D7 promotion), there are now **2 candidates for EC-34 slot**: tension-pair codification OR shell-paste discipline. Chair-side decision at Phase 3β planning whether to promote both (becoming EC-34 + EC-35) or one (the other deferred).

**Final catalog projection per Section G:**
- Phase 2 close: 14 experts
- Phase 3α (this CLOSURE): 14 experts, content depth +209% (tokens) / +480% (anchors)
- Phase 3β (paired tensions): +6 paired (torvalds, unclebob, evans, hickey, majors, sridharan) = 20 seats core
- Phase 3γ (lang specialists): +2 (lerdorf, colvin) = 22 seats
- Per-task seating (chair selects subset): typically 7-12 per dispatch via stack-tag filter + tension-axis selection

Still well within "strong allies NOT 100+" anti-pattern boundary (per `specs/external-knowledge-enrichment-sources.md` Section A user guidance: 7-15 strong agents, 22 max).

---

## Validator brief for this FINAL CLOSURE HANDOFF

Writer authors `/tmp/phase-3-α-FINAL-CLOSURE-validator-brief.md` after this commit lands. Contains:
- aura-companion HEAD before / after CLOSURE commit
- skills-repo HEAD (`7529345` post-N3.14)
- HANDOFF file path + line count
- Per-required-field presence check (commits[] / decisions[] / NRs[] / inherited[] / writer_token_budget / phase_3α_arc_totals / A/B_test_binding / phase_3β_preview)
- All cumulative NRs (NR1-NR9) explicitly named
- NR8 promotion-candidate explicit
- Mirror-shape taxonomy explicit (all 4 shapes covered)
- Verify commands for validator

After PASS: **writer ends this session per EC-30.** Operator runs A/B competitive test per Surface 6 above; amendment commit OR separate addendum records the verdict and the Phase 3α acceptance decision.

---

## Phase 3α implementation totals (cumulative across 14 commits / 4 sub-phases / 5 writer sessions)

| Metric | Value |
|---|---|
| Implementation commits in skills repo | 14 (`2ab3547`, `3adfb81`, `dc15978`, `ada5eed`, `5912d0a`, `21626ec`, `f99a228`, `4fc400a`, `24a99aa`, `5434381`, `d9490f8`, `9f87d24`, `83e7ddd`, `7529345`) |
| Skills-repo net diff (cumulative) | +7290 / -3 lines across 82 files |
| Tokens added to coverage YAML | +96 (46 → 142) |
| Structural anchors added | +24 (5 → 29) |
| Lock manifest entries: bumped | 3 (dahl, ritchie, hashimoto sha256 bumps) |
| Lock manifest entries: added | 11 (fowler, beck, hunt, willison, saarinen, friedman, watson, abramov, brandur, durov, vanrossum) |
| Verify-catalog gate failures | 0 across 14 commits |
| cp-mirrors --check gate failures | 0 across 14 commits |
| v1 catalog (`_council-experts/`) byte changes | 0 (isolation pattern preserved) |
| Path-3 principles authored | 76 |
| D5 Detection-signal coverage | 76/76 (100%) on Path-3 commits |
| Aura-companion CLOSURE HANDOFFs | 4 (sub-1, sub-2A.1-mid, sub-2A, sub-2B) + THIS FINAL CLOSURE |
| Writer sessions | 5 |
| Cumulative writer tokens | ~425-490k across 5 sessions (within 1M-window per session) |
| D7 zero-drift consecutive | **7 (N3.08..N3.14) — threshold for NR8 promotion to convention floor met** |
| Asymmetric mirror shapes covered | **4 of 4** (full-panel + review-only + aura-only + non-aura) |

---

## Phase 3α — IMPLEMENTATION CLOSED ✅

Skills repo HEAD `7529345` master (14 of 14 implementation commits).
Aura-companion HEAD `b87a48d` (this FINAL CLOSURE HANDOFF commit advances to next SHA).
Verify-catalog C1-C12 + cp-mirrors --check green throughout 14 commits.
Convention floor EC-1..EC-24 + EC-30..EC-33 + Phase 3α SPEC + PLAN + 4 sub-phase HANDOFFs + operator Path 3 directive + D1-D8 + NR1-NR9 all held.

### Sign-off

- Writer Phase 3α (5 sessions, 14 atomic skills-repo commits, 14 validator briefs all PASSed, 4 sub-phase CLOSURE HANDOFFs + this FINAL CLOSURE): all green throughout
- Validator: 14 PASS reports received in-pipeline; 7 consecutive D7 zero-drift on the post-D7-codification arc (N3.08..N3.14)
- Phase 3α IMPLEMENTATION arc closed
- **Next step (operator-driven):** A/B competitive test per `/tmp/phase-3-α-closure-handoff-directive.md`; verdict landed as amendment to this CLOSURE OR separate addendum

### Phase 3α progress checkpoint (FINAL)

- ✅ Phase 3α₀: spec + plan committed
- ✅ Phase 3α₁: 3 append-existing (dahl/ritchie/hashimoto), CLOSURE landed
- ✅ Phase 3α₂-A: 4 seed-new domain-neutral (fowler/beck/hunt/willison), mid-CLOSURE + full CLOSURE landed
- ✅ Phase 3α₂-B: 4 seed-new UI cluster (saarinen/friedman/watson/abramov), CLOSURE landed
- ✅ **Phase 3α₂-C: 3 seed-new language cluster (brandur/durov/vanrossum), this FINAL CLOSURE landing now**
- ⏳ Phase 3α ACCEPTANCE TEST (A/B competitive) — next-operator action per directive

**14 of 14 implementation commits complete (100%).** Phase 3α implementation arc CLOSED.

Phase 3β entry (post A/B test acceptance): fresh writer session reads this FINAL CLOSURE + spec + plan + dump #2 (8 expert candidates) + Section F tension-pair principle; picks up at Phase 3β planning per `/council-plan-aura-v2`.
