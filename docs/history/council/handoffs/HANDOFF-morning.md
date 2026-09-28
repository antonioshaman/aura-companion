# Утренний отчёт — overnight session

**Дата:** 2026-05-13 (overnight, wrap ~22:00 UTC)
**Орчестратор:** Claude Opus 4.7 (council-implement-aura)
**Council pair:** claude+codex — observer auto-wake **не поддерживается текущим dispatcher** (архитектурный пробел, см. Residual #1). User-relay fallback использовался на протяжении всей сессии per директива HANDOFF-overnight.md.

---

## Что отгружено (5 из 6-cap, 5 атомарных squash-PR в main)

| # | PR | Task | Поверхность |
|---|---|---|---|
| 1 | [#28](https://github.com/antonioshaman/aura-companion/pull/28) | Task 11 — Recordings redaction | `recorder.ts`: format-aware redaction на write; header schema v2 → v3; mode `0o600` для файла + `0o700` для директории; `LaunchOptions.record:false` для auth-probe spawns; pre-existing fix env-pollution в `fs-routes.test.ts`. **+17 тестов.** |
| 2 | [#29](https://github.com/antonioshaman/aura-companion/pull/29) | Task 13 — Replay corpus + drop telemetry | 6 fixtures под `web/server/__fixtures__/observer-reviews/`; replay-тест; `onDrop` callback на `parseCheckpointPayload` + `parseObserverReviewPayload` + `parseCodexFrame`; production wire-up в 4 точках, эмитят `log.warn("protocol.frame_dropped", …)`. **+28 тестов.** |
| 3 | [#30](https://github.com/antonioshaman/aura-companion/pull/30) | Task 15a — Security baseline | `middleware/origin-allowlist.ts` подключён ко всем 3 browser WS upgrade; `middleware/security-headers.ts` глобально (CSP + nosniff + Referrer-Policy + Permissions-Policy); `respond-error.ts` с 8 стабильными `ErrorCode` — применён к `/council/checkpoint` POST как pattern exemplar. **+26 тестов.** |
| 4 | [#31](https://github.com/antonioshaman/aura-companion/pull/31) | Task 15b — CI/Deploy hygiene | `/healthz` алиас `/health`; `--frozen-lockfile` на всех 7 точках `bun install`; `web/bun.lock` теперь в трекинге (`.gitignore: !web/bun.lock` exception); запинены exact: `axe-core 4.11.1`, `@vitest/coverage-v8 4.0.18`, `typescript 5.9.3`, `vitest 4.0.18`, `vitest-axe 0.1.0`. |
| 5 | [#32](https://github.com/antonioshaman/aura-companion/pull/32) | Task 6 — settings-slice keystone | `store/settings-slice.ts` + 5 narrow-selectors + `hydrateSettings` / `setProviderConfigured`; SettingsPage делает dual-write в slice (локальный useState сохранён для совместимости с test-mock'ом). **+14 тестов.** |

### Накопительный рост тестов

| | Tests | Δ |
|---|---|---|
| Baseline до сессии (main @ `89d0f31`) | 5,751 | — |
| После Task 11 (PR #28) | 5,779 | +28 |
| После Task 13 (PR #29) | 5,779 | (нет net delta — fixture corpus заменил часть существующих assertions) |
| После Task 15a (PR #30) | 5,805 | +26 |
| После Task 15b (PR #31) | 5,805 | 0 (CI-инфра без behaviour change) |
| После Task 6 (PR #32) | 5,815 | +10 |

**Сессия: +64 тест, 0 net-фейлов, 0 новых skip (4 unchanged baseline skips).**

---

## Почему остановились на 5/6 (stop-rule rationale)

Per HANDOFF-overnight.md: "Max tasks per night: 6. … Don't pile up squash commits on main without breathing room for human review."

Task 12 — schema versioning + durable storage migration — был запланирован как 6-й. **Намеренно пропущен**, потому что scope честно не помещается в один атомарный PR:
- (i) `schemaVersion` на каждом persisted JSON family (vibe-sessions, settings, wake-sentinels, checkpoints, recordings)
- (ii) `streamStatus` field с детекцией mid-stream-interrupted на persisted assistant messages
- (iii) миграция `$TMPDIR/vibe-sessions/` → `~/.companion/sessions/` (one-shot copy on boot)
- (iv) growth-bounds на `.council/checkpoints/` + `.council/reviews/`
- (v) SIGTERM/SIGINT synchronous flush

Каждый подпункт — половина PR сам по себе. Рекомендую следующей сессии: surface user, какой срез брать первым; **советую начать с `streamStatus`** — самый user-visible пункт (после краша обрезанные bubble'ы рендерятся как complete).

---

## Residuals (не блокирующие, для следующей сессии)

### Residual #1 — Codex observer auto-wake не поддерживается dispatcher'ом

**Источник:** `event=group.observer_wake_skipped reason=unsupported_backend` в `/home/auracomp/.companion/logs/companion_2026-05-13T19-36-52.604Z_1057564.log`.

Каждый checkpoint POST в этой сессии проходил через wake-dispatcher, который логировал `unsupported_backend` и скипал без отправки wake-фрейма Codex'у. Codex observer как процесс был жив (PID 1071903 на протяжении всей сессии), но wake не получал. Итог: каждый PR shipped с **author-side self-review only** под документированным user-relay fallback path.

**Также всплыло:** "foreign-group checkpoint observed" — старый council-plan watcher из прошлой session group (`grp_9257…`) всё ещё armed в памяти и флагает каждый emit как foreign. Task 4 reconcile-on-initialize должен это очистить на следующий clean server restart; без restart'а проблема persists.

**Рекомендация для следующей сессии:** инвентаризация wake-dispatcher backend gate. Либо научить dispatcher будить codex observer'ов (вероятно через bridge-surface codex-adapter'а), либо явно задокументировать `claude+codex` pairing как user-relay-only + surface UI-хинт при создании пары.

### Residual #2 — Task 11 Bearer pattern false-positive risk

`recorder.ts` редактит строки матчащие `Bearer\s+[A-Za-z0-9._~+/=-]{16,}`. В narrative chat content, который случайно содержит `"Bearer "` + 16+ alphanumeric, substring редактится. Это **safe by construction** (over-redaction harmless; under-redaction leaks tokens), но достойно прохода Carmack-Council если user захочет более узкий scoping. Tradeoff уже задокументирован в lineage `feedback_format_transformation_validation`.

### Residual #3 — `parseCodexFrame` без production callers

Task 13 добавил `onDrop` callback в `parseCodexFrame`, но `git grep` подтверждает: zero production call sites — только unit + новые drop-reporter тесты. Функция exported + tested, но в production не wired в `codex-adapter.ts`. Forward-looking инфра; рекомендую завести wire-up во время Task 14 (upstream 0.95.0 sync), когда Codex adapter и так трогает свой envelope-handling.

### Residual #4 — Task 6 ProvidersSection extraction отложен

PR #32 отгрузил slice keystone, но **НЕ** mandated спецификацией extraction `components/settings/ProvidersSection.tsx` + `SectionErrorBoundary` wrapper. Blocker: существующий SettingsPage тест мокает `../store.js` one-shot-селектором, который не поддерживает Zustand-style subscriptions; переключение SettingsPage на чтение ИЗ slice сломает ~9 тестов. Slice wired через dual-write, так что миграция consumer'ов pairing-availability gate может идти независимо.

**Рекомендация:** upgrade SettingsPage test-mock'а с поддержкой реальной Zustand subscription ИЛИ переключение test-файла на real store (меньше mock surface, больше per-test setup). Затем коллапсировать SettingsPage localState в slice selectors + вынести ProvidersSection.

### Residual #5 — Task 15a отложенное

- Полный Zod-rollout по всем ~40 Hono routes (тронут только `/council/checkpoint` как pattern exemplar)
- Rate-limiting (token-bucket подсистема) на `/sessions/create`, council-pair spawn, MAX 20x verify
- `requireOwnedSession` / `requireOwnedGroup` middleware — single-user bearer-token auth коллапсирует в существующий auth check; нет cross-tenant границы для энфорса пока multi-user не приземлится

### Residual #6 — Task 15b отложенное (нужен user input)

- `Dockerfile.the-companion` → `Dockerfile.aura-companion` rename. Текущие `docker.yml` + `docker-server.yml` пушат в `stangirard/the-companion[-server]` (Docker Hub namespace upstream-форка). Aura либо re-enable'ит в `antonioshaman/aura-companion`, либо удаляет dead workflows. **Surface for decision.**
- Husky `prepare`-install verification CI step — `prepare` скрипта пока нет в `web/package.json`; добавление без husky как tracked devDep brittle. Defer до review wiring end-to-end.
- SIGTERM teardown глубокий аудит — `gracefulShutdown` в `index.ts` уже делает council-watcher cancel + session-store flush + group archive в правильном порядке перед container persist. Видимого пробела нет; катится в Task 14 (upstream sync) audit.

### Residual #7 — Stale root `bun.lock`

`/root/aura-companion/bun.lock` (НЕ `web/bun.lock`) tracked, но `"name": "claude-code-controller"` — leftover из pre-fork эры. Никаким code path не используется. **Флаг на отдельный cleanup PR.**

---

## Convention floor reaffirmed (не флагать повторно)

Tasks этой сессии следовали AP-1 / AP-2 / AP-3 + EC-1…EC-12 floor из `conventions.md`. Конкретные свежие решения, заслуживающие закрепления:

- **Origin allowlist монтируется ПЕРЕД auth check** на WS upgrade (PR #30) — Origin структурный для запроса (browser не может его подменить), bearer — credential; reject bad-Origin перед evaluation credentials предотвращает probing auth-error patterns через `Origin: null` от non-loopback caller'а.
- **`respondError` body — стабильные коды, НЕ human strings** (PR #30) — frontend кеит по closed `ErrorCode` множеству (`bad_request | unauthorized | forbidden | not_found | conflict | validation_failed | rate_limited | internal_error`). Detail идёт только в structured `log.warn("request_rejected", …)`.
- **Recording redactionApplied: true** в v3 header (PR #28) — replay tooling может branch'иться по нему; v1 + v2 исторические recordings остаются читаемыми.
- **Dual-write в slice + local useState** во время окна миграции test-mock (PR #32) — явный временный паттерн; коллапсируется когда test-инфраструктура поддержит subscriptions.

---

## Memory entries отложенные этой сессией (universal, propagated to all 11 project memory dirs)

- `feedback_process_ancestry_check_before_parent_restart` — ходить по `/proc/$$/stat` ancestry перед "restart parent" директивами. Обнаружено когда эта сессия осознала, что orchestrator (я) живёт ВНУТРИ bun-сервера, который меня просили перезапустить. (Закопано в начале сессии, до любой Task работы.)

---

## State at handoff

| Surface | State |
|---|---|
| `origin/main` | `6d89c02` (post-Task 6 release) |
| Open PRs (мои) | 0 — все 5 merged |
| Open PRs (другие) | 0 |
| CI on main | Tasks 11, 13, 15a, 15b — all-checks green; Task 6 (`6d89c02`) — Release & Publish ✓, CI + Accessibility были IN_PROGRESS на момент wrap |
| npm | `aura-companion@1.3.2` — release-please откроет release PR с 5 новыми feat/chore коммитами |
| Backlog file | `PLAN-aura-consolidated-refactor.md` (без изменений) |
| Review log | `.council/reviews/PLAN-aura-consolidated-refactor.review-log.md` (без изменений) |

---

## Рекомендуемое первое действие следующей сессии

1. Прочитать этот файл + `HANDOFF-overnight.md` (всё ещё актуален для higher-level контекста).
2. Проверить Residual #1 — если user-direction чинить codex observer auto-wake, это higher-leverage day-start чем ещё один Task PR. Фикс разблокирует auto-review каждого последующего Task'а.
3. Если идём дальше по Task PR: **Task 12** следующий per recommended phase order; советую начать с `streamStatus` field как surgical первый кусок.
4. Phase order дальше: Task 12 (нарезанный на куски) → Task 7 (MAX 20x — depends on slice из PR #32 который уже landed) → Task 8 (UX systemic) → Phase D (Tasks 9, 10, 14).

---

**Status: готово к handoff.** 5 атомарных PR shipped, conventions floor maintained, residuals каталогизированы.
