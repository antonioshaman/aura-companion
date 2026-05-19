# Council Plan (Aura): Phase 3β — v2 catalog expansion + EC-34/EC-35 codification

**Plan file:** `.council/plan-output/2026-05-18-phase-3-beta/PLAN-phase-3-β-implementation.md`

**Scope:** Add 8 new v2 council experts (catalog 14 → 22) at Phase 3α Path-3 hybrid depth, with 6 paired-tension axis docs, then codify EC-34 (tension-pair seating) + EC-35 (D7 shell-paste) in `conventions.md`. Skills repo + aura repo, ~22 atomic commits across 4 sub-phases × 5 writer sessions per EC-30 budget.

**Context:** Phase 3α IMPLEMENTATION CLOSED at skills HEAD `7529345` (router landed since at `a593c16`); A/B competitive test PASSED v2 across 4 specs (per CLOSURE-council-mode-v2.md); Phase 3β scope unlocked. This phase operates on catalog-content + filesystem + git only — NO Bun/Hono/React/protocol/subprocess/UI/a11y surface.

**Boundaries (explicit out of scope):** (a) No second A/B test (Phase 3α verdict carries). (b) No v1 catalog (`_council-experts/`) edits — isolation pattern preserved. (c) No `cp-mirrors.py` TARGET_ALLOWLIST refactor (NR1 housekeeping deferred to Phase 3-C). (d) No new gates on `verify-catalog.sh` — C1-C12 stays intact. (e) No Aura GHA CI shim to run skills-repo gates (per hashimoto recommendation 3 — EC-31 manual discipline is the gate). (f) No Phase 3γ skill-surface unification (dec-011 — separate phase). (g) No new dispatcher SKILL.md panel changes — the 22-seat catalog stays gated by per-skill panel lists.

**Council dispatched:** 5 of 10 (fowler / hunt / willison / ritchie / hashimoto). Skipped: dahl/abramov/watson/saarinen/friedman (zero in-scope domain per pat-013). beck dropped from initial 6-list due to runtime-probe finding review-only mirror shape (no plan-aura.md per dec-008). All 5 returned substantive recommendations (no "no recommendations" responses).

---

## Task Sequence

### 1. Sub-1 entry — commit this PLAN + per-expert subplans + author `lerdorf`

| | |
|---|---|
| **Domain** | fowler × ritchie × Carmack — bounded-context boundary + replay determinism |
| **Ref** | `references/quality-fowler.md` → §B bounded-context; `references/quality-ritchie.md` → §B Principle 7 (replay determinism) |
| **Depends on** | — |

Commit this PLAN file + 5 per-expert subplan files to `.council/plan-output/2026-05-18-phase-3-beta/` on the writer-side branch as the sub-1 anchor commit. Then author `lerdorf` (PHP web-first pragmatism, unpaired) following the Phase 3α atomic-commit pattern: skills-repo `_council-experts-v2/lerdorf/` dir + `meta.yaml` + dispatcher prompts per runtime-probed mirror shape + canonical `references/quality-lerdorf.md` at Path-3 hybrid depth + mirror cp + lock-manifest entry + coverage-tokens YAML entry. Per willison recommendation 6, `quality-lerdorf.md` should bridge web-runtime pragmatism to LLM-stream-lifecycle pragmatism in EXACTLY one principle and stay in PHP lane for the rest.

---

### 2. Sub-1 finish — author `colvin` + sub-1 HANDOFF

| | |
|---|---|
| **Domain** | willison × Carmack — schema-strict vs exploration self-tension |
| **Ref** | `references/quality-willison.md` → §A structured outputs (Principle 2) |
| **Depends on** | Task 1 |

Author `colvin` (pydantic-ai, Samuel Colvin, weak-paired with willison on schema-strict ↔ exploration) following the atomic-commit pattern. **Critical** per willison recommendation 1: `quality-colvin.md` must claim what `quality-willison.md` would refuse to claim — types-as-contract, schema-strict-eliminates-failure-loop, production-safety-over-iteration. NOT a stylistic variant of exploration. The crisp boundary per willison: Colvin wins when consumer is a program; Willison wins when consumer is a developer iterating on the prompt. Close sub-1 with `HANDOFF-phase-3-β-sub-1-CLOSURE.md` at aura repo root per EC-32 (commits[] / decisions[] / inherited[] / next_phase_scope).

---

### 3. Sub-2 entry — author `unix-purity-vs-linux-pragmatism.md` axis doc + `torvalds`

| | |
|---|---|
| **Domain** | fowler × ritchie × Carmack — axis-doc-first per bounded-context boundary; Linux-vs-Unix tension |
| **Ref** | `references/quality-fowler.md` → §B bounded-context; `references/quality-ritchie.md` → Torvalds-tension framing in subplan |
| **Depends on** | Task 2 |

Per fowler recommendation 1: author the axis doc at `.council/plan-output/2026-05-18-phase-3-beta/tension-pairs/unix-purity-vs-linux-pragmatism.md` FIRST, then author `torvalds` against the settled axis statement (NOT inferring tension retroactively). The axis doc captures ritchie's "kernel-enforces invariants" vs torvalds's "kernel-allows-skip-when-measured-safe" framing. `quality-torvalds.md` authored with backward-compat-by-tolerance lens (per ritchie's Torvalds-tension framing) — not by stamping every change with a schema version, but by writing readers that handle absent fields gracefully. Atomic-commit pattern as Phase 3α.

---

### 4. Sub-2 finish — author `economic-vs-principle.md` axis doc + `unclebob` + sub-2 HANDOFF

| | |
|---|---|
| **Domain** | fowler × Carmack — principle-purity vs economic-pragmatic tension |
| **Ref** | `references/quality-fowler.md` → §A economic refactoring + tension-pair codification framing in subplan |
| **Depends on** | Task 3 |

Author `economic-vs-principle.md` axis doc capturing fowler's economic-refactoring stance vs unclebob's principle-purity stance. Then `quality-unclebob.md` at Path-3 hybrid depth. Per fowler recommendation 5: unclebob's SOLID/Clean-Architecture rigour must NOT be soft-pedalled into "Fowler with more discipline" — the genuine split is whether architecture-fitness is judged economically (Fowler) or didactically (unclebob). Close sub-2 with `HANDOFF-phase-3-β-sub-2-CLOSURE.md`.

---

### 5. Sub-3 entry — author `emergent-vs-strategic.md` axis doc + `evans`

| | |
|---|---|
| **Domain** | fowler × Carmack — strategic-DDD vs emergent-microservices tension |
| **Ref** | `references/quality-fowler.md` → §B bounded-context + tension-pair codification framing |
| **Depends on** | Task 4 |

Author `emergent-vs-strategic.md` axis doc — note this is fowler's SECOND pairing (also paired with unclebob in sub-2). Per spec Section F multi-pairing footnote: "fowler's body of work crosses both axes; per-task chair seating picks which pairing is active". Then `quality-evans.md` at Path-3 hybrid depth, capturing ubiquitous-language + bounded-contexts + aggregates + context-mapping + domain-events from dump #2. Evans's strategic-modeling stance is genuinely orthogonal to Fowler's emergent-architecture stance; the axis doc must surface this without collapsing one into the other.

---

### 6. Sub-3 finish — author `incremental-vs-simplification.md` axis doc + `hickey` + sub-3 HANDOFF

| | |
|---|---|
| **Domain** | (beck reference for pairing, not dispatched as planner) × Carmack — incremental-TDD vs fundamental-simplification |
| **Ref** | `references/quality-beck.md` (review-only mirror; pair via dispatch-time reference); `references/quality-hickey.md` (new) |
| **Depends on** | Task 5 |

Author `incremental-vs-simplification.md` axis doc — beck's TDD-microcycle / make-the-change-easy-then-make-the-easy-change stance vs Hickey's simplicity-vs-easy / complecting-avoidance / immutable-value-semantics stance. The tension: incrementalism trusts that small steps converge on simplicity; Hickey's stance is that incrementalism without fundamental simplification compounds complecting. Then `quality-hickey.md` at Path-3 hybrid depth. Close sub-3 with `HANDOFF-phase-3-β-sub-3-CLOSURE.md`.

---

### 7. Sub-4 entry — author `prevention-vs-debugging.md` axis doc + `majors`

| | |
|---|---|
| **Domain** | hashimoto × Carmack — immutable-prevention vs debugging-in-prod tension |
| **Ref** | `references/quality-hashimoto.md` + hashimoto↔majors paired-tension framing in subplan |
| **Depends on** | Task 6 |

Author `prevention-vs-debugging.md` axis doc per hashimoto's crisp split: hashimoto wins on asymmetric-rollback-cost / reproducibility / multi-operator-trust / secrets-at-rest; majors wins on emergent-distributed-behavior / unknown-unknowns / MTTR-dominated-systems / small-team-debug-own-code. Per hashimoto recommendation 5: author `quality-majors.md` with NATIVE observability-SRE-Google-practice lens — do NOT compensate-author from hashimoto perspective. The tension-axis row in EC-34 must be genuinely orthogonal, not fake-orthogonal.

---

### 8. Sub-4 mid — author `realism-vs-skepticism.md` axis doc + `sridharan`

| | |
|---|---|
| **Domain** | majors × Carmack — operational-realism vs resilience-skepticism (second-degree majors-side tension) |
| **Ref** | `references/quality-majors.md` (just-authored) + `references/quality-sridharan.md` (new) |
| **Depends on** | Task 7 |

Author `realism-vs-skepticism.md` axis doc — sridharan's resilience-skepticism / failure-mode-analysis / alert-fatigue-reduction stance vs majors's operational-realism / wide-events-over-narrow-metrics stance. Note: this is a within-observability-domain tension (both share the "you cannot prevent everything" baseline), but sridharan pushes resilience-engineering one step further toward skepticism of observability dashboards themselves. Then `quality-sridharan.md` at Path-3 hybrid depth.

---

### 9. Sub-4 finish — EC-34 + EC-35 conventions amendment (own atomic commit)

| | |
|---|---|
| **Domain** | fowler × Carmack — two-hat discipline: amendment separate from content |
| **Ref** | `references/quality-fowler.md` → §A two-hat discipline + tension-pair codification framing |
| **Depends on** | Task 8 |

Per fowler recommendation 2: EC-34 + EC-35 amendment lands as its OWN atomic commit at the HEAD of sub-4 closure (not bundled with the majors/sridharan content commits). Per fowler tension-pair codification framing: (a) Surface the economic justification for the >12-seat scale threshold (12 is observed elbow, not a derived constant). (b) Lead with "synthesis becomes resolution, not aggregation" as the load-bearing claim. (c) Explicit non-prescription of the chair's filter (judgement under context, NOT mechanically codifiable; future codification attempts must clear "second real caller" gate). (d) Mark scope as catalog-organisational, distinct from runtime conventions. (e) Per fowler recommendation 4: enumerate the 6 concrete axes by name; mark the archetype list ("purity-vs-pragmatism, principle-vs-economics, paranoia-vs-curiosity") as illustrative. (f) Per fowler recommendation 5: explicitly admit unpaired seats as valid (lerdorf + colvin precedent). (g) Per fowler recommendation 7: EC-35 wording anchored to empirical zero-drift sequence (7/7 commits N3.08..N3.14) + cost-and-payback framing, NOT aesthetic "good writers shell-paste". (h) Per hashimoto recommendation 4: include footnote acknowledging NR1 cp-mirrors.py TARGET_ALLOWLIST refactor deferred to Phase 3-C.

---

### 10. Phase 3β FINAL CLOSURE

| | |
|---|---|
| **Domain** | fowler × ritchie × Carmack — closure handoff per EC-32 |
| **Ref** | conventions.md EC-32 + Phase 3α `HANDOFF-phase-3-α-CLOSURE.md` template |
| **Depends on** | Task 9 |

Write `HANDOFF-phase-3-β-CLOSURE.md` at aura repo root capturing the full 22-commit arc (or whatever final count after sub-1..sub-4) + EC-34/EC-35 amendment + decisions[] (D9, D10, ... ratified this phase) + inherited[] (NR1 still deferred, dec-007..dec-011 carried) + next_phase_scope (Phase 3γ skill-surface unification per dec-011 + Phase 3-C cp-mirrors housekeeping). Per ritchie §B recommendation 4: stamp `<!-- handoff-schema: v1 -->` immediately below the H1. Per hunt recommendation 4: archive all `/tmp/phase-3-beta-N*-validator-brief.md` files into `.council/plan-output/2026-05-18-phase-3-beta/validator-briefs/` BEFORE FINAL CLOSURE commit (forensic-grade retention). Per willison recommendation 3: validator-briefs preserve the full envelope (brief sent + validator response + shell-paste + verdict), not summaries.

---

## Risks & Watchpoints

These apply across ALL tasks above; do not require their own task slot but the writer MUST honor each at every atomic commit.

### Cross-cutting watchpoint A — Supply-chain hygiene at every atomic commit (Hunt × Hashimoto convergence)

- **Atomic sha256 in same commit:** Each new `quality-<id>.md` lands with its `_ref-mirrors.lock` sha256 attestation entry in the SAME atomic commit. Sha256 computed from on-disk byte-identical artifact at D7 shell-paste moment, never from a prior draft. Phase 3α discipline (D1) held; do not split. Chronological append-after-existing, NOT alphabetical re-sort. **Hunt principle:** §A attack surface + §C breach forensics. **Hashimoto principle:** Principle 7 reproducibility + Principle 3 pin everything.
- **Prompt-injection screening (Tier-1 + Tier-2) per new file:** Mechanical `grep -nE` pass on each new `quality-<id>.md` + dispatcher prompt + axis doc BEFORE commit. Tier-1 patterns (`ignore previous`, `system:`/`assistant:`/`user:` at line start, ChatML control sequences `<|im_start|>`, `[INST]`, zero-width / RTL-override Unicode, `New instructions:`, ANSI escapes) MUST be 0 OR explicitly framed in prose. Tier-2 patterns (`eval(`/`exec(`, shell-injection shapes, real-looking credential shapes) MUST be inside fenced code blocks with anti-pattern naming. High-risk authors this phase: `lerdorf` (PHP `eval()` discussions), `colvin` (tool-definition examples), `majors`/`sridharan` (example log payloads). Grep results pasted into validator brief alongside D7 evidence.
- **Path-bytes-redaction (EC-23):** No raw absolute paths from authoring host (`/home/auracomp/`, `/tmp/aura-phase3beta/`, `/root/`) in any new principle body, axis doc, or `meta.yaml`. Reference paths by conventional name (`<workspace>/.council/`, `~/.claude/skills/_council-experts-v2/`).
- **`meta.yaml` tone/concept token screening:** No operator topology in `tone:` lists or `concepts:` lists. URLs in `urls:` lists point to public docs only.
- **EC-24 cross-project surface:** Dispatcher prompt files (`plan.md` / `plan-aura.md` / `review.md` / `review-aura.md` × ~3-4 per expert × 8 = ~16-32 new files) inherit the same content-review discipline as canonicals. Per-file authoring-time review, NOT "dispatcher is just boilerplate".

### Cross-cutting watchpoint B — Validator-brief discipline (Ritchie §A × Hunt forensic convergence)

- **Writer-tmux strictly serialized across the 5 writer sessions.** Phase 3α 5-session × 14-commit empirics hold; Phase 3β must preserve "exactly one writer at a time". Reader-validator-tmux is READ-ONLY on skills repo + aura working tree. No concurrent writer access to `_ref-mirrors.lock` / `_phase2-coverage-tokens.yml` / `conventions.md`.
- **Atomic validator-brief artifacts.** `/tmp/phase-3-beta-NX-validator-brief.md` written via tmp+rename within `/tmp/`. Brief's first line carries a commit-anchored sentinel (e.g. `# Validator brief — commit <staged-tree-sha or N3.XX-tag>`) so reader confirms identity before evaluation, not file mtime. Reader's reply at `/tmp/phase-3-beta-NX-validator-reply.md`.
- **File-only handoff.** No shared env var, no tmux send-keys, no Claude session continuity. Filesystem-only communication preserves replay determinism (pat-018).
- **Forensic-grade archive of all briefs.** Before FINAL CLOSURE: `cp /tmp/phase-3-beta-N*-validator-brief.md .council/plan-output/2026-05-18-phase-3-beta/validator-briefs/` + same for replies. `/tmp/` is reaped on reboot; the briefs are the EC-31 proof-of-attestation trail.
- **Brief preserves raw envelope.** Brief sent + validator prose response + `$ <command>` shell-paste outputs + PASS/FAIL verdict. NOT summarised to "PASS".

### Cross-cutting watchpoint C — Prompt-stability + structured metadata (Willison × Fowler convergence)

- **Dispatcher prompt structure locked across 8 new experts.** Same section headers (`## YOUR LENS`, `## CRITICAL CONTEXT FROM THE BRIEF`, `## OUTPUT SHAPE`, ...), same output-shape block, same "If no recommendations" escape clause as Phase 3α 14-expert catalog. Schema drift = release-gated change. Validator-brief D7 shell-paste includes `$ diff <new-dispatcher>.md <reference-dispatcher>.md | grep ^##` to surface section-header drift.
- **`meta.yaml` machine-readable tension fields.** Each new `meta.yaml` ships `tension_axis: "<axis-text>"` + `paired_with: <expert-id>` fields (machine-parseable, not prose-buried). lerdorf + colvin use `paired_with: null` + `tension_axis: null` (unpaired). Phase 3γ chair-side dispatch logic depends on this substrate.
- **Dry-run dispatch smoke test per new expert.** Before sub-phase HANDOFF declares the expert available: invoke `/council-plan-aura` (or `-aura-v2`) against a synthetic micro-brief, inspect that the subagent returns the canonical OUTPUT SHAPE block (not blank, not malformed). Capture transcript into validator-brief. This is the prompt-engineering smoke test — catches dispatcher-prompt typos that pass markdown validation but produce empty subagent output.
- **3 §-sections per `quality-<id>.md` cap.** Resist 4th-section bloat (Large Class smell). torvalds + majors will tempt 4-section authoring (kernel-process + patch-review-discipline; observability-philosophy + on-call-economics) — split into a second pair seat for Phase 3γ scope rather than inflate a single doc.

### Cross-cutting watchpoint D — Filesystem reconcile + JSONL attestation sidecar (Ritchie §B)

- **Atomic edits for `_ref-mirrors.lock`, `_phase2-coverage-tokens.yml`, `conventions.md`.** Post-edit `git diff` + `verify-catalog.sh` re-run is the durability gate. NEVER `git add` + `git commit` without re-running `verify-catalog.sh` between edit and commit.
- **Slug-collision canary at sub-1 entry.** Pre-create grep: each of 8 IDs (`lerdorf`, `colvin`, `torvalds`, `unclebob`, `evans`, `hickey`, `majors`, `sridharan`) matches `^[a-z][a-z0-9-]{1,31}$`, none collide with existing 14 v2 OR v1 catalog slugs (case-insensitive comparison), none are POSIX reserved.
- **Per-commit JSONL attestation sidecar.** Author `.council/plan-output/2026-05-18-phase-3-beta/commit-attestations.jsonl` (append-only). One line per atomic commit: `{commit_sha, expert_id, brief_path, validator_pass_sha, ts_iso}`. Enables Phase 3γ chair-side dispatch logic to replay EC-31 compliance per commit without scraping markdown.
- **HANDOFF schema-version stamp.** First line below `# HANDOFF` H1 in all 5 Phase 3β HANDOFFs: `<!-- handoff-schema: v1 -->`. Non-breaking for Phase 3α readers (HTML comment); fixed point for Phase 3γ schema evolution.
- **Runtime reconcile at every sub-phase pickup.** New writer session at sub-phase entry MUST run: `ls ~/.claude/skills/_council-experts-v2/` (count dirs), `grep -c "^  - target:" _ref-mirrors.lock` (count entries), `git log --oneline` since Phase 3α HEAD, `cat HANDOFF-phase-3-β-sub-(N-1)-CLOSURE.md`. Disagreement: runtime wins per EC-33.
- **Validator-brief + HANDOFF live under aura repo working tree, not skills repo.** `/tmp/phase-3-beta-N*-validator-brief.md` are scratch only; durable artifacts under `/tmp/aura-phase3beta/.council/plan-output/` and `/tmp/aura-phase3beta/` (aura repo root for HANDOFFs).

---

## External Setup Required

| # | What | Why | Blocking task |
|---|------|-----|---------------|
| 1 | Operator confirms skills-repo writable from writer-tmux | All 8 new expert dirs land under `~/.claude/skills/_council-experts-v2/` — writer needs write access | Task 1 |
| 2 | Operator confirms validator-tmux can be spawned (or accepts deferring to PR-time review) | EC-31 mandates writer + reader pipeline; validator may run synchronously or async | Task 2+ (any expert commit) |
| 3 | Operator confirms NO concurrent Aura CLI orchestrator session edits `~/.claude/skills/` during Phase 3β | Race-safety per ritchie §A serialization | All tasks |

If validator-tmux unavailable, writer can self-validate per-commit using `verify-catalog.sh` + shell-paste discipline + dry-run dispatch smoke test (per willison recommendation 5) — but EC-31 strongly prefers a separate validator session. Operator decision.

---

## Sub-phase Budget Decomposition (EC-30 gate)

| Sub-phase | Scope | Atomic commits | Expected token budget |
|---|---|---|---|
| **Sub-1** | This PLAN commit + 5 per-expert subplan files + `lerdorf` (~5 commits) + `colvin` (~5 commits) + sub-1 HANDOFF | 1 + 1 + 5 + 5 + 1 = **~13 commits** | ~95-115k (Phase 3α 3α₁ + 3α₂-A.1 empirics) |
| **Sub-2** | `unix-purity-vs-linux-pragmatism.md` axis + `torvalds` (~5) + `economic-vs-principle.md` axis + `unclebob` (~5) + sub-2 HANDOFF | 1 + 5 + 1 + 5 + 1 = **~13 commits** | ~100-120k |
| **Sub-3** | `emergent-vs-strategic.md` axis + `evans` (~5) + `incremental-vs-simplification.md` axis + `hickey` (~5) + sub-3 HANDOFF | 1 + 5 + 1 + 5 + 1 = **~13 commits** | ~100-120k |
| **Sub-4** | `prevention-vs-debugging.md` axis + `majors` (~5) + `realism-vs-skepticism.md` axis + `sridharan` (~5) + EC-34/EC-35 amendment (1 atomic) + FINAL CLOSURE | 1 + 5 + 1 + 5 + 1 + 1 = **~14 commits** | ~110-130k |
| **TOTAL** | | **~53 commits** | **~405-485k cumulative across 4 writer sessions** |

**Commit count reconciliation:** PICKUP estimated ~22 commits; this PLAN refines to ~53 because the atomic Phase 3α per-expert pattern is ~3-5 commits per expert, not "1 commit per expert". Plus 6 axis docs + EC-34/EC-35 amendment + PLAN+subplans + 4 HANDOFFs. The ~22 figure was the count of new EXPERTS × 3 commits avg; the ~53 figure is the AC7 verifier count (validator-briefs per commit). Both can be true; the PLAN uses the AC7-binding figure.

Each sub-phase ends with `HANDOFF-phase-3-β-sub-X-CLOSURE.md`. Writer ends session per EC-30 between sub-phases. Next sub-phase writer reads HANDOFF + auto-memory + this PLAN, runs the runtime reconcile (watchpoint D), then resumes.

---

## EC-31 Validator-brief shape (per atomic commit)

```
# Validator brief — commit <staged-tree-sha-or-NX.YY-tag>

## D7 shell-paste evidence

$ wc -l ~/.claude/skills/_council-experts-v2/<id>/references/quality-<id>.md
<verbatim output>

$ grep -c "^Detection signal in code review:" <file>
<verbatim output>

$ ~/.claude/skills/_council-experts-v2/.verify/verify-catalog.sh
<verbatim output ending in PASS / RED>

$ ~/.claude/skills/_council-experts-v2/.verify/cp-mirrors.py --check
<verbatim output>

$ grep -nE '(ignore previous|system:|<\|im_start)' <new-files>
<verbatim output — expected empty or framed>

## Empirical claims

- <claim 1 with shell-paste evidence above>
- <claim 2 ...>

## Expected validator response

PASS if all claims match runtime; FAIL with specific corrections otherwise.
```

Reader-validator writes `/tmp/phase-3-beta-NX-validator-reply.md` with PASS or FAIL+corrections. Writer awaits PASS before next commit. Both files archived at FINAL CLOSURE per watchpoint B.

---

## Acceptance Criteria (verbatim from Phase 2 hard gate; verifier mapping included)

| AC | Claim | Verifier |
|---|---|---|
| AC1 | 8 new dirs at `_council-experts-v2/<id>/` with `meta.yaml` + dispatcher prompts matching runtime-probed mirror shape | `ls ~/.claude/skills/_council-experts-v2/<id>/` + `verify-catalog.sh` C1-C9 |
| AC2 | 8 canonical `quality-<id>.md` at correct canonical path, Path-3 hybrid depth (≥67L per `## §X` section, 6 sub-paragraphs per principle including `Detection signal in code review:`) | `wc -l` per section + `grep -c "^Detection signal in code review:" <file>` == principle count |
| AC3 | Lock manifest 14 → 22 canonical entries with sha256 green | `grep -c "^  - target:" _ref-mirrors.lock` == 22; `verify-catalog.sh C12` |
| AC4 | Coverage-tokens YAML +8 expert sections, ≥5 external-enrichment tokens / ≥2 anchors each | `verify-catalog.sh C10` + per-expert grep |
| AC5 | `conventions.md` contains EC-34 + EC-35 with Section F text + 6-axis table + economic justification + non-prescription clause | `grep -F "EC-34 Expert seating by ideological tension"` + `grep -F "EC-35"` |
| AC6 | 4 sub-phase HANDOFFs + 1 FINAL CLOSURE at aura repo root | `ls HANDOFF-phase-3-β-*-CLOSURE.md` |
| AC7 | Every Phase 3β skills-repo commit cites `/tmp/phase-3-beta-NX-validator-brief.md` in body | `git log --grep "phase-3-beta-N.*-validator-brief"` per commit |
| AC8 | C1-C12 + cp-mirrors --check green at every commit | per-commit pre-push gate (watchpoint A) |
| AC9 | 6 tension-axis docs at `.council/plan-output/2026-05-18-phase-3-beta/tension-pairs/` | `ls *.md \| wc -l == 6` |

Phase 3β is DONE when all 9 ACs verify green AND the FINAL CLOSURE HANDOFF lands at aura repo root.

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | Sub-1 entry — PLAN commit + subplans + `lerdorf` | fowler × ritchie × willison | — |
| 2 | Sub-1 finish — `colvin` + sub-1 HANDOFF | willison × Carmack | 1 |
| 3 | Sub-2 entry — `unix-purity-vs-linux-pragmatism.md` + `torvalds` | fowler × ritchie | 2 |
| 4 | Sub-2 finish — `economic-vs-principle.md` + `unclebob` + sub-2 HANDOFF | fowler × Carmack | 3 |
| 5 | Sub-3 entry — `emergent-vs-strategic.md` + `evans` | fowler × Carmack | 4 |
| 6 | Sub-3 finish — `incremental-vs-simplification.md` + `hickey` + sub-3 HANDOFF | beck-pair × Carmack | 5 |
| 7 | Sub-4 entry — `prevention-vs-debugging.md` + `majors` | hashimoto × Carmack | 6 |
| 8 | Sub-4 mid — `realism-vs-skepticism.md` + `sridharan` | majors-pair × Carmack | 7 |
| 9 | EC-34 + EC-35 conventions amendment (atomic) | fowler × Carmack | 8 |
| 10 | Phase 3β FINAL CLOSURE | fowler × ritchie × Carmack | 9 |

Plus 4 cross-cutting watchpoints (A: supply-chain hygiene, B: validator-brief discipline, C: prompt-stability + structured metadata, D: filesystem reconcile + JSONL attestation) applied at every atomic commit.

---

## Verdict

The most important architectural decision in this plan is **fowler's recommendation 1 — axis-doc-first per paired sub-phase**. It changes Phase 3β from "8 new expert docs (some happen to be paired)" into "6 axis-defined tensions, each with two seats". Without it, the paired authoring degenerates into "stack-for-coverage" (the very anti-pattern EC-34 exists to prevent) and the second pair member's ref doc gets written defensively against an inferred-retroactively axis. With it, each paired sub-phase opens with the chair's structural statement of the tension, then both seats author against it.

The expert whose domain is MOST critical for build time is **ritchie (filesystem persistence)** — every atomic commit touches `_ref-mirrors.lock` + `_phase2-coverage-tokens.yml` + (occasionally) `conventions.md`, and watchpoint D's atomic-edit + runtime-reconcile + JSONL-sidecar discipline determines whether the EC-31 pipeline scales to 4 writer sessions × ~53 commits without drift.

The developer (writer of sub-1) should start at **Task 1 — PLAN commit + lerdorf**. lerdorf is the simpler unpaired bootstrap (per willison's "one bridging principle, rest in PHP lane" guidance) and lets the writer settle into the per-commit watchpoint discipline before facing the paired-axis-doc-first cadence in sub-2.

**If a pair agent would be especially valuable during build:** a separate reader-validator session per EC-31 is the structural requirement; beyond that, ONE-OFF Carmack-chair side-checks at the EC-34/EC-35 amendment boundary (Task 9) would catch the wording-drift fowler warned against ("ritual vs economics" for EC-35; "scope-creep into archetype taxonomy" for EC-34). The chair side-check is a ~30-min sanity pass, not a full council dispatch.

Phase 3β converts the Phase 3α structural-enrichment foundation into a tension-pair-organized council, ships the structural codification (EC-34) that the council now operates under, and promotes the empirical discipline (EC-35) that the writer pipeline cleared 7-for-7 in Phase 3α₂-B/C. Both are universal conventions surviving beyond this phase.
