# HANDOFF: Council Mode v2 — Phase 1 complete → Phase 2 start

## Состояние на 2026-05-16

- **Branch:** `feat/council-v2-pipeline` (в `/root/aura-companion` repo) — без коммитов, Phase 1 артефакты живут в skills repo.
- **Skills repo:** `/home/auracomp/.claude/skills/.git` — owner `auracomp:auracomp`. Все git-команды от auracomp: `sudo -u auracomp git -C /home/auracomp/.claude/skills <cmd>`.
- **Skills repo commits (linear, newest → oldest):**
  - `874e06b` phase 1c — verify-catalog C6-C9 extension
  - `17167f4` phase 1c-pre — mechanical reference chain (panel-list class)
  - `7dd0d50` phase 1b-aux — `.verify/_phase2-merges.yml`
  - `3bc513f` phase 1b — 17 meta.yaml (creator + stack only)
  - `f620b80` phase 1a — 4 renames (a11y/backend-python/frontend-react/telegram-ux → watson/vanrossum/abramov/durov)
  - `10e6682` phase 0 — isolation (7 forked skills)
- **Archive tag (rollback target):** `council-v1-archive-20260516` в обоих repo (aura-companion HEAD `613328e` + skills HEAD `9a3ed34` — pre-v2).
- **Snapshot:** `/tmp/council-v2-phase1-snapshot.tar.gz` — full 7-dir tar of v2 trees.
- **v1 untouched:** baseline `/tmp/v1-md5-full-baseline.txt` (47 files) — `md5sum -c` passes.
- **Aura runtime:** `/api/skills` показывает 6 v2 dispatchers с `[v2-DEV]` markers + 6 v1 dispatchers неизменённо.

## Что сделано в Phase 1

- [x] **Phase 0** — isolation (7 forked skills: 1 catalog + 6 dispatchers, `[v2-DEV]` маркер, `_council-experts/` refs переписаны)
- [x] **Phase 1a** — 4 expert renames per spec §51-58 (`a11y/backend-python/frontend-react/telegram-ux → watson/vanrossum/abramov/durov`), `git mv` preserves byte-identity
- [x] **Phase 1b** — `meta.yaml × 17` per spec §170-173 (creator + stack only, NO transient fields; common-cohort 7 экспертов matches spec §35 verbatim)
- [x] **Phase 1b-aux** — `.verify/_phase2-merges.yml` declares 3 targets × 6 sources for Phase 2 (dahl/ritchie/hashimoto)
- [x] **Phase 1c-pre** — mechanical reference chain post-rename (verify-catalog.sh C2 brace expansion → v2 dispatchers + 4 dispatcher panel-list ID updates)
- [x] **Phase 1c** — verify-catalog C6-C9 extension (presence + count via `EXPECTED_COUNT=17`, schema keys⊆{creator,stack}, stack enum, case-insensitive unique IDs)

Final state: `bash _council-experts-v2/.verify/verify-catalog.sh; echo $?` → all C1-C9 ✓, exit=0.

## Deferred to Phase 2 (known gaps, surfaced explicitly)

**a. Output-file refs в dispatcher prose** (6 строк):
- `council-review-v2` lines 245, 246, 376, 377 — `telegram-ux.md` / `backend-python.md` paths still stale post-rename
- `council-review-aura-v2` lines 255, 392 — `a11y.md` paths still stale

Coupled с catalog prompt content (subagent writes filename — инструктируется prompt'ом, не только dispatcher panel-list). Чинить только dispatcher-side = создаёт two-side disagreement at runtime. Phase 2 (prompt upgrades) разрешит consistent'но.

**b. review-aura split id↔filename — design choice:**
v1 имеет `id=frontend-react` но `filename=react-ui.md`. После rename `frontend-react → abramov`, filename может стать `abramov.md` или остаться `react-ui.md`. Не mechanical.

**c. 3 catalog merges (Phase 2 main work):**
- `dahl` ← `backend-ts` + `realtime-ndjson` (Node/Bun/TS + WebSocket/NDJSON)
- `ritchie` ← `subprocess` + `persistence-fs` (Unix lifecycle + FS persistence)
- `hashimoto` ← `deploy-docker-gha` + `deploy-vps` (DevOps Docker+CI/CD+VPS systemd)

После merge: `EXPECTED_COUNT 17 → 16` в `verify-catalog.sh`. Требует semantic-coverage canary (spec §125) — каждое объединение покрывает все concern'ы sources. `_phase2-merges.yml` уже декларирует план.

**d. 2 новых эксперта (Phase 3):**
- `lerdorf` (PHP / Rasmus Lerdorf)
- `colvin` (Pydantic / pydantic-ai / Samuel Colvin)

**e. Chair-side stack-detection (Phase 3):**
`detect-stack.sh` читает package.json/composer.json/pyproject.toml, фильтрует panel по `meta.yaml.stack` tags. Spec §33-34, §157-163.

**f. Pre-existing subshell bug β в verify-catalog C2:**
`awk ... | while read` идиом теряет `ERR=1` мутацию в subshell. Не v2-introduced (был в v1 baseline). Фикс на 1 строку (process substitution: `< <(awk ...)`). Отдельный follow-up.

## KB catches успешные в Phase 1 (proof что self-learning работает)

1. **`trust-diff-not-prose`** — каждый раз когда читал actual diff (не trust план/брифы prose) — surface'нул mechanical drift серийно
2. **`partial-fix-passed-as-complete`** — поймало половинчатый Phase 0 mechanical refs fix. Phase 1c-pre catch class 2 panel-lists; class 3 output-file refs тут же surface'нулся как deferred (а не "доделаем потом").
3. **`multi-expert-convergence-promotion`** — каждая phase × validator independent проверял артефакты с разных углов (md5/structure-diff/schema/inject-test). Convergence promote'нул внимание к scope edges.
4. **`test-your-inject-tests`** (NEW pattern из этой сессии) — inject-test в Phase 1c брифе для C7 (extra-keys check) был malformed (`'  evil: yes'` с 2-space indent). YAML parser ловил это раньше чем schema check → log показывал YAML parse error, не C7 fail. Validator retry без indent (`'evil: yes'`) правильно exercise'нул C7 path и подтвердил `'✗ hunt: extra keys not allowed: ['evil']'`. Lesson: inject-tests тоже могут иметь baked-in bug — test the test. Candidate for `.agents/knowledge/patterns.jsonl`.

## Open architectural question — RESOLVE BEFORE Phase 2 START

**Dispatcher local `references/` vs catalog `_council-experts-v2/<id>/references/`** — две независимые ветки prompt'ов:
- v2 dispatcher SKILL.md ссылается на `references/quality-backend.md` (local to dispatcher)
- v2 catalog имеет `_council-experts-v2/<id>/references/quality-*.md` (per-expert local)
- Spec не закрывает развилку явно — текущая Phase 0 cp склонировала ОБА деревья.

Развилка для Phase 2 (prompt upgrades):
- (A) catalog references = single source of truth; dispatcher `references/` удалить
- (B) dispatcher references = single source of truth; catalog `references/` удалить
- (C) keep both — dispatcher overrides catalog per-skill

**Решать через `/council-plan-v2` в начале Phase 2 (BEFORE prompt upgrades),** не лепить ad-hoc.

## Next session pickup

```bash
tmux new -s aura-v2-phase2   # OR attach existing
cd /root/aura-companion
claude
```

В новой Claude сессии:

> Подхватываю Phase 2 council-v2 pipeline. План в `/home/auracomp/.claude/plans/hashed-kindling-meteor.md`, HANDOFF в `/root/aura-companion/HANDOFF-council-v2-phase1.md`. Стартуем с `/council-plan-v2` на dispatcher-vs-catalog references question (см. HANDOFF "Open architectural question"). После плана — Phase 2 task list (3 merges, semantic-coverage canary, EXPECTED_COUNT 17→16).

## Files / artifacts ledger

| Artifact | Path | Purpose |
|---|---|---|
| Phase 1 snapshot | `/tmp/council-v2-phase1-snapshot.tar.gz` | Rollback insurance, full 7-dir tar |
| v1 baseline | `/tmp/v1-md5-full-baseline.txt` | md5sum -c regression gate |
| 1c-pre diff | `/tmp/phase-1c-pre.diff` | mechanical reference fix audit |
| 1c diff | `/tmp/phase-1c.diff` | verify-catalog extension audit |
| 1c verify log | `/tmp/phase-1c-verify.log` | proof C1-C9 ✓, exit=0 |
| 1b validator brief | `/tmp/phase-1b-validator-brief.md` | history |
| 1c validator brief | `/tmp/phase-1c-validator-brief.md` | history |
| Phase 2 merge plan | `_council-experts-v2/.verify/_phase2-merges.yml` | Phase 2 source of truth (committed) |
| Phase 1 plan | `/home/auracomp/.claude/plans/hashed-kindling-meteor.md` | session entry |
| Specs | `specs/council-experts-catalog-v2-expansion.md` + `specs/council-mode-bidirectional-pipeline.md` | canonical reference |

## Aura-companion PR — NOT created yet

Phase 1 changes живут целиком в `/home/auracomp/.claude/skills/.git`. Branch `feat/council-v2-pipeline` в `aura-companion` создана, tag `council-v1-archive-20260516` поставлен, но NO commits yet on the branch.

Per plan §141, PR в aura-companion документирует Phase 0+1 через spec note + опциональный snapshot tarball reference. **Этот шаг отложен** — решить на старте Phase 2 (или после Phase 2 если bundling предпочтительнее).
