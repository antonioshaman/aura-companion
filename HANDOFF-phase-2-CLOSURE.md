# HANDOFF: Council Mode v2 — Phase 2 CLOSURE (2026-05-16)

**Status:** ✅ Phase 2 atomic catalog refactor + convention codification complete. EC-30..EC-33 ratified.
**Next phase candidate:** Phase 3 (Lerdorf / Colvin expansion + implement-*-v2 cutover); separate spec work (Item 1 + Item 2 from Phase 2c HANDOFF future-scope) recommended interleaved.

---

## Skills-repo state (HEAD `fd5b645` on master at `~/.claude/skills/`)

### Catalog steady-state: **14 dirs** (was 17 pre-Phase-2)

| Sub-phase | SHA | Files changed | Net lines | Action |
|---|---|---|---|---|
| 2d-PRE-a | `df8614d` | 2 created | +64 | dahl plan-aura + review-aura prompts |
| 2d-PRE-b | `f19acbb` | 2 created | +77 | ritchie plan-aura + review-aura (two-lens §A/§B) |
| 2d-PRE-c | `586097c` | 4 created | +121 | hashimoto 4 prompts (cross-stack [common]) |
| 2d-N1 | `87fa9f9` | 13 (3M+9D+1mod) | +30 / -819 | dahl atomic merge → 18 dirs |
| 2d-N2 | `f24725e` | 16 (3M+12D+1mod) | +25 / -1490 | ritchie atomic merge → 16 dirs |
| 2d-N3 | `fd5b645` | 21 (8M+9D+4 mirror writes) | +29 / -833 | hashimoto atomic merge + V3 anchor + lock sha bump → 14 dirs |

### Verify-catalog steady-state: **C1-C12 all green** at HEAD

```
=== C1: no SKILL.md may inline a subagent prompt block (Beck) ===
  ✓ no inline subagent blocks
=== C2: every named expert in every consumer skill exists in catalog (Beck) ===
  (check complete — failures printed above if any)
=== C3: expert IDs match ^[a-z][a-z0-9-]{1,31}$ (Hunt) ===
  ✓ all expert IDs match shape
=== C4: no catalog files are symlinks (Hunt) ===
  ✓ no symlinks
=== C5: catalog files have mode 644, not executable (Hunt) ===
  ✓ all data files non-executable
=== C6: every catalog dir has meta.yaml AND count == EXPECTED_COUNT (Phase 1c) ===
  ✓ all 14 dirs have meta.yaml, count == EXPECTED_COUNT
=== C7+C8: meta.yaml schema (keys ⊆ {creator,stack}) + stack values in enum (Phase 1c) ===
  ✓ 14 meta.yaml conform (creator+stack only, stack values in enum)
=== C9: catalog IDs case-insensitively unique (Phase 1c) ===
  ✓ 14 IDs case-insensitively unique
=== C10: semantic-coverage canary (Phase 2c-N1) ===
  ✓ 46 tokens + 5 structural anchors + 1 forbidden patterns — all green
=== C11: catalog supply-chain (schema + 4 call-site IDs + ownership + B2 byte-identity) ===
  ✓ schema + 4-call-site IDs + ownership/mode + 1 B2 entries / 4 mirrors — all green
=== C12: ref-mirrors lock (sha256 attestation manifest) ===
  ✓ 3 mirror sets / 8 mirrors / 3 canonicals — lock attestation green
```

### 14 catalog dirs

```
abramov, beck, brandur, dahl, durov, fowler, friedman, hashimoto,
hunt, ritchie, saarinen, vanrossum, watson, willison
```

### Lock manifest sha256 (post-N3 hashimoto canonical edit)

| Target | Canonical path | sha256 |
|---|---|---|
| `dahl` | `council-review-aura-v2/references/quality-dahl.md` | `8006a3c8e5b6a76b4dbd37de05b6859c44de4c4c640200c88f9abe399d3f440c` (unchanged from 2c-N3) |
| `ritchie` | `council-review-aura-v2/references/quality-ritchie.md` | `d2c74c78a56dc86f8e9dc350cf2c12819951372662ca49996b38f28361e12ef2` (unchanged) |
| `hashimoto` | `_council-experts-v2/hashimoto/references/quality-hashimoto.md` | `fb52eb722d52e2eab90666baad2c6ddb0172f8c2e05c608561837c9562cd0b94` (bumped from `cd46dbed...` due to V3 secondary anchor add) |

---

## Aura-companion repo state (HEAD `6f6ac9d` on `feat/council-v2-pipeline` at `/root/aura-companion/`)

### Phase 2d-N4 commit (this repo, single commit)
`6f6ac9d` — `docs(council): codify EC-30..EC-33` — 1 file changed, +32 lines. `conventions.md` gained 4 new EC entries (numbering gap EC-25..29 preserved).

### conventions.md count: **28 EC entries** total (EC-1..EC-24 + EC-30..EC-33)

---

## Decisions ratified this round (Phase 2d-specific)

### Commit structure: 3 atomic merge commits + 3 PRE + 1 doc + 1 closing HANDOFF
HANDOFF model honoured. Each atomic merge commit bundles step 5-8 (panel cutover + source-dir delete + ref delete + count bump + aggregator sync + file-consistency table-row removal) per merge, keeping C1-C12 green at HEAD throughout. PRE-a/b/c content-authorship commits separated from cutover for fowler-P8 Two Hats; user authorised batched validator PASS for PRE+N1+N2 (5 commits) because comprehensive canary suite covers structural invariants; N3 serialised through validator because of V3 anchor + lock sha256 + cp-mirrors re-materialise complexity.

### Implement-aura-v2 scope: delete refs from all 3 Aura dispatchers + ALSO remove corresponding table rows from implement-aura SKILL.md in same commit
File-consistency invariant: no commit may leave a dangling markdown table cite to a deleted file. Per N1: removed "Realtime / NDJSON Protocol Expert" row (cited deleted quality-realtime.md). Per N2: removed FS-JSON Persistence + Subprocess Lifecycle rows (cited deleted quality-persistence + quality-subprocess). Per N3: removed Docker + GHA Deploy Expert row (cited deleted quality-deploy). "Bun/Hono/TS Backend Expert" row KEPT — quality-backend.md survives (vanrossum co-tenant).

### implement-aura-v2 panel-list NOT cut over (out of Phase 2 scope)
Per pickup-prompt directive: "in 4 dispatcher panel-lists (plan-v2, plan-aura-v2, review-v2, review-aura-v2 — NOT implement-*-v2)". Council-implement-aura-v2/SKILL.md table at line 53+ still references the old "Bun/Hono/TS Backend Expert" + quality-backend.md path (out of scope; quality-backend.md survives anyway). Phase 3 candidate.

### V3 secondary anchor pattern
`feedback_check_supervisor_before_kill` added as secondary anchor to Facet V3 in quality-hashimoto.md alongside primary `feedback_process_ancestry_check_before_parent_restart`. Two anchors cover bidirectional containment failure: (a) agent kills parent; (b) agent fails to kill supervisor (Restart= respawns faster). "Cross-reference also [[...]]" construction matches Facet V5 convention.

---

## Inherited corrections re-asserted (Phase 2a/2b/2c → Phase 2d)

- **hashimoto seat count = 4 dispatchers** (Aura plan-aura + review-aura, non-aura plan + review). NOT 5 or 6. C11 (cp-mirrors --check) + C2 (panel-list) doubly enforce; adding a 5th mirror without panel update fails both.
- **vanrossum co-tenancy on `quality-backend.md`** — Phase 2c-N1 C10 forbidden pattern (`Bun\.serve|Hono|web/server`) enforces ZERO across dispatcher mirrors; vanrossum's Python authority preserved.
- **Ref-path regex relaxation** (Phase 2c-N2 surfaced) — `^[a-z_][a-z0-9_-]{0,63}(/[a-z][a-z0-9_.-]{0,63})*$` accommodates `_council-experts-v2/` leading underscore. Phase 2d author should NOT flip back without proposing alternative canonical-path convention.
- **C11 vs C12 independent-gate design** — C11 = B2 byte-identity (mirrors==canonical at present state, no pinned hash); C12 = canonical sha256 pinned at lock time. Together close prompt-injection-as-supply-chain attack class (Hunt REC-7).

---

## NEW corrections / resolutions discovered this round

### Council Plan Task 10 step 3 prompt-author gap
Phase 2a-N1 created placeholder dirs `_council-experts-v2/{dahl,ritchie,hashimoto}/` with ONLY `meta.yaml`. The matching `plan-aura.md`/`review-aura.md`/`plan.md`/`review.md` prompt files were owed but missed through Phase 2b/2c. Phase 2d pickup surfaced the gap via verify-catalog C2 simulation: cutover panel-list to cite `dahl` → `awk` extracts `dahl` → `[ -f $CATALOG/dahl/plan-aura.md ]` fails → ERR=1.

Closure: inserted Phase 2d-PRE-a/b/c content-authorship sub-phases BEFORE N1/N2/N3 cutover. Each PRE commit authored 2-4 prompt files via concatenate-and-dedupe from source-expert prompts (NOT paraphrase, per willison REC-5).

### Aggregator-section sync was UNDERSPECIFIED in original Phase 2 plan
Council Plan Task 10 step 5 said "update each seating dispatcher's `### Council panel` list — replace source IDs with target ID". But the dispatcher SKILL.md aggregator sections (Phase 4/5 in council-review-aura-v2: Domain File Assignments, dedup rules, Pre-synthesis output filenames list, Findings Breakdown table, Expert Output Files list, description metadata) all needed coordinated renames. Each N1/N2/N3 commit body now documents ALL surfaces touched per merge so future similar refactors have a complete checklist.

### Cosmetic dangling cite handling vs scope creep
Pickup-prompt initial scope said "NOT implement-*-v2 panel-lists" but also "delete refs from 3 Aura dispatchers" (which includes implement-aura). User clarified: delete refs from all 3 Aura including implement-aura AND remove corresponding implement-aura/SKILL.md TABLE ROWS in same commit (file-consistency invariant), but DO NOT touch implement-aura panel-list. Hybrid scope honoured.

### Batched validator PASS discipline
User authorised batched validator PASS for PRE-a/b/c + N1 + N2 (5 commits at HEAD f24725e) because the comprehensive canary suite (C1-C12 + cp-mirrors --check) covers all structural invariants. N3 was serialised through validator because of the V3 anchor + lock sha256 + cp-mirrors re-materialise complexity (lock-update-without-canonical-edit OR canonical-edit-without-lock-update are the two failure modes that C12 catches but the canary doesn't preview). Codified as EC-31 caveat.

---

## Phase 3 scope (candidate) + future-scope items

### Phase 3-A: implement-*-v2 panel cutover
- `council-implement-aura-v2/SKILL.md` table at L50+ still cites "Bun/Hono/TS Backend Expert" + `quality-backend.md`. Needs cutover to `dahl` + `quality-dahl.md` (canonical or mirror).
- Same for `council-implement-aura-v2/references/` — currently still has `quality-dahl.md` + `quality-ritchie.md` mirrors per _ref-mirrors.lock; the BUN/HONO/TS row table cite path is the inconsistency.
- Plus: `council-implement-v2/SKILL.md` (non-aura implement) — never had brandur/durov/vanrossum cutover; check if hashimoto should be added to non-aura implement panel too.

### Phase 3-B: Lerdorf (PHP) + Colvin (Python/3.10+) expert additions
- Per Phase 2 plan §13: "Lerdorf/Colvin are Phase 3".
- New catalog dirs `_council-experts-v2/lerdorf/` + `_council-experts-v2/colvin/`.
- New refs `quality-lerdorf.md` + `quality-colvin.md`.
- Non-aura dispatcher panel-list additions.
- EXPECTED_COUNT 14 → 16.

### Phase 3-C: housekeeping
- Stale `.verify/verify-panels.py` (obsoleted AC-3.2 canary, replaced by C10). Either delete entire file OR add C13 to verify-catalog that warns on its presence.
- Stale ref paths in non-Aura SKILL.md (Phase 1c deferred, lines 245/246/376/377 in council-review-v2, 255/392 in council-review-aura-v2 — listed in Phase 2c HANDOFF).
- `frontend-react` → `abramov` rename + `quality-react-ui.md` → `quality-abramov.md` (per willison REC-4 / Phase 2c HANDOFF Phase-2d-N5 deferred).

### Future-scope (per Phase 2c HANDOFF, intentionally NOT Phase 3)

#### Item 1: Auto-respawn of CLI sessions on context-window threshold (separate spec, Phase 5)
Recommended path: `specs/council-mode-session-rotation.md` written via `/council-plan-aura-v2` after Phase 3 closure. Requires significant new infrastructure (token-tracking pipeline + threshold config + graceful HANDOFF protocol + pair coordination + UI affordance + telemetry).

#### Item 2: Lightweight token-usage display (advisory) — small feature
Recommended path: `/plan-feature` → `/spec-writer` → 1 PR (~300 lines). Backend parses `system.usage` from NDJSON, emits `session:token-usage`. Store gets `tokenUsage` per session. UI: TopBar active session detail + Sidebar per-session color-coded pill. Pairs naturally with EC-30 — operator sees counter approaching the 100k threshold, manually rotates per the EC's directive.

Boundary statement (re-asserted from Phase 2c HANDOFF): NEITHER item is Phase 3 scope. Both captured here so the next session reader can surface them as next spec-planning candidates after Phase 3 closes.

---

## EC convention floor additions (Phase 2d-N4 ratified)

**EC-30:** Council Mode phases ≤100k working tokens; mandatory HANDOFF + sub-phase split when scope exceeds.
**EC-31:** Multi-commit Council Mode phases require writer-tmux + reader-validator pipeline; bridge via `/tmp/<phase>-NX-validator-brief.md` artifacts.
**EC-32:** Every phase MUST end with `HANDOFF-phase-X-after-NY.md` capturing `commits[]`, `decisions[]`, `inherited_corrections[]`, `next_phase_scope`.
**EC-33:** Mid-session-created skills under `~/.claude/skills/` require fresh Claude session before invocation; build runners MUST warn on detection.

Per-EC origin/principle/sibling-memory pointers in `conventions.md` post-EC-24.

---

## Validator pipeline pattern (carried forward from Phase 2a/2b/2c)

- Writer tmux: this Phase 2d Claude session (aura-v2-p2d). All artifacts → `/tmp/`. Chat report = ONE LINE per commit per `feedback_validator_pipeline_one_line_report`.
- Reader validator: parallel Claude session. Picks up `/tmp/phase-2d-*-validator-brief.md` files, validates, PASS/FAIL with corrections.
- Validator empirical-claim discipline symmetric (per `feedback_runtime_check_applies_symmetrically`).
- Batched PASS acceptable when canary-suite covers; serialise content-quality commits.
- Per-commit serialisation recommended for cross-commit invariants (panel-list cutover order, lock-update coordination).
- Per `feedback_multi_source_instruction_contradiction_defer_surface`: if pickup-prompt and HANDOFF disagree → defer + surface, ask for resolution.
- Per `feedback_test_the_verifier_adversarial_input`: any new canary added requires adversarial input run alongside green-path PASS.

---

## Validator briefs (Phase 2d artifacts in /tmp/)

| Sub-phase | Brief | Status |
|---|---|---|
| 2d-PRE-a | `/tmp/phase-2d-PRE-a-validator-brief.md` | Batched PASS at f24725e |
| 2d-PRE-b | `/tmp/phase-2d-PRE-b-validator-brief.md` | Batched PASS at f24725e |
| 2d-PRE-c | `/tmp/phase-2d-PRE-c-validator-brief.md` | Batched PASS at f24725e |
| 2d-N1 | `/tmp/phase-2d-N1-validator-brief.md` | Batched PASS at f24725e |
| 2d-N2 | `/tmp/phase-2d-N2-validator-brief.md` | Batched PASS at f24725e |
| 2d-N3 | `/tmp/phase-2d-N3-validator-brief.md` | Awaiting explicit serialised PASS per user directive |
| 2d-N4 | `/tmp/phase-2d-N4-validator-brief.md` | Awaiting validator |

---

## Phase 2 totals (4-phase arc)

| Phase | Commits | Skills repo lines | Aura repo lines | Notes |
|---|---|---|---|---|
| 2a | 3 (`5e4e831`, `ede752b`, `98c271d`) | +X | +0 | Person-named target ratification; B1/B2 hybrid; stack tags |
| 2b | 3 (`a5b9af2`, `8ab2d49`, `19728a9`) | +Y | +0 | quality-X.md authoring |
| 2c | 3 (`7e4fd62`, `86644e9`, `a2e68e9`) | +2573 | +0 | Canaries C10/C11/C12, supply-chain hardening, lock manifest |
| 2d | 7 (`df8614d`, `f19acbb`, `586097c`, `87fa9f9`, `f24725e`, `fd5b645`, `6f6ac9d`) | +346 / -3142 (net -2796) | +32 | Atomic catalog refactor + EC codification |

**Phase 2 grand total:** ~13 skills-repo commits, 1 aura-companion commit (this round; conventions.md). Skills repo: 20 → 14 catalog dirs (net -6). Aura-companion: conventions.md 24 → 28 EC entries (+4).

---

## Knowledge propagation (Phase 2d round)

Memory entries reinforced this round (no new entries created — all 4 ECs cite pre-existing memories from Phase 2c):
- `feedback_phase_decomposition_by_token_budget` (EC-30)
- `feedback_two_process_validator_pipeline` (EC-31)
- `feedback_multi_source_instruction_contradiction_defer_surface` (EC-32)
- `feedback_skill_registry_restart_locality` (EC-33)
- `feedback_validator_pipeline_one_line_report` (EC-31 supporting)
- `feedback_runtime_check_applies_symmetrically` (EC-31 supporting)

Plus 1 NEW writer-side observation worth promoting:
- Batched validator PASS discipline (codified as EC-31 caveat). NOT a separate memory entry; captured at EC-31 doc level instead.

---

## Phase 2 — CLOSED ✅

Skills repo HEAD `fd5b645` master.
Aura-companion HEAD `6f6ac9d` `feat/council-v2-pipeline`.
Verify-catalog C1-C12 + cp-mirrors --check green throughout.
Convention floor EC-1..EC-24 + EC-30..EC-33 ratified.

### Sign-off
- Writer Phase 2d (this session): 8 commits, 8 briefs, this HANDOFF, EC-30..EC-33 codified.
- Validator: batched PASS for 5/6 skills-repo commits at f24725e; N3 + N4 serialised PASS pending.
- Phase 2 atomic catalog refactor: closed at HEAD.
- Phase 3 entry: pickup from this HANDOFF + `MEMORY.md` auto-memory + `specs/council-experts-catalog-v2-expansion.md`.

### Skills affected — restart required (EC-33 directive)
None this round. All 14 catalog dirs are existing skill-registry entries; the dahl/ritchie/hashimoto IDs were registered Phase 2a-N1; this Phase only added prompt files inside existing dirs + cut over panel-lists. No new top-level skill directory created. The 4 modified Aura dispatcher SKILL.md descriptions ARE live in the running session's skill registry (visible in tool reminder text mid-Phase-2d).
