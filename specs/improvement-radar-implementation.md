# Council Implementation Log: Радар улучшений

План: `specs/improvement-radar-plan.md`, подтверждён в текущей беседе. Дополнение пользователя: компактные счётчики предложений и уже реализованных идей. Реализация выполнена в `/tmp/aura-improvement-radar`, ветка `feat/improvement-radar`, чтобы не запускать HMR на рабочей сессии.

## Поведение

На старте новой сессии появляется свёрнутая строка «Радар улучшений · N предложений · M уже в Aura». Нет баннера, toast, автоматического раскрытия или внедрения. Внутри — до 10 коротких предложений, ссылки, даты, неопределённость и действия «не предлагать», «уже реализовано», восстановление. Счётчик «уже в Aura» включает четыре возможности с основаниями в коде и явные отметки пользователя; это не число автоматически выполненных задач.

Публичные GitHub-поиски, CLI-релизы и официальные каталоги OpenAI/Anthropic проверяются вручную либо раз в сутки после явного включения. Оценка детерминированная, без LLM и отправки приватного кода. Идентичность предложения привязана к репозиторию/официальному каталогу, поэтому отклонение сохраняется и при следующем релизе; его можно отменить.

Данные хранятся атомарно в `COMPANION_HOME/radar/state.json`. Лимиты: 20 источников, 100 находок/сохранённых идей, 2000 решений, 256000 байт ответа, дедлайн 60 секунд и 60 секунд паузы ручных запусков. Пропущенные задания не воспроизводятся очередью. Ошибки и прерванные попытки сохраняют предыдущие результаты; повреждённый файл не затирается.

Каталоги моделей не подменяются анонсами. Расширены существующие Settings: результат Codex refresh теперь `local-cache`, а не ложный `ok`; новый метаданный ответ различает свежий/устаревший/отсутствующий/повреждённый каталог и отсутствие Anthropic API-ключа. Версии установленных CLI наблюдаются фиксированным асинхронным `--version` с таймаутом. Установка, смена модели и перезапуск текущих сессий отсутствуют.

## Сопоставление задач с diff

| Задача | Статус | Эксперт / применённый принцип | Файлы |
|---|---|---|---|
| 1. Контракт | completed | Fowler 6, Hunt 5 | `server/radar/radar-types.ts`, `radar-evaluator.ts` |
| 2. Сохранение решений | completed | Fowler 3 | `server/radar/radar-store.ts`, `.test.ts` |
| 3. Ограниченные источники | completed | Hunt 1,5 | `server/radar/radar-sources.ts`, `.test.ts` |
| 4. Проверяемые предложения | completed | Willison 3,9 | `server/radar/radar-evaluator.ts`, `radar-types.test.ts` |
| 5. Запуск и расписание | completed | Fowler 6, Hunt 7 | `server/radar/radar-runner.ts`, `routes/radar-routes.ts`, `routes.ts`, `index.ts` и тесты |
| 6. Актуальность моделей | completed | Willison 7 | `server/model-freshness.ts`, `routes/settings-routes.ts`, `src/api.ts` и тесты |
| 7. Компактный UI | completed | Fowler 3, Beck 7 | `src/components/ImprovementRadar.tsx`, `.test.tsx`, `HomePage.tsx` |
| 8. Селектор и диагностика | completed | Willison 7, Beck 7 | `HomePage.tsx`, `SettingsPage.tsx`, соответствующие `.test.tsx` |
| 9. Проверки | completed | Beck 4,6,7 | Серверные, UI, auth, axe, browser smoke; результаты ниже |

Справочники всех перечисленных экспертов прочитаны из `packs/skills/council-plan-aura/references/`. Conventions: EC-53 (перехват фоновых ошибок), атомарная запись через существующий helper; auth и Origin сохранены, каталог/registry не расширяются внешними анонсами. Протоколы CLI и компоненты чата не менялись; Playground для отдельного home-only Радара не требуется.

## Проверка и ограничения

- Целевые проверки: render/axe/keyboard, отрицательные состояния, решения/перезапуск, single-flight, deadline, повреждённые данные, ограничение размера и источников, Claude/Codex metadata, production auth/Origin. Комментарии объясняют проверяемые гарантии. Существующие тесты не удалялись и не ослаблялись.
- Проверки расширялись по задачам, общий suite запускается на этапе приёмки, а не после каждого промежуточного файла. TodoWrite отсутствует в доступных инструментах; состояние зафиксировано здесь и в сообщениях.
- Браузерная проверка выполнена `agent-browser`, на отдельном компонентном стенде с фикстурой, в светлой/тёмной теме и ширинах 390/768/1280. Нет горизонтального переполнения на 390 px, раскрытие работает с Enter. Это не скриншот production-данных. Внешний CLI использован вместо Playwright-инспектора design skill согласно правилам репозитория.
- Стиль: Achromatic ledger, seed 1576101520, сохранены существующие tokens и шрифт Aura; без смены дизайна остального приложения.
- Живые ограниченные проверки: GitHub поиск, официальные Markdown-каталоги и оба CLI-источника доступны. Для Codex использована Atom-лента, поскольку JSON-релиз содержит слишком большой список бинарных assets; для Claude Code — ограниченный JSON последнего релиза. Неизвестный формат/oversize возвращает частичную ошибку, не отключение лимита.
- Первый полный прогон обнаружил унаследованные `AURA_*TIMEOUT*`, `AURA_COUNCIL_CATALOG_DIR`, `PYTHONDONTWRITEBYTECODE`, влияющие на старые suites. Повторный прогон выполняется с этими переменными отключёнными только в тестовом процессе. Одно временное несовпадение свежего теста и ещё загруженной версии модуля устранено повторной целевой проверкой финального кода.
- Попытка smoke запуска полного сервера выявила, что `SessionStore` использует `homedir()/.companion/sessions`, независимо от `COMPANION_HOME` и `TMPDIR`. Этот сервер остановлен; далее использовался только изолированный компонентный стенд без сессий и CLI. Рабочий сервер не перезапускался.
- Человеческого ревью не было. Код и проверки подготовлены AI.

## Ready for Review

Все пути ниже относительно `web/`, кроме этого документа:

- `server/radar/radar-types.ts`, `radar-evaluator.ts`, `radar-store.ts`, `radar-sources.ts`, `radar-runner.ts`
- `server/radar/radar-types.test.ts`, `radar-store.test.ts`, `radar-sources.test.ts`, `radar-runner.test.ts`
- `server/model-freshness.ts`, `server/model-freshness.test.ts`
- `server/routes/radar-routes.ts`, `server/routes/radar-routes.test.ts`
- `server/routes/settings-routes.ts`, `server/routes/settings-routes.test.ts`
- `server/routes.ts`, `server/routes.test.ts`, `server/index.ts`
- `src/api.ts`
- `src/components/ImprovementRadar.tsx`, `src/components/ImprovementRadar.test.tsx`
- `src/components/HomePage.tsx`, `src/components/SettingsPage.tsx`, `src/components/SettingsPage.test.tsx`
- `specs/improvement-radar-implementation.md`, `specs/improvement-radar-plan.md`
- `specs/assets/improvement-radar/*.png` — четыре превью на тестовых данных
- `.agents/knowledge/gotchas.jsonl` — проверенное ограничение изоляции SessionStore (got-062)

## Итог верификации

- Полный зафиксированный прогон в очищенном тестовом окружении: **580 suites passed, 1 skipped; 12126 tests passed, 8 skipped** (188 секунд). Пропуски существовали до изменения.
- После последней привязки обновления каталога к загрузке опций селектора: **197 целевых и интеграционных тестов прошли**; typecheck и production build прошли. Общий suite после этой небольшой frontend-привязки повторно не запускался; изменённые поверхности проверены целевыми наборами.
- Покрытие новых модулей в целевом прогоне: **97.3% строк совокупно**; отдельные файлы 90–100%, компонент Радара 93.33%. Финальная привязка callback отдельно покрыта интерактивным тестом.
- Все девять задач имеют изменения в diff; ни одна задача не отброшена. Новые helper-модули проверены офлайн; живые источники проверены отдельно и не служат CI gate.
- Скриншоты вынесены в `specs/assets/`, поскольку это превью, а не изменения Council runtime.

## Доставка

Проверенный diff перенесён в основной workspace `/root/aura-companion` независимым tmux-процессом, чтобы текущая сессия не выступала writer для собственного runtime. Побайтово проверено совпадение всех 31 файлов с worktree; `git diff --check` прошёл. Пользовательские `docs/security/` и прежние плановые артефакты сохранены. Коммит, PR и production restart не выполнялись. Council checkpoint пропущен: API не содержит подходящего активного orchestrator для этого workspace. Временный компонентный стенд и браузер закрыты.

## Council review fix pass — 2026-11-26

Все 11 экспертов завершили ревью; 12 уникальных P2, P1/P3 нет. Пользователь разрешил исправить все уровни и затем выпустить релиз. Отчёт: `.council/review-output/2026-11-26-2036/FINAL-REVIEW.md`.

| Finding | Рекомендуемое поведение / внесённое исправление | Проверка |
|---|---|---|
| HUNT-1 | Только строковое решение из enum на обоих runtime-boundaries; неверный JSON не меняет файл | route/store: red → green |
| HUNT-2 | Одна общая CLI-проба на backend, 60-секундный кеш включая ошибки | burst20: red (20 processes) → green (1) |
| DAHL-1 | Закрывать body HTTP-ошибки; ошибка cancel не заменяет безопасный текст | 403/429/500 streams: red → green |
| RIT-1 | Частичный результат сначала сохраняет прежние 100 записей | boundary100: red → green |
| FOWLER-1 / UX-1 | Отдельный bounded архив доказательств решений; восстановление возвращает предложение | replacement/restart/restore: red → green; UI title/source |
| ABR-1 | Сериализовать polling, игнорировать ответы до начала/завершения mutation | deferred GET→POST→GET: red → green |
| BECK-1 | Положительно проверить запуск opted-in расписания раз в сутки | scheduled-call deletion mutation: red; original green |
| BECK-2 | Проверять trusted binary/version argv/timeout/output bounds и ошибки | argv mutation: red; original green |
| WATSON-1 | После успешного restore возвращать фокус в summary; при ошибке сохранять control | implemented/dismissed focus: red → green |
| UX-2 | Повторная загрузка после первой ошибки без перезагрузки страницы | retry interaction: red → green |
| WILLISON-1 | Подавлять настоящий fork Aura и upstream без учёта регистра | fork cases: red → green |
| WILLISON-2 | Не сообщать успех при HTTP200 unavailable/absent; не перезагружать selector при неуспехе | semantic failure: red → green |

**Diff matches recommendation: yes** — guards проверяют фактический тип, error-body закрывается до throw, partial cap сохраняет начало списка, архив не зависит от replaceable scan, старый polling не применяет state, фокус переносится только при успехе, semantic failure не объявляется успешным обновлением. Новая optional decisionIdeas совместима с version1 без этого поля; общий лимит записи512KB сохранён. При заполненных100 предложениях restore архивной записи отклоняется без потери решения и просит сначала разобрать список.
