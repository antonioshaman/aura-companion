# Council Plan (Aura): повторный usability-аудит и исправления

**Scope:** подтверждённый пользователем 2026-10-31 повторный аудит Aura Companion, приоритет iPhone/PWA, затем исправления доказанных проблем. Основа main@c330b124; PR444–449 и их регрессии сохраняются.
**Context:** недавний mobile fix устранил самопроизвольный Home→Session, но не покрывал обычные переходы с черновиком, второй редактор и состояния списков при отказах сети. Изолированные пробы снова подтверждают три дефекта KB.
**Boundaries:** без изменения бренда, стека и фактических прав CLI; без чужих проектов/лендинга. Производственные KB/сессии не используются для разрушающих тестов. Физический iPhone и реальный CLI не подменяются моками.
**Council dispatched:** abramov, friedman, saarinen, watson, ritchie, fowler, hunt, willison, beck — все 9 вернули непустые отчёты. Saarinen не подтвердил необходимость визуального изменения. Beck: review-only каталог не имеет plan-aura.md; адаптация его фактической testing reference явно записана, отсутствующий шаблон не выдан за существующий.
**Roster/evidence:** `.council/plan-output/2026-10-31-uiux-usability/`; выбор и исключения в ROSTER.md. Экономный состав расширен AC-специалистами для UI и опасных KB-действий. Никаких новых протокольных/инфраструктурных/DB задач, потому dahl/hashimoto/durov/brandur не привлекались.

## Spec Acceptance Criteria

Дословные согласованные AC1–AC9 и проверяющие файлы — [SCOPE.md](.council/plan-output/2026-10-31-uiux-usability/SCOPE.md), часть этого плана. Каждый квалификатор действует: два backend; не терять ввод молча; не считать axe incomplete пройденной проверкой; подтверждённый факт отличать от гипотезы; новые chat-состояния в Playground; максимум 15 задач. Новая схема хранения не требуется.

## Принятые решения Chair

- Черновики — transient in-memory Zustand, отдельно на sessionId и отдельно Home. Переживают переходы интерфейса, не обещают сохранение после убийства вкладки/перезагрузки. Не добавлять browser-disk хранение исходников/изображений без отдельной потребности.
- Автоматический reconnect не запрещает локальное редактирование; отправка без соединения/при terminal failure остаётся запрещена. Offline queue не создаётся.
- Подпись режима — display-only. Для Codex учесть фактический never/danger-full-access в adapter и отдельное observer read-only ограничение; не писать «Supervised» и не усиливать права ради красивой подписи.
- KB version loss исправляется содержательной проверкой версии. Для некооперативного /learn внешнего редактора stat→rename не является CAS: не заявлять безопасность от одного локального lock. До доказанного общего writer protocol destructive Archive/prune должны быть fail-closed с понятной причиной; анализ, Keep и merge-mark продолжают работать. Это временное ограничение функции ради сохранности данных, явно сообщаемое владельцу.
- Никакого общего редизайна: у визуального эксперта нет подтверждённого дефекта, оправдывающего его стоимость.

## Task Sequence

### 1. Реестр сценариев и доказательств
| | |
|---|---|
| **Domain** | Beck × Carmack — красный тест доказывает проблему |
| **Ref** | references/quality-testing.md → behavioral regression / red step |
| **Depends on** | — |
Зафиксировать текущие сценарии/состояния, severity0–4, источники и отдельные device-гипотезы. Для каждой следующей задачи сначала воспроизвести конкретный дефект; не объявлять всю систему проверенной по отсутствию axe violations.

### 2. Сохранность версий KB и граница destructive Archive/prune
| | |
|---|---|
| **Domain** | Ritchie §B × Carmack — данные до действия; cross-ref Hunt/Beck |
| **Ref** | references/quality-ritchie.md → durable state; references/security.md → fail closed |
| **Depends on** | 1 |
Различать совпадение id и сохранённую актуальную версию; сохранять все поля и обе версии до удаления строки в quiescent helper. Доказать межпроцессную гонку на временных файлах и отключить разрушительное применение через UI/API/CLI до общего writer protocol, сохранив анализ и неразрушительные решения. Показать явную причину ограничения, не успешный Archive.

### 3. Полная проверка вложенного KB-отчёта
| | |
|---|---|
| **Domain** | Hunt × Carmack — проверить boundary; cross-ref Fowler/Ritchie |
| **Ref** | references/security.md → validation; references/refactoring.md → one owner |
| **Depends on** | 1 |
Сделать чтение неизвестного JSON total: повреждённые entry/signals/memory/mergeTasks получают report-invalid, а не runtime throw/available. Проверить все вложенные поля, реально используемые карточками, status и decisions, сохранив поддержку известных optional полей и newer-schema результата.

### 4. Исключение решений во время анализа
| | |
|---|---|
| **Domain** | Ritchie × Carmack — асинхронная граница имеет владельца |
| **Ref** | references/quality-ritchie.md → ownership / lifetime |
| **Depends on** | 3 |
Повторно проверять состояние анализа после чтения тела перед синхронным validate/apply. Поздний запрос получает 409 без применения, ledger или обновления счётчиков; сохранить отказы по устаревшему runId.

### 5. Изоляция и сохранение черновиков Home/Composer
| | |
|---|---|
| **Domain** | Abramov × Carmack — владелец состояния; cross-ref Fowler/Beck |
| **Ref** | references/quality-frontend.md → state identity; references/refactoring.md → minimal ownership |
| **Depends on** | 1 |
Сохранить текст/изображения Composer отдельно по sessionId, а незапущенную форму Home — при обычном уходе в другой раздел. Отдельно определить явный reset/«+» и успешную отправку/создание: поздний старый результат не очищает новый черновик. Не держать все routed pages смонтированными и не добавлять storage schema.

### 6. Оба редактора: сохранение, загрузка и отказ дерева
| | |
|---|---|
| **Domain** | Abramov × Carmack — результат относится к своей ревизии |
| **Ref** | references/quality-frontend.md → async effects / lifetime |
| **Depends on** | 1 |
В CLAUDE.md позднее сохранение не снимает dirty с нового текста/другого файла, а поздняя загрузка другого cwd/диалога не подменяет документ. Отказ обновления дерева SessionEditorPane сохраняет выбранный файл и несохранённый buffer; ошибка предлагает повтор, а не подразумевает удаление файла.

### 7. Agents/Runs: ошибки, stale-данные и порядок запросов
| | |
|---|---|
| **Domain** | Friedman × Carmack — пять честных состояний; cross-ref Beck |
| **Ref** | references/quality-ux.md → error / partial / ideal states |
| **Depends on** | 1 |
Отличать недоступный список от успешного пустого; сохранять последние строки с явной stale-пометкой и Retry при отказе refresh. В Runs только последний применимый запрос владеет результатом, total и статусом: предыдущий фильтр/поздний poll не перезаписывают текущие данные.

### 8. Composer: понятный режим и ввод при reconnect
| | |
|---|---|
| **Domain** | Willison × Carmack — правдивое состояние; cross-ref Friedman/Hunt |
| **Ref** | references/quality-llm.md → do not misrepresent; references/quality-ux.md → never freeze local input |
| **Depends on** | 5 |
Дать backend-specific человекочитаемые подписи известным режимам и честную unavailable подпись отсутствующему/неизвестному режиму. Подписи не отправляют permission mutations; при reconnect можно готовить черновик, но существующие запреты отправки действуют.

### 9. FolderPicker: возврат фокуса
| | |
|---|---|
| **Domain** | Watson × Carmack — один modal contract |
| **Ref** | references/quality-a11y.md → keyboard / focus return |
| **Depends on** | 1 |
Использовать существующий общий modal focus contract с возвратом на реальный opener после Escape, Close, backdrop и выбора. Сохранить special Escape manual path и корректность вложенных диалогов; отдельный modal framework не вводить.

### 10. Relationship IDs и семантика badge/summary
| | |
|---|---|
| **Domain** | Watson × Carmack — проверяемые отношения и роли |
| **Ref** | references/quality-a11y.md → names / roles / relationships |
| **Depends on** | 1 |
Сделать component-local IDs уникальными для повторов CouncilToggle/Budget/Coverage/Toolkit. Убрать неподдерживаемые имена generic wrappers либо дать уместную group/text семантику, сохранив reviewer/reason/CI пояснения. Проверить два экземпляра и объединённый Playground; gallery-only дефекты не выдавать за доказанный production navigation blocker.

### 11. Состояния Playground и интеграционная регрессия
| | |
|---|---|
| **Domain** | Beck × Carmack — проверка реального контракта; cross-ref Watson |
| **Ref** | references/quality-testing.md → boundary evidence; references/quality-a11y.md → state coverage |
| **Depends on** | 2–10 |
Отразить изменённые chat-состояния в Playground, выполнить компонентные render/axe/interaction проверки и полный suite/typecheck/coverage. Записать отдельно mocked/readonly preview и реальные CLI/device свидетельства; старые тесты не удалять и не ослаблять ради зелёного результата.

### 12. Повтор browser matrix и PWA-сценарий
| | |
|---|---|
| **Domain** | Friedman × Carmack — пользовательская задача; cross-ref Saarinen/Watson |
| **Ref** | references/quality-ux.md → task-based acceptance; references/quality-ui.md → inspect actual output |
| **Depends on** | 11 |
Через agent-browser пройти главные разделы в двух темах, мобильные ширины и контракты фокуса/ошибок/черновика. Проверить PWA update двумя различающимися сборками, сохранив clean final build. Физические iPhone/VoiceOver и реальные CLI результаты отметить честно: недоступное не считается PASS.

### 14. Codex 0.162.1: наблюдаемая совместимость первого ответа
| | |
|---|---|
| **Domain** | Dahl × Carmack — observed protocol contract / EC-5, EC-6 |
| **Ref** | references/quality-dahl.md → B7 protocol drift / B8 two protocols |
| **Depends on** | 12 live smoke |
Добавлено по реальному SSE/WebSocket smoke: новый turn/moderationMetadata ошибочно обрывает первый ответ. Сохранить обезличенный captured replay, сверить схему установленного CLI, принять только известный метод с threadId/turnId и обязательным opaque metadata; неизвестные методы и повреждённые оболочки продолжать отклонять. Подтвердить реальным ответом Codex после доставки. Anthropic verification фиксируется отдельно как внешнее ограничение, не чинится изменением auth/policy.

### 13. Доставка и короткий лист приёмки
| | |
|---|---|
| **Domain** | Chair × Carmack — конечный пользовательский результат |
| **Ref** | docs/conventions/pull-requests.md; docs/architecture/production-deployment.md |
| **Depends on** | 12, 14 |
Слить только после зелёного CI, выложить проверенную сборку и проверить публичный bundle/готовность, сохранив rollback. Backend изменения доставить безопасно по действующему lifecycle; frontend без ненужного рестарта. Дать владельцу короткую таблицу «исправлено / как проверено / что осталось вручную», отдельно назвать временно недоступный Archive/prune.

## Risks & Watchpoints

- **Ritchie:** произвольный внешний /learn не обязан соблюдать наш lock. Повторный stat/checksum не закрывает гонку; не обещать CAS без доказательства.
- **Abramov:** key без внешнего draft owner предотвращает перенос текста в B, но теряет его для A; это неполное исправление. Не сериализовать изображения в browser disk по умолчанию.
- **Willison/Hunt:** Codex collaboration mode не доказывает read-only sandbox; display-only изменения не должны менять wire/policy.
- **Watson:** валидный aria-haspopup=listbox с условно смонтированным popup не считать ошибкой автоматически. Фокус/ARIA на реальном DOM важнее наличия атрибута в исходнике.
- **Saarinen:** пока нет подтверждённой необходимости визуального рестайлинга. Не добавлять косметические задачи ради количества.
- **Beck:** inherited timeout/catalog/PYTHONDONTWRITEBYTECODE env уже давали ложные server-suite failures; повторять suite с диагностированным чистым окружением, не скрывать падения.

## External Setup Required

Код и автоматические проверки выполняются в текущем workspace. Для окончательной аппаратной приёмки нужен физический iPhone/PWA/VoiceOver владельца. Живой Claude smoke зависит от доступности Anthropic; отказ провайдера не является успешным запуском. Никакой внешний setup не блокирует исправление перечисленных доказанных дефектов.

## Summary

| # | Task | Domain | Depends on |
|---|---|---|---|
| 1 | Реестр и red-first evidence | Beck | — |
| 2 | KB версии + destructive safety boundary | Ritchie/Hunt | 1 |
| 3 | Total KB report validator | Hunt/Fowler | 1 |
| 4 | Decision race | Ritchie | 3 |
| 5 | Home/Composer drafts | Abramov/Fowler | 1 |
| 6 | Editor lifetimes | Abramov | 1 |
| 7 | Honest lists + latest Runs request | Friedman | 1 |
| 8 | Truthful modes + reconnect input | Willison/Friedman | 5 |
| 9 | Folder focus | Watson | 1 |
| 10 | Unique ARIA IDs + badge semantics | Watson | 1 |
| 11 | Integration + Playground | Beck/Watson | 2–10 |
| 12 | Browser/PWA matrix | Friedman/Saarinen | 11 |
| 14 | Captured Codex moderation metadata compatibility | Dahl | 12 live smoke |
| 13 | CI/deploy/owner checklist | Chair | 12,14 |

## Verdict

Начать с сохранности KB и черновиков. Ключевое решение — один явный владелец каждого пользовательского состояния и результата асинхронной операции; ради этого не нужен новый routing/state framework. Доказанные ошибки данных и обратной связи важнее декоративного редизайна. После плана исправления уже авторизованы пользователем, повторный общий permission gate не требуется.

Scope update: всего 14 задач (лимит 15 соблюдён). Dahl не был нужен до выявленного live protocol drift; теперь его reference применяется к доказанному сбою, без общего расширения транспорта.
