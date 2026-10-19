# AuraBench D2-full: итоги этапа 1 и состав этапа 2

Этап 1 по решению человека от 2026-09-29: все 41 задачи корпуса, варианты A–F,
1 повтор, всего 246 ячеек. G исключён, потому что повторяет F со скиллами и в
пилоте и пробе только ухудшал результат. Этап 2 добирает до 3 повторов задачи,
на которых варианты разошлись.

Первая ячейка стартовала 2026-09-28 20:24 UTC (переиспользована из пилота, sha
промпта совпадает). Последняя закончилась 2026-10-08 09:58 UTC. Паузы между
ними: лимиты подписок Claude и Codex, инцидент с OAuth (FIX-D2-CLAUDE-AUTH),
приоритетные шаги DIET-AB / COUNCIL-PANEL-BENCH / P7 и заполнение диска
2026-10-06 (P6-DISK-GATE). Модели закреплены: Claude `claude-opus-5-5`, Codex `gpt-5.5`.

## Валидность

| Критерий | Результат |
|---|---|
| Записи | **246/246**, все `status=completed`, ключи `задача\|вариант\|повтор` уникальны |
| Таймауты | 0; самая долгая ячейка 25,4 мин (E) |
| `isolation.violations` | **0** из 246 |
| Изоляция naked Claude (A) | 41/41: 0 MCP-серверов, 0 hook-событий, только встроенные skills и плагины CLI |
| Реальный `~/.codex` (B, F) | `unchanged: true` во всех 82 ячейках; в `ambient` попадают только `tmp/arg0/*` прод-процессов codex (см. ISO-ARG0) |
| Перепрогоны | 3 ячейки B/F с ENOSPC 2026-10-06 вынесены в `results/disk-full.jsonl` и посчитаны заново |
| `hidden.tampered` | не пуст в 245 ячейках: агенты правят тест-файлы, которые потом подменяются скрытыми (как в пилоте, на оценку не влияет) |

## Сводка по вариантам (1 повтор, промежуточно)

Цифры ниже даны без доверительных интервалов. Это сырой этап 1, а не выводы:
выводы с bootstrap-ДИ будут в `REPORT.md` после этапа 2 (шаг D3-REFRESH).

| Вариант | Успех | Регрессии зоны | Время, медиана / макс, мин | Стоимость (API-экв.), медиана |
|---|---|---|---|---|
| A naked Claude | 36/41 | 1 | 3,7 / 15,6 | $0,45 |
| B naked Codex | 33/41 | 3 | 4,2 / 18,8 | — (Codex не отдаёт) |
| C Claude + knowledge | 35/41 | 0 | 4,3 / 13,5 | $0,64 |
| D C + observer | 33/41 | 0 | 7,0 / 22,1 | $1,37 |
| E D + council + auto-proceed | 31/41 | 0 | 16,1 / 25,4 | $1,63 |
| F Codex + knowledge | 35/41 | 2 | 4,7 / 18,0 | — |

Время E включает ожидания auto-proceed (см. примечание к D3 в STATE).

## Правило отбора на этап 2

Задача идёт на этап 2, если среди A–F есть расхождение по `success` или доля
пройденных скрытых тестов (`tests_passed / (tests_passed + tests_failed)`)
различается больше чем на 2 п.п. 28 задач не прошли отбор: на 26 из них все
шесть вариантов успешны со 100%, на 2 все шесть провалены с почти одинаковой
долей. Это `orphan-reaper-misses-stdio-claude` (96,2% у всех) и
`sever-self-update-and-upstream-sync` (98,3–99,4%, разброс 1,1 п.п.).

## Задачи этапа 2 (13)

Успех по вариантам дан строкой `ABCDEF`, где 1 значит успех. Справа доля
скрытых тестов в процентах.

| Задача | Класс | ABCDEF | A | B | C | D | E | F |
|---|---|---|---|---|---|---|---|---|
| `archived-sessions-hold-memory` | bugfix | 111101 | 100 | 100 | 100 | 100 | 99,7 | 100 |
| `claude-adapter-outbound-queue-overflow` | feature | 101100 | 100 | 80,2 | 100 | 100 | 95,3 | 89,6 |
| `claude-cli-stdio-transport` | architecture | 101110 | 100 | 85,5 | 100 | 100 | 100 | 99,3 |
| `claude-model-switch-404-strands-session` | bugfix | 111101 | 100 | 100 | 100 | 100 | 98,0 | 100 |
| `codex-error-notification-shown-as-drift` | bugfix | 100010 | 100 | 99,6 | 98,8 | 98,8 | 100 | 99,6 |
| `codex-observer-findings-dropped` | bugfix | 001111 | 100 | 100 | 100 | 100 | 100 | 100 |
| `council-degraded-pair-never-recovers` | bugfix | 110011 | 100 | 100 | 99,3 | 99,3 | 100 | 100 |
| `council-observer-idle-until-first-checkpoint` | feature | 000001 | 99,4 | 99,4 | 99,4 | 99,4 | 99,4 | 100 |
| `extract-empty-chat-state` | refactor | 010001 | 87,5 | 100 | 87,5 | 87,5 | 87,5 | 100 |
| `own-sandbox-image-no-upstream-registry` | refactor | 101001 | 100 | 100 | 100 | 99,6 | 99,6 | 100 |
| `respawned-cli-forgets-last-message` | feature | 111110 | 100 | 100 | 100 | 100 | 100 | 100 |
| `resume-discards-conversation-too-eagerly` | bugfix | 111101 | 100 | 100 | 100 | 100 | 99,3 | 100 |
| `settings-secret-field-saves-mask-dots` | security | 111001 | 100 | 100 | 100 | 98,3 | 98,3 | 100 |

В `codex-observer-findings-dropped` и `respawned-cli-forgets-last-message` при
100% скрытых тестов провал дала регрессия зоны (A/B и F соответственно).
`codex-observer-findings-dropped` в `REPORT.md` уже отмечена как спорная, она
считается и с ней, и без неё.

Объём этапа 2: 13 задач × 6 вариантов × 3 повтора = **234 ячейки**, из них 78
(повтор 1) уже есть, **156 к прогону**: 104 Claude (A, C, D, E) и 52 Codex (B, F).
Codex идёт под бюджетом 12 стартов за 24 ч (FIX-CODEX-QUOTA), поэтому этап 2
займёт не меньше 5 суток.

## Команда этапа 2

Запускать из `$WORK/repo`. Команда идемпотентна, готовые ячейки пропускаются.
В неё встроены гейты потолка Claude (75%), бюджета Codex и диска ≥ 5 GB.

```bash
cd web && env $(env | grep -oE '^AURA_[A-Z_]+' | sed 's/^/-u /') \
  AURABENCH_CODEX_LEDGER=/home/auracomp/aura-diet/bench/codex-starts.log \
  AURABENCH_FIVE_HOUR_CEILING=75 NODE_OPTIONS=--max-old-space-size=2560 \
  bun run eval:aurabench bench --bench-root /home/auracomp/aura-diet/bench \
  --variants A,B,C,D,E,F --reps 3 \
  --task-ids archived-sessions-hold-memory,claude-adapter-outbound-queue-overflow,claude-cli-stdio-transport,claude-model-switch-404-strands-session,codex-error-notification-shown-as-drift,codex-observer-findings-dropped,council-degraded-pair-never-recovers,council-observer-idle-until-first-checkpoint,extract-empty-chat-state,own-sandbox-image-no-upstream-registry,respawned-cli-forgets-last-message,resume-discards-conversation-too-eagerly,settings-secret-field-saves-mask-dots \
  --state /home/auracomp/aura-diet/STATE.json --timeout-min 60 \
  --timeout-min-class architecture=120 --wt-root /home/auracomp/aura-diet/wt-cells
```

Перед командой этапа 2 драйвер прогоняет оставшиеся 5 Codex-ячеек BENCH-H
(`bench.active_step`).
