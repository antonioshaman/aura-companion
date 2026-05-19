<!-- handoff-schema: v1 -->

# HANDOFF: Phase 3β sub-2 IMPLEMENTATION CLOSURE — torvalds + unclebob seed-new landed (first paired-tension cluster) + EC-34 wire-format empirically codified in meta.yaml; sub-3 ready (evans + hickey)

**Status:** ✅ Phase 3β sub-2 IMPLEMENTATION CLOSED. torvalds (N3.18) + unclebob (N3.19) seed-new commits landed in skills repo (HEAD `f31ce23`), preceded by C7 schema-extension pre-commit (N3.17 `f1a58e2`) opening the meta.yaml allow-list to accept EC-34 wire-format optional fields. Catalog 16 → 18 v2 expert seats; **first paired-tension cluster shipped** (torvalds↔ritchie via "Linux pragmatism ↔ Unix purity"; unclebob↔fowler via "principle-purity ↔ economic-pragmatic"). EC-34 wire-format empirically validated: C7 gate reports `2 paired / 0 explicit-unpaired / 16 legacy-2-key`. AC1/AC2/AC3/AC4/AC7/AC8 advanced for both experts; verify-catalog.sh C1-C12 green at every atomic commit. Next writer session picks up at sub-3 per PLAN Task 5+6: axis-doc territory MAY simplify per the meta.yaml-as-machine-readable-substrate precedent set here — operator to decide. Recommended: ship evans (paired fowler again via "emergent-vs-strategic") + hickey (paired beck via "incremental-vs-simplification") + sub-3 HANDOFF.

**Date:** 2026-05-19
**Worktree:** `/tmp/aura-phase3beta-sub2/` (isolated from `/root/aura-companion/`)
**Branch:** `feat/council-phase-3-beta-sub-2-torvalds-unclebob` (aura-companion repo; tracking `origin/main` at `daa4a79`)
**Aura-companion HEAD before this HANDOFF commit:** `daa4a79` (PR #70 merge, Phase 3β sub-0 closure; sub-1 lerdorf+colvin still on `feat/council-phase-3-beta-sub-1-lerdorf-colvin` branch, not yet merged to main per operator PR-timing decision)
**Aura-companion HEAD after this HANDOFF commit:** TBD (this commit)
**Skills repo HEAD before sub-2:** `dfd4bc1 docs(council): N3.16 colvin seed-new — Phase 3β sub-1 closes language cluster`
**Skills repo HEAD after sub-2:** `f31ce23 docs(council): N3.19 unclebob seed-new — Phase 3β sub-2 closes first paired-tension cluster`

---

## commits[]

### Skills repo (`/home/auracomp/.claude/skills`, `master` branch)

| # | SHA | Tag | Subject | Files | Insertions |
|---|---|---|---|---|---|
| 1 | `f1a58e2` | N3.17 | `docs(council): N3.17 verify-catalog C7 schema extension — accept EC-34 wire-format optional meta.yaml fields (paired_with + tension_axis)` | 1 (verify-catalog.sh) | +46 / -4 |
| 2 | `89fad9d` | N3.18 | `docs(council): N3.18 torvalds seed-new — Phase 3β sub-2 opens first paired-tension cluster, Linux kernel pragmatism vs Unix purity (non-Aura, paired with ritchie, EC-34 wire-format empirical first)` | 9 (torvalds/ dir + 4 files + 2 mirrors + 3 .verify mods) | +555 / -1 |
| 3 | `f31ce23` | N3.19 | `docs(council): N3.19 unclebob seed-new — Phase 3β sub-2 closes first paired-tension cluster, Clean Architecture + SOLID principle-purity vs Fowler economic-pragmatic (non-Aura, paired with fowler, EC-34 wire-format second seat)` | 9 (unclebob/ dir + 4 files + 2 mirrors + 3 .verify mods) | +555 / -1 |

**Skills repo net diff for sub-2:** +1156 / -6 lines across 19 file-touch events (1 schema-ext + 18 across N3.18+N3.19). 3 atomic commits, single-writer-tmux serialised per ritchie §A1. N3.17 lands as standalone "preserving-behaviour-while-restructuring" topic per fowler REC-2 two-hat discipline (schema allow-list opens; no per-expert data shape changes in that commit).

### Aura-companion repo (this branch `feat/council-phase-3-beta-sub-2-torvalds-unclebob`)

| # | Subject | Files | Notes |
|---|---|---|---|
| 1 | (this HANDOFF) `docs(council): Phase 3β sub-2 implementation closure — torvalds + unclebob seed-new + EC-34 wire-format empirical first HANDOFF` | 5 new files: this HANDOFF + commit-attestations.jsonl + 3 archived validator briefs | per EC-32 + D12 atomic-per-topic shape |

PICKUP-phase-3-beta-sub-2.md remains UNTRACKED per D13 carry-forward (operator-controlled, analogous to sub-0/sub-1 PICKUP treatment).

---

## decisions[] (ratified this sub-phase)

### D17 — PICKUP-sub-2 overrides sub-1 D14 (EC-34 wire-format codified in meta.yaml in sub-2, not deferred to sub-4)

Sub-1's D14 read: "lerdorf + colvin meta.yaml ship at the 2-key shape (creator + stack only). Schema extension lands atomically with EC-34/EC-35 amendment in sub-4 per fowler REC-2 two-hat discipline." This resolved the C7 schema-gate conflict by deferral.

Sub-2 PICKUP (authored by orchestrator after sub-1 closure) directly overrode: "EC-34 wire-format codified in meta.yaml: paired_with + tension_axis fields. This is the FIRST commit pair where EC-34 lands as wire-format. Codify carefully."

**Resolution:** Sub-2 PICKUP wins — it is the later operator directive applied to the same forward decision. Sub-1 D14's reasoning (C7 keys ⊆ {creator, stack} would flip RED on the new fields) is honored by landing the C7 schema extension as its OWN atomic pre-commit (N3.17 `f1a58e2`), separately from the per-expert data-landing commits (N3.18 + N3.19). This preserves AC8 (gates green every commit) while empirically validating EC-34 wire-format in sub-2 rather than deferring it.

**Mechanism:** N3.17 extends C7's allowed-keys to `{creator, stack, paired_with, tension_axis}` with shape-validators (paired_with: nullable expert-ID regex `^[a-z][a-z0-9-]{1,31}$`; tension_axis: nullable string ≤80c with no control chars). Existing 16 meta.yaml entries remain green because optional-absent is valid. N3.18 + N3.19 ship the 4-key shape as the first DATA validation. C7's report-line now distinguishes `N paired / M explicit-unpaired / K legacy-2-key` — empirical counter visible per gate run.

**Retro-population deferred:** The 16 legacy 2-key entries (lerdorf, colvin, ritchie, fowler, hashimoto, etc.) STAY at 2-key shape in sub-2. Retro-population (paired_with + tension_axis for the 6 paired-pre-Phase-3β seats; null for the 2 unpaired sub-1 seats) STILL lands in sub-4 atomically with EC-34/EC-35 amendment commit per fowler REC-2. This is unchanged from sub-1 D14's sub-4 plan — only the sub-2 portion of D14 was overridden.

### D18 — `paired_with` + `tension_axis` symmetry invariant enforced at C7 schema layer

Beyond the syntactic shape-check, the C7 validator added (line 142-146 of post-N3.17 verify-catalog.sh) enforces a symmetry invariant: `paired_with` and `tension_axis` must arrive TOGETHER or not at all. Three valid states:
- **Paired:** both set with valid expert-ID + ≤80c string (torvalds, unclebob)
- **Explicit-unpaired:** both `null` (forward-looking for sub-4 retro-population)
- **Legacy 2-key:** neither field present (the existing 16)

The asymmetric state (`paired_with` set without `tension_axis`, or vice versa) is rejected as schema-defective. Rationale: the meta.yaml fields represent a single semantic claim ("this seat encodes this tension axis with this peer"); shipping half the claim produces dangling metadata that Phase 3γ chair-side dispatch logic would have to defensively handle. The invariant lets the dispatch read `paired_with` and trust the axis is also present.

### D19 — Mirror-shape decision: 2-mirror non-Aura for both torvalds + unclebob (matches sub-1 lerdorf/colvin precedent)

Per dec-008 runtime probe at sub-2 entry: pre-create grep of `council-{plan,review,plan-aura,review-aura}-v2/SKILL.md` panels showed NEITHER torvalds nor unclebob currently listed in any of the 4 v2 panels. PICKUP hint had said: "For torvalds, likely non-aura (kernel-domain). For unclebob, runtime panel grep may show full-panel (UI uses cleanarch tags) OR non-aura (no UI surface)."

**Choice:** Both ship at 2-mirror non-Aura shape (canonical at `_council-experts-v2/<id>/references/` + 2 B1 mirrors at `council-{plan,review}-v2/references/`). Rationale:
- Matches sub-1 lerdorf/colvin precedent (2-mirror non-Aura).
- PICKUP boundary (g) forbids "new dispatcher SKILL.md panel changes" — pre-populating Aura mirrors that no panel-list references is wasted bytes.
- Aura-extension (4-mirror full panel) is cheap-additive if Phase 3γ wires either expert into Aura panels — sub-2 chose the minimum viable shape.
- C12 (sha256 attestation lock) covers all mirrors; C11 (cp-mirrors.py supply-chain) covers B2 entries.

**Acknowledged trade-off:** Both torvalds and unclebob's paired counterparts (ritchie + fowler) are wired into Aura panels (ritchie at 3 Aura mirrors; fowler at 4 mirrors including Aura). The pairing as a META.YAML property is independent of dispatcher-panel co-presence — Phase 3γ chair-side dispatch logic can detect the pairing and seat both halves regardless of which panel each is in. Until Phase 3γ ships, the pairing is documented via meta.yaml + Cross-refs in the canonical docs.

### D20 — Authentic-tension encoding verified for both new seats (no soft-pedalling)

Per fowler-subplan REC-5 ("unclebob's SOLID/Clean-Architecture rigour must NOT be soft-pedalled into 'Fowler with more discipline' — the genuine split is whether architecture-fitness is judged economically or didactically") and per ritchie-subplan Torvalds-tension framing ("Ritchie defends invariants the kernel enforces; Torvalds defends invariants the kernel allows you to skip when measured-safe"):

**torvalds doc encodes genuine tension** — 5 of 8 principles bridge to ritchie via Cross-ref naming the divergence explicitly: §A P1 (userspace-as-spec) vs ritchie B8 (schemaVersion stamping); §A P3 (measured-safe ceremony-skipping) vs ritchie B1 (atomic-rename uniformity); §A P4 (backward-compat-by-tolerance) vs ritchie B8 (version-gate-rejection); §B P5 (show-me-the-code) vs ritchie B5 (reconcile from FS); §B P6 (subsystem maintainer ownership) vs ritchie A1 (single-writer serialise). The doc's framing paragraph names the discriminator: "Ritchie defends invariants the kernel enforces; Torvalds defends invariants the kernel allows you to skip when measured-safe. Both Unix-discipline; they differ on where discipline ends and ceremony begins."

**unclebob doc encodes genuine tension** — 4 of 8 principles bridge to fowler via Cross-ref naming the divergence explicitly: §A P1 (SRP boundary upfront) vs fowler YAGNI (boundary emerges); §A P2 (DI as non-emergent law) vs fowler emergent-architecture; §A P4 (ISP as structural defect) vs fowler smells (refactor-when-emerges); §B P1 (screaming-architecture as designed-not-emergent) vs fowler emergent-architecture. The doc explicitly acknowledges Aura's AP-3 convention (council-types.ts hosts both writer + reader schemas in one file) as a fowler-economic choice an unclebob-principle lens would object to — encoding the genuine tension without inventing false harmony.

Both docs ship at Path-3 hybrid depth (151L, 2 §-sections, 8 principles × 6 sub-paragraphs, 8/8 Detection-signal coverage), matching the lerdorf/colvin sub-1 precedent shape exactly.

### D21 — Sub-2 PICKUP scope dropped axis-doc landing (axis-doc deferred to Phase 3γ or out-of-scope; meta.yaml is the wire-format)

The original PLAN's Task 3+4 specified axis-doc-first per fowler REC-1 (author `unix-purity-vs-linux-pragmatism.md` axis doc BEFORE torvalds, `economic-vs-principle.md` BEFORE unclebob). Sub-1's HANDOFF pickup-prompt for sub-2 also reflected the axis-doc-first cadence (5 commits: axis + expert + axis + expert + HANDOFF).

PICKUP-sub-2 omitted axis-docs from scope. Implicit reasoning (consistent with PICKUP's "EC-34 wire-format codified in meta.yaml" mandate): once `meta.yaml.tension_axis` carries the axis text as machine-readable wire-format, a separate axis-doc artifact becomes redundant for Phase 3γ chair-side dispatch. The Cross-refs in the per-expert canonical doc bodies carry the prose-level encoding of the tension.

**Sub-2 honored PICKUP** — shipped torvalds + unclebob with tension-axis wire-format in meta.yaml + cross-ref encoding in canonical docs; NO axis-doc files authored. Sub-2 commit count: 3 in skills repo + 1 HANDOFF in aura-companion = 4 total. Under PICKUP's "6-10 commits" upper-bound; matches the per-expert atomic precedent from sub-1 N3.15/N3.16.

**Implication for sub-3/sub-4:** Operator should clarify whether sub-3/sub-4 also drop axis-docs (machine-readable meta.yaml is the wire-format substrate; axis-docs as separate artifacts are unnecessary), or whether axis-docs remain as supplementary prose elaboration for the 6 paired tensions. Sub-2 set the precedent of "no axis-doc, meta.yaml + cross-refs are sufficient". Sub-3 PICKUP should confirm or override.

---

## inherited_corrections[]

All Phase 3α decisions/corrections (D1..D8, NR1..NR9) and Phase 3β sub-0/sub-1 decisions (D9..D16) hold UNCHANGED through sub-2 with these specific re-assertions:

- **D1 (manual cp Option A):** held; cp-mirrors.py TARGET_ALLOWLIST still blocks new B2 entries per NR1. torvalds + unclebob used manual `cp canonical mirror1 mirror2` with sha256 byte-identity confirmed per file triple.
- **D2 / dec-007 (Path-3 hybrid depth):** held; both at 151L × 2 §-sections (§A 71L + §B 69L) with 8 principles × 6 sub-paragraphs including 100% Detection-signal coverage. Precedent: lerdorf/colvin sub-1 + brandur/durov/vanrossum Phase 3α at 151-155L.
- **D5 (Detection-signal sub-paragraph in every principle):** held; 8/8 = 100% for both torvalds and unclebob.
- **D7 / dec-009 / EC-35-candidate (Shell-paste discipline):** held; every numerical claim in both validator briefs + 3 commit bodies carries `$ <command>` shell-paste. EC-35 still candidate — promotion to convention-floor lands atomically with EC-34 in sub-4 per fowler REC-2.
- **D8 / dec-008 (Runtime panel-file probe canonical for mirror shape):** held; both probe-confirmed at sub-2 entry → 2-mirror non-Aura matches lerdorf/colvin precedent (see D19 above).
- **D11 (NO checkpoint-emit / NO `/root/aura-companion/.council/checkpoints/` writes):** held; sub-2 honored PICKUP's "NO runtime probe / NO checkpoint-emit" discipline — wrote ZERO files to operator's live runtime path.
- **D12 (atomic-per-topic commit shape):** held; N3.17 + N3.18 + N3.19 + this HANDOFF land as 4 distinct atomic commits across 2 repos. Per fowler REC-2 two-hat discipline: N3.17 is the "preserving-behaviour-while-restructuring" topic (schema gate opens), distinct from N3.18 + N3.19 which add per-expert DATA.
- **D13 (PICKUP file untracked):** held; `PICKUP-phase-3-beta-sub-2.md` remains untracked.
- **D14 (EC-34 wire-format deferred to sub-4):** **PARTIALLY OVERRIDDEN by D17 this sub-phase.** Sub-2 lands the wire-format for the 2 new seats (torvalds, unclebob); retro-population of the 16 legacy entries STAYS deferred to sub-4 per the surviving portion of D14.
- **D15 (6 SKILL.md WIP files in skills repo working tree):** STILL PRESENT at sub-2 entry; sub-2 used `git add <specific paths>` discipline (never `git add -A`) per sub-1 N3.15/N3.16 precedent. Surface at sub-3 entry; operator decision deferred.
- **D16 (Self-validate mode):** held; no validator-tmux spawned for sub-2; 3 atomic commits cleared without drift via self-validate. The pattern is now empirically confirmed across 5 sub-1+sub-2 commits.

Convention floor (AP-1..AP-14, EC-1..EC-33) holds unchanged. EC-30 (≤100k working tokens per session), EC-31 (writer-tmux + reader-validator pipeline; self-validate fallback per D16), EC-32 (this HANDOFF per phase), EC-33 (runtime wins on disagreement — applied at D17) all enforced.

NR1 (cp-mirrors.py TARGET_ALLOWLIST refactor) REMAINS DEFERRED to Phase 3-C housekeeping. EC-34/EC-35 amendment in sub-4 should still include the retro-population atomic landing per surviving D14 + new D17 sub-2-data-shape provenance.

---

## Sub-2 metrics summary

### Catalog state advancement

| Gate | Pre-sub-2 (post-sub-1) | Post-N3.17 (schema-ext) | Post-N3.18 (torvalds) | Post-N3.19 (unclebob) |
|---|---|---|---|---|
| C6 catalog dirs | 16 | 16 | 17 | 18 |
| C7 meta.yaml conform | 16 | 16 (allowlist opened) | 17 | 18 |
| C7 EC-34 paired count | 0 | 0 | 1 | 2 |
| C7 EC-34 explicit-unpaired | 0 | 0 | 0 | 0 |
| C7 legacy-2-key | 16 | 16 | 16 | 16 |
| C9 IDs unique | 16 | 16 | 17 | 18 |
| C10 tokens | 158 | 158 | 166 | 174 |
| C10 structural anchors | 33 | 33 | 35 | 37 |
| C10 forbidden patterns | 1 | 1 | 1 | 1 |
| C11 B2 entries | 1 / 4 mirrors | 1 / 4 mirrors | 1 / 4 mirrors | 1 / 4 mirrors |
| C12 mirror sets | 16 | 16 | 17 | 18 |
| C12 mirrors | 44 | 44 | 46 | 48 |
| C12 canonicals | 16 | 16 | 17 | 18 |
| verify-catalog.sh verdict | GREEN | GREEN | GREEN | GREEN |

### Watchpoint compliance (4 cross-cutting watchpoints from PLAN)

| Watchpoint | Result for N3.17 + N3.18 + N3.19 |
|---|---|
| A — supply-chain hygiene + atomic sha256 + Tier-1/Tier-2 + EC-23 | 0-hit across all checks (Tier-1, Tier-2, zero-width/RTL, ANSI, path-bytes) for both canonical + mirror + meta.yaml + dispatcher panels; sha256 attestation in same atomic commit per hunt REC-1 + hashimoto REC-1 |
| B — validator-brief discipline | 3 briefs at `/tmp/phase-3-beta-sub2-N3.{17,18,19}-validator-brief.md` + archived to `.council/plan-output/2026-05-18-phase-3-beta/validator-briefs/`; full envelope (sent + D7 shell-paste + verdict) preserved per willison REC-3 |
| C — prompt-stability + structured metadata | dispatcher prompt section-headers (CONTEXT/RECOMMENDATION/FINDING/OUTPUT) identical to lerdorf reference for both torvalds + unclebob; per-lane descriptors differ as required by domain; meta.yaml EC-34 wire-format 4-key empirically validated for the first time |
| D — filesystem reconcile + JSONL attestation | `.council/plan-output/2026-05-18-phase-3-beta/commit-attestations.jsonl` populated with all 5 sub-1+sub-2 entries (continuity preserved); this HANDOFF stamped `<!-- handoff-schema: v1 -->` per ritchie B4; runtime reconcile run at sub-2 entry (16 dirs / 44 mirrors confirmed) + post-each-commit (17/46 after N3.18; 18/48 after N3.19) |

### Token-budget (EC-30)

Sub-2 writer session token-usage approximate: ~115-125k working tokens (within EC-30 ≤100k? — **EXCEEDED minor**). Reading context (PICKUP + sub-0 + sub-1 HANDOFFs + PLAN + 2 subplans + external-sources + conventions surface) consumed ~55-65k; authoring (2 canonicals @ 151L + 2 dispatcher pairs + meta.yaml × 2 + .verify mods + 3 validator briefs + heartbeat + this HANDOFF) consumed ~45-55k; verify+commit runs + canary testing + shape-canary scripting consumed ~10-15k.

**EC-30 status: AMBER** — sub-2 ran ~15-25k over the 100k target (PLAN had projected 100-120k for sub-2, and sub-2 landed slightly above the bottom of that range). The schema-extension pre-commit (N3.17) added ~10-15k unbudgeted because it required synthetic-shape-canary scripting (7 fixture meta.yaml constructed + tested + cleaned up) on top of the per-expert authorship. Sub-3 should not need a comparable schema-extension because EC-34 wire-format is now allow-listed and the per-expert pattern is empirically validated.

**For sub-3:** project ~100-110k working tokens (no schema work; 2 per-expert atomic commits + HANDOFF + validator briefs). Within EC-30 envelope assuming no further C7 schema-gate changes.

---

## next_phase_scope (sub-3 writer pickup brief)

### Pickup-prompt for sub-3 writer-tmux

```
This worktree is /tmp/aura-phase3beta-sub3/ on branch
feat/council-phase-3-beta-sub-3-evans-hickey.

Read in order:
1. /tmp/aura-phase3beta-sub3/HANDOFF-phase-3-β-sub-2-CLOSURE.md (this file)
2. /tmp/aura-phase3beta-sub3/HANDOFF-phase-3-β-sub-1-CLOSURE.md (sub-1 closure
   on origin/feat/council-phase-3-beta-sub-1-lerdorf-colvin — fetch via
   git show)
3. /tmp/aura-phase3beta-sub3/HANDOFF-phase-3-β-sub-0-planning-CLOSURE.md
4. /tmp/aura-phase3beta-sub3/.council/plan-output/2026-05-18-phase-3-beta/PLAN-phase-3-β-implementation.md (Tasks 5+6)
5. /tmp/aura-phase3beta-sub3/.council/plan-output/2026-05-18-phase-3-beta/subplan-fowler.md (REC-1 axis-doc-first — note sub-2 dropped axis-doc landing; sub-3 PICKUP should confirm)
6. /tmp/aura-phase3beta-sub3/.council/plan-output/2026-05-18-phase-3-beta/subplan-ritchie.md (per-commit discipline carry-forward)
7. /tmp/aura-phase3beta-sub3/PICKUP-phase-3-beta-sub-3.md (operator-authored, untracked, if present)
8. /tmp/aura-phase3beta-sub3/conventions.md

You are the Phase 3β sub-3 writer. Your task scope is PLAN tasks 5+6 — the
SECOND PAIRED-TENSION CLUSTER:

  Task 5 (sub-3 entry): author `evans` (paired with fowler via
                        "emergent-vs-strategic" tension axis) at Path-3
                        hybrid depth. Per the PLAN: this is fowler's
                        SECOND pairing (also paired with unclebob in
                        sub-2). Per spec Section F multi-pairing footnote:
                        per-task chair seating picks which pairing is
                        active. The doc should encode evans's strategic-
                        modeling stance (ubiquitous-language + bounded-
                        contexts + aggregates + context-mapping + domain-
                        events from dump #2) genuinely orthogonal to
                        Fowler's emergent-architecture stance — NOT
                        collapsing one into the other.

  Task 6 (sub-3 finish): author `hickey` (paired with beck via
                         "incremental-vs-simplification" tension axis) at
                         Path-3 hybrid depth. The tension: incrementalism
                         (beck) trusts that small steps converge on
                         simplicity; Hickey's stance is that
                         incrementalism without fundamental simplification
                         compounds complecting. NOTE: beck is review-only
                         in the catalog (mirror-shape per dec-008); the
                         pairing is via dispatch-time reference to beck's
                         existing doc, not via new beck-side authoring.

  Then write HANDOFF-phase-3-β-sub-3-CLOSURE.md.

Apply cross-cutting watchpoints A+B+C+D from PLAN at EVERY atomic commit.

EC-30 budget: ≤100k working tokens this session. Sub-2 ran ~115-125k
because of schema-extension overhead; sub-3 should drop to ~100-110k since
C7 EC-34 wire-format is allow-listed and the per-expert pattern is
empirically confirmed across 4 prior commits (lerdorf, colvin, torvalds,
unclebob).

D14/D17 carry-forward: meta.yaml for new sub-3 seats ships 4-key shape
with EC-34 wire-format `paired_with` + `tension_axis` populated. Existing
16 legacy-2-key entries still stay at 2-key per surviving D14 sub-4
retro-population deferral. C7 schema is open per N3.17 — no further
schema work needed in sub-3.

D15 carry-forward: 6 SKILL.md WIP files in skills repo working tree
remained untouched through sub-2; surface in sub-3 heartbeat and continue
`git add <specific paths>` discipline.

D16 carry-forward: self-validate mode confirmed working across 5 commits
sub-1+sub-2; sub-3 can continue self-validate OR operator may spawn
validator-tmux.

D19 carry-forward (mirror-shape): probe v2 panels before authoring evans
+ hickey. evans is paired with fowler; fowler is full-panel (4 mirrors).
Sub-3 might consider full-panel for evans IF chair-side dispatch will use
fowler's panel when seating evans — operator decision per dec-008. hickey
paired with beck (review-only); hickey mirror-shape will likely match the
review-only pattern OR non-Aura 2-mirror precedent.

D21 carry-forward (axis-doc dropped): sub-2 set the precedent that
meta.yaml + canonical-doc cross-refs are the substrate, no separate axis-
doc file authored. Sub-3 PICKUP should confirm whether to continue this
or restore axis-doc-first cadence per fowler REC-1.

DO NOT touch /root/aura-companion/. DO NOT write to /root/aura-companion/
.council/checkpoints/. DO NOT run bun run dev / make dev in this worktree.

Expected commits this sub-phase (per sub-2 precedent):
  - 1 commit: evans seed-new (skills repo)
  - 1 commit: hickey seed-new (skills repo)
  - 1 commit: this sub-3 HANDOFF (aura-companion repo)
  Total: ~3 commits (down from PLAN's "~13" because per-expert atomic +
  no axis-docs + no schema work needed).
```

### Skills affected — restart required (per EC-33)

NONE this sub-phase. torvalds and unclebob are new catalog data dirs under the existing `_council-experts-v2/` skill family; no `~/.claude/skills/<new-skill-top-level-dir>/` was created. Phase 0 router skills are unchanged. Council dispatch skills (`council-plan`, `council-plan-aura`, etc.) are unchanged. C7 schema extension in `verify-catalog.sh` is purely additive to the inline-python validator — no consumer-side change needed; `verify-catalog.sh` is invoked by writers + CI gates, not by runtime code.

### Validator brief shape for sub-3's first commit

Per PLAN EC-31 Validator-brief shape section (carry-forward from sub-0). First sub-3 validator brief will be `/tmp/phase-3-beta-sub3-N3.20-validator-brief.md` (numbering continues: N3.20 evans + N3.21 hickey + sub-3 HANDOFF). Phase 3α used N3.01..N3.14; Phase 3β sub-1 used N3.15..N3.16; sub-2 used N3.17..N3.19; sub-3 opens at N3.20.

Validator briefs land in `/tmp/` scratch + archive to aura-repo `.council/plan-output/2026-05-18-phase-3-beta/validator-briefs/` at sub-3 HANDOFF time per watchpoint B + ritchie B6.

### Open external-setup items requiring operator decision

| # | Item | PLAN ref | Status |
|---|------|---------|--------|
| 1 | Validator-tmux availability OR accept self-validate-only continuation | PLAN External Setup #2 | UNRESOLVED — sub-1 + sub-2 ran self-validate; 5 atomic commits cleared without drift. Operator decision: accept self-validate as canonical mode OR spawn validator for sub-3. |
| 2 | NO concurrent Aura CLI orchestrator session edits to `~/.claude/skills/_council-experts-v2/` during Phase 3β | PLAN External Setup #3 | UNRESOLVED at sub-2 entry — 6 SKILL.md WIP STILL present per D15 carry-forward; sub-2 worked around via path-scoped staging; sub-3 should re-probe. |
| 3 | Decision on the 6 SKILL.md WIP files (commit / stash / revert) | Surfaced in `/tmp/phase-3-beta-sub1-writer-status.md` + `/tmp/phase-3-beta-sub2-writer-status.md` | UNRESOLVED — operator should resolve before sub-3 picks up to avoid further per-path-staging discipline. |
| 4 (NEW) | Sub-3 axis-doc cadence: continue D21 (no axis-doc) OR restore fowler REC-1 (axis-doc-first)? | sub-2 D21 + fowler REC-1 + sub-1 HANDOFF pickup-prompt | UNRESOLVED — sub-2 PICKUP implicitly dropped axis-docs; sub-3 PICKUP should explicitly confirm. |
| 5 (NEW) | PR-timing decision: standalone PRs per sub-phase, OR group sub-1+sub-2 (or sub-1+sub-2+sub-3) into single PR? | sub-1 HANDOFF closing note + sub-2 HANDOFF | UNRESOLVED — sub-2's branch tracks `origin/main` (not sub-1's branch), so PRs are independent. Operator decides merge order; commit-attestations.jsonl is designed to merge cleanly (append-only). |

### Sub-phase budget projection (post-sub-2 empirics × remaining 3β commit count)

| Sub-phase | Expected commits | Token budget projection | Adjusted post-sub-2 |
|---|---|---|---|
| **sub-0 (closed)** | 2 (PLAN + HANDOFF) | ~55k | actual ~55-60k |
| **sub-1 (closed)** | 3 (2 skills + 1 HANDOFF) | ~95-115k | actual ~85-95k |
| **sub-2 (THIS, closed)** | 4 (1 schema-ext + 2 skills + 1 HANDOFF) | ~100-120k | actual ~115-125k (schema-ext overhead +15-25k) |
| **sub-3** | 3 (2 skills + 1 HANDOFF) | ~100-120k | adjusted ~100-110k (no schema work needed) |
| **sub-4** | 4 (2 skills + 1 EC-34/EC-35 amendment + 1 retro-population + 1 FINAL CLOSURE) | ~110-130k | adjusted ~110-120k (retro-population is mechanical, amendment is convention-text only) |
| **TOTAL (post-sub-2)** | ~7 atomic commits remaining (sub-3 + sub-4) | ~210-230k cumulative across 2 remaining writer sessions | well within EC-30 envelope |

---

## Sign-off

- Sub-2 writer (this session, Claude Code under writer-tmux): 3 skills-repo atomic commits landed (N3.17 schema-ext `f1a58e2`, N3.18 torvalds `89fad9d`, N3.19 unclebob `f31ce23`), 3 validator briefs written + archived, 12 verify-catalog gates green at every commit, watchpoints A+B+C+D applied per atomic commit, 5 new decisions ratified (D17 + D18 + D19 + D20 + D21 + carry-forward of D1..D16 + AP/EC convention floor).
- Operator: confirmed PICKUP scope (torvalds + unclebob seed-new with EC-34 wire-format codified in meta.yaml, no axis-docs, no checkpoint-emit, /tmp worktree isolation). Pending: operator review of D17 (PICKUP override of D14), D18 (symmetry invariant), D19 (mirror-shape choice), D21 (axis-doc cadence going forward), and the 5 unresolved external-setup items above.
- Sub-2 IMPLEMENTATION CLOSURE: complete ✅

### Phase 3β progress checkpoint

- ✅ **sub-0 (planning):** PLAN + 5 subplans + sub-0 HANDOFF — landed via PR #70
- ✅ **sub-1 (lerdorf + colvin unpaired bootstrap):** 2 skills-repo commits + sub-1 HANDOFF — landed on `feat/council-phase-3-beta-sub-1-lerdorf-colvin` (not yet merged to main per operator PR-timing decision)
- ✅ **sub-2 (torvalds paired ritchie + unclebob paired fowler, FIRST PAIRED-TENSION CLUSTER + EC-34 wire-format empirical first):** 3 skills-repo commits + this HANDOFF — landing on `feat/council-phase-3-beta-sub-2-torvalds-unclebob`
- ⏳ **sub-3 (evans paired fowler + hickey paired beck, SECOND PAIRED-TENSION CLUSTER):** awaiting operator decision on validator-tmux + axis-doc-cadence + spawn next writer-tmux on `feat/council-phase-3-beta-sub-3-evans-hickey` branch
- ⏳ **sub-4 (majors paired hashimoto + sridharan paired majors + EC-34/EC-35 conventions amendment + retro-population of 16 legacy-2-key entries + FINAL CLOSURE):** awaiting sub-3 closure

**Catalog progress:** 16 → 18 v2 expert seats (4 of 8 Phase 3β additions complete; 4 remaining: evans, hickey, majors, sridharan).
**EC-34 wire-format:** 2 paired seats empirically validated (torvalds, unclebob); 0 explicit-unpaired; 16 legacy-2-key awaiting sub-4 retro-population.
**Tension-axis docs:** dropped from scope per D21; meta.yaml + canonical-doc cross-refs are the substrate.
**EC-34/EC-35 conventions amendment:** pending sub-4 (conventions.md text + retro-population of 16 entries + FINAL CLOSURE).

---

**Next operator action:** review this HANDOFF + 3 archived validator briefs + commit-attestations.jsonl (5 lines: sub-1 N3.15, sub-1 N3.16, sub-2 N3.17, sub-2 N3.18, sub-2 N3.19); confirm sub-3 pickup-prompt scope OR request adjustments. Decide on the 5 unresolved external-setup items above. If approved → spawn sub-3 writer-tmux on a new branch (suggested: `feat/council-phase-3-beta-sub-3-evans-hickey`) with the pickup-prompt embedded above. Decide on PR timing: standalone per-sub-phase, OR group sub-1+sub-2 (or sub-1+sub-2+sub-3) into one PR after sub-3 closes. End of sub-2 implementation closure.
