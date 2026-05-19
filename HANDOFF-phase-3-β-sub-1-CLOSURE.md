<!-- handoff-schema: v1 -->

# HANDOFF: Phase 3β sub-1 IMPLEMENTATION CLOSURE — lerdorf + colvin seed-new landed; sub-2 ready (torvalds + unclebob, first paired-tension cluster)

**Status:** ✅ Phase 3β sub-1 IMPLEMENTATION CLOSED. lerdorf (N3.15) + colvin (N3.16) seed-new commits landed in skills repo (HEAD `dfd4bc1`). Catalog 14 → 16 v2 expert seats. AC1/AC2/AC3/AC4/AC7/AC8 advanced for both experts; verify-catalog.sh C1-C12 green at every atomic commit. Next writer session picks up at sub-2: axis-doc-first per fowler REC-1 → torvalds (paired with ritchie via `unix-purity-vs-linux-pragmatism.md`) → unclebob (paired with fowler via `economic-vs-principle.md`) → sub-2 HANDOFF.

**Date:** 2026-05-18
**Worktree:** `/tmp/aura-phase3beta-sub1/` (isolated from `/root/aura-companion/`)
**Branch:** `feat/council-phase-3-beta-sub-1-lerdorf-colvin` (aura-companion repo; tracking `origin/main`)
**Aura-companion HEAD before this HANDOFF commit:** `daa4a79` (PR #70 merge, Phase 3β sub-0 closure)
**Aura-companion HEAD after this HANDOFF commit:** TBD (this commit)
**Skills repo HEAD before sub-1:** `a593c16 feat(router): Phase 0 stack detection on 3 suffixless skills`
**Skills repo HEAD after sub-1:** `dfd4bc1 docs(council): N3.16 colvin seed-new — Phase 3β sub-1 closes language cluster`

---

## commits[]

### Skills repo (`/home/auracomp/.claude/skills`, `master` branch)

| # | SHA | Tag | Subject | Files | Insertions |
|---|---|---|---|---|---|
| 1 | `4c85337` | N3.15 | `docs(council): N3.15 lerdorf seed-new — Phase 3β sub-1 opens, request-lifecycle pragmatism + backward-compat (non-aura, unpaired)` | 9 (lerdorf/ dir + 4 files + 2 mirrors + 3 .verify mods) | +548 / -1 |
| 2 | `dfd4bc1` | N3.16 | `docs(council): N3.16 colvin seed-new — Phase 3β sub-1 closes language cluster, schema-as-contract + production-safety-over-iteration (non-aura, unpaired)` | 9 (colvin/ dir + 4 files + 2 mirrors + 3 .verify mods) | +549 / -1 |

**Skills repo net diff for sub-1:** +1097 / -2 lines across 18 file-touch events (10 new files + 6 mod events on .verify files, counted twice across two commits). 2 atomic commits, single-writer-tmux serialised per ritchie §A1.

### Aura-companion repo (this branch `feat/council-phase-3-beta-sub-1-lerdorf-colvin`)

| # | Subject | Files | Notes |
|---|---|---|---|
| 1 | (this HANDOFF) `docs(council): Phase 3β sub-1 implementation closure — lerdorf + colvin seed-new HANDOFF` | 4 new files: this HANDOFF + commit-attestations.jsonl + 2 archived validator briefs | per EC-32 + D12 atomic-per-topic shape |

PICKUP-phase-3-beta-sub-1.md remains UNTRACKED per D13 carry-forward (operator-controlled, not part of council-PLAN commit scope; analogous to sub-0's PICKUP-phase-3-beta.md treatment).

---

## decisions[] (ratified this sub-phase)

### D14 — meta.yaml `tension_axis` + `paired_with` machine-readable fields DEFERRED to sub-4 EC-34 amendment

Watchpoint C from PLAN says: "Each new `meta.yaml` ships `tension_axis: "<axis-text>"` + `paired_with: <expert-id>` fields (machine-parseable, not prose-buried). lerdorf + colvin use `paired_with: null` + `tension_axis: null` (unpaired)."

PLAN Boundary (d) says: "No new gates on `verify-catalog.sh` — C1-C12 stays intact."

The two are in direct contradiction at the C7 schema gate: C7 enforces `keys ⊆ {creator, stack}`; adding `tension_axis` or `paired_with` (even with `null`) flips C7 red. EC-33 (runtime wins on disagreement) breaks the tie in favour of the gate.

**Resolution:** lerdorf + colvin meta.yaml ship at the 2-key shape (creator + stack only). Schema extension lands atomically with EC-34/EC-35 amendment in sub-4 per fowler REC-2 two-hat discipline — that commit can extend C7's allow-list to permit the optional fields, populate them for all 22 v2 experts retroactively (NULL for the 2 unpaired seats; populated for the 14 carrying explicit pairings), and add the EC-34/EC-35 convention text in the same atomic landing.

**Risk acknowledged:** willison REC-4's risk-if-skipped says "Phase 3γ chair-side dispatch becomes LLM-on-LLM lookup with correlated failure modes" without the machine-readable substrate. Mitigation: Phase 3γ chair-side dispatch (post-Phase-3β scope per dec-011) can fall back to prose-parsing of the unpaired/paired status documented in:
- each canonical reference doc's lead paragraph (e.g. lerdorf §A1 explicitly says "unpaired" status; colvin's lead paragraph documents the willison-orthogonality claim)
- this HANDOFF's per-expert entries
- sub-2/3/4 HANDOFFs that introduce the 6 paired seats with their axis docs

The fallback is unavoidable for the sub-1 unpaired experts regardless of whether the meta.yaml fields ship now or sub-4, because the chair-side dispatch logic doesn't exist yet (Phase 3γ scope). Shipping the fields in sub-4 atomically with EC-34 is the strictly better moment: the convention text and the data substrate land together, not split across two commits.

### D15 — Pre-existing 6-file SKILL.md WIP in skills repo working tree NOT touched by sub-1

Sub-1 entry probe found 6 SKILL.md files modified-uncommitted in `~/.claude/skills/` working tree (council-{implement,plan,review}-aura-v2/SKILL.md + council-{implement,plan,review}/SKILL.md). The edits include substantive structural content (Carmack-economic dispatch sizing, AC verifier mapping requirements, etc.) — clearly someone else's prior WIP, NOT in sub-1 scope per PLAN boundary (g) "No new dispatcher SKILL.md panel changes".

Sub-1 used `git add <specific paths>` discipline to stage ONLY lerdorf/colvin paths; the 6 SKILL.md WIP files remained in working tree across both commits. verify-catalog.sh C1 (no inline subagent blocks) and C2 (panel-named experts have catalog files) passed against the working-tree state at both commits.

**Operator action recommended (out-of-band of sub-1 scope):** investigate the 6 SKILL.md WIP provenance; decide whether to commit, stash, or revert before sub-2 pickup. Surfaced via `/tmp/phase-3-beta-sub1-writer-status.md` heartbeat. NOT a sub-2 blocker — sub-2 writer can apply the same `git add <specific paths>` discipline if the state persists.

### D16 — Self-validate mode confirmed for sub-1; validator-tmux availability still pending (External Setup #2)

PICKUP allowed: "pause for PASS (or proceed if no validator-tmux spawned)". No validator-tmux was spawned for sub-1; writer self-validated per External Setup #2 alternative. Discipline applied:
- D7 shell-paste evidence captured at AT-commit moment in each validator brief
- Hunt Tier-1 (12 patterns) + Tier-2 (8 patterns) + EC-23 path-bytes screening run against each new canonical + dispatcher + meta.yaml
- verify-catalog.sh C1-C12 run twice per commit (pre-commit gate per hashimoto REC-2 + post-commit confirmation per ritchie A2)
- Slug-collision canary run pre-create per ritchie B2 (watchpoint D)
- Sha256 byte-identity verified across all 6 mirror+canonical triples (3 lerdorf + 3 colvin)
- Willison REC-1 orthogonality canary explicit for colvin (grep counts on `types are the contract`, `iteration is the cost of having no contract`, `schema-strict eliminates the failure loop`)
- Willison REC-6 bridging-principle canary explicit for lerdorf (grep count on `LLM-stream-lifecycle realism` cross-stack bridge)

Operator decision required before sub-2: spawn validator-tmux for EC-31 two-process pipeline OR accept self-validate continuation. Phase 3β PLAN noted self-validate is "strongly disprefer[red]" but ratified as fallback (External Setup #2 + willison REC-5 dry-run smoke test). Sub-1's 2 commits cleared without drift; the empirical evidence supports either continuation path.

---

## inherited_corrections[]

All Phase 3α decisions/corrections (D1..D8, NR1..NR9) and Phase 3β sub-0 decisions (D9..D13) hold UNCHANGED through sub-1. Specific re-assertions:

- **D1 (manual cp Option A):** held; cp-mirrors.py TARGET_ALLOWLIST still blocks new B2 entries per NR1. lerdorf + colvin used manual `cp canonical mirror1 mirror2` with sha256 byte-identity confirmed per file triple.
- **D2 / dec-007 (Path-3 hybrid depth):** held; both lerdorf and colvin at 151L × 2 §-sections (§A 72L + §B 69L) with 8 principles × 6 sub-paragraphs including 100% Detection signal coverage.
- **D3 / NR2 (per-section scaling):** held; both 2-section commits at 151L within 134-167L floor (precedent: brandur/durov/vanrossum at 155L).
- **D5 (Detection-signal sub-paragraph in every principle):** held; 8/8 = 100% for both lerdorf and colvin.
- **D7 / dec-009 / EC-35-candidate (Shell-paste discipline):** held; every numerical claim in both validator briefs and both commit bodies carries `$ <command>` shell-paste. EC-35 still candidate — promotion to convention-floor lands atomically with EC-34 in sub-4 per D10 ratified.
- **D8 / dec-008 (Runtime panel-file probe canonical for mirror shape):** held; both lerdorf and colvin shape probed BEFORE authoring (non-Aura confirmed matching brandur/durov/vanrossum precedent: plan.md + review.md + references/quality-X.md + 2 mirrors at council-plan-v2 + council-review-v2).
- **D9 (5-expert dispatch from sub-0):** carry-forward only; no council dispatch in sub-1 (implementation-only). Sub-X review-time invocation will honour the same shape.
- **D10 (EC-34 + EC-35 both promoting Option A):** held; D14 above coordinates the sub-4 atomic-amendment landing.
- **D11 (Phase 7 checkpoint emit silent-skipped per workspace mismatch):** held; sub-1 honored PICKUP's "NO runtime probe / NO checkpoint-emit" discipline — wrote ZERO files to `/root/aura-companion/.council/checkpoints/`. Operator's live ObserverPanel undisturbed.
- **D12 (atomic-per-topic commit shape):** held; lerdorf + colvin landed as separate atomic commits (per-expert), this HANDOFF lands as separate third commit (closure-handoff topic).
- **D13 (PICKUP file untracked on this branch):** held; `PICKUP-phase-3-beta-sub-1.md` remains untracked. Operator may commit/archive separately.

Convention floor (AP-1..AP-14, EC-1..EC-33) holds unchanged. EC-30 (≤100k working tokens per session), EC-31 (writer-tmux + reader-validator pipeline; self-validate fallback per D16), EC-32 (this HANDOFF per phase), EC-33 (runtime wins on disagreement — applied at D14) all enforced.

NR1 (cp-mirrors.py TARGET_ALLOWLIST refactor) REMAINS DEFERRED to Phase 3-C housekeeping. EC-34/EC-35 amendment in sub-4 should include footnote per hashimoto REC-4. Reasserted from sub-0 inherited_corrections without modification.

---

## Sub-1 metrics summary

### Catalog state advancement

| Gate | Pre-sub-1 | Post-N3.15 (lerdorf) | Post-N3.16 (colvin) |
|---|---|---|---|
| C6 catalog dirs | 14 | 15 | 16 |
| C7 meta.yaml conform | 14 | 15 | 16 |
| C9 IDs unique | 14 | 15 | 16 |
| C10 tokens | 142 | 150 | 158 |
| C10 structural anchors | 29 | 31 | 33 |
| C10 forbidden patterns | 1 | 1 | 1 |
| C11 B2 entries | 1 / 4 mirrors | 1 / 4 mirrors | 1 / 4 mirrors (allowlist scope unchanged per NR1) |
| C12 mirror sets | 14 | 15 | 16 |
| C12 mirrors | 40 | 42 | 44 |
| C12 canonicals | 14 | 15 | 16 |
| verify-catalog.sh verdict | GREEN | GREEN | GREEN |

### Watchpoint compliance (4 cross-cutting watchpoints from PLAN)

| Watchpoint | Result for N3.15 + N3.16 |
|---|---|
| A — supply-chain hygiene + atomic sha256 + Tier-1/Tier-2 + EC-23 | 0-hit across all checks; sha256 attestation in same atomic commit per hunt REC-1 + hashimoto REC-1 |
| B — validator-brief discipline | 2 briefs at `/tmp/phase-3-beta-sub1-N3.{15,16}-validator-brief.md` + archived into `.council/plan-output/2026-05-18-phase-3-beta/validator-briefs/`; full envelope preserved per willison REC-3 |
| C — prompt-stability + structured metadata | dispatcher prompt headers stable across both new experts; tension_axis fields deferred per D14; section count + structure mirrors brandur/durov/vanrossum precedent |
| D — filesystem reconcile + JSONL attestation | `.council/plan-output/2026-05-18-phase-3-beta/commit-attestations.jsonl` populated with both commits; this HANDOFF stamped with `<!-- handoff-schema: v1 -->` per ritchie B4; runtime probe re-run at sub-1 entry |

### Token-budget (EC-30)

Sub-1 writer session token-usage approximate: ~85-95k working tokens (within EC-30 ≤100k budget; PLAN's sub-1 projection was 95-115k). Reading context (PICKUP + sub-0 HANDOFF + PLAN + 5 subplans + external-sources + conventions.md) consumed ~60-65k; authoring (2 canonicals + 2 dispatcher pairs + 2 validator briefs + this HANDOFF) consumed ~25-30k; verify+commit runs consumed ~3-5k. EC-30 status: GREEN.

---

## next_phase_scope (sub-2 writer pickup brief)

### Pickup-prompt for sub-2 writer-tmux

```
This worktree is /tmp/aura-phase3beta-sub2/ on branch feat/council-phase-3-beta-sub-2-torvalds-unclebob.

Read in order:
1. /tmp/aura-phase3beta-sub2/HANDOFF-phase-3-β-sub-1-CLOSURE.md (this file)
2. /tmp/aura-phase3beta-sub2/HANDOFF-phase-3-β-sub-0-planning-CLOSURE.md
3. /tmp/aura-phase3beta-sub2/.council/plan-output/2026-05-18-phase-3-beta/PLAN-phase-3-β-implementation.md (Tasks 3+4)
4. /tmp/aura-phase3beta-sub2/.council/plan-output/2026-05-18-phase-3-beta/subplan-fowler.md (REC-1 axis-doc-first; REC-5 unclebob)
5. /tmp/aura-phase3beta-sub2/.council/plan-output/2026-05-18-phase-3-beta/subplan-ritchie.md (Torvalds-tension framing)
6. /tmp/aura-phase3beta-sub2/.council/plan-output/2026-05-18-phase-3-beta/subplan-hunt.md (prompt-injection screening — torvalds + unclebob NOT in pat. high-risk list, but discipline holds)
7. /tmp/aura-phase3beta-sub2/PICKUP-phase-3-beta-sub-2.md (operator-authored, untracked, if present)
8. /tmp/aura-phase3beta-sub2/conventions.md

You are the Phase 3β sub-2 writer. Your task scope is PLAN tasks 3+4 — the
FIRST PAIRED-TENSION CLUSTER:

  Task 3 (sub-2 entry): author `unix-purity-vs-linux-pragmatism.md` axis doc
                        FIRST (per fowler REC-1 — settle the tension axis
                        before the second seat), then `torvalds` (paired
                        with ritchie via that axis) at Path-3 hybrid depth.
                        Per ritchie's Torvalds-tension framing: torvalds
                        encodes backward-compat-by-tolerance, not by
                        schema-stamping; both lenses are Unix-discipline
                        and differ on where discipline ends and ceremony
                        begins.

  Task 4 (sub-2 finish): author `economic-vs-principle.md` axis doc, then
                         `unclebob` (paired with fowler via that axis) at
                         Path-3 hybrid depth. Per fowler REC-5: unclebob's
                         SOLID/Clean-Architecture rigour must NOT be soft-
                         pedalled into "Fowler with more discipline" — the
                         genuine split is whether architecture-fitness is
                         judged economically (Fowler) or didactically
                         (unclebob).

  Then write HANDOFF-phase-3-β-sub-2-CLOSURE.md.

Apply cross-cutting watchpoints A+B+C+D from PLAN at EVERY atomic commit.

EC-30 budget: ≤100k working tokens this session. Sub-1 ran ~85-95k for 2
unpaired non-Aura experts; sub-2's 2 paired full-panel experts + 2 axis
docs will run higher — projected 100-120k per PLAN. If session approaches
100k, write HANDOFF after axis-doc-1 + torvalds and split unclebob into a
separate writer session.

D14 carry-forward: meta.yaml still 2-key shape (creator + stack) for sub-2
seats. Axis docs are .council/plan-output/ markdown files, NOT meta.yaml
fields — their existence is the machine-readable substrate for Phase 3γ
chair-side dispatch in the interim. Once EC-34/EC-35 amendment lands in
sub-4, the meta.yaml `tension_axis` + `paired_with` fields will reference
the axis docs by name + the paired seat ID.

D15 carry-forward: if the 6 SKILL.md WIP files are STILL uncommitted in
~/.claude/skills/ at sub-2 entry, surface in heartbeat. Use `git add
<specific paths>` discipline — never `git add -A` or `git add .`.

D16 carry-forward: validator-tmux still pending operator decision per
External Setup #2. Self-validate per N3.15/N3.16 brief shape if no
validator-tmux spawned.

DO NOT touch /root/aura-companion/. DO NOT write to /root/aura-companion/
.council/checkpoints/. DO NOT run bun run dev / make dev in this worktree.

Expected commits this sub-phase (per PLAN Sub-2 row):
  - 1 commit: axis doc unix-purity-vs-linux-pragmatism.md
  - 1 commit: torvalds seed-new (skills repo)
  - 1 commit: axis doc economic-vs-principle.md
  - 1 commit: unclebob seed-new (skills repo)
  - 1 commit: this sub-2 HANDOFF (aura-companion repo)
  Total: ~5 commits (within PLAN's "~13 commits" estimate after Phase 3α
  empirical reconciliation — atomic-per-expert pattern means 1 skills-repo
  commit per expert, not 5).
```

### Skills affected — restart required (per EC-33)

NONE this sub-phase. lerdorf and colvin are new catalog data dirs under the existing `_council-experts-v2/` skill family, not new top-level skills. No `~/.claude/skills/<new-skill-top-level-dir>/` was created. Phase 0 router skills are unchanged. Council dispatch skills (`council-plan`, `council-plan-aura`, etc.) are unchanged.

### Validator brief shape for sub-2's first commit

Per PLAN EC-31 Validator-brief shape section (carry-forward from sub-0). First validator brief will be `/tmp/phase-3-beta-sub2-N3.17-validator-brief.md` (or whatever tag sub-2 picks). Numbering continues N3.{17,18,19,20} likely (axis doc + torvalds + axis doc + unclebob — 4 atomic commits in skills repo + 1 in aura-companion for HANDOFF). Phase 3α used N3.01..N3.14; Phase 3β sub-1 used N3.15..N3.16; sub-2 opens at N3.17.

Note: axis docs land in `.council/plan-output/2026-05-18-phase-3-beta/tension-pairs/` in the AURA-COMPANION repo (per watchpoint B + ritchie B6 "validator-brief and HANDOFF artifacts live under aura-repo working tree, not skills repo"), NOT in the skills repo. The skills repo only receives the expert seed-new commits.

### Open external-setup items requiring operator decision

| # | Item | PLAN ref | Status |
|---|------|---------|--------|
| 1 | Validator-tmux availability OR accept self-validate-only continuation | PLAN External Setup #2 | UNRESOLVED — sub-1 used self-validate per fallback; sub-2 needs same decision |
| 2 | NO concurrent Aura CLI orchestrator session edits to `~/.claude/skills/_council-experts-v2/` during Phase 3β | PLAN External Setup #3 + ritchie §A1 serialization | UNRESOLVED at sub-1 entry — 6 SKILL.md WIP found in working tree per D15; sub-1 worked around via path-scoped staging; sub-2 should re-probe |
| 3 (NEW) | Decision on the 6 SKILL.md WIP files surfaced at sub-1 (commit / stash / revert) | Surfaced in `/tmp/phase-3-beta-sub1-writer-status.md` | UNRESOLVED — operator should resolve before sub-2 picks up to avoid further per-path-staging discipline |

### Sub-phase budget projection (Phase 3α + 3β sub-1 empirics × remaining 3β commit count)

| Sub-phase | Expected commits | Token budget projection | Adjusted post-sub-1 |
|---|---|---|---|
| **sub-0 (closed)** | 2 (PLAN + HANDOFF) | ~55k | actual ~55-60k |
| **sub-1 (THIS, closed)** | 3 (2 skills + 1 HANDOFF) | ~95-115k | actual ~85-95k |
| **sub-2** | 5 (2 axis + 2 skills + 1 HANDOFF) | ~100-120k | unchanged |
| **sub-3** | 5 (2 axis + 2 skills + 1 HANDOFF) | ~100-120k | unchanged |
| **sub-4** | 6 (2 axis + 2 skills + 1 amendment + 1 FINAL CLOSURE) | ~110-130k | unchanged |
| **TOTAL (post-sub-1)** | ~21 atomic commits remaining | ~310-370k cumulative across 3 remaining writer sessions | well within EC-30 envelope |

---

## Sign-off

- Sub-1 writer (this session, Claude Code under writer-tmux): 2 skills-repo atomic commits landed (lerdorf N3.15 `4c85337` + colvin N3.16 `dfd4bc1`), 2 validator briefs written + archived, 12 verify-catalog gates green at every commit, watchpoints A+B+C+D applied per atomic commit, 4 new decisions ratified (D14 + D15 + D16 + carry-forward of D9..D13 + D1..D8 + NR1..NR9).
- Operator: confirmed PICKUP scope (lerdorf + colvin seed-new, no checkpoint-emit, /tmp worktree isolation). Pending: operator review of D14 (tension fields deferred to sub-4), D15 (6 SKILL.md WIP provenance), D16 (validator-tmux availability for sub-2).
- Sub-1 IMPLEMENTATION CLOSURE: complete ✅

### Phase 3β progress checkpoint

- ✅ **sub-0 (planning):** PLAN + 5 subplans + sub-0 HANDOFF — landed via PR #70
- ✅ **sub-1 (lerdorf + colvin unpaired bootstrap):** 2 skills-repo commits + this HANDOFF — landed
- ⏳ **sub-2 (torvalds paired ritchie + unclebob paired fowler, FIRST PAIRED-TENSION CLUSTER):** awaiting operator decision on validator-tmux + spawn next writer-tmux on `feat/council-phase-3-beta-sub-2-torvalds-unclebob` branch
- ⏳ **sub-3 (evans paired fowler + hickey paired beck):** awaiting sub-2 closure
- ⏳ **sub-4 (majors paired hashimoto + sridharan paired majors + EC-34/EC-35 amendment + FINAL CLOSURE):** awaiting sub-3 closure

**Catalog progress:** 14 → 16 v2 expert seats (2 of 8 Phase 3β additions complete; 6 remaining: torvalds, unclebob, evans, hickey, majors, sridharan).
**Tension-axis docs:** 0 of 6 authored (sub-2 opens with 2).
**EC-34/EC-35 amendment:** pending sub-4.

---

**Next operator action:** review this HANDOFF + 2 archived validator briefs + commit-attestations.jsonl; confirm sub-2 pickup-prompt scope OR request adjustments. Decide on the 3 unresolved external-setup items above. If approved → spawn sub-2 writer-tmux on a new branch (suggested: `feat/council-phase-3-beta-sub-2-torvalds-unclebob`) with the pickup-prompt embedded above. Decide on PR timing: per-sub-phase PR (this branch becomes PR #71 standalone), OR group sub-1 + sub-2 into one PR after sub-2 closes. End of sub-1 implementation closure.
