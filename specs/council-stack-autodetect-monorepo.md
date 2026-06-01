# ТЗ: Auto-detection стека в /council-* skill routers (рекурсивный marker scan)

**Дата:** 2026-06-01
**Контекст:** rapesha_academy, monorepo, повторное падение Phase 0 `/council-plan`
**Целевой репозиторий правок:** `/home/auracomp/.claude/skills/` (Aura Companion-side)
**Затрагиваемые skill'ы:** `council-plan`, `council-implement`, `council-review`, `council-plan-aura`, `council-implement-aura`, `council-review-aura`, `council-plan-copilot`, плюс v2-варианты тех же

**Связан с:** [`council-command-stack-router.md`](./council-command-stack-router.md) — оригинальный spec для Phase 0 root-only marker check. Этот документ — follow-up, расширяющий scan до depth=2 для monorepo-layouts, сохраняя весь refuse/override-контракт оригинала.

---

## Проблема (наблюдаемая)

Phase 0 stack-detection в каждом `/council-*` skill router'е делает strict root-only marker check:

```
1. web/package.json:name=aura-companion          (root)
2. web/package.json:dependencies.hono            (root)
3. web/server/ws-bridge.ts                       (root)
4. pyproject.toml:aiogram                        (root)
5. requirements.txt:^aiogram + bot/              (root)
6. .council-stack-override                       (root)
```

Если ни один root-маркер не сматчился → refuse: `Stack detection: no recognised stack markers at workspace root.`

**Где это ломается:** multi-bot monorepos. Реальные кейсы:

| Repo | Layout | Root markers? |
|------|--------|---------------|
| `rapesha_academy` | `advisor_bot/requirements.txt`, `bot/requirements.txt`, `backend/requirements.txt`, `webapp/package.json` | НЕТ |
| `om_event_bot` (предположительно) | `script/requirements.txt` либо `pyproject.toml` в скриптовой папке | вероятно НЕТ |
| Любой репо где `web/` называется `webapp/` или `frontend/` | — | НЕТ |
| Любой репо с pyproject в `apps/<service>/` | — | НЕТ |

**Каждый запуск** в таком репо → refusal → юзер вынужден руками создавать `.council-stack-override`. Это recurring friction.

## Что должно происходить (контракт)

Stack должен определяться автоматически. Override-файл остаётся как escape hatch для пограничных случаев (mixed repo, эксперимент с миграцией стека), но **не как обязательный workaround для нормальных monorepo layouts**.

## Предлагаемое изменение

### 1. Расширить marker scan до depth 2 от workspace root

Текущий algorithm:
```python
# pseudocode of Phase 0 spec
aura_match = any([
    file_exists("web/package.json") and json_field_eq("web/package.json", "name", "aura-companion"),
    file_exists("web/package.json") and json_has_dep("web/package.json", "hono"),
    file_exists("web/server/ws-bridge.ts"),
])
python_match = any([
    file_exists("pyproject.toml") and "aiogram" in read("pyproject.toml"),
    dir_exists("bot/") and file_exists("requirements.txt") and re_match(r"^aiogram\b", read("requirements.txt"))
])
```

Новый algorithm — рекурсивный scan с фиксированными top-level marker dirs:

```python
# Anywhere within depth-2 from workspace root
WORKSPACE_GLOB_DEPTH = 2

aura_files_scanned = glob("*/package.json", depth=WORKSPACE_GLOB_DEPTH)
aura_match = any([
    json_field_eq(f, "name", "aura-companion") for f in aura_files_scanned
] + [
    json_has_dep(f, "hono") for f in aura_files_scanned
] + [
    file_exists(f"{d}/server/ws-bridge.ts") for d in dirs_at_depth_1_with_package_json
])

python_match = any([
    "aiogram" in read(f) for f in glob("*/pyproject.toml", depth=WORKSPACE_GLOB_DEPTH) + [root_pyproject]
] + [
    re_match(r"^aiogram\b", read(f)) for f in glob("*/requirements.txt", depth=WORKSPACE_GLOB_DEPTH) + [root_requirements]
])
```

### 2. Сохранить strict "ambiguous → refuse" контракт

Если в subdir'ах ОДНОВРЕМЕННО нашлись и Aura, и Python markers — это легитимный случай для refuse-as-ambiguous (например, repo где Python bot и Aura companion живут как sibling subdirs). Override-файл остаётся единственным способом разрешить.

### 2a. Specificity invariant (НЕ ослаблять markers при расширении scope)

Depth=2 расширяет **где** ищем, не **что** считается markers'ом. Канон сохраняется буквально:

- Aura: `package.json:name === "aura-companion"` ИЛИ `package.json:dependencies.hono` ИЛИ `server/ws-bridge.ts` (полный путь к файлу, не любой `*.ts`).
- Python: `pyproject.toml` содержит литерал `aiogram` ИЛИ `requirements.txt` содержит строку, матчащую `^aiogram\b`.

**Никогда:**
- «любой `package.json` = web stack» — false-positive на marketing-сайтах, doc-генераторах, monorepo tooling configs.
- «папка `bot/` или `webapp/` = соответствующий стек» — directory naming != stack signal.
- partial matching (`aiogram` как substring в случайной dep, `hono` в каком-нибудь нелетающем поле) — markers буквальные.

Этот invariant защищает от drift'а в будущих редактурах детектора: следующий контрибьютор может «улучшить» auto-detect, ослабив markers, и схлопнуть safety — refusals станут реже, но false-dispatch'и появятся. Specificity — не баг, а фича.

### 3. Сохранить refuse-as-unknown

Если ни в root, ни в subdir'ах нет markers — refuse-as-unknown (тот же текст что сейчас). Override-файл остаётся escape hatch.

### 4. Refusal text должен включать ЧТО именно сматчилось

Текущий refusal перечисляет markers абстрактно. Новый должен показать какие конкретно файлы были scanned и что в них найдено — это помогает дебагу:

```
Stack detection: no recognised stack markers (scanned depth=2 from workspace root).

Scanned:
  - ./webapp/package.json (parsed, name="rapesha-webapp", no hono dep)
  - ./advisor_bot/requirements.txt (no aiogram line found within first 200 lines)
  - ./bot/requirements.txt (no aiogram line)
  - ./backend/requirements.txt (no aiogram line)
  - ./pyproject.toml (not present)
  - ./.council-stack-override (not present)

(In a properly-configured python repo, expect aiogram in at least one requirements.txt.)
```

Если refuse-as-ambiguous — тот же подход (показать какие subdir'ы дали Python signal vs Aura signal).

### 5. Acceptance criteria

- В `rapesha_academy/` БЕЗ `.council-stack-override` → `/council-plan` корректно стартует как Python variant (matches `advisor_bot/requirements.txt:^aiogram`).
- В `aura-companion/` БЕЗ override → стартует как Aura (matches `web/server/ws-bridge.ts` или `web/package.json:hono`).
- В repo где есть И `apps/python-bot/requirements.txt:^aiogram` И `apps/aura-app/server/ws-bridge.ts` → refuse-as-ambiguous (текущее поведение, корректное).
- В пустом репо → refuse-as-unknown (текущее поведение, корректное).
- `.council-stack-override` остаётся priority-override (если есть и валидный — игнорировать auto-detection).
- **AC-conflict (ask-first)**: workspace где auto-detect single signal (например, `advisor_bot/requirements.txt:^aiogram` → Python) И есть `.council-stack-override` с конфликтующим значением (например, `aura`) → refuse с conflict message, **не** silently dispatch override. Воспроизводит `feedback_stack_gated_skill_refusal_three_options.md` контракт «три варианта» — юзер должен явно выбрать, какой источник истины.

### 6. Out of scope

- Не делаем networking lookups (PyPI, Github API) — детект strictly local-fs.
- Не следуем git submodules глубже своей рабочей копии.
- Не пытаемся угадать по `.gitignore` или другим heuristics.

### 7. Test plan

В каждом из 7+ skill'ов (`council-plan`, `council-implement`, `council-review`, плюс `-aura`, `-copilot`, v2-варианты) — синхронно обновить Phase 0. Один shared snippet (например, `.council-stack-detect.shared.md`) который inline'ится через include — чтобы не дрейфовать (это известная проблема, см. `feedback_skill_md_vs_references_drift.md`).

Smoke tests:
- pytest fixture с 5 mock-repo layouts (root-python, root-aura, monorepo-python, monorepo-aura, ambiguous, empty)
- Each test invokes Phase 0 detect → asserts verdict matches expected

### 8. Migration

- Существующие `.council-stack-override` файлы — продолжать работать (backward compat).
- Документировать в README skill'а: "auto-detection now scans depth=2; override-file остался для edge cases".

---

## Why this matters

> «поидее стек должен определяться автоматом»

Это user comment 2026-06-01. Detection IS the skill's job. Workaround-файл за пределами single project = friction. Скиллы которые требуют от пользователя ручной конфигурации перед invocation — не "skill", а "ритуал".

## Ссылки

- `feedback_skill_marker_mismatch_use_override.md` — память о том, что refusal на mismatch ≠ wrong stack; depth=2 scan **не отменяет** этот контракт, только сужает множество false refusals на однозначных monorepo-layouts. Override остаётся документированным escape hatch для пограничных случаев.
- `feedback_stack_gated_skill_refusal_three_options.md` — память о «трёх вариантах при refusal» (inline / fork / override). AC-conflict выше (Section 5) воспроизводит этот контракт для случая «detected ≠ override».
- `feedback_skill_md_vs_references_drift.md` — общая проблема synchronization при multi-skill changes (motivation для shared snippet `.council-stack-detect.shared.md` в Section 7).
- `feedback_skill_protocol_scope_threshold.md` — когда вообще запускать council (orthogonal вопрос, не затрагивается этим spec'ом).
