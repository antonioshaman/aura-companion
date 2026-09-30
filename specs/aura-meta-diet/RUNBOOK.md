# RUNBOOK — автономное исполнение `specs/aura-meta-diet.md`

Этот файл читает **исполнитель** (headless `claude -p`), которого в цикле запускает
`scripts/aura-diet/run.sh`. Каждый запуск = одна итерация. Человек в цикле не участвует;
всё, что требует человека, уходит в `ASK-FIRST.md`, и работа продолжается дальше.

## 0. Пути и инварианты

| Что | Где |
|---|---|
| Рабочая директория | `$WORK = /home/auracomp/aura-diet` |
| Клон репо (единственное место правок) | `$WORK/repo` |
| Состояние | `$WORK/STATE.json` (машиночитаемо, источник истины прогресса) |
| Журнал | `$WORK/JOURNAL.md` (append-only, по-русски, 3–10 строк на итерацию) |
| Очередь для человека | `$WORK/ASK-FIRST.md` |
| Бенчмарк | `$WORK/bench/` (worktrees, результаты, изолированный инстанс) |
| Интеграционная ветка | `diet/main` (от `origin/main`), push в origin |

**Никогда:** `/root/aura-companion` (прод-чекаут), `aura-companion.service`, порт 3456,
push/merge в `main`, `git reset --hard`, `git config`, удаление тестов, правки в
`~/.claude/**` и `~/.codex/**`. Идентичность коммитов:
`git -c user.name="Anton Shmonin" -c user.email="rufirium@gmail.com" commit --no-verify -F <file>`
(pre-commit хук на этом боксе падает с EACCES по окружению — верификация делается вручную,
и в PR это пишется явно). Трейлер: `Co-Authored-By: Claude <noreply@anthropic.com>`.

## 1. Протокол итерации

1. Прочитать `STATE.json`, хвост `JOURNAL.md` (последние 40 строк), `ASK-FIRST.md`.
2. Выбрать **следующий шаг**: первый `pending` шаг в текущей фазе, чьи зависимости `done`.
   Если текущая фаза заблокирована только Ask-first пунктами — перейти к следующей
   независимой фазе (граф в §3).
3. `cd $WORK/repo && git fetch origin && git checkout diet/main && git pull --ff-only`;
   ветка шага: `diet/<phase>-<step>` от `diet/main`.
4. Сделать шаг. Объём — одна история или её логичная часть (≈ до 2 ч работы агента).
5. Верификация (обязательна, с unset всех `AURA_*` переменных —
   `env $(env | grep -oE '^AURA_[A-Z_]+' | sed 's/^/-u /') …` — и `NODE_OPTIONS=--max-old-space-size=2560`): `cd web && bun run typecheck`, затем
   таргетные `bun run test -- <зона>`; при изменениях `web/src/components` — `bun run test:a11y`.
   Сверить с ACs истории из спеки; невыполненные перечислить.
6. Коммит (commitizen), push ветки, `gh pr create --repo antonioshaman/aura-companion --base diet/main`,
   затем `gh pr merge --squash --delete-branch` **только в `diet/main`**. Если gh 401 — повтор до 5 раз с паузой 30 с.
7. Обновить `STATE.json` (статус шага, sha, PR, метрики) и дописать `JOURNAL.md`.
8. Завершить итерацию. Не начинать второй шаг, если контекст уже большой.

Если шаг провалился трижды подряд (по `attempts` в STATE) — пометить `blocked`,
записать диагноз в `ASK-FIRST.md`, перейти дальше. Никогда не «чинить» провал удалением
теста или ослаблением assert'а.

## 2. Формат STATE.json

```json
{
  "status": "running | done | stalled",
  "current_phase": "P1",
  "phases": {
    "P1": { "status": "pending|in_progress|done|blocked",
            "steps": { "C2": {"status":"pending","attempts":0,"pr":null,"sha":null,"notes":""} } }
  },
  "metrics": { "claude_md_bytes": null, "observer_prompt_bytes": null,
               "orchestrator_lines": null, "kb_used_ratio": null },
  "bench": { "tasks_valid": 0, "cells_total": 0, "cells_done": 0 },
  "updated_at": "ISO"
}
```

`run.sh` создаёт начальный STATE; исполнитель его только обновляет.

## 3. Фазы, шаги, выходные гейты

Граф: P1 → P2; P1 → P3; P1 → P4; P4 → P5 → P6. P2/P3/P4 независимы между собой.

### P1 — Гигиена (шаги: C2, A1, A2)
- **C2** `git mv` 51 процессный документ корня + `.council/{handoffs,review-output,implementation-logs,plan-output}` → `docs/history/…`. Обновить все ссылки (grep по репо, включая скиллы в `.agents/`, тесты, CLAUDE.md). Перед переносом проверить, что ни один runtime-путь (`.council/checkpoints|reviews|prompts|state|eval`) не затронут.
  Гейт: grep старых путей = 0; typecheck + тесты council/eval зелёные.
- **A1** Миграция `.learnings/*.md` → KB (через формат `/learn`, провенанс `migrated-from:.learnings/<file>#<heading>`), отчёт `docs/history/learnings-migration.md` (перенесено / дубликат / отброшено + причина). Skill `self-improvement` **удалить полностью** (`.agents/skills/self-improvement`, симлинки, `skills-lock.json`, упоминания в CLAUDE.md/AGENTS.md/SELF-LEARNING.md/скиллах/тестах). `.learnings/` → `docs/history/learnings/`. Патч для хука в `~/.claude/settings.json` (UserPromptSubmit self-improvement-reminder) — **в ASK-FIRST**, не применять.
- **A2** Health-команда KB (скрипт в `web/scripts/` + тест + npm-script `kb:health`), персистентный инкремент usage в `/prime`, прунинг в архив `.agents/knowledge/archive/`. Зафиксировать baseline в STATE.metrics.

### P2 — Контекст (шаги: A3, B4)
- **A3** Разрезать CLAUDE.md: ядро ≤ 15 360 байт; остальное — `docs/architecture/*.md`, `docs/conventions/*.md` с однострочными ссылками. Отчёт-маппинг правило→новое место `docs/history/claude-md-split.md`. Сохранить AGENTS.md в синхроне, если он дублирует CLAUDE.md.
- **B4** Отчёт по run-stats (`COMPANION_COUNCIL_STATS_DIR`, engine `web/scripts/run-stats*`): медиана экспертов по размеру диффа. Политика отбора — в in-repo engine (с тестами, fail-closed линзы hunt/fowler/willison/beck сохранены). Правки живых скиллов `~/.claude/skills/council-*` и `_council-experts` — **патчем в ASK-FIRST** (там canary `.verify/verify-catalog.sh` и C12-лок).

### P3 — Observer (шаги: B1, B2, B3)
- **B1** Хост формирует конверт ревью. Observer возвращает только массив находок
  `{severity, claim, evidence_path, evidence_lines, confidence}`. Всё прочее (schema version, timestamps — серверные часы, provider, model, CLI version, group id, checkpoint id, wake version, имя файла) — хост. Поддержать оба провайдера (Claude + Codex) и переходный период: старый формат ревью продолжает парситься. Промпт ≤ 5 KB; перегенерировать bundled-артефакт и прогнать canary `bun run build-observer-prompt-bundle && git diff --exit-code`. Replay-тесты на оба провайдера (EC-6).
- **B2** Новые проверки grounding (строка существует / строка изменена в чекпоинте / символ из claim есть на строках → иначе weak evidence). Precision-раннер: вывести false STOP до/после; recall корпуса не ухудшить.
- **B3** Экспорт label sheet из recordings (`~/.companion/recordings` — **только чтение**, копировать в `$WORK`), без дублей. Сгенерированный sheet положить в `$WORK/labeling/` и строку в ASK-FIRST «разметить N находок».

### P4 — Код (шаги: C1a…C1e, C3)
- **C1** Вынос из `session-orchestrator.ts` по одной capability за шаг: C1a Checkpoint pipeline, C1b Observer scheduler (вкл. EC-13 failsafe), C1c Auto-proceed controller, C1d Session recovery, C1e Council lifecycle. DI как в AP-1. Поведение не меняется; тесты не удаляются; обновить устаревший комментарий «1900+». Гейт после каждого подшага: полный набор тестов server-зоны зелёный. Финальный гейт: ≤ 1 800 строк.
  Незакоммиченная правка в прод-чекауте (`git -C /root/aura-companion diff web/server/session-orchestrator.ts`) — прочитать, записать в ASK-FIRST, **не переносить** без решения человека.
- **C3** Флаги слоёв knowledge / observer / council / auto-proceed: env + per-session опция создания, fail-closed парсинг (как `isRecordingHubEnabled`), дефолт = текущий прод. Тесты на каждый флаг. Флаги — вход для P6.

### P5 — AuraBench корпус (шаг D1)
- Источник: `gh pr list --state merged --limit 300` (≈194 PR). Для каждого кандидата: base = parent merge-коммита, hidden tests = тест-файлы, добавленные/изменённые PR.
- Валидация: hidden tests **падают** на base и **проходят** на merge → иначе исключить с причиной.
- Текст задачи: из title/body/issue, переписанный без подсказок решения; второй LLM-проход проверяет утечку (имена новых символов/файлов из диффа → переписать).
- Классы: bugfix / feature / refactor / architecture / security / ui / debug. Цель 50, минимум 30.
- Формат — расширение существующей схемы `web/evals/tasks` (+ loader-тест). Корпус коммитится в `web/evals/aurabench/`.

### P6 — Ablation, отчёт, лендинг (шаги: D2-harness, D2-pilot, D2-full, D3, A3-recheck, FINAL)
- **D2-harness** Раннер в `web/evals/` (без LLM в CI-тестах, моки на исполнителя):
  - каждая ячейка (задача × вариант × повтор) — свежий `git worktree` на base в `$WORK/bench/wt/`;
  - **naked Claude (A):** `claude -p` c чистым `CLAUDE_CONFIG_DIR` (только скопированный `.credentials.json`), в worktree удалены CLAUDE.md/AGENTS.md/.agents/.council/.claude. Доказательство изоляции — init-фрейм stream-json: нет пользовательских skills/hooks; сохранить в результат ячейки;
  - **naked Codex (B):** `codex exec --json` в очищенном worktree; `~/.codex` **не копировать и не править** (ротация refresh-токена сломает прод) — если там есть AGENTS.md, записать как конфаунд;
  - **Aura-варианты (C–G):** отдельный инстанс Companion из `$WORK/repo` (`diet/main`) на порту 3499, свои `TMPDIR`, `COMPANION_RECORDINGS_DIR`, `COMPANION_COUNCIL_STATS_DIR`, `COMPANION_ALLOWED_ORIGIN`; сессии создаются через его REST API с флагами из C3;
  - после завершения агента: вернуть hidden tests, прогнать их + регрессионный набор зоны; метрики из result-фрейма (tokens, cost API-эквивалент, turns, tool calls), `git diff --numstat`;
  - результаты — JSONL в `$WORK/bench/results/`, **ячейка идемпотентна** (ключ task×variant×rep; готовые пропускаются) → прогон переживает перезапуски и лимиты;
  - таймаут ячейки 60 мин → `timeout`, считается провалом, не повтором.
- **D2-pilot** 5 задач × 7 вариантов × 1 повтор. Гейт: ≥ 90% ячеек дали валидную запись; изоляция доказана. Иначе чинить harness.
- **D2-full** Все задачи × 7 × 5 повторов. Конкуренция = 1 (прод на том же боксе, 8 GB); запуск агентов под `nice -n 10`. Перед каждой ячейкой: если свободной памяти < 1.5 GB — ждать. Длинный прогон исполняет **драйвер**, а не итерация: после D2-pilot записать в `STATE.bench.runner_cmd` одну shell-команду (cwd `$WORK/repo`), которая идемпотентно гонит все незавершённые ячейки, сама спит на лимитах подписки (не падает) и после каждой ячейки обновляет `STATE.bench.cells_done`/`cells_total`; поставить `D2-full.status = "in_progress"`. Драйвер запустит её и вернёт управление итерации, когда она завершится; итерация проверяет полноту и ставит `done` (или чинит и перезапускает).
- **D3** `docs/aurabench/REPORT.md`: success rate / cost / Aura Lift по вариантам и классам с bootstrap-ДИ 95%; отдельная таблица по слоям (A→C→D→E); выводы «где окупается, где нет». Черновик блока лендинга `landing/…` **в ветке**, каждая цифра — сноска на строку отчёта; если lift незначим — честная формулировка. Лендинг **не публиковать и не деплоить**: сначала отчёт, решение о размещении принимает человек (ASK-FIRST). Сырые данные (JSONL ячеек, без секретов/токенов/прод-путей) коммитить в `docs/aurabench/data/`.
- **A3-recheck** Повторить 10 задач варианта C со старым CLAUDE.md vs новым; регресс > 5 п.п. → блокер в отчёт.
- **FINAL** Draft PR `diet/main → main` с описанием всех фаз, метрик до/после, ссылками на отчёт, пометкой «hook skipped (EACCES), verified: …», provenance «Implemented by AI agent, human review: no». Записать `$WORK/FINAL-REPORT.md` (по-русски: что сделано, цифры, ASK-FIRST список). `STATE.status = "done"`.

## 4. Самоконтроль исполнителя

- Сомнение, трогает ли действие прод → не делать, ASK-FIRST.
- Утверждение «сделано» только после команды-доказательства в этой же итерации (вывод теста, размер файла, grep = 0).
- Не повторять side-effect (push/merge/PR create) без проверки текущего состояния (`gh pr list --head`, `git ls-remote`).
