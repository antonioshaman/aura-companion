# HANDOFF: Phase 3α₁ CLOSURE — Council Mode v2 expert-references enrichment, append-existing sub-phase (2026-05-16)

**Status:** ✅ Phase 3α₁ atomic append-enrichment complete on 3 existing canonicals. Pattern proven across both B1 (dahl/ritchie) and B2 (hashimoto) mirror classes. Ready to hand off to Phase 3α₂-A (seed-new domain-neutral cluster).

**Per EC-32:** this artifact bridges the writer Claude session that authored N3.01..N3.03 to the next writer session that will author N3.04..N3.07. Writer ends current session here per EC-30 (≤100k working-tokens-per-session); next sub-phase picks up via pickup-prompt referencing this HANDOFF.

---

## Skills-repo state (HEAD `dc15978` on master at `~/.claude/skills/`)

### Sub-phase 3α₁ commits — **3 atomic, one per expert** (runtime values)

| Sub-phase | SHA | Files changed | Lines added | Lines removed | Strategy | Mirrors |
|---|---|---|---|---|---|---|
| 3α₁ N3.01 | `2ab3547` | 5 | **+92** | -1 | append-existing dahl | B1, 2 mirrors via manual `cp` |
| 3α₁ N3.02 | `3adfb81` | 5 | **+91** | -1 | append-existing ritchie | B1, 2 mirrors via manual `cp` |
| 3α₁ N3.03 | `dc15978` | 7 | **+147** | -1 | append-existing hashimoto | B2, 4 mirrors via `cp-mirrors.py` apply |

**Runtime line counts per canonical/mirror file: +28 lines each across all 3 commits** (correcting writer's prior N3.01 brief claim of "+30 lines" — validator SF-2 caught the drift; +28 is the actual diffstat for each `quality-<id>.md` file in each commit).

### Verify-catalog steady-state: **C1-C12 all green** at HEAD throughout

```
=== C10: semantic-coverage canary (Phase 2c-N1) ===
  ✓ 62 tokens + 5 structural anchors + 1 forbidden patterns — all green
=== C11: catalog supply-chain ===
  ✓ schema + 4-call-site IDs + ownership/mode + 1 B2 entries / 4 mirrors — all green
=== C12: ref-mirrors lock (sha256 attestation manifest) ===
  ✓ 3 mirror sets / 8 mirrors / 3 canonicals — lock attestation green
```

### Lock manifest sha256 transitions (Phase 3α₁ round)

| Target | Class | Pre-3α₁ sha256 (Phase 2 baseline) | Post-3α₁ sha256 (current) |
|---|---|---|---|
| `dahl` | B1 | `8006a3c8e5b6a76b4dbd37de05b6859c44de4c4c640200c88f9abe399d3f440c` | `c42145303dee7914b1cd90bbbab24c4e79c8988893bab5b754882fd023ad9a71` |
| `ritchie` | B1 | `d2c74c78a56dc86f8e9dc350cf2c12819951372662ca49996b38f28361e12ef2` | `e3a720e410dabbc9ba14f0fcd98bc82d46ad599e65cd5e5a920b0262b4363cc2` |
| `hashimoto` | B2 | `fb52eb722d52e2eab90666baad2c6ddb0172f8c2e05c608561837c9562cd0b94` | `2deab564f03d35c9e595ee2ee0f6c026163fbac9ac7258ddf7734eb415b5bab0` |

### Coverage manifest token growth (C10 ground-truth)

| Round | Tokens count | Δ | Source category added |
|---|---|---|---|
| Pre-Phase-3α (Phase 2c-N1 baseline) | 46 | — | (backend-ts, realtime-ndjson, subprocess, persistence-fs, deploy-docker-gha, deploy-vps merged) |
| Post-N3.01 (dahl §Z) | 52 | +6 | `external-enrichment` cluster introduced |
| Post-N3.02 (ritchie §Z) | 57 | +5 | (same source) |
| Post-N3.03 (hashimoto §Z) | 62 | +5 | (same source) |

**Total Phase 3α₁ token growth: +16 tokens.** All under `source: external-enrichment`. All grep-F verified ≥1 against their canonical at commit time.

---

## Decisions ratified this sub-phase

### D1: B1 manual-cp vs B2 cp-mirrors.py-apply path divergence ratified
- B1 targets (dahl/ritchie) have canonical at a dispatcher dir (`council-review-aura-v2/references/`) with mirrors at sibling dispatcher dirs. `cp-mirrors.py` is a B2-only runner (reads `_phase2-merges.yml`); B1 mirror regeneration requires manual `cp canonical mirror1 mirror2`.
- B2 target (hashimoto) has canonical at `_council-experts-v2/hashimoto/references/` with 4 dispatcher mirrors. `cp-mirrors.py` (no flag) materialises all 4.
- Both paths produce byte-identical sha256 outputs at all mirror sites. The B1 vs B2 choice is mechanical (which manifest tool owns the materialisation), not semantic (the catalog itself doesn't care).
- **Phase 3-C housekeeping candidate (out of Phase 3α scope):** unify B1+B2 by either (a) extending `cp-mirrors.py` to read `_ref-mirrors.lock` and process B1 entries, or (b) migrating B1 targets to a B2 entry in `_phase2-merges.yml`. Current divergence is functional but two-code-paths.

### D2: Token case follows file body, not normalization convention
- Tokens registered in `_phase2-coverage-tokens.yml` use the EXACT case that appears in the canonical file body (mixed: `event-loop discipline` lowercase, `Anti-bloat`/`Low-latency pragmatism`/`Systems austerity`/`Deterministic engineering`/`Automation-heavy` capital-first).
- Rationale: `grep -F` is case-sensitive; token MUST literally appear in the file. Normalizing all tokens lowercase would require rewriting body prose, which is more invasive than registering mixed case.
- Existing Phase 2 tokens have mixed case too (`Bun.serve`, `Hono`, `JSONL`, `--resume`) — no convention says lowercase.

### D3: §Z anchor uses `## §Z External-source enrichment` literal header
- Z chosen as section letter to indicate "appendix below existing §A/§B" without colliding with future principal-content additions.
- Sub-blocks within §Z: `Sources:` (URL list) + `### Additional principles` + `### Tone characteristics` + `### Anti-patterns to detect`. Pattern preserved across all 3 commits; ready for seed-new files to adapt this shape into §A/§B primary sections.

### D4: Self-correction discipline (SF-2 from N3.03 validator report)
- Writer's N3.01 brief claimed "+30 lines per dahl file"; runtime was +28. Drift originated in PLAN (Task 1 length budget: "~80 lines added") and propagated through brief without empirical re-check.
- Corrected throughout this HANDOFF: all 3 commits = +28 lines per canonical/mirror file.
- Trust-diff-not-prose: validator caught it via `git diff --stat`; writer's prior claim was prose drift.

---

## Inherited corrections re-asserted (Phase 2 → Phase 3α₁)

- **hashimoto seat count = 4 dispatchers** (plan-v2 + plan-aura-v2 + review-v2 + review-aura-v2). Confirmed empirically in N3.03 cp-mirrors apply output ("4 wrote, 0 unchanged").
- **vanrossum co-tenancy on `quality-backend.md`** — verify-catalog forbidden pattern (`Bun\.serve|Hono|web/server`) still 0 hits across dispatcher mirrors. Phase 3α₁ did NOT touch `quality-backend.md`.
- **Ref-path regex relaxation** (`^[a-z_][a-z0-9_-]{0,63}(/[a-z][a-z0-9_.-]{0,63})*$`) — still required for `_council-experts-v2/` underscore-prefixed canonicals. Hashimoto's canonical path validates against this regex.
- **C11 vs C12 independent-gate design** — both ran green at every commit. C11 = byte-identity (cp-mirrors --check), C12 = sha256 attestation against pinned lock value. Both verify the same invariant via different mechanisms; both must stay green.

---

## NEW corrections / resolutions discovered this sub-phase

### NR1: cp-mirrors.py B2-only scope (writer-side gap, NOT in spec)
Phase 3α spec assumed `cp-mirrors --apply` would refresh all mirrors per the lock manifest. Runtime: tool reads `_phase2-merges.yml` (B2 only) and skips B1 entries. Writer adapted via manual `cp` for dahl/ritchie. Captured as Phase 3-C housekeeping candidate (D1 above).

### NR2: Token case normalization sub-rule (validator SF reminder applied to writer practice)
N3.01 initially proposed tokens like `anti-bloat` (lowercase) but file body had `Anti-bloat:` (capital). `grep -F` returned 0. Fixed by registering tokens with the case from the body. Codified as D2.

### NR3: Validator-pipeline parallelism + chat-report-state asymmetry
Writer assumed validator PAUSE was unresolved when no `/tmp/*-report.md` had been read by writer; reality, validator was processing in parallel and reports were on disk. Writer's chat reports labeled commits as "user-overridden PAUSE" when both user-directive AND validator-PASS-on-disk were green (double-gated, not single-overridden). Corrected mid-sub-phase via runtime `ls /tmp/phase-3-α-*-report.md` probe. Sibling of `feedback_handoff_narrative_vs_runtime_state` — symmetric application: writer-side narrative vs validator-side runtime artifact.

### NR4: HANDOFF binding to A/B competitive test gate (Phase 3α CLOSURE only)
Validator+operator landed `/tmp/phase-3-α-closure-handoff-directive.md` mid-sub-phase. Binding requirement: Phase 3α formal closure (after N3.14) requires an A/B competitive test (legacy v1 council vs enriched v2 council) on `specs/composer-permission-mode-toggle.md`, judged by Aura observer + independent blind Claude. NOT applicable to sub-1 closure; applicable to final Phase 3α closure HANDOFF. Captured here so next-writer is aware before authoring HANDOFF-phase-3-α-CLOSURE.md after N3.14.

---

## Writer token budget (NEW REQUIRED FIELD per validator SF-3)

**Writer session for Phase 3α₁: estimated ~55-70k working tokens consumed.**

Cost breakdown (rough):
- Spec + plan + dump reads (one-time at session start): ~10k
- 3× canonical reads (existing dahl 481L / ritchie 469L / hashimoto 406L): ~15-18k
- 3× content authoring (§Z drafts): ~6k
- 3× manifest edits + lock edits + cp-mirrors runs + verify-catalog runs: ~6k
- 3× commit body authoring: ~3-4k
- 3× validator brief authoring (~200-300 lines each): ~10-12k
- Bash command output + diagnostic loops (token-grep verification, sha256 capture, mirror byte-identity checks): ~5-8k
- Mid-sub-phase corrections (token case mismatches, N3.01 line count drift caught later): ~2-3k

**Vs PLAN estimate for 3α₁: 55-65k.** Actual is within ±10% of plan, validating the per-commit cost model for append-existing.

**Implication for Phase 3α₂-A (4 seed-new commits):** PLAN estimated 100-120k for that sub-phase. Seed-new is more expensive per commit (~25-30k vs ~18-21k for append) because:
- New file authoring (200-250 lines per file) vs append (~30 lines per commit)
- 4× canonical writes (per mirror set, B2 path)
- New lock canonical entries (vs sha256 bump)
- New structural_anchors registration in manifest

**Recommendation for next-writer:** if 3α₂-A approaches ~80k mid-stream, write intermediate HANDOFF-phase-3-α-sub-2A-mid-CLOSURE.md and end session. Better to over-split than to compact mid-commit.

---

## Phase 3α₂-A scope (NEXT SUB-PHASE — for fresh writer session)

### Tasks N3.04 → N3.07 — 4 seed-new commits, domain-neutral cluster

Per PLAN-aura-expert-references-enrichment.md (aura-companion HEAD `b754d41`):

| # | Commit | Expert | Canonical (NEW) | Mirrors | Structural anchors | Tokens | Strategy |
|---|---|---|---|---|---|---|---|
| N3.04 | (TBD) | fowler | `_council-experts-v2/fowler/references/quality-fowler.md` | 4 | §A Refactoring economics + §B Architecture evolution + §C Code smell taxonomy | 7 (economic refactoring / strangler fig / feature toggle / bounded context / code smell / deviation amplification / evolutionary architecture) | seed-new B2 |
| N3.05 | (TBD) | beck | `_council-experts-v2/beck/references/quality-beck.md` | 2 (review-v2 + review-aura-v2 only) | §A Test-driven discipline + §B Small safe steps | 6 (TDD microcycle / empirical test design / make the change easy / locality of behavior / small safe steps / optimistic programming) | seed-new B2 |
| N3.06 | (TBD) | hunt | `_council-experts-v2/hunt/references/quality-hunt.md` | 4 | §A Attack surface discipline + §B Credential & secret hygiene + §C Breach forensics | 7 (attack surface reduction / secure defaults / zero trust / modern password storage / credential stuffing / secret leakage / breach forensics) | seed-new B2 |
| N3.07 | (TBD) | willison | `_council-experts-v2/willison/references/quality-willison.md` | 4 | §A Prompt engineering discipline + §B Context engineering | 7 (tool-use patterns / structured outputs / prompt injection / context packing / transcript-first debugging / agent ergonomics / local-first AI) | seed-new B2 |

### Per-commit seed-new workflow (writer template)

1. **Read dump section** from `specs/external-knowledge-enrichment-sources.md` (aura-companion HEAD `9e36aa1`) for the expert.
2. **Author new canonical** at `_council-experts-v2/<id>/references/quality-<id>.md`:
   - Header: `<!-- canonical-source: _council-experts-v2/<id>/references/quality-<id>.md -->`
   - Title: `# quality-<id>.md — <Expert Display Name>`
   - One-paragraph intro
   - `## §A <topic>` with Sources / Principles / Tone / Anti-patterns sub-blocks
   - `## §B <topic>` (and §C if dump warrants 3 topics)
   - Length target: 200-250 lines (vs 28-line §Z append)
3. **Add NEW canonical entry to `_ref-mirrors.lock`** with `canonical.sha256` + `mirrors[]` list (per panel cite-site intersection in PLAN's mirror table).
4. **Materialise mirrors:** for B2 (uniform pattern for all 11 seed-new), the canonical is at `_council-experts-v2/<id>/` — but `cp-mirrors.py` reads `_phase2-merges.yml`, not the lock. Decision for fresh writer to make:
   - (Option A) Manually `cp` canonical to each mirror path. Same as B1 dahl/ritchie pattern in 3α₁. Simple, low-tooling-trust.
   - (Option B) Extend `_phase2-merges.yml` to include the new B2 entry. Lets `cp-mirrors.py` handle materialisation. Tool-aligned but bigger lock-step contract.
   - **Writer recommendation:** Option A for 3α₂-A (matches sub-1 pattern); revisit B for 3α₂-C closure or Phase 3-C housekeeping.
5. **Add new tokens** (≥5) + **structural_anchors** (≥1) to `_phase2-coverage-tokens.yml` under `targets.<id>`. Verify each token grep-F-matches the new file before commit.
6. **Run verify-catalog** + `cp-mirrors --check` — both must be green.
7. **Atomic-per-expert commit** in skills repo with commitizen `docs(council): N3.0X <expert> seed-new ...` body.
8. **Write `/tmp/phase-3-α-N3.0X-validator-brief.md`** with 12 verify commands + PAUSE for validator PASS.

### EC-30 watchpoint for 3α₂-A

Per writer's actuals in 3α₁ (~60-70k for 3 simpler commits), 3α₂-A's 4 seed-new commits at ~25-30k each = ~100-120k. **At ~75k cumulative, fresh writer should checkpoint mid-sub-phase HANDOFF and end session.** Better to split 3α₂-A into 3α₂-A.1 (2 commits) + 3α₂-A.2 (2 commits) than to risk session compaction mid-commit.

---

## Aura-companion repo state (pre-this-HANDOFF-commit)

HEAD `b754d41` on `feat/council-v2-pipeline`:
- N0 `9e36aa1` — Phase 3α canonical input spec (enrichment-sources.md)
- N1 `9428192` — Phase 3α implementation spec
- N2 `5d7ab09` + `b754d41` — Council PLAN (initial + structural fixup)

This HANDOFF commit will advance aura-companion HEAD to a new SHA.

---

## Validator brief for this HANDOFF

Per EC-31 + validator directive: writer authors `/tmp/phase-3-α-sub-1-CLOSURE-validator-brief.md` after this commit lands. Contains:
- aura-companion HEAD before / after CLOSURE commit
- skills repo HEAD (unchanged `dc15978`)
- HANDOFF file path + line count
- Per-required-field presence check (commits[] / decisions[] / inherited_corrections[] / writer_token_budget / next_phase_scope)
- Line-count corrections vs N3.01-brief drift
- Verify commands for validator

After PASS: **writer ends this session per EC-30.** Phase 3α₂-A picks up in fresh Claude session via pickup-prompt referencing this HANDOFF.

---

## Phase 3α₁ totals (cumulative)

| Metric | Value |
|---|---|
| Commits in skills repo (3α₁) | 3 (`2ab3547`, `3adfb81`, `dc15978`) |
| Skills-repo net diff | +330/-3 lines across 17 files (3 canonicals + 8 mirrors + manifest + lock × 3) |
| Tokens added to `_phase2-coverage-tokens.yml` | +16 (all `source: external-enrichment`) |
| Lock sha256 entries bumped | 3 (dahl + ritchie + hashimoto) |
| Validator briefs written | 4 (N3.01 / N3.02 / N3.03 / + this CLOSURE brief upcoming) |
| Validator reports received | 4 PASS (N1 / N2 / N3.01 / N3.02 — N3.03 PASS just landed) |
| Verify-catalog gate failures | 0 |
| cp-mirrors --check gate failures | 0 |
| v1 catalog (`_council-experts/`) byte changes | 0 (isolation pattern preserved) |
| Aura-companion commits (3α₁ round) | 0 (spec+plan landed pre-3α₁; this HANDOFF will be the first) |

---

## Phase 3α₁ — CLOSED ✅

Skills repo HEAD `dc15978` master.
Aura-companion HEAD `b754d41` (this HANDOFF commit will advance to next SHA).
Verify-catalog C1-C12 + cp-mirrors --check green throughout 3α₁.
Convention floor EC-1..EC-24 + EC-30..EC-33 + Phase 3α SPEC + PLAN all held.

### Sign-off
- Writer Phase 3α₁ (this session): 3 atomic skills-repo commits, 4 validator briefs (with this HANDOFF's brief upcoming), HANDOFF artifact (this file).
- Validator: 4 PASS reports lain; SF corrections incorporated (N3.01 line-count drift; token-case normalization; writer-token-budget actuals).
- Phase 3α₁ append-existing arc closed.
- Phase 3α₂-A entry: fresh writer session reads this HANDOFF + spec + plan + dumps; picks up at N3.04 fowler seed-new.
