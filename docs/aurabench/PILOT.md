# AuraBench D2-pilot — итог (попытка 2)

Пилот гейта D2: 5 задач × 7 вариантов (A–G) × 1 повтор = 35 ячеек. Раннер
`bun run eval:aurabench bench` (PR #234 и фиксы #248–#265), инстанс Companion
бенча на :3499, модели закреплены: Claude `claude-opus-5-5` (CLI 2.1.283),
Codex `gpt-5.5` (codex-cli 0.142.5).

Прогон шёл с 2026-09-28 20:25 UTC по 2026-09-29 00:32 UTC. Пять ячеек тогда
записались как `agent_error` из-за лимита сессии подписки: раннер не распознал
текст «You've hit your session limit». После FIX-D2-LIMIT (#264) супервизор
вынес их в `results/limit-misrecorded.jsonl`. 2026-09-29 08:41–09:34 UTC они
перепрогнаны уже под гейтом USAGE-CEILING (#265): 0 пауз на лимитах и 0
ожиданий потолка.

## Гейт

| Критерий | Результат |
|---|---|
| ≥ 90% ячеек дали валидную запись | **35/35 (100%)**, все `status=completed`, ключи уникальны |
| Изоляция naked Claude (A) | init-фрейм: только встроенные skills, 0 MCP-серверов, 0 hook-событий, `apiKeySource=none`, свой `CLAUDE_CONFIG_DIR` |
| Реальный `~/.codex` | не изменён ни в одной ячейке (снимок 5700 файлов / 2530 каталогов; sha `auth.json` до и после совпадает) |
| Нарушения изоляции (`isolation.violations`) | 0 из 35 |
| Aura-инстанс | порт 3499, свои home/recordings/stats; у всех Aura-ячеек `bench/aura-home/.codex` — настоящий каталог; stash keeper'а пуст |

## Результаты (1 повтор, без доверительных интервалов — это не отчёт D3)

| Вариант | Успех | Медиана wall clock, с | Стоимость API-экв., $ (сумма) | tokens out (сумма) |
|---|---|---|---|---|
| A naked Claude | 5/5 | 145 | 1.65 | 23 673 |
| B naked Codex | 5/5 | 206 | — (подписка, без цены) | 28 454 |
| C Claude + knowledge | 4/5 | 229 | 3.17 | 30 268 |
| D Claude + Observer | 4/5 | 382 | 6.42 | 54 146 |
| E Claude + full Council | 4/5 | 822 | 8.11 | 71 395 |
| F Codex + Aura | 4/5 | 273 | — | 29 061 |
| G Codex + Council | 4/5 | 257 | — | 27 388 |

Задачи: `codex-model-fallback-picks-mini`, `dedupe-assistant-avatar`,
`known-broken-claude-model-substitution`, `observer-findings-oldest-first`,
`resume-hiccup-loses-conversation`.

## Наблюдения

- Четыре задачи из пяти решили все 7 вариантов. На лёгких и средних задачах
  пилот различает варианты только по стоимости и времени: E в 4,9 раза дороже
  A и в 5,7 раза дольше по медиане.
- `resume-hiccup-loses-conversation`: A и B прошли (122/122), а все пять
  Aura-вариантов упали на hidden-тестах `shouldClearResumeAfterExit`. У C, D и E
  один провал (`clears only after a second consecutive fast resume-death`:
  ожидалось значение счётчика 2, получено 0). У F и G по четыре провала:
  счётчик не заведён. Это расхождение в семантике счётчика, а не сбой harness.
  Перед D3 стоит проверить, что текст задачи однозначно задаёт эту семантику:
  возможно, A и B совпали с ожиданием случайно. Это вход для D2-PROBE и D3.
- `hidden.tampered` не пуст во всех 35 ячейках: агенты правили файлы
  hidden-тестов (обычное «добавь тест»). Harness перед проверкой возвращает
  hidden-тесты в исходное состояние, поэтому на оценку это не влияет. Флаг
  информационный.
- Регрессионный набор зоны (`regressions.checked`) в пилоте пуст: у пилотных
  задач нет `related`-тестов вне hidden. Для отчёта это ограничение.

Сырые записи ячеек лежат в `$WORK/bench/results/cells.jsonl` (вне репо) и
попадут в `docs/aurabench/data/` на шаге D3 без секретов и прод-путей.
