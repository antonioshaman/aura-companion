# HANDOFF: Council Mode v2 — Phase 2c complete → Phase 2d entry

## State on 2026-05-16 (after N3)

- **aura-companion branch:** `feat/council-v2-pipeline` (no new aura-companion commits in Phase 2c — Phase 2c lives entirely in the skills repo; only HANDOFF + commit briefs are aura-companion-side artifacts).
- **Skills repo HEAD:** `a2e68e9` (Phase 2c-N3 complete). All git ops from auracomp: `sudo -u auracomp git -C /home/auracomp/.claude/skills <cmd>`. Identity via `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars (`git config` is OFF-LIMITS per safety rule).
- **Archive tag (rollback target):** `council-v1-archive-20260516` (unchanged from Phase 0; pre-Phase-2 baseline).
- **Predecessor HANDOFF:** `/root/aura-companion/HANDOFF-phase-2b-after-N3.md` (Phase 2b: 3 quality-X.md drafted at canonical seats).
- **Plan output:** `/tmp/phase-2-council-plan-output.md` (Tasks 7/8/9 LANDED in Phase 2c; Task 10 = Phase 2d).

## Phase 2c complete: 3/3 commits

| Sub-phase commit | SHA | Sub-task | Lands |
|---|---|---|---|
| 2c-N1 | `7e4fd62` | Task 7 — semantic-coverage canary | `_council-experts-v2/.verify/_phase2-coverage-tokens.yml` (ground-truth: 46 source-attributed tokens + 5 structural anchors + 1 forbidden pattern) + verify-catalog.sh C10 (Python heredoc with `timeout 10` per grep, `_SAFE_REGEX_ATOM` shape filter, argv-form). ReDoS hardening triple-layered (kind=fixed default + safe-shape filter + subprocess timeout). |
| 2c-N2 | `86644e9` | Task 8 — catalog supply-chain hardening + B2 cp runner | `cp-mirrors.py` (514 lines): single source of `ID_REGEX` + `REF_PATH_REGEX`; schema validates `_phase2-merges.yml` with closed key sets; realpath-bounded; atomic `O_CREAT\|O_EXCL` + `fsync` + `os.replace`; three modes (default materialise / `--check` / `--selftest`). Materialised 4 hashimoto dispatcher mirrors (sha256 `f51e11...`). C11 added to verify-catalog.sh; 4 call-site ID-regex enforcement; ownership + mode floor; B2 byte-identity gate. |
| 2c-N3 | `a2e68e9` | Task 9 — author-attestation manifest | `_ref-mirrors.lock` (50 lines, 3 mirror sets × `(target, canonical.{path,sha256}, mirrors[])`); 11 `<!-- canonical-source: <path> -->` HTML-comment markers prepended atop all `quality-X.md` files (3 dahl + 3 ritchie + 5 hashimoto). Marker text IDENTICAL within each set → byte-identity preserved. C12 added: independent of C11 — C12 pins canonical sha256 at lock time, fails on canonical OR mirror drift. |

**Validator briefs** (writer-tmux + reader-validator pattern; one-line writer report per `feedback_validator_pipeline_one_line_report`):
- `/tmp/phase-2c-N1-validator-brief.md` — validator PASS (independent rerun reproduced 46/5/1 banner).
- `/tmp/phase-2c-N2-validator-brief.md` — validator PASS (independent rerun reproduced 4-call-site + 1 B2 / 4 mirrors banner + sha256-set-=1-unique).
- `/tmp/phase-2c-N3-validator-brief.md` — PASS pending validator independent confirmation (3 mirror sets / 8 mirrors / 3 canonicals — lock attestation green).

verify-catalog.sh: **C1-C12 all green** throughout (Phase 2c steady-state EXPECTED_COUNT = 20).

## Post-Phase-2c canonical sha256 (at lock time)

| Target | Canonical path | sha256 |
|---|---|---|
| `dahl` | `council-review-aura-v2/references/quality-dahl.md` | `8006a3c8e5b6a76b4dbd37de05b6859c44de4c4c640200c88f9abe399d3f440c` |
| `ritchie` | `council-review-aura-v2/references/quality-ritchie.md` | `d2c74c78a56dc86f8e9dc350cf2c12819951372662ca49996b38f28361e12ef2` |
| `hashimoto` | `_council-experts-v2/hashimoto/references/quality-hashimoto.md` | `cd46dbedfb646d8c854d0872b8657c22a5710e262fcd7aac7260f42188c54f29` |

Hashimoto sha256 differs from Phase 2b-N3's `f51e1182...` by 1 line (the prepended HTML marker). All 5 hashimoto files (1 canonical + 4 mirrors) now share the new hash via IDENTICAL marker text.

## Inherited corrections honoured this round

### Carried forward from Phase 2a/2b (re-asserted; no new info)
- **hashimoto seat count = 4 dispatchers** (NOT 6). N2's `cp-mirrors.py` materialised exactly 4 (`plan`, `plan-aura`, `review`, `review-aura`); N3's lock attests the same 4. Adding a 5th would trigger BOTH C2 (panel missing) AND C12 (lock missing entry) — twin canaries on the same invariant.
- **vanrossum co-tenancy on `quality-backend.md`** — Phase 2c-N1 C10 forbidden pattern (`Bun\.serve|Hono|web/server`) enforces ZERO across 6 dispatcher mirrors, post-Phase-2b-N1 rewrite. Verified empirically per dispatcher path.

### NEW corrections / resolutions this round
- **Ref-path regex relaxation (HANDOFF-style ambiguity surfaced in N2):** Council plan §8 cited `^[a-z][a-z0-9-]{0,63}(/[a-z][a-z0-9_.-]{0,63})*$` (first segment strict, no leading `_`). But concrete canonical `_council-experts-v2/hashimoto/references/quality-hashimoto.md` starts with `_` (Phase 1 naming reserves leading-`_` for infrastructure dirs). N2 relaxed first-segment to `[a-z_][a-z0-9_-]{0,63}` — pragmatic given concrete path under audit. Surfaced explicitly in commit body + brief per `feedback_multi_source_instruction_contradiction_defer_surface`. NOT silently broadened. Phase 2d author should NOT flip this back without proposing an alternative canonical-path convention.
- **Section ordering bug pre-commit (caught in N3 authorship):** intermediate state had C12 inserted BEFORE C11 in verify-catalog.sh (numeric out of order). Caught via `grep -n '^echo "===' verify-catalog.sh` pre-commit numeric scan; fixed via Python atomic file rewrite (swap block boundaries). Lesson: when adding sequential `echo "=== C<N>: ..."` sections to a verifier, ALWAYS grep section numbering before commit — cheap, mechanical, prevents shipped order bugs.
- **C11 vs C12 — independent-gate design (N3 codification):** C11 only covers B2 byte-identity (mirrors==canonical at present state, no pinned hash). C12 pins canonical sha256 at lock time → catches single-mirror tamper without lock update. The mirror-drift adversarial test in N3 brief is the precise empirical proof of asymmetry — C11 stays green for B1 drift, C12 catches it. Double-gate against prompt-injection-as-supply-chain (hunt REC-7).

## Token-budget discipline (codification for Phase 2d + future)

Token-window pressure emerged organically in Phase 1/2 work (Phase 2 plan-gen hit 190k → forced restart; Phase 2 implementation split into 2a/2b/2c/2d for emergent token-budget reasons). Captured as universal KB memory: `feedback_phase_decomposition_by_token_budget.md` (propagated to all 12 `/root/.claude/projects/*/memory/` dirs by validator side).

### EC convention floor additions for Council Mode v2 (Phase 2d task)

Add to `/root/aura-companion/conventions.md` (or `specs/council-mode-bidirectional-pipeline.md` depending on which is canonical):

- **EC-30 Token budget discipline.** Каждая Council Mode phase должна fit в ≤100k working tokens включая reads of artifacts + plan + spec. Если scope exceeds, MANDATORY split на sub-phases с HANDOFF между.

- **EC-31 Validator-pipeline pattern для multi-commit phases.** Writer-tmux + reader-validator в parallel sessions, мост через `/tmp/<phase>-NX-validator-brief.md`. Не один-process loop. См. `feedback_two_process_validator_pipeline`.

- **EC-32 HANDOFF as inter-phase context boundary (mandatory).** Every phase MUST end с `HANDOFF-phase-X-after-NY.md` capturing: `commits[]`, `decisions[]`, `inherited_corrections[]`, `next_phase_scope`. Next phase starts от HANDOFF + memory, NEVER от previous Claude session memory.

- **EC-33 Skill-registry restart locality.** Mid-session-created skills (cp в `~/.claude/skills/`) require fresh session to invoke. Build runners (e.g., `cp-mirrors.py`) должны emit warning "skill X created — restart required для invoke" если detect new skill directory. См. `feedback_skill_registry_restart_locality`.

### Phase 2d task addendum

Phase 2d already has: panel-list cutover + source-dir delete + EXPECTED_COUNT 20→14 + V3 secondary anchor + abramov filename consistency + stale ref paths.

**ADD ONE MORE TASK to Phase 2d scope:**
- **Codify EC-30..EC-33 в `conventions.md`** (или canonical doc по Aura Companion). One commit. Pure doc edit, не code. Low risk. Carries universal KB lesson into project-specific contract.

### Future scope (NEW separate spec, post-Phase-2)

Two candidates surfaced during Phase 2c retrospective. Both are post-Phase-2 work and intentionally not blocking Phase 2d closure. Item 2 is an intermediate, low-risk step that natively complements EC-30..EC-33 codification (Phase 2d-N4); Item 1 is the longer-tail automation arc.

#### Item 1: Auto-respawn of CLI sessions on context-window threshold (Phase 5 spec candidate)

Auto-respawn of CLI sessions (including Council Mode pairs) when approaching context-window threshold. Discussed as architecturally feasible (`cli-launcher --resume` + ws-bridge usage parsing + `session-orchestrator.armReconnect` all existing); needs significant new infrastructure (token-tracking pipeline + threshold config + graceful HANDOFF protocol + pair coordination async/sync + UI affordance + telemetry).

Recommended path: separate new spec `specs/council-mode-session-rotation.md` written via `/council-plan-aura-v2` after Phase 2 closure. Implementation as part of Phase 5 bidirectional pipeline expansion (REST :3457 endpoint already planned — token-budget heartbeat fits naturally).

#### Item 2: Lightweight token-usage display (advisory) — separate Aura feature

Immediately after Phase 2 closure, candidate for next small Aura feature (~300 lines, 1 PR):

- **Backend** (`web/server/ws-bridge.ts`): parse `system.usage` field from NDJSON stream, accumulate per-session total = input + cache_read + output. Emit `session:token-usage` event to browser.
- **Store**: add `tokenUsage` per session in `sessions-slice`.
- **UI** (recommended A+C combined):
  - TopBar: active session detail "Tokens: 47k / 200k window · recommend rotate at 100k"
  - Sidebar: per-session color-coded pill (green <100k / yellow 100-150k / orange 150-180k / red >180k)
  - Optional: ObserverPanel pair-health side-by-side for Council pairs (both halves independently tracked)
- **Tests**: Vitest + axe per CLAUDE.md component test policy.

Advisory only — does NOT auto-rotate. Operator sees counter approaching threshold, manually rotates (current Phase 2d-onwards workflow with HANDOFF + new tmux). Pairs naturally with EC-30..EC-33 codification — the EC's say "rotate at 100k", and the UI helps operator see when.

Scope-wise this is its own feature (not Phase 2). Recommended path:
  - `/plan-feature` → `/spec-writer` → implementation in 1 PR
  - OR (light treatment) just `/build-feature` directly if scope is clear.

This is the intermediate step between doc-only EC's (Phase 2d-N4 task) and full auto-respawn (Item 1's Phase 5 spec work) — gives operator proactive visibility without yet building automation.

#### Boundary statement

NEITHER item is Phase 2d scope. Both captured here so Phase 2d HANDOFF reader can surface them as next spec-planning candidates after Phase 2 closes. Recommended sequencing: Item 2 first (small, low-risk, complements EC codification, ships in one PR), then Item 1 (larger, needs spec + multi-PR implementation arc, depends on Phase 5 REST :3457 infra).

## Phase 2d entry — first action

**Next session:** new tmux session (e.g. `aura-v2-p2d`), new Claude instance, reads:
- THIS HANDOFF.
- `/tmp/phase-2-council-plan-output.md` (Task 10 — atomic deletion sequence; per-merge ordering 1-8).
- Previous Phase 2c validator briefs (`/tmp/phase-2c-N{1,2,3}-validator-brief.md`).

### Phase 2d scope (sequenced; per council plan Task 10 atomic deletion ordering)

Each merge is one commit; Task 10 step ordering must hold WITHIN each commit (SIGTERM-the-citations before SIGKILL-the-files).

| Sub-phase commit | Merge | Steps | EXPECTED_COUNT |
|---|---|---|---|
| 2d-N1 | **dahl** atomic merge | (5) panel-list cutover: `backend-ts`/`realtime-ndjson` → `dahl` in 4 dispatcher panel-lists (plan-v2, plan-aura-v2, review-v2, review-aura-v2 — NOT implement-*-v2); (6) `git rm -r _council-experts-v2/backend-ts/` + `_council-experts-v2/realtime-ndjson/`; (7) delete obsolete refs `quality-realtime.md` (single-cited); KEEP `quality-backend.md` (vanrossum co-tenant); (8) bump `EXPECTED_COUNT` 20→18 in same commit. C1-C12 green post-commit. | 20 → 18 |
| 2d-N2 | **ritchie** atomic merge | Same 8-step shape: panel-list `subprocess`/`persistence-fs` → `ritchie` in 4 dispatchers; `git rm` source dirs; delete `quality-subprocess.md` + `quality-persistence.md`; bump 18→16. | 18 → 16 |
| 2d-N3 | **hashimoto** atomic merge | Panel-list `deploy-docker-gha`/`deploy-vps` → `hashimoto` in 4 dispatchers; `git rm` source dirs; delete `quality-deploy.md`; bump 16→14. **V3 secondary anchor `feedback_check_supervisor_before_kill` add to quality-hashimoto.md body line ~288 (HANDOFF condition "if touching the file anyway" met — panel-list cutover legitimately resyncs hashimoto.md body).** Re-materialise via `cp-mirrors.py` (5 mirrors all bump to new sha); bump pinned sha256 in `_ref-mirrors.lock` (3-file coordinated: canonical + 4 mirrors via runner + lock manually). | 16 → 14 |
| 2d-N4 | **convention codification** | Add EC-30..EC-33 to `conventions.md` (or `specs/council-mode-bidirectional-pipeline.md`). Pure doc commit, no code. | 14 (unchanged) |
| 2d-N5 (optional) | **rename + stale refs cleanup** | `frontend-react` → `abramov` rename (review-aura split filename consistency per willison REC-4 / `quality-react-ui.md` → `quality-abramov.md`); stale ref paths in non-Aura SKILL.md (Phase 1c deferred — lines 245/246/376/377 in council-review-v2, 255/392 in council-review-aura-v2). | 14 |

### Phase 2d verification (per-commit)

After each commit: `bash _council-experts-v2/.verify/verify-catalog.sh` — must stay C1-C12 green throughout. After 2d-N3, expect `cp-mirrors.py --check` to fail UNTIL `_ref-mirrors.lock` sha256 is updated and runner re-run.

After 2d-N3 (V3 anchor add): C10 grep for `feedback_check_supervisor_before_kill` in `quality-hashimoto.md` should return ≥1. Phase 2c added tokens were source-attributed; V3 anchor add does NOT introduce new tokens (anchor is a memory-ID, not a council-plan-derived concern token) — no `_phase2-coverage-tokens.yml` update required unless the validator specifically wants to add a token for V3 traceability.

### Phase 2d gotchas (from N3 retrospective)

- **Section ordering in verify-catalog.sh:** any new section (C13+) must go AFTER C12 and BEFORE `exit $ERR`. Always grep `^echo "===` numeric order pre-commit.
- **Lock manifest updates are 2-file commits minimum:** when canonical changes, BOTH the canonical AND `_ref-mirrors.lock` `canonical.sha256` must update in the same commit. C12 will reject the commit otherwise.
- **Marker text byte-identity:** if Phase 2d edits a `quality-X.md` body (panel-list cutover for hashimoto adds V3 anchor → body mutation), the marker text stays untouched and all 5 hashimoto files re-share the new body hash via `cp-mirrors.py` re-run.

## Validator pipeline pattern (unchanged from Phase 2a/2b/2c)

- Writer tmux: Phase 2d Claude. All artifacts → `/tmp/`. Chat report = ONE LINE per `feedback_validator_pipeline_one_line_report` ("phase 2d-NX done, brief @ /tmp/phase-2d-NX-validator-brief.md").
- Reader validator: parallel Claude session. Picks up `/tmp/` briefs, validates, PASS/FAIL with corrections.
- Validator empirical-claim discipline applies symmetrically (per `feedback_runtime_check_applies_symmetrically`): both writer and validator grep/sha256/exit-code-check every claim BEFORE landing in commit body / brief.
- Per-commit serialization recommended for 2d-N1→N2→N3 (sequential merges interact through dispatcher panel-list state + `_ref-mirrors.lock`).
- Per `feedback_multi_source_instruction_contradiction_defer_surface`: if pickup-prompt and HANDOFF disagree on a concrete action, defer + surface in next brief, ask for resolution. Never silently pick.
- Per `feedback_test_the_verifier_adversarial_input` (newly captured in Phase 2c-N1): for any new canary/verifier added in Phase 2d, run adversarial input alongside green-path PASS. Capture both runs in commit body.

## Knowledge propagation captured this round

Two new universal KB memories propagated to all 13 memory dirs (12 root-side + 1 auracomp-side):

- **`feedback_test_the_verifier_adversarial_input`** (writer-side, N1 round) — "New canary/lint/validator: alongside green PASS run adversarial input proving failures caught. Verifier code has bugs; green PASS vacuous. Setup-side of verify-test-bodies / trust-diff. Universal."
- **`feedback_phase_decomposition_by_token_budget`** (validator-side, codified end-of-Phase-2c) — Token-window pressure as mandatory phase-split trigger; ≤100k working tokens per phase; HANDOFF + memory bridge over Claude session boundaries.
- **`feedback_skill_registry_restart_locality`** (validator-side, codified) — Mid-session-created skills in `~/.claude/skills/` require fresh session to invoke; build runners should warn on detection.

## Phase 2c totals

| Sub-phase | SHA | Files changed | Lines |
|---|---|---|---|
| 2c-N1 | `7e4fd62` | 2 | +262 / -0 |
| 2c-N2 | `86644e9` | 8 | +2165 / -0 |
| 2c-N3 | `a2e68e9` | 13 | +146 / -0 |

Total: 23 skills-repo file mutations + 11 file marker-prepends. +2573 / -0. Aura-companion repo: 0 commits (this HANDOFF is uncommitted-WIP; writer's discretion whether to commit it to aura-companion's `feat/council-v2-pipeline`).

## Session wrap protocol

- This session: writer of Phase 2c (3 commits, 3 briefs, this HANDOFF, 1 writer-side KB memory propagated to 13 memory dirs, 2 validator-side KB memories carried-forward).
- Phase 2c sign-off: validator PASS on N1 + N2; N3 awaits independent confirmation.
- Next session: writer of Phase 2d. Cadence: one sub-phase per session per Phase-2d 4-or-5-sub-phase split (depending on optional 2d-N5).
- Skills repo `feat/council-v2-pipeline` doesn't exist — Phase 2 lives on `master` of the skills repo.
- This HANDOFF lives in aura-companion repo so successor session has stable read path. `git add HANDOFF-phase-2c-after-N3.md` in aura-companion is writer's call (separate aura-companion commit, NOT a Phase 2c deliverable).
