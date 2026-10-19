# Handoff prompt — next paired session (PR 2b2 + onwards)

Paste the block below into the new session as the first message.

---

```
Контекст: продолжаем работу над auto-proceed feature в aura-companion. Предыдущая сессия 2026-05-14 шипнула 4 PR в main: #44 (sidebar chip suppression), #45 (auto-proceed foundation Tasks 1+3+4), #46 (persistence helpers Tasks 5+6), #47 (idle-timer-manager Task 7). Все merged. origin/main = 1fb19d1.

Что делать сейчас — PR 2b2 = Tasks 8 + 9 из PLAN-aura-orchestrator-idle-auto-proceed.md. Это самый дорогой оставшийся server-side кусок, его специально отложили до fresh-context сессии потому что трогает session-orchestrator.ts (1900+ lines, очень stateful) и group-state-machine.ts.

Task 8 — state-machine integration via applyEvent:
- Расширить web/server/group-state-machine.ts шестью новыми events: orchestrator_turn_idle, orchestrator_turn_active, stop_finding_raised, stop_finding_resolved, auto_proceed_fired, iteration_cap_tripped.
- deriveSideEffects table должен фанить arm/disarm/persist/log actions для каждой из них.
- Side-effect channel — добавить новый descriptor type (например ArmIdleTimerEffect / CancelIdleTimerEffect / NoteUserMessageEffect) рядом с существующими GroupBusSideEffect.
- AP-2 invariant: state machine как единственный mutator группового lifecycle сохраняется; добавление новых событий не должно требовать новых mutator-сайтов вне applyEvent.

Task 9 — boot reconcile + SIGTERM drain:
- В web/server/session-orchestrator.ts initialize() добавить pass: для каждой реконструированной council group сделать readdir(<workspace>/.council/state/*-auto-proceed-trace.json), вызвать readAutoProceedTrace, и (если ok) — idleTimerManager.rehydrate(sessionId, trace, expectedGroupId). Skip orphans + unknown-schemaVersion at WARN. Idempotent.
- В web/server/group-shutdown.ts SIGTERM path: idleTimerManager.disposeAll() ПЕРВЫМ шагом, ДО kill propagation. EC-2 invariant — закрыть таймеры до того как kills полетят к детям.
- DI: session-orchestrator должен получить IdleTimerManager в конструкторе. Production IdleTimerManagerDeps собирается из: SystemClock, getSession через session map, getGroupStatus через SessionGroupCoordinator, writeAutoProceedTrace + appendAfkSummary напрямую, sendSyntheticFrame через ClaudeAdapter.send (Task 11 эту обёртку улучшит — пока вызов простой), logEvent через logger.

Ключевые файлы которые уже шипнуты и которые нужно импортировать (НЕ переписывать):
- web/server/auto-proceed-types.ts — envelope + parser + AUTO_PROCEED_DIRECTIVE_PREFIX
- web/server/clock-source.ts — ClockSource interface + SystemClock + FakeClock
- web/server/council-state-path.ts — resolveCouncilStatePath wrapper (EC-7)
- web/server/auto-proceed-state.ts — readAutoProceedTrace + writeAutoProceedTrace + appendAfkSummary + ensureCouncilStateDir
- web/server/idle-timer-manager.ts — IdleTimerManager class + IdleTimerManagerDeps interface
- web/server/event-bus-types.ts — orchestrator:turn-done event variant (используем как trigger для arm)

Convention floor (НЕ перепроверять в самопроверке):
- AP-1: coordinator DI-decoupled
- AP-2: state-machine = single source of truth (Task 8 это укрепляет)
- AP-3: writer + reader в одном файле
- EC-2: group-aware kills mark BOTH intentional до kill
- EC-7: filesystem path resolution через resolving wrapper (уже сделано в Task 5)
- EC-9: structured JSON log lines с event + sessionGroupId + sessionId + role

Тесты: всё через DI. Используй FakeClock из clock-source.ts, не vi.useFakeTimers. Идемпотентность boot reconcile проверь явно. Реальный test workspace через mkdtempSync.

Не делай:
- Не трогай Codex auto-wake (reverted в #43, новый mechanism нужен — отдельный план).
- Не делай Task 2 (skill canary) — требует моих правок ~/.claude/skills/council-*-aura/SKILL.md.
- Не делай PR 3+4 (boundary + frontend) — будут отдельной сессией после 2b2.

Workflow:
1. git status — убедись на main, чистая.
2. git pull --ff-only origin main.
3. git checkout -b feat/auto-proceed-statemachine-and-reconcile.
4. Реализуй Task 8 + Task 9 в одном PR (они связаны DI шиной).
5. cd web && bun run typecheck && bun run test — должны пройти.
6. Коммит + push + PR в main, gh pr create с body-file.
7. Дождись CI green + merge --squash --delete-branch.

В CLEANUP-AUDIT.md repo root есть полный статус. PLAN-aura-orchestrator-idle-auto-proceed.md в repo root — каноничный план.

Если контекст забивается на середине — стопни, дай мне такой же handoff prompt для следующей сессии (та же папка, тот же стиль).
```

---

That's everything the next session needs. Start it in this directory (`/root/aura-companion`); the new agent will read CLAUDE.md + memory automatically.
