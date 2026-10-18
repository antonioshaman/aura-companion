# Страница «Диагностика» + фоновый анализатор KB / памяти — v1

Status: Draft for owner review (2026-10-18). Источник: `specs/lifeos-and-soul-md-takeaways.md` §3
п. 2 + п. 5, слитые по поправке владельца (handoff 2026-10-18). Реализация — `/council-plan-aura`
→ `/council-implement-aura` (triage: persistence + scheduler + routes + UI → economy council
обязателен).

## 0. Поправки владельца, которые спека обязана соблюдать

1. **Ничего из KB и памяти не удаляется и не правится автоматически.** Анализатор только
   формирует отчёт; решение (оставить / архивировать / объединить) принимает человек на странице.
2. **Анализ работает фоном в цикле** и запускается **по накоплению** (N новых записей KB или
   N сессий с прошлого прогона), а не на каждом тике.
3. Касается `.agents/knowledge/*.jsonl` (152 записи, `usageCount ≥ 1` у 2) и, по желанию,
   memory-файлов `~/.claude/projects/<slug>/memory/` (469 файлов, 2.2 МБ) — **только отчёт**,
   без правок файлов памяти вообще (даже по кнопке).

## 1. Зачем

- Observability Aura рассыпана по `journalctl`: живость пар, drift-kill'ы и relaunch'и,
  context-advisory, квота KV у usage-badge, здоровье KB. Половина обращений «элемент UI исчез»
  закрывается одним взглядом на такую страницу (см. memory
  `feedback_silent_null_render_hides_upstream_failure`, `feedback_usage_badge_gone_means_kv_quota`).
- KB копится, но не используется (152 / 2). Нужен «Bitter Pill»-прунинг: запись устарела, потому
  что модель и так это делает, или потому что файлов, о которых она, больше нет. Сегодня
  `kb:prune` умеет только «idle 20 сессий → archive», и то его никто не зовёт.

## 2. Job stories

- **JS-1 Оператор.** Когда у пользователя «пропал observer / badge / сессия молчит», я хочу открыть
  одну страницу и за 10 секунд увидеть, жив ли бэкенд, какие пары живы, были ли drift-kill'ы за
  последний час и что сказал context-advisory, чтобы не лезть в journalctl.
- **JS-2 Владелец KB.** Когда с последнего анализа накопилось достаточно новых записей или сессий,
  я хочу, чтобы Aura сама подготовила отчёт «что в KB мёртвое, дублируется или противоречит»,
  чтобы я принял решения по каждой карточке за пару минут, а не перечитывал 152 строки.
- **JS-3 Владелец памяти.** Когда memory-каталог разросся до сотен файлов, я хочу тот же отчёт по
  нему (дубли, устаревшие ссылки на файлы/флаги, противоречия), **без единой правки файлов**, чтобы
  решить, что чистить руками.
- **JS-4 Агент.** Когда я (Claude/Codex в сессии) обращаюсь к KB, я хочу, чтобы usage фиксировался
  (сейчас `usage.log` пуст), чтобы анализатор видел реальное использование, а не нули.

## 3. Scope v1

### 3.1 Страница `#/diagnostics` (WORKSPACE → «Diagnostics»)

Секции-карточки, каждая со своим источником и временем последнего обновления:

| Карточка | Что показывает | Источник |
|---|---|---|
| **Backend** | MainPID, uptime, версия, RSS/heap, браузеров/сессий (то, что сейчас в `[diagnostics] Runtime snapshot` раз в 5 мин) | уже собирается в `server/index.ts:945` — отдать через API |
| **Pairs** | каждая живая council-пара: оркестратор/observer, state, последний inbound-кадр (age), observer turn state, последний checkpoint/wake | `ws-bridge` + coordinator |
| **Drift / relaunch (24h)** | лента `silent_stdio_drift.detected / withheld_* / rate_limited`, relaunch'и, boot-resume; по сессии, с причиной | кольцевой буфер событий в памяти сервера (новый, bounded) + лог |
| **Context advisory** | последние advisory по сессиям (tier, размер jsonl / compactions) | уже считается в `session-recovery` pass |
| **Usage badge** | статус апстрима usage (OK / KV-квота / OAuth истёк) и время последнего успешного ответа | `GlobalUsageBadge` источник |
| **Knowledge base** | счётчики `kb:health` (used / promoted / stale / never-surfaced / idle), дата последнего анализа, порог накопления «N из M», кнопка «Запустить анализ сейчас» | `kb-health.ts` + анализатор |
| **KB analysis — решения** | карточки находок (см. 3.3) с кнопками **Оставить / Архивировать / Объединить** | отчёт анализатора |
| **Memory report** (опц., флаг) | те же находки по memory-файлам, **только чтение**, кнопок действия нет, только «Отметить как просмотренное» | анализатор, режим report-only |

Правила UI (из конвенций): discriminated-union state как в `SweepPage.tsx`; каждая карточка
рендерит явное состояние «нет данных / источник недоступен» вместо пустоты
(`feedback_silent_null_render_hides_upstream_failure`); `.test.tsx` с render + axe + клики.

### 3.2 Фоновый анализатор — цикл и триггер по накоплению

- Регистрируется в `CleanupScheduler` как **отдельная проверка с коротким интервалом**
  (`registerSweep("kb-analysis-check", …)` неприемлемо — у него 24h; нужен второй экземпляр
  планировщика или параметр интервала ≥ 1h, который уже допускает clamp `[1h, 25h]`). Проверка
  раз в час, дёшево: читает счётчики и решает, пора ли.
- **Пора**, если с момента `lastRun` выполнено хотя бы одно:
  - новых/изменённых записей KB ≥ `kbNewEntriesThreshold` (default **10**; считаем по
    `createdAt/updatedAt > lastRun.ts`);
  - завершённых сессий ≥ `sessionsThreshold` (default **25**; по session-store);
  - прошло ≥ `maxAgeDays` (default **14**) — страховка, чтобы отчёт не устаревал.
  Иначе — тишина, одна структурная строка лога раз в сутки «not due: 3/10 entries, 7/25 sessions».
- Запуск вручную кнопкой «Запустить анализ сейчас» (`POST`), с single-flight (повторный запуск
  при идущем → 409).
- Пороговые значения — в Settings → Session defaults → «Knowledge analysis», не в коде.

### 3.3 Что ищет анализатор (сигналы v1, все — детерминированные, без LLM)

| Сигнал | Критерий | Предлагаемое решение (человеку) |
|---|---|---|
| `never-used` | `usageCount = 0` и в `usage.log` нет id, возраст ≥ 30 дней | архивировать |
| `dead-reference` | любой путь из `affectedFiles`/`provenance.reference` не существует в репо | архивировать или обновить |
| `duplicate` | одинаковый нормализованный `fact` (lowercase, без пунктуации) или Jaccard по токенам `fact`+`tags` ≥ 0.8 между двумя записями | объединить (показать обе) |
| `contradiction` | две записи с пересечением `affectedFiles` и `recommendation`, содержащие противоположные модальности («never/always», «do not/do») — только эвристика, помечается как «проверить» | проверить вручную |
| `outdated-reports` | `outdatedReports ≥ 1` | архивировать или обновить |
| `stale-promoted` | promoted, но `dead-reference` | обновить |
| `bitter-pill` (v1 — только пометка) | gotcha/pattern про поведение модели/CLI с `provenance.date` старше текущей major-версии CLI (`claude_code_version` из последней сессии) | проверить: возможно, модель уже делает это сама |

Для memory-файлов (режим report-only): `duplicate` (по `description`/`name`), `dead-reference`
(пути/флаги в теле, которых нет в репо), `age` (feedback старше 180 дней без ссылок из других
файлов) — только отчёт.

### 3.4 Персистентность

- Отчёты: `~/.companion/diagnostics/kb-analysis/<ts>-<runId>.json` (atomic write, schemaVersion,
  bounded; хранить последние 20, старше — удалять как derived data; это НЕ KB).
- Решения: `~/.companion/diagnostics/kb-analysis/decisions.jsonl` — append-only
  `{ts, runId, entryId, decision: keep|archive|merge, mergeInto?, by: "owner"}`.
- Применение решения: `archive` → перенос строки в `.agents/knowledge/archive/<file>.jsonl`
  (как `kb:prune`, через существующий `pruneKb`-путь, никогда delete); `merge` → **v1 не
  применяет автоматически**: создаёт задачу «объединить X в Y» в отчёте и помечает X как
  `mergePending`; `keep` → запись помечается `reviewedAt`, из следующих отчётов исключается на
  90 дней, если не появится новый сигнал.
- Memory-файлы: никаких записей на диск, кроме `decisions.jsonl` с `decision: "seen"`.

### 3.5 REST

- `GET /api/diagnostics/overview` — все карточки 3.1 кроме анализа (один вызов, ≤ 50 КБ).
- `GET /api/diagnostics/kb-analysis/latest` — последний отчёт + статус накопления + inFlight.
- `POST /api/diagnostics/kb-analysis/run` — запуск; 409 если идёт; 202 + runId.
- `POST /api/diagnostics/kb-analysis/decisions` — `[{entryId, decision, mergeInto?}]`,
  валидируется против текущего отчёта (неизвестный entryId → 400).
- Всё под существующим bearer-auth; никаких путей из тела запроса (EC-7: resolving wrapper).

## 4. Acceptance criteria (Gherkin)

```gherkin
Feature: Diagnostics page
  Scenario: pair liveness at a glance
    Given a live council pair whose observer received no inbound frame for 20 min
    When I open #/diagnostics
    Then the Pairs card lists that pair with observer "silent 20m" and the last checkpoint time

  Scenario: drift events are visible without journalctl
    Given a silent_stdio_drift.detected and a withheld_open_tool_call happened in the last hour
    When I open #/diagnostics
    Then the Drift card shows both events with sessionId, time and reason, newest first

  Scenario: an unavailable source is explicit
    Given the usage upstream returns 429 (KV quota)
    When I open #/diagnostics
    Then the Usage card reads "KV quota exceeded since <time>" instead of rendering nothing

Feature: KB analyzer — accumulation trigger
  Scenario: not due
    Given the last analysis ran 2 days ago, 3 KB entries and 7 sessions since
    When the hourly check runs
    Then no analysis starts and the KB card shows "3/10 entries · 7/25 sessions · due in ≤12 days"

  Scenario: due by entries
    Given 10 KB entries were added since the last run
    When the hourly check runs
    Then exactly one analysis runs, a report file is written, and the KB card shows its findings

  Scenario: manual run is single-flight
    Given an analysis is in flight
    When I press "Run analysis now"
    Then the API answers 409 and the button stays disabled with "running…"

Feature: KB analyzer — nothing is deleted automatically
  Scenario: findings are proposals
    Given the report flags got-017 as never-used and got-040/got-041 as duplicates
    Then no file under .agents/knowledge changes until a decision is posted

  Scenario: archive decision
    When I choose "Archive" on got-017
    Then its line moves to .agents/knowledge/archive/gotchas.jsonl, nothing is deleted,
      and decisions.jsonl gains one line

  Scenario: memory report is read-only
    Given the memory report flags two duplicate feedback files
    Then the card offers only "Mark as seen" and no file under the memory dir is written
```

## 5. Границы

**Must:** owner-поправки §0; structured logs с `event=kb_analysis.*`; single-flight; atomic
writes; каждая карточка имеет состояние «источник недоступен»; тесты сервера (triggers,
signals на фикстурах KB, decisions validation) и компонентов (`.test.tsx` + axe).

**Never:** удалять строки KB; писать в memory-dir; звать LLM в анализаторе v1; блокировать
event-loop (чтение KB и memory — через `trackSync` метки, ≤ 100 мс; memory-анализ — только по
ручному запуску или флагу `diagnosticsMemoryReport`, default **off**).

**Out of scope v1:** авто-merge; LLM-оценка «модель уже умеет»; экспорт отчёта; Codex-специфика
(страница общая для обоих бэкендов, Pairs-карточка показывает backendType).

## 6. Открытые вопросы владельцу (с предложенными ответами)

1. Пороги накопления 10 записей / 25 сессий / 14 дней — ок как стартовые? (предлагаю да,
   настраиваемые в Settings).
2. Memory-report по умолчанию выключен и запускается только вручную — ок? (предлагаю да: 469
   файлов, 2.2 МБ, читать на каждом цикле незачем).
3. «Объединить» в v1 только помечает пару, не сливает текст — ок? (предлагаю да: слияние текста
   без LLM даст мусор, с LLM — нарушит «ничего не правим автоматически»).
