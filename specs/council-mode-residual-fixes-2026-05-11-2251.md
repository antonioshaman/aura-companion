# Spec: Council Mode — закрытие residual P1/P2/P3 из ревью 2026-05-11-2251

**Date:** 2026-05-12
**Status:** Draft

## Objective

Совет-ревью от 2026-05-11-2251 выявил 15 findings (5 P1, 6 P2, 4 P3) по Council Mode. Четыре fix-pass коммита (`bac6ac3`, `0fd07ed`, `2b8bafa`, `1d1a72d`) **заявляют** полное закрытие всех 15, но точечный grep по mainline показывает, что как минимум четыре конкретных артефакта из секций "Fix:" в production-коде отсутствуют. Эта работа: каждое из 15 findings верифицировать против актуального кода (grep + чтение, не trust prose), закрыть подтверждённые residuals точечно, и прогнать свежий `/council-review` чтобы baseline артефакт отражал реальное состояние ветки `feat/council-mode-paired-sessions`.

## Context

Артефакт: `.council/review-output/2026-05-11-2251/FINAL-REVIEW.md` (15 findings, scope Phase D–G). Branch `feat/council-mode-paired-sessions`, 13 коммитов поверх `main`, typecheck зелёный, 5508 тестов проходят.

Коммит `1d1a72d` декларирует "All 15 findings addressed". Точечная верификация по `web/server/` обнаружила:

- `wrapObserverFindingForInjection` — defined + tested, **0 production callers** (явно "deferred" в `bac6ac3` body, finding P1#2)
- `assertObserverWriteAllowed` — defined + tested, **0 production callers** (finding P1#2)
- `stopCouncilWatchers` в `group-shutdown.ts` — **отсутствует** (finding P1#4 sub-d)
- Boot-time canary `disallowedTools Bash` — **отсутствует** на server side (finding P1#1 sub-d)

Это применение `feedback_trust_diff_not_prose.md`: claim в commit message инвертирует direction относительно реального diff. Список выше — **seed** verification'а, не исчерпывающий — оставшиеся 11 findings нужно проверить тем же методом.

Spec не открывает новых findings, не делает структурного рефакторинга — только закрывает residuals и заменяет stale baseline свежим артефактом.

## Scope

### In scope
- Верификация каждого из 15 findings из FINAL-REVIEW против актуального кода (grep + чтение секции "Fix:")
- Закрытие любого finding, чьи sub-fixes отсутствуют в production diff (минимум: 4 sub-fix'а выше)
- Свежий прогон `/council-review` на post-residual HEAD
- Verification log: `.council/residual-verification-2026-05-12.md` со статусом каждого finding

### Out of scope
- Новые findings сверх 15 — попадают в новый review артефакт, не в эту spec
- Структурные рефакторинги вне секций "Fix:"
- CI/lint changes (последние 3 коммита покрыли)

### Non-goals
- Не минимизируется количество новых тестов: каждый sub-fix получает свой тест
- Не обновляется 2026-05-11-2251 артефакт — остаётся historic snapshot

## Stories

### Story 1: Верификация 15 findings против реального diff

**When** имеется ревью артефакт с заявлением о закрытии в commit body, **I want** каждое finding верифицировать grep+чтением и зафиксировать статус с file:line цитатой, **so I can** отделить true-closed от drifted-prose не доверяя commit messages.

**Acceptance Criteria:**

Given FINAL-REVIEW артефакт и текущий HEAD ветки
When verification проходит по 15 findings
Then создан `.council/residual-verification-2026-05-12.md` где каждый finding помечен одной из меток: `closed-with-evidence` (с file:line), `closed-partial` (со списком отсутствующих sub-fixes), `open` (со всеми отсутствующими sub-fixes)

Given секция любого `closed-with-evidence` finding'а
When она читается
Then цитируется конкретный файл:строка ИЛИ test:describe в production коде (не только в тестах), доказывающий что код выполняет описанное в "Fix:", не только импортирует символ

Given finding P1#2 (`wrapObserverFindingForInjection` deferred per commit body) и finding P1#4 (`stopCouncilWatchers` отсутствует)
When verification их читает
Then их статус ≥ `closed-partial`, отсутствующие sub-fixes перечислены явно

### Story 2: Закрытие подтверждённых residuals

**When** verification log пометил finding как `closed-partial` или `open`, **I want** каждый отсутствующий sub-fix закрыть точечным изменением scope'а finding'а, **so I can** дать `/council-review` baseline без deferred-перетянутых fix'ов.

**Acceptance Criteria:**

Given verification log со списком ≥ 1 finding ≠ `closed-with-evidence`
When residual fix landed
Then точечное изменение покрывает все отсутствующие sub-fixes секции "Fix:" этого finding'а и **не** делает структурных изменений за пределами scope finding'а

Given любой residual fix содержит новую логику
When он landed
Then соответствующий `*.test.ts` рядом с source документирует что именно sub-fix проверяет (комментарий внутри теста)

Given residual fix касается Convention floor (AP-1..3 / EC-1..9)
When изменение готовится
Then конвенция цитируется в commit body **и** тест enforces инвариант (не JSDoc — `feedback_council_documented_contract_canary.md`)

Given residual fix предлагает поведение, противоречащее "Fix:" секции (например, переоценка underlying проблемы)
When fix готовится
Then работа паузится с явным запросом к человеку перед commit'ом

Given P1#1 sub-fix "boot-time canary"
When он landed
Then существует production call site, throw/exit если observer-role launch достиг `Bun.spawn` без `--disallowedTools Bash` в argv

### Story 3: Свежий /council-review на post-residual HEAD

**When** Story 2 завершена и working tree чистый, **I want** прогнать `/council-review-aura` и получить новый артефакт, **so I can** иметь baseline что отражает реальное состояние, не drifted snapshot.

**Acceptance Criteria:**

Given Story 2 завершена, `bun run typecheck` и `bun run test` зелёные
When `/council-review-aura` запущен
Then артефакт записан в `.council/review-output/<new-timestamp>/FINAL-REVIEW.md`

Given новый артефакт записан
When читается его список findings
Then **ни одно** из 15 findings из 2026-05-11-2251 не появляется как новый P1/P2 (P3 polish-cluster допустим)

Given новый артефакт содержит P1 finding, связанный с одним из 15 closed/partial
When это обнаружено
Then работа паузится: возврат в Story 2 с человеческим решением (residual не был достаточно закрыт)

Given новый артефакт записан, `git status` чистый
When завершение
Then ветка готова к PR с двумя коммитами (residual closure + verification log) либо squashed

## Boundaries

### ✅ Always
- `bun run typecheck` + `bun run test` зелёные после каждого commit (husky pre-commit hook)
- Каждый sub-fix получает свой test в `*.test.ts` рядом с source
- Цитата конвенции (AP-N / EC-N) в commit body при касании Convention floor
- Тест enforces инвариант (file:line), не JSDoc

### ⚠️ Ask first
- Любое изменение за пределами scope конкретного finding'а (структурный refactor, новые модули, переименование экспортов)
- Удаление существующего теста — даже если он покрывал старое поведение fix'а
- Переход к Story 3 (/council-review) если хоть один finding остался `open` без человеческой санкции

### 🚫 Never
- Пропустить тест/typecheck через `--no-verify`, `it.skip`, `.only` (`feedback_no_ignore_failing_test_diagnose_first.md`)
- Пометить finding `closed-with-evidence` если grep подтверждения нет в production коде (тесты ≠ production callers — см. P1#2)
- Принять commit body как доказательство — citation = file:line или test:describe (`feedback_trust_diff_not_prose.md`)
- Открыть новые findings сверх 15 в рамках этой spec'и
- Удалить или переименовать `.council/review-output/2026-05-11-2251/` (historic snapshot)

## Success Metrics

- Verification log содержит 15 записей со ссылками на file:line или test:describe
- Свежий `/council-review-aura` артефакт не повторяет **ни одного** из 15 finding'ов в P1/P2
- `bun run test` count ≥ 5508 + N (N = число residual sub-fixes)
- 0 регрессий в существующих 5508 тестах

## Assumptions
- (confirmed) Все 15 findings из 2026-05-11-2251 актуальны — ни одно не отозвано как ложноположительное
- (unconfirmed) Запуск через `/council-review-aura` skill (Bun+Hono+TS стек) — если другой вариант, поправьте перед Story 3
- (unconfirmed) Свежий review может выявить новые findings вне 15; они НЕ закрываются этой spec'ой, а уходят в отдельную работу

---

*After implementing, compare results against each acceptance criterion above and list any unmet requirements.*
