# HANDOFF: Council Mode v2 — Phase 2b complete → Phase 2c entry

## State on 2026-05-16 (after N3)

- **aura-companion branch:** `feat/council-v2-pipeline` (no new aura-companion commits in Phase 2b — Phase 2b lives entirely in skills repo; only this HANDOFF + commit briefs are aura-companion-side artifacts).
- **Skills repo HEAD:** `19728a9` (Phase 2b-N3 complete). All git ops from auracomp: `sudo -u auracomp git -C /home/auracomp/.claude/skills <cmd>`. Identity via `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars (`git config` is OFF-LIMITS per safety rule).
- **Archive tag (rollback target):** `council-v1-archive-20260516` (unchanged from Phase 0; pre-Phase-2 baseline).
- **Predecessor HANDOFF:** `/root/aura-companion/HANDOFF-phase-2a-after-N3.md` (Phase 2a inheritance corrections + Phase 2b scope).
- **Plan output:** `/tmp/phase-2-council-plan-output.md` (still valid; Tasks 4/5/6 LANDED in Phase 2b; Tasks 7/8/9/10 PENDING).

## Phase 2b complete: 3/3 commits

| Sub-phase commit | SHA | Sub-task | Lands |
|---|---|---|---|
| N1 | `a07d64d` | Task 4 (dahl) | `quality-dahl.md` × 3 byte-identical Aura dispatcher mirrors (B1) + `quality-backend.md` rewrite × 6 dispatcher mirrors (framework-neutral, vanrossum co-tenancy preserved). ZERO `Bun.serve\|Hono\|web/server` canary clean post-rewrite. |
| N2 | `8ab2d49` | Task 5 (ritchie) | `quality-ritchie.md` × 3 byte-identical Aura dispatcher mirrors (B1) with literal `## §A Process lifecycle` + `## §B Filesystem persistence` partition headers. Two parallel severity ladders + two parallel overriding filters inside one doc. |
| N3 | `19728a9` | Task 6 (hashimoto) | `quality-hashimoto.md` × 1 canonical at catalog-side B2 location (`_council-experts-v2/hashimoto/references/quality-hashimoto.md`). 10 deploy-docker-gha principles VERBATIM + 6 VPS-systemd compensate-authored facets with HANDOFF-aligned footnote wording. NO manual cp to dispatcher mirrors this phase. |

**Validator briefs** (writer-tmux + reader-validator pattern; one-line writer report per `feedback_validator_pipeline_one_line_report`):
- `/tmp/phase-2b-N1-validator-brief.md` — validator PASS (6/6 invariants green)
- `/tmp/phase-2b-N2-validator-brief.md` — validator PASS + N3 ambiguity resolution ("HANDOFF wins")
- `/tmp/phase-2b-N3-validator-brief.md` — PASS pending validator independent confirmation

verify-catalog.sh: 9/9 canaries green throughout (Phase 2b steady-state EXPECTED_COUNT = 20).

## Inherited corrections surfaced (and HONOURED) this round

### Carried forward from Phase 2a (re-asserted; no new info)

- **hashimoto seat count = 4 dispatchers** (NOT 6). Council-implement-*-v2 panels were deliberately NOT seated with deploy-* in Phase 1; hashimoto inherits that asymmetry. Phase 2b-N3 honoured this by writing canonical only — Phase 2c Task 8 build runner will cp to 4 mirrors (plan-aura, review-aura, plan, review), NOT 6.
- **quality-backend.md SURVIVES (vanrossum co-tenant).** N1 rewrite preserved the file framework-neutral across all 6 dispatcher seats. Bun content migration was one-way → quality-dahl.md only. ZERO `Bun.serve\|Hono\|web/server` canary enforces mechanically.

### NEW corrections / resolutions this round

- **Phase 2b-N3 pickup-prompt vs HANDOFF ambiguity (cp now vs cp later):** Pickup-prompt said "cp to 4 dispatcher mirrors". HANDOFF-phase-2a-after-N3 said "canonical ONLY this phase; cp deferred to Phase 2c Task 8 build runner". Validator resolution: **HANDOFF wins.** Rationale captured in [[feedback_multi_source_instruction_contradiction_defer_surface]] (UNIVERSAL — propagated to all `/root/.claude/projects/*/memory/` dirs this session). The validator self-attributed this as their own pickup-prompt error.
- **Footnote wording divergence:** Council plan + HANDOFF say `(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)` (with "perspective"); pickup-prompt dropped "perspective". Per "Honor HANDOFF" rule, N3 used "perspective" wording. Phase 2c canary author should grep for the WITH-perspective form.
- **V3 anchor name substitution:** Pickup-prompt anchored facet V3 to `feedback_check_supervisor_before_kill`. The substantively-equivalent memory used at N3 was `feedback_process_ancestry_check_before_parent_restart` (process-ancestry-walk before parent-restart). Validator confirmation post-N3: BOTH memories exist; ancestry-walk gives sensible V3 anchor, but supervisor-before-kill would be the literal facet-title match. **NON-BLOCKING follow-up for Phase 2c:** add `feedback_check_supervisor_before_kill` as V3 secondary cross-ref in hashimoto.md body — both anchors usefully reinforce the facet. Phase 2c canary author should grep for BOTH anchor names OR be path-agnostic on cross-references.

## Phase 2c canary path convention (CAPTURED for Phase 2c writer)

The Phase 2c Task 7 semantic-coverage canary MUST grep different paths depending on the per-expert B1/B2 split (ratified in Phase 2a-N2). Uniform catalog-side path would 404 for dahl and ritchie.

| Expert | Convention | Canary grep target | Mirror count |
|---|---|---|---|
| **dahl** | B1 (no catalog-side `references/` dir) | `council-{plan,review,implement}-aura-v2/references/quality-dahl.md` | 3 (Aura only) |
| **ritchie** | B1 (no catalog-side `references/` dir) | `council-{plan,review,implement}-aura-v2/references/quality-ritchie.md` | 3 (Aura only) |
| **hashimoto** | B2 (catalog-side canonical) | `_council-experts-v2/hashimoto/references/quality-hashimoto.md` (canonical) | 1 + 4 mirrors (mirrors materialized by Phase 2c Task 8 build runner) |

**Rationale for hashimoto-canonical-not-mirrors grep target:** the 4 mirrors are derived from canonical by Task 8 build runner; canary against canonical avoids verification cycle on cp output. Mirrors must equal canonical sha256; the cp + `git diff --exit-code` CI gate (per council plan Task 2's B2 design) is the byte-identity enforcement, not the semantic-coverage canary.

### Phase 2c semantic-coverage canary literal anchors (Task 7 implementation reference)

These are the structural canary anchors the Phase 2c writer needs to grep:

```bash
# ritchie two-lens partition (subprocess REC-1 / council plan Risks)
grep -cF '## §A Process lifecycle' .../quality-ritchie.md      # expect 1 per mirror
grep -cF '## §B Filesystem persistence' .../quality-ritchie.md # expect 1 per mirror

# hashimoto compensate-authored footnote (council plan Task 6 / willison REC-6)
grep -cF '(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)' \
  .../quality-hashimoto.md  # expect ≥6 (6 facet headers; 2 additional meta-prose references are OK)

# backend.md vanrossum-co-tenancy canary (council plan Risks)
grep -cE 'Bun\.serve|Hono|web/server' .../quality-backend.md  # expect 0 per mirror

# dahl §A/§B structural (sibling of ritchie's partition; NOT required by council plan but used for clarity)
grep -cF '## §A Bun/Hono runtime surface' .../quality-dahl.md  # expect 1 per mirror
grep -cF '## §B NDJSON/WS protocol correctness' .../quality-dahl.md  # expect 1 per mirror
```

Phase 2c Task 7 ground-truth lives at `_council-experts-v2/.verify/_phase2-coverage-tokens.yml` per council plan; each anchor above should appear as a token entry there.

## Phase 2c entry — first action

**Next session:** new tmux session (e.g. `aura-v2-p2c`), new Claude instance, reads:
- THIS HANDOFF.
- `/tmp/phase-2-council-plan-output.md` (Tasks 7, 8, 9 sections — Task 10 is Phase 2d).
- Previous Phase 2b validator briefs (`/tmp/phase-2b-N{1,2,3}-validator-brief.md`).

### Phase 2c scope (3 medium commits)

| Sub-phase commit | Task | Lands |
|---|---|---|
| 2c-N1 | Task 7 — semantic-coverage canary | `_council-experts-v2/.verify/verify-catalog.sh` extension (new section "=== C10: semantic-coverage canary ===") + `_council-experts-v2/.verify/_phase2-coverage-tokens.yml` ground-truth. Grep-based; ReDoS-safe (`grep -F` default OR anchored regex over `\w+` placeholders per `feedback_static_grep_canary_regex_over_substring`); always double-quote `"$concern"` and `"$file"`; per-needle `timeout 10s`. Per-token whitelist counts per source-expert: backend-ts ≥10 clusters, realtime-ndjson ≥9 clusters, subprocess ≥10 named failure-mode tokens, persistence-fs ≥10 principle-keys, deploy-docker-gha ≥7 P1-severity-floor entries. Use the path convention table above. |
| 2c-N2 | Task 8 — catalog supply-chain hardening | `_phase2-merges.yml` schema validation (Zod or equivalent; `additionalProperties: false`; allow-listed targets/sources; ref-path regex `^[a-z][a-z0-9-]{0,63}(/[a-z][a-z0-9_.-]{0,63})*$`; reject `..`/leading-`/`/`~`/`$`/NUL). B2 build-time `cp` resolves both src and dst against catalog root realpath, rejects path-escape, spawns with `shell: false` + argv array. Expert-ID regex `^[a-z][a-z0-9-]{1,31}$` enforced at YAML parse + mkdir + panel-list parse + canary target lookup (4 call-sites per `feedback_call_site_presence_not_just_symbol_export`). Startup assertion that catalog dir is owned-by-or-readable-to agent uid (mode floor: refs `0644`, catalog dir `0755`, `_phase2-merges.yml` `0644` owned by skill-home owner). The B2 cp runner is part of this task — first running materializes hashimoto's 4 dispatcher mirrors. |
| 2c-N3 | Task 9 — author-attestation manifest | Every new `quality-<target>.md` carries top-of-file `<!-- canonical-source: ... -->` marker. `_council-experts-v2/.verify/_ref-mirrors.lock` records `(canonical-path, sha256, mirror-paths[])`. `verify-catalog.sh` recomputes hashes, rejects on mismatch. Note: dahl + ritchie are B1 → canonical-path = dispatcher seat; pick one (e.g. council-review-aura-v2 seat) as canonical-marker target. hashimoto is B2 → canonical-path = `_council-experts-v2/hashimoto/references/quality-hashimoto.md`. The lock file lists 3 mirrors for dahl, 3 for ritchie, 4 for hashimoto (the canonical sits OUTSIDE the mirror list per B2 design). |

### Phase 2c verification (per-commit)

After each commit: `bash _council-experts-v2/.verify/verify-catalog.sh` — must stay green throughout. EXPECTED_COUNT remains 20 (Phase 2c doesn't add/remove catalog dirs; deletions are Phase 2d).

After 2c-N2 (Task 8): the B2 cp runner's first run materializes hashimoto's 4 mirrors. Verify:
```bash
sudo -u auracomp sha256sum \
  ~/.claude/skills/_council-experts-v2/hashimoto/references/quality-hashimoto.md \
  ~/.claude/skills/council-{plan,plan-aura,review,review-aura}-v2/references/quality-hashimoto.md \
  | awk '{print $1}' | sort -u | wc -l
# expect 1 (canonical + 4 mirrors all byte-identical)
```

After 2c-N3 (Task 9): `verify-catalog.sh` runs hash recomputation; mutating any single mirror by 1 byte should fail the lock check.

## Validator pipeline pattern (unchanged from Phase 2a/2b)

- Writer tmux: Phase 2c Claude. All artifacts → `/tmp/`. Chat report = ONE LINE per `feedback_validator_pipeline_one_line_report` ("phase 2c-NX done, brief @ /tmp/phase-2c-NX-validator-brief.md").
- Reader validator: parallel Claude session. Picks up `/tmp/` briefs, validates, PASS/FAIL with corrections.
- Validator empirical-claim discipline applies symmetrically (per `feedback_runtime_check_applies_symmetrically`): both writer and validator grep/sha256/exit-code-check every claim BEFORE landing in commit body / brief.
- Per-commit serialization recommended where cp pipeline + path-allowlist + canary writes interact (validator's directive on N2→N3 still applies to N2→N3 in 2c due to shared `_phase2-merges.yml` surface).
- **NEW from Phase 2b round** (per [[feedback_multi_source_instruction_contradiction_defer_surface]]): if pickup-prompt and HANDOFF disagree on a concrete action, defer + surface in next brief, ask for resolution. Never silently pick.

## Knowledge propagation captured this round

- **`feedback_multi_source_instruction_contradiction_defer_surface`** (NEW from N3 ambiguity round):
  > Two instruction sources (HANDOFF + pickup-prompt, spec + PR description, linter + style-guide) disagree on a concrete action — defer the contested action, surface the contradiction in next brief/PR/log, ask for resolution. Silent picking creates ghost contracts. Universal sibling of `pushback-is-not-correction` + `handoff-narrative-vs-runtime-state`.
  > **Propagated to 12 `/root/.claude/projects/*/memory/` dirs + auracomp's project memory.** Initial run: one dir (`/root/.claude/projects/-root/memory/MEMORY.md`) is root-owned 644 → index-append blocked for auracomp uid; file itself landed. Validator-side cleanup post-N3: ran sudo to sync the missing index line → all 12/12 root MEMORY.md indexes + auracomp index now contain the entry. No further cleanup needed.

## Phase 2c optional refinements (NON-BLOCKING; carry forward if economical)

- **V3 secondary anchor in `quality-hashimoto.md`:** add `[[feedback_check_supervisor_before_kill]]` as secondary cross-ref alongside the existing `[[feedback_process_ancestry_check_before_parent_restart]]` anchor on facet V3. Both memories exist and usefully reinforce the same facet (different framing of the same incident class). Optional; carry forward as a Phase 2c-N1 or Phase 2c-N2 single-line edit if you're touching the file anyway, or defer to Phase 2d as part of the panel-list cutover commit. NOT a blocker for Phase 2b closure.
- **Phase 2c heaviness warning:** Phase 2c is the heaviest infrastructure phase of the Phase 2 plan (canary script + path-allowlist hardening + `_ref-mirrors.lock` manifest + B2 cp build runner). Consider running with `claude --debug-file /tmp/claude-phase2c-debug.log` for trace if anything misbehaves.

## Phase 2c deferred (per HANDOFF Phase 2b §"Not in scope")

- Dispatcher panel-list cutover (Phase 2d step 5; replaces `backend-ts`/`realtime-ndjson`/`subprocess`/`persistence-fs`/`deploy-docker-gha`/`deploy-vps` with `dahl`/`ritchie`/`hashimoto` in 4 dispatcher panel-lists — NOT council-implement-*-v2 per inherited correction)
- Source-dir / source-ref deletion (Phase 2d steps 6-8; deletes `backend-ts/`, `realtime-ndjson/`, `subprocess/`, `persistence-fs/`, `deploy-docker-gha/`, `deploy-vps/` catalog dirs + `quality-realtime.md`/`quality-subprocess.md`/`quality-persistence.md`/`quality-deploy.md` from Aura dispatcher `references/`; bumps `EXPECTED_COUNT` 20→14)
- Stale ref paths in non-Aura SKILL.md (Phase 1c deferred; lines 245/246/376/377 in `council-review-v2`, lines 255/392 in `council-review-aura-v2` cite OLD source IDs `telegram-ux.md`/`backend-python.md`/`a11y.md`). Phase 2d panel-list cutover is the natural landing point.
- review-aura split id↔filename: `frontend-react` renamed to `abramov`; filename was `react-ui.md`. Decision still pending: rename to `abramov.md` for willison REC-4 consistency. Phase 2d.

## Phase 2b totals

| Sub-phase | SHA | Files changed | Lines |
|---|---|---|---|
| 2b-N1 | `a07d64d` | 9 | +2067 / -909 |
| 2b-N2 | `8ab2d49` | 3 | +1404 / -0 |
| 2b-N3 | `19728a9` | 2 | +403 / -0 (1 delete) |

Total: 14 skills-repo file mutations. Aura-companion repo: 0 commits (this HANDOFF is uncommitted-WIP; writer's discretion whether to commit it to aura-companion's `feat/council-v2-pipeline`).

## Session wrap protocol

- This session: writer of Phase 2b (3 commits, 3 briefs, this HANDOFF, 1 KB catch propagated to 13 memory dirs).
- Phase 2b sign-off: validator PASS on N1 + N2; N3 awaits independent confirmation.
- Next session: writer of Phase 2c. Cadence: one sub-phase per session per Phase-2 4-sub-phase split.
- Skills repo `feat/council-v2-pipeline` doesn't exist — Phase 2 lives on `master` of the skills repo.
- This HANDOFF lives in aura-companion repo so successor session has stable read path. `git add HANDOFF-phase-2b-after-N3.md` in aura-companion is writer's call (separate aura-companion commit, NOT a Phase 2b deliverable).
