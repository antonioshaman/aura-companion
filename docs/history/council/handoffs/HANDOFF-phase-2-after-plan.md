# HANDOFF: Council Mode v2 — Phase 2 plan validated → sub-phase 2a entry

## Состояние на 2026-05-16 (evening)

- **Branch:** `feat/council-v2-pipeline` (в `/root/aura-companion`). Без новых коммитов — Phase 2 plan живёт в `/tmp/`, не в repo.
- **Skills repo HEAD:** `874e06b` (Phase 1c complete). Все git-команды от auracomp: `sudo -u auracomp git -C /home/auracomp/.claude/skills <cmd>`.
- **Archive tag (rollback target):** `council-v1-archive-20260516`.
- **Phase 1 HANDOFF (predecessor):** `/root/aura-companion/HANDOFF-council-v2-phase1.md`.

## Phase 2 plan validated (VERDICT: PASS, validator 2026-05-16 evening)

- **Plan output:** `/tmp/phase-2-council-plan-output.md` — 213 lines, sha7 `0aa6e0d7`
- **Brief (corrected during dispatch):** `/tmp/phase-2-arch-question-brief-v2.md` — 147 lines, sha7 `4b18c2a6`
- **Per-expert outputs:** 12 files `/tmp/phase-2-expert-<id>.md` (9 producing, 3 no-rec sentinels)
- **Artifact index:** `/tmp/phase-2-council-artifacts.txt`
- **Scratch (with dispatch-time KB catches):** `/tmp/phase-2-scratch.md`

### Dispatch-time corrections honored

1. **Brief NOTE corrected** — original validator NOTE claimed "backend-ts, deploy-docker-gha, deploy-vps НЕ в aura-v2 panel". Runtime check (`grep -nE` against `council-plan-aura-v2/SKILL.md` lines 153–164) showed 2/3 false. Corrected NOTE: aura-v2 panel has 12 seats; 5 of 6 merge sources directly seated; only `deploy-vps` absent. Brief sha bumped accordingly.
2. **Skill registry locality** — `/council-plan-aura-v2` lives at `/home/auracomp/.claude/skills/` but runtime reads `/root/.claude/skills/` (root-side only has v1 `council-plan`). Workflow executed inline; output identical to skill-tool dispatch.
3. **`quality-backend.md` keep** — confirmed in Tasks 4 + 8 + Risks (vanrossum co-tenancy invariant).
4. **hashimoto VPS compensation** — Task 6 mines memory feedback corpus (`feedback_systemctl_edit_drops_below_marker`, `feedback_service_user_vs_config_user_divergence`, `feedback_check_supervisor_before_kill`, `feedback_running_build_vs_disk_build`) as institutional knowledge for unseated `deploy-vps`.

### Council expansion of validator framing (PASS, accepted)

Validator pre-brief framing: hashimoto stays Aura-only (`meta.yaml.stack: [aura, common]` or `[aura]`).
Council REC (deploy-docker-gha REC-5, source authority for hashimoto): `meta.yaml.stack: [common]`. Routing semantics: seating is dispatcher-list-driven; tag should report routing capability, not heritage. Validator accepted on source-authority reasoning. See Risks for friedman's dev-UX dissent.

## 5 sub-task decisions ratified

| Sub-task | Decision | Convergence |
|---|---|---|
| A (per-merge α/β/γ) | **γ for all 3** (dahl, ritchie, hashimoto) | UNANIMOUS — 7 producing seats |
| B (canonical ref location) | **HYBRID: B2 for hashimoto only; B1 for dahl/ritchie** | deploy-docker-gha + fowler + willison + persistence-fs split honoured |
| C (semantic-coverage canary) | **Grep + regex tokens + ground-truth YAML + ReDoS-safe + optional LLM-grader artifact** | 7 seats converged |
| D (hashimoto stack tag) | **`[common]`** | deploy-docker-gha source authority; friedman dissent in Risks |
| E (deletion atomicity) | **One commit per merge; 8-step ordering: author → cp → create-target → verify → update-panel-list → delete-source → delete-obsolete-ref → bump EXPECTED_COUNT** | UNANIMOUS |

## 4 sub-phase split (do NOT collapse into one session — 10-15 commits = context overflow risk)

| Sub-phase | Tasks (from plan) | Commits | Type |
|---|---|---|---|
| **2a** | Task 1 (γ ratification + person-named IDs), Task 2 (B1/B2 hybrid), Task 3 (`[common]` stack tag) | 3 small | Decisions — meta.yaml + commit message records |
| **2b** | Task 4 (`quality-dahl.md`), Task 5 (`quality-ritchie.md` two-lens), Task 6 (`quality-hashimoto.md` + 6 VPS compensate-authored sections) | 3 medium | Ref authoring (concatenation + dedup, NEVER paraphrase per willison REC-5) |
| **2c** | Task 7 (semantic-coverage canary), Task 8 (supply-chain hardening), Task 9 (`_ref-mirrors.lock` attestation) | 3 medium | Infrastructure (canary + hardening + sha256 manifest) |
| **2d** | Task 10 (atomic deletion sequence) | 3 atomic commits (one per merge: dahl, ritchie, hashimoto) | Per-merge 8-step deletion sequence with EXPECTED_COUNT bump in final commit |

Each sub-phase = new tmux session + handoff (`HANDOFF-phase-2<x>-entry.md`). Validator-pipeline pattern unchanged from Phase 1 — writer tmux + reader validator across `/tmp/` briefs. Same convention as `feedback_two_process_validator_pipeline`.

## Sub-phase 2a entry — first action

**Entry artifact for next session:** `/tmp/phase-2-council-plan-output.md` (full plan). Read Task 1 + Task 2 + Task 3 sections; commit budget is 3 small commits.

**Task 1 (γ ratification + person-named IDs):**
- This is mostly a DECISION recorded in commit messages — there's no `quality-<target>.md` to create yet (that's Tasks 4–6 in sub-phase 2b).
- What lands: PR body / commit message documenting γ-for-all-3 with attribution to fowler/backend-ts/realtime-ndjson/persistence-fs/subprocess/deploy-docker-gha/willison; person-named IDs chosen over domain-named per willison REC-4 (LLM-pipeline grounds); friedman REC-1 dissent captured in PR body for traceability.
- Could also include creating placeholder `_council-experts-v2/{dahl,ritchie,hashimoto}/` directories with `meta.yaml` carrying the stack tags from Task 3 — but `plan*.md`/`review*.md` content waits for Tasks 4–6.

**Task 2 (B1/B2 hybrid):**
- DECISION recorded in commit messages + initial scaffolding for B2 (catalog-side canonical path: `_council-experts-v2/hashimoto/references/quality-hashimoto.md`).
- No build script yet (that's Task 8 in sub-phase 2c).

**Task 3 (`[common]` stack tag for hashimoto, `[aura]` for dahl + ritchie):**
- Lands in the new target dirs' `meta.yaml.stack` field.
- Verification gate: post-update `grep -nE "hashimoto" council-*-v2/SKILL.md | wc -l` must equal 6 (but only AFTER sub-phase 2d updates panel-lists — Task 3 sets the tag, doesn't add panel entries).

**Sub-phase 2a entry brief to write (next session start):**
`/tmp/phase-2a-entry-brief.md` — should restate the 3-task scope, the 3 commits, the validator hand-back contract (one-line report convention), and reference this HANDOFF.

## Validator pipeline pattern (unchanged)

- Writer tmux: this Claude (or successor). All artifacts → `/tmp/`. Chat report = ONE LINE per `feedback_validator_pipeline_one_line_report`.
- Reader validator: parallel Claude session. Picks up `/tmp/` briefs, validates, PASS/FAIL with corrections.
- Multi-artifact step → `/tmp/phase-2<x>-artifacts.txt` index file. Chat: "phase 2<x> done, indexed @ /tmp/phase-2<x>-artifacts.txt".
- Never inline-dump diff / brief / log / plan-output in chat.

## Known gaps / open items for Phase 2

- **Phase 1 deferred output-file refs** (from `HANDOFF-council-v2-phase1.md` §"Deferred to Phase 2 (a)"): 6 stale ref paths in `council-review-v2` (lines 245, 246, 376, 377) and `council-review-aura-v2` (lines 255, 392). These cite OLD source IDs (`telegram-ux.md`, `backend-python.md`, `a11y.md`) post-rename. Coupled with catalog prompt content — sub-phase 2b (ref authoring) is the natural landing point since `quality-<target>.md` files reference these by content, not just by panel-list.
- **review-aura split id↔filename** (Phase 1 deferred): `frontend-react` renamed to `abramov`; filename was `react-ui.md`, ambiguous whether to rename to `abramov.md`. Phase 2 sub-phase 2b should make the call when authoring `quality-<target>.md` files; person-named filename consistent with willison REC-4.
- **Hunt REC-3 ReDoS-safety** is a mandatory constraint on sub-phase 2c Task 7 implementation. Pair with `@pair-hunt` during canary build.
- **Subprocess two-lens partition** mandate on sub-phase 2b Task 5 — `quality-ritchie.md` MUST have literal `## §A Process lifecycle` and `## §B Filesystem persistence` headers; canary asserts both present.
- **Willison REC-6 compensate-authoring footnote** on sub-phase 2b Task 6 — every VPS section in `quality-hashimoto.md` carries `(compensate-authored from deploy-docker-gha perspective; deploy-vps native review pending)` footnote. Enforce via grep canary in sub-phase 2c Task 7.

## KB catches captured this round (memory propagation done in this session)

- **Skill/extension registry restart user-scoped** (`feedback_skill_registry_restart_locality.md`) — propagated to all 12 `/root/.claude/projects/*/memory/` dirs.
- **Slash-skill name encodes invisible panel/stack contract** (`feedback_slash_skill_name_encodes_panel_stack.md`) — propagated to all 12 project memory dirs.
- **Validator self-application of empirical-claim gate** — captured in `/tmp/phase-2-scratch.md` "KB catch (2026-05-16, dispatch-time learning)". Promotion candidate: `feedback_runtime_check_applies_symmetrically.md` (writer ↔ reader, no asymmetric trust by role). To-propagate at next /self-reflect.
- **Council source-expert REC over upstream framing** (NEW from this round) — when a source-authority subagent reasons reasonably against the writer/validator's pre-brief framing (e.g. deploy-docker-gha REC-5 expanding hashimoto from Aura-only to cross-stack `[common]`), trust the council. Source-domain authority + solid reasoning + no convention-floor violation = override upstream framing. Captured in this HANDOFF and `/tmp/phase-2-scratch.md`. To-promote as `feedback_trust_council_source_authority_over_upstream_framing.md` next /self-reflect.

## Session wrap protocol

This session: writer (plan-output). Validator session: PASS issued; reader sign-off captured above.

Next session (sub-phase 2a entry): new tmux session, new Claude instance, reads this HANDOFF + plan output. Recommended cadence: one sub-phase per session.

Plan + per-expert artifacts in `/tmp/` survive until reboot; copy to permanent location if needed for archaeology (`.council/review-output/2026-05-16-phase2-plan/`).
