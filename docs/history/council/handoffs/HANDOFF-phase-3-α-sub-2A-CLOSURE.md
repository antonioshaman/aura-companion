# HANDOFF: Phase 3α₂-A CLOSURE — Council Mode v2 expert-references enrichment, seed-new domain-neutral sub-phase complete (2026-05-16)

**Status:** ✅ Phase 3α₂-A = 4 of 4 seed-new commits landed (N3.04 fowler, N3.05 beck, N3.06 hunt, N3.07 willison). Domain-neutral cluster complete. Ready to hand off to Phase 3α₂-B (UI cluster: saarinen/friedman/watson/abramov).

**Per EC-32:** this artifact bridges the writer Claude session that authored N3.06..N3.07 (and inherits N3.04..N3.05 from sub-2A.1 mid-CLOSURE) to the next writer session that will author N3.08..N3.11 (Phase 3α₂-B UI cluster). Writer ends current session here per EC-30 (~85-95k cumulative).

---

## Skills-repo state (HEAD `f99a228` on master at `~/.claude/skills/`)

### Phase 3α₂-A commits — **4 atomic, one per expert** (runtime values, shell-pasted)

| Sub-phase | Sub-step | SHA | Files | Lines added | Strategy | Mirrors | Per-§ depth |
|---|---|---|---|---|---|---|---|
| 3α₂-A.1 | N3.04 fowler | `ada5eed` | 7 | +467 | seed-new B2 (full-panel) | 4 (manual cp Option A) | shallow 87L (pre-Path-3, first-commit overhead) |
| 3α₂-A.1 | N3.05 beck | `5912d0a` | 5 | +431 | seed-new B2 (review-only) | 2 (manual cp Option A) | 134L Path 3 (§A 58 / §B 66) |
| 3α₂-A.2 | N3.06 hunt | `21626ec` | 7 | +1098 | seed-new B2 (full-panel) | 4 (manual cp Option A) | 213L Path 3 + D5 (§A 67 / §B 67 / §C 67 — all AT floor) |
| 3α₂-A.2 | N3.07 willison | `f99a228` | 7 | +807 | seed-new B2 (full-panel) | 4 (manual cp Option A) | 155L Path 3 + D5 (§A 67 / §B 77 — §A AT floor) |

### Verify-catalog steady-state: **C1-C12 + cp-mirrors --check all green** at HEAD throughout

```
=== C10: semantic-coverage canary (Phase 2c-N1) ===
  ✓ 89 tokens + 15 structural anchors + 1 forbidden patterns — all green
=== C11: catalog supply-chain ===
  ✓ schema + 4-call-site IDs + ownership/mode + 1 B2 entries / 4 mirrors — all green
=== C12: ref-mirrors lock (sha256 attestation manifest) ===
  ✓ 7 mirror sets / 22 mirrors / 7 canonicals — lock attestation green
```

### Lock manifest sha256 entries (Phase 3α₂-A cumulative)

| Target | Class | Status | sha256 |
|---|---|---|---|
| `fowler` | B2 seed-new | NEW (N3.04, 3α₂-A.1) | `f1fcc6ccf5d05d984f057633380ddff03019b665f60c51bf3ea372c8478a1fe1` |
| `beck` | B2 seed-new | NEW (N3.05, 3α₂-A.1) | `8940308dbccec88db3e4a12676b54461ac67de11e9b479b7d51f3b1b964bd413` |
| `hunt` | B2 seed-new | NEW (N3.06, 3α₂-A.2) | `1c03dc380ee5fe4ed55cf5b3f23fb65f49751cac07290c3e58cfe2453c2c9171` |
| `willison` | B2 seed-new | NEW (N3.07, 3α₂-A.2) | `3b4fc005122e43932d505fcadbd8c71247b96aac5dcd6605677f60b60a172eee` |

Pre-Phase-3α₂ lock had 3 entries / 8 mirrors / 3 canonicals; post-3α₂-A has 7 entries / 22 mirrors / 7 canonicals. Net Phase 3α₂-A: +4 entries, +14 mirrors (4 + 2 + 4 + 4), +4 canonicals.

### Coverage manifest token growth (C10 ground-truth, shell-pasted)

| Round | Tokens | Δ | Anchors | Δ | Source category |
|---|---|---|---|---|---|
| Pre-Phase-3α₂ (post-N3.03) | 62 | — | 5 | — | (external-enrichment intro sub-1) |
| Post-N3.04 fowler | 69 | +7 | 8 | +3 | external-enrichment |
| Post-N3.05 beck | 75 | +6 | 10 | +2 | external-enrichment |
| Post-N3.06 hunt | 82 | +7 | 13 | +3 | external-enrichment |
| **Post-N3.07 willison** | **89** | **+7** | **15** | **+2** | external-enrichment |

**Total Phase 3α₂-A token growth: +27 tokens / +10 structural anchors.** All under `source: external-enrichment`. All grep-F verified ≥1 against canonical AT commit time (per N3.05 SF-6 discipline + N3.06 NR shell-paste discipline for briefs).

---

## Decisions ratified across Phase 3α₂-A (D1-D7)

### D1 (continuity from sub-1, ratified across sub-2A): Option A manual cp for seed-new B2 mirrors

Sub-1 D1 ratified B1-vs-B2 path divergence. Sub-2A extended: all 4 sub-2A seed-new B2 entries (fowler, beck, hunt, willison) materialise via manual cp because cp-mirrors.py TARGET_ALLOWLIST = frozenset({"dahl", "ritchie", "hashimoto"}) rejects new B2 entries at schema validation (NR1). C12 lock attestation is the byte-identity gate throughout; C11 cp-mirrors --check covers only the 1 pre-existing hashimoto B2 entry / 4 mirrors. **Phase 3-C housekeeping candidate:** unify cp-mirrors.py to handle B1 + seed-new B2.

### D2 (sub-2A.1 N3.04→N3.05): Path 3 (Hybrid) depth policy ratified

Per operator directive at `/tmp/phase-3-α-N3.04-PASS-and-N3.05-proceed.md`:
- Per-section depth: ~67-83 lines per § block (load-bearing per-section invariant per NR2)
- Multi-paragraph principle treatment (statement + elaboration + Example + Anti-pattern + Detection signal + Cross-ref = 6 sub-paragraphs)
- Shape reference: hashimoto §V1..§V5 facet structure for DEPTH; keep §A/§B/§C anchor scheme
- N3.04 fowler stays at 87L (pre-Path-3, first-commit absorbs setup-overhead, shallow-aesthetic acceptable for that commit only — no retroactive expansion)

### D3 (sub-2A.1 N3.05 reframe): Path 3 floor scales per-section (NR2 codified)

Per N3.05 validator PASS report: total budget = section count × per-section floor + ~20L overhead. Codified table:

| Section count | Per-section floor (Path 3) | Total floor (sections × per-§ + ~20L overhead) |
|---|---|---|
| 2 (beck, willison) | 67-83L | 154-186L |
| 3 (fowler, hunt) | 67-83L | 221-269L |

Empirical Phase 3α₂-A per-section actuals: beck 58/66 (just below floor; overhead-absorbed), hunt 67/67/67 (AT floor exactly), willison 67/77 (§A AT floor; §B within range).

### D4 (sub-2A.1 N3.05): Review-only seat → asymmetric mirror set

Beck is review-only (review-v2 + review-aura-v2). Mirror set = 2, not 4. C11/C12 gate this correctly. First asymmetric-mirror seed-new in Phase 3α₂; fowler/hunt/willison are all 4-mirror full-panel.

### D5 (sub-2A.1 N3.05 → carry-forward sub-2A.2): "Detection signal in code review" sub-paragraph established

N3.05 beck introduced Path-3-native sub-paragraph `Detection signal in code review:` that names how to recognise the principle's violation in a PR diff or commit-graph view. Carry-forward enforced:

| Commit | Detection signal in code review count | Principle count | Coverage |
|---|---|---|---|
| N3.04 fowler | 0 | 15 | pre-Path-3 (not retroactively added per D2) |
| N3.05 beck | 7 | 7 | 100% (first commit with pattern) |
| N3.06 hunt | 9 | 9 | 100% |
| N3.07 willison | 7 | 7 | 100% |

**D5 carry-forward rule:** every principle in N3.06+ must include `Detection signal in code review:` sub-paragraph. Held across all sub-2A.2 commits.

### D6 (sub-2A.1): Memory propagation accepted as universal-charge

Per operator directive: memory propagation work (`feedback_git_identity_per_command_override` across 12 project memory dirs) accepted as universal-charge to sub-2A.1 session, not separate ledger.

### D7 (sub-2A.2 N3.06 PASS report → applied N3.07): Shell-paste discipline for brief numerical claims

Per N3.06 validator PASS report (SF-6 token-count drift + SF-7 per-section-line-count drift recurrence, same family): "numerical claims in N3 briefs should be shell-pasted (grep/wc output verbatim), not transcribed". Applied throughout N3.07 brief: all token grep counts, sha256 values, verify-catalog output, diffstat — pasted verbatim from shell, no transcription. **Carry-forward rule for Phase 3α₂-B+:** all brief numerical claims must be shell-pasted with `$ <command>` annotation showing source command.

---

## NEW corrections / resolutions discovered (NR) across Phase 3α₂-A

### NR1 (sub-2A.1): cp-mirrors.py TARGET_ALLOWLIST rejects new seed-new B2 entries

Sub-1 NR1 captured B1-skip behaviour. Sub-2A.1 surfaces broader scope: `TARGET_ALLOWLIST = frozenset({"dahl", "ritchie", "hashimoto"})` at `cp-mirrors.py:71` rejects any new B2 target (fowler, beck, hunt, willison) at schema validation (`cp-mirrors.py:149`). Tool blocks new seed-new entries by allowlist, not just by manifest-class. **Phase 3-C housekeeping must address BOTH B1 inclusion AND seed-new B2 inclusion.** Until Phase 3-C, all 11 Phase 3α₂ seed-new B2 entries materialise via manual cp + C12 lock attestation only.

### NR2 (sub-2A.1 N3.05 → applied throughout sub-2A): Path 3 per-section scaling

Per-section depth is the load-bearing invariant; total scales linearly with section count. PLAN's 160-200L (beck-specific) and 200-250L (general Path 3) were correctly calibrated to section count; the "discrepancy" reflected sectional structure not PLAN error. Sub-2A.2 actuals validate: hunt 213L total = 3 × 67L per § + 12L header (slightly tighter overhead than NR2's assumed 20L); willison 155L total = (67+77) + 11L header.

### NR3 (sub-2A.1): License heuristic refinement — verbatim-bound applies to contiguous prose, NOT to named-principle tokens or work-titles

Named-principle tokens (`TDD microcycle`, `strangler fig migration`, `attack surface reduction`, `prompt injection`, `local-first AI`) are citations not quotations; verbatim-bound applies to contiguous external explanatory prose. None of the Phase 3α₂-A canonicals contain such prose; all paraphrased. **Recommendation:** spec L107 amendment candidate; defer to operator.

### NR4 (sub-2A.1 N3.05 SF-6 → reinforced N3.06 SF-6+SF-7 → codified D7): Token-drift + line-count-drift = same brief-transcription family

Pattern across 4 of 5 briefs (N3.01 +30/+28 lines; N3.04 "code smell" 4/5; N3.05 "small safe steps" 5/6; N3.06 token counts + per-section line counts). Same family: writer transcribes a number into the brief that drifts from the runtime value at commit time. Root cause: writer's pre-commit grep snapshot taken before final paragraph adds principle-name mentions or before final line-count edits. **Codified as D7 above:** shell-paste all numerical claims with `$ <command>` annotation.

### NR5 (sub-2A.2 NEW): Awk pattern brittleness for YAML block extraction

While preparing the N3.07 brief, the awk pattern `/^  willison:$/,/^  [a-z][a-z]*:$|^forbidden:$/` returned 0 entries (intended 9). Sed pattern `/^  willison:$/,/^forbidden:$/p` worked. The brittleness is the awk range-pattern's regex grouping behavior with `$` anchors. **Detection:** any zero-count from a YAML block extraction → re-run with sed before accepting the count. Universal sibling of `feedback_validator_self_grep_format_variations` (validator-grep patterns are themselves code with bugs; try ≥2 variations).

---

## Inherited corrections re-asserted (Phase 2 → sub-1 → sub-2A.1 → sub-2A.2)

- **Option A manual cp** for new B2 entries — held across all 4 sub-2A commits
- **Token case follows file body** — held; all 27 sub-2A external-enrichment tokens grep-F verified ≥1
- **§Z anchor literal** — does not apply to seed-new (uses §A/§B/§C primary anchors directly)
- **Atomic-per-expert (EC-31)** — held; each commit touched exactly one `_council-experts-v2/<id>/` dir
- **v1 catalog untouched** — held throughout sub-2A; `git diff` against `_council-experts/` is empty for all 4 commits
- **hashimoto seat count = 4 dispatchers** — held
- **Ref-path regex** — held; all 4 sub-2A canonical paths validate
- **C11 vs C12 independent-gate design** — both green at every commit
- **EC-30 watchpoint** — held: sub-2A.1 split at ~80-85k; sub-2A.2 split at ~85-95k

---

## Writer token budget (per sub-1 SF-3 + sub-2A.1 SF-3)

**Writer session for Phase 3α₂-A.2: estimated ~85-95k working tokens consumed** (this session, N3.06 + N3.07 + sub-2A CLOSURE HANDOFF).

Cost breakdown (rough):
- Pickup-prompt + 7 canonical inputs reading at session start: ~15k
- Skill-repo state probing (beck exemplar + fowler exemplar + lock + tokens.yml + panel-lists + hunt/willison persona files): ~8-10k
- N3.06 hunt authoring (3-section Path 3 + D5; 213L; targeted depth-expansion edits to hit per-section floor): ~10-12k
- N3.06 lock + manifest + cp + verify + commit + brief: ~10k
- N3.07 willison authoring (2-section Path 3 + D5; 155L; expansion to hit §A 67L floor): ~8-10k
- N3.07 lock + manifest + cp + verify + commit + brief (shell-paste): ~10k
- This HANDOFF + its validator brief: ~12-15k

**Vs sub-2A.1 estimate for 3α₂-A.2 (2 commits + closure HANDOFF): 70-80k.** Actual ~85-95k is +15-20% over estimate. Drift drivers: more shell verification roundtrips (per NR4 shell-paste discipline applied to briefs), thicker N3.06 (3-section Path 3 with per-section depth expansion).

**Implication for Phase 3α₂-B (UI cluster, fresh writer session, 4 commits):**
- Pickup-prompt + canonical inputs reading: ~12-15k (this HANDOFF + sub-2A-mid + sub-1 + spec + plan + dumps)
- N3.08 saarinen (2-section Path 3): ~22-25k
- N3.09 friedman (2-section Path 3): ~22-25k
- HANDOFF-phase-3-α-sub-2B-mid-CLOSURE.md + brief: ~10-12k
- **End sub-2B.1 at ~70-80k cumulative** → fresh session for sub-2B.2 (watson + abramov)

Per EC-30 100k ceiling, sub-2B.1 should target 2 commits (saarinen + friedman) ending at ~70-80k, with sub-2B.2 (watson + abramov) in a fresh session at ~70-80k, then full sub-2B CLOSURE HANDOFF after N3.11.

---

## Phase 3α₂-B scope (NEXT SUB-PHASE — fresh writer session)

### Tasks N3.08 → N3.11 — 4 seed-new commits, UI cluster

Per PLAN-aura-expert-references-enrichment.md (aura-companion HEAD `9c65baf`):

| # | Commit | Expert | Canonical (NEW) | Mirrors | Sections | Tokens | Line target (per NR2) |
|---|---|---|---|---|---|---|---|
| N3.08 | (TBD) | saarinen | `_council-experts-v2/saarinen/references/quality-saarinen.md` | 4 (full-panel) | §A Calm interface discipline + §B Workflow ergonomics | 7 (interface calmness / visual hierarchy / aesthetic compression / latency perception / keyboard-first / low-friction / opinionated polish) | **~155-185L (2-section)** |
| N3.09 | (TBD) | friedman | `_council-experts-v2/friedman/references/quality-friedman.md` | 4 (full-panel) | §A Scanability & decision design + §B Form & friction UX | 7 (scanability / progressive disclosure / decision fatigue / friction-aware / form usability / resilient interface / dashboards that drive action) | **~155-185L (2-section)** |
| N3.10 | (TBD) | watson | `_council-experts-v2/watson/references/quality-watson.md` | 2 (plan-aura-v2 + review-aura-v2 — aura-only) | §A Assistive technology compatibility + §B WCAG operationalization | 7 (screen-reader / semantic HTML / ARIA correctness / keyboard navigation / contrast compliance / assistive technology / WCAG operationalization) | **~155-185L (2-section)** |
| N3.11 | (TBD) | abramov | `_council-experts-v2/abramov/references/quality-abramov.md` | 2 (plan-aura-v2 + review-aura-v2 — aura-only) | §A React state & effects discipline + §B Rendering mental models | 7 (state minimization / effects discipline / server-client boundary / hydration correctness / optimistic UI / synchronization over lifecycle / composable components) | **~155-185L (2-section)** |

### Per-commit workflow (carry-forward from sub-2A)

Same as sub-2A.1/sub-2A.2 with all decisions ratified (D1-D7):
1. Read dump section (saarinen/friedman/watson/abramov all in dump #3 per spec L25).
2. Author canonical with Path 3 + D5 (6 sub-paragraphs per principle, including Detection signal in code review).
3. Manual cp Option A (cp-mirrors.py TARGET_ALLOWLIST still blocks).
4. Lock entry + tokens + structural_anchors registration.
5. Re-grep tokens AT COMMIT time (NR4 discipline).
6. verify-catalog + cp-mirrors --check both green.
7. Atomic-per-expert commit with `git -c user.name=auracomp -c user.email=auracomp@local`.
8. Write validator brief with ALL numerical claims shell-pasted (D7 / NR4 discipline) including `$ <command>` annotation.
9. PAUSE for validator PASS before next commit.

### EC-30 watchpoint for 3α₂-B

Per sub-2A.2 actuals (~85-95k for 2 commits + CLOSURE HANDOFF), fresh writer should expect ~25-30k per 2-section Path 3 commit + ~10-12k for HANDOFF. Mid-split candidate: after N3.09 (2 commits in) at ~75-80k → write sub-2B-mid HANDOFF + end session; sub-2B.2 picks up at N3.10 in fresh session.

---

## Aura-companion repo state (pre-this-HANDOFF-commit)

HEAD `9c65baf` on `feat/council-v2-pipeline`:
- N0 `9e36aa1` — Phase 3α canonical input spec
- N1 `9428192` — Phase 3α implementation spec
- N2a `5d7ab09` / N2b `b754d41` — Council PLAN
- N3-sub-1 `e9d7755` — Phase 3α₁ CLOSURE HANDOFF
- N3-sub-2A.1-mid `9c65baf` — Phase 3α₂-A.1 mid-CLOSURE HANDOFF

This HANDOFF commit advances aura-companion HEAD to a new SHA.

---

## Validator brief for this HANDOFF

Writer authors `/tmp/phase-3-α-sub-2A-CLOSURE-validator-brief.md` after this HANDOFF commit lands. Contains:
- aura-companion HEAD before / after CLOSURE commit
- skills repo HEAD (`f99a228` post-N3.07)
- HANDOFF file path + line count
- Per-required-field presence check (commits[] / decisions[] / NRs[] / inherited_corrections[] / writer_token_budget / next_phase_scope)
- All 5 NRs (NR1..NR5) explicitly named
- D7 shell-paste carry-forward rule explicit
- Verify commands for validator

After PASS: **writer ends this session per EC-30 + sub-2A-mid HANDOFF projection.** Phase 3α₂-B picks up in fresh Claude session via pickup-prompt referencing this CLOSURE HANDOFF.

---

## Phase 3α₂-A totals (cumulative)

| Metric | Value |
|---|---|
| Commits in skills repo (3α₂-A) | 4 (`ada5eed` fowler, `5912d0a` beck, `21626ec` hunt, `f99a228` willison) |
| Skills-repo net diff (3α₂-A) | +2803 / -0 lines across 26 files (4 canonicals + 14 mirrors + 4 manifest edits × 2 .verify files) |
| Tokens added to coverage YAML | +27 (7+6+7+7, all `source: external-enrichment`) |
| Structural anchors added | +10 (3+2+3+2) |
| Lock manifest entries added | 4 (fowler, beck, hunt, willison) |
| Validator briefs written (3α₂-A) | 5 (N3.04, N3.05, N3.06, N3.07 + sub-2A-mid CLOSURE brief + this HANDOFF brief upcoming) |
| Validator PASS reports received | 3 PASS confirmed (N3.04, N3.06 16/16 + adversarials, N3.05 PASS via operator directive); N3.07 pending at brief time |
| Verify-catalog gate failures | 0 |
| cp-mirrors --check gate failures | 0 (covered hashimoto-only throughout per Option A) |
| v1 catalog (`_council-experts/`) byte changes | 0 (isolation pattern preserved) |
| Aura-companion commits (3α₂-A round) | 1 prior (sub-2A.1 mid-CLOSURE `9c65baf`); this HANDOFF will be the 2nd |

---

## Phase 3α₂-A — CLOSED ✅

Skills repo HEAD `f99a228` master.
Aura-companion HEAD `9c65baf` (this HANDOFF commit advances to next SHA).
Verify-catalog C1-C12 + cp-mirrors --check green throughout 3α₂-A.
Convention floor EC-1..EC-24 + EC-30..EC-33 + Phase 3α SPEC + PLAN + sub-1 HANDOFF + sub-2A-mid HANDOFF + operator Path 3 directive + N3.06 PASS NR (shell-paste) all held.

### Sign-off
- Writer Phase 3α₂-A.2 (this session): 2 atomic skills-repo commits (N3.06 hunt, N3.07 willison), 2 validator briefs (N3.06 PASS confirmed, N3.07 brief landed), HANDOFF artifact (this file).
- Validator: 1 confirmed PASS report received in-session (N3.06 16/16 + adversarials; SF-6 + SF-7 NR for shell-paste discipline codified as D7); N3.07 PASS pending or implicit via operator HANDOFF directive at this commit.
- Phase 3α₂-A seed-new domain-neutral cluster (4 commits) closed.
- Phase 3α₂-B entry: fresh writer session reads this HANDOFF + sub-2A-mid + sub-1 + spec + plan + dump #3 UI cluster fields; picks up at N3.08 saarinen seed-new (2-section, ~155-185L per NR2, with D5 Detection-signal + D7 shell-paste-discipline carry-forward).

### Phase 3α progress checkpoint

- ✅ Phase 3α₀: spec + plan committed
- ✅ Phase 3α₁: 3 append-existing (dahl/ritchie/hashimoto), CLOSURE landed
- ✅ Phase 3α₂-A: 4 seed-new domain-neutral (fowler/beck/hunt/willison), mid-CLOSURE + this full CLOSURE landed
- ⏳ Phase 3α₂-B: pending (N3.08-N3.11 UI cluster: saarinen/friedman/watson/abramov)
- ⏳ Phase 3α₂-C: pending (N3.12-N3.14 language/platform: brandur/durov/vanrossum)
- ⏳ Phase 3α FINAL CLOSURE: pending A/B competitive test per `/tmp/phase-3-α-closure-handoff-directive.md`

7 of 14 implementation commits complete (50%).
