# Handoff prompt — PR 2c (Task 11) — synthetic-frame send pipeline

Контекст: продолжаем работу над auto-proceed feature в aura-companion. Предыдущая сессия 2026-05-14 шипнула 3 PR в main:
- #47 — idle-timer-manager DI module (Task 7)
- #48 — state-machine integration + boot reconcile + SIGTERM drain (Tasks 8+9) — `172619c`
- #49 — Hono boundary validator + observer-poll failsafe (Task 10) — `bd092f0`

`origin/main` = `bd092f0`. Все three merged with green CI + observer-reviewed plans (3 council-plan iterations on PR 2c PLAN, all findings substantively closed). Stub в `index.ts` сейчас возвращает `{ok: false, error: "synthetic-send-not-wired-task-11"}` — это unreachable в production (no caller emits orchestrator_turn_idle через state machine yet) и блокирует переход в Task 11.

## Что делать сейчас — PR 2c Task 11 = synthetic-frame send pipeline

Самый дорогой оставшийся server-side кусок. Канонический план в `PLAN-tasks-10-11-boundary-and-send-pipeline.md` в repo root — он прошёл 3 раунда council-plan observer review, все substantive findings закрыты в файле. Task 11 секция (Task 10 уже шипнут) включает:

### 1. Per-session outbound FIFO queue (claude-adapter)

- Перед `sendUserFrameFromServer` на adapter level (НЕ на bridge level — keeps existing user-frame path unchanged).
- Реализация: `Promise.resolve().then(...)` chain stored on adapter instance.
- Bounded depth **16** (4 tabs × 4 in-flight × 2x headroom — inline comment на call site обязательно для grep-auditability).
- Entries shape: `{kind: "user" | "synthetic", payload, enqueuedAt}`.

### 2. Asymmetric overflow policy

- **Synthetic enqueue at depth ≥ 16:** REFUSE → EC-9 log `auto-proceed.synthetic_dropped_queue_full` + manager's `fire()` returns `{kind:"send-failed", error:"queue-full"}`. Trace counter NOT advanced.
- **User-frame enqueue at depth ≥ 16:** evict OLDEST synthetic (newest-to-oldest scan), make room for user. If no synthetic queued → surface `protocol.frame_dropped` to originating browser socket via existing wire variant. User-typed messages MUST NEVER be silently lost.

### 3. Recorder origin extension

- Update `web/server/recorder.ts`: extend `RecordingOrigin = "browser" | "server:council-wake" | "server:auto-proceed"`.
- Synthetic frame send calls recorder with `origin: "server:auto-proceed"`.
- **Doc-drift defence:** update CLAUDE.md "Raw Protocol Recordings" section в том же commit чтобы документировать новое значение origin. Сейчас в CLAUDE.md описаны только `ts/dir/raw/ch` поля; нужно добавить упоминание `origin` (уже существует в v2 schema) с тремя возможными значениями.

### 4. Sticky `pendingSyntheticTurnToken` race-defence (КРИТИЧНО — observer v2 nailed это)

- В IdleTimerManager: per-session `pendingSyntheticTurnToken: number | null` field.
- Stamp при fire-time с текущим `turnToken`.
- Cleared **ONLY** на receipt of terminal `result` NDJSON frame for that turn — NOT на user typing, NOT на next user-frame send.
- Expose: `isSyntheticTurnInFlight(sessionId): boolean`.
- `noteUserMessage` does NOT clear the synthetic-pending flag — only the `result`-frame observer in adapter does. Это форсит race к structurally impossible.

### 5. Denylist module + can_use_tool gate

- New file `web/server/auto-proceed-permissions.ts`:
  ```ts
  export const SYNTHETIC_FRAME_TOOL_DENYLIST: ReadonlySet<string> = new Set([
    "Bash:git push", "Bash:git commit", "Bash:gh pr create", "Bash:gh pr merge",
  ]);
  export function isToolUseDeniedForSynthetic(toolName: string, toolInput: unknown): boolean;
  ```
- Gate fires inside orchestrator-side `can_use_tool` handler in `claude-adapter.ts` (NOT observer's — `observer-permissions.ts` стоит отдельно). Reads `isSyntheticTurnInFlight()` — sticky semantics (см. #4).
- Denied → `{behavior:"deny", message:"...synthetic frame may not invoke git push/commit/gh pr ..."}` to CLI.

### 6. Single-firer gate / cross-tab union

- `wsBridge.onUserFrameObserved(callback: (sessionId: string) => void)` — fires synchronously on ANY browser socket's user-frame.
- In `session-orchestrator.initialize()`: `wsBridge.onUserFrameObserved((sid) => this.idleTimerManager.noteUserMessage(sid))`.
- IdleTimerManager.fire's existing turnToken re-read IS the single-firer gate — this task only adds the observability path.

### 7. Idle-kill clock split (Subprocess council Rec1)

- Enumerate ALL `session.lastCliActivityTs = Date.now()` sites in `ws-bridge.ts` (grep before/after).
- Split into:
  - `noteUserActivity(sessionId)` — advances `lastCliActivityTs`.
  - `noteSyntheticActivity(sessionId)` — does NOT advance.
- **Grep-auditable canary test**: a sibling test asserts `session\.lastCliActivityTs\s*=` matches ONLY inside `noteUserActivity` in `ws-bridge.ts`.

### 8. Wire index.ts stub → real bridge call

- `sendSyntheticFrame: (sessionId, body) => wsBridge.sendOrchestratorSyntheticFrame(sessionId, body)`
- `wsBridge.sendOrchestratorSyntheticFrame` — mirror of `sendObserverWakeFrame` but `origin: "server:auto-proceed"` + sticky-flag stamp side-effect on adapter.
- **No orchestrator-busy gate bypass needed** — manager.fire is reachable ONLY when gate stack returns `awaiting-input` with `blockedByStop=false`, which is strict subset of NOT-busy. State this contract в JSDoc on `sendOrchestratorSyntheticFrame`.

### 9. Tests

- **Race-regression test (mandatory)**:
  - Fire synthetic. Verify `isSyntheticTurnInFlight=true`.
  - Inject user-frame from another tab. Verify flag STILL true.
  - Inject `can_use_tool` for `Bash:git push`. Verify deny.
  - Inject terminal `result` frame. Verify flag flips false.
  - Inject another `can_use_tool` for `Bash:git push`. Verify ALLOW.
- **Multi-tab single-firer test** (`ws-bridge-multi-tab.test.ts`, new): 2 sockets → arm timer → send user frame from tab B → advance FakeClock past `idleMs` → assert fire callback observed turnToken advanced and refused.
- **Idle-kill split test**: 100 synthetic frames в sequence НЕ advance `lastCliActivityTs`.
- **FIFO ordering test**: 2 near-simultaneous frames serialise correctly.
- **Denylist unit test**: `isToolUseDeniedForSynthetic` returns true for each entry, false for anything else.

### 10. Coverage gate

- Every new file ≥ 80% line coverage в same commit:
  - `web/server/auto-proceed-permissions.ts` (new)
  - Modifications to `claude-adapter.ts`, `ws-bridge.ts`, `recorder.ts` — keep thin (≤ 5 lines per god-module).
- File-level cascade defence: НЕ заваливать coverage god-modules — push complexity в sibling files. Если sticky-token state логика разрастается, вынести в `web/server/auto-proceed-turn-state.ts`.

## Ключевые файлы которые уже шипнуты и которые нужно импортировать (НЕ переписывать)

- `web/server/auto-proceed-types.ts` — envelope + parser + AUTO_PROCEED_DIRECTIVE_PREFIX
- `web/server/clock-source.ts` — ClockSource interface + SystemClock + FakeClock
- `web/server/council-state-path.ts` — resolveCouncilStatePath wrapper (EC-7)
- `web/server/auto-proceed-state.ts` — readAutoProceedTrace + writeAutoProceedTrace + appendAfkSummary
- `web/server/idle-timer-manager.ts` — IdleTimerManager class + IdleTimerManagerDeps interface
- `web/server/event-bus-types.ts` — `orchestrator:turn-done` event variant
- `web/server/group-state-machine.ts` — 6 new auto-proceed events + GroupIdleTimerEffect
- `web/server/auto-proceed-reconcile.ts` — boot reconcile reducer
- `web/server/auto-proceed-orchestrator-bindings.ts` — orchestrator-side concrete bindings
- `web/server/auto-proceed-config-validator.ts` — boundary parser (Task 10)
- `web/server/recorder.ts` — RecordingOrigin enum (extend, не rewrite)

## Convention floor (НЕ перепроверять в самопроверке)

- AP-1: coordinator DI-decoupled
- AP-2: state-machine = single source of truth
- AP-3: writer + reader в одном файле
- EC-1: SDK permission profile applied at spawn
- EC-2: group-aware kills mark BOTH intentional до kill
- EC-5: protocol parsers reject unknown shapes (validator уже соблюдает)
- EC-7: filesystem path resolution через resolving wrapper
- EC-9: structured JSON log lines с event + sessionGroupId + sessionId + role
- EC-13 (новое, в PR #49): observer 5-min failsafe self-poll, документировано в observer-system.md

## Memory правила обязательные к чтению ДО action

Если в memory есть ≥2 feedback файла по топику — grep + skim ДО invoke (см. `feedback_grep_memory_before_invoking_known_quirky_tool`). Топики для Task 11:
- `coverage`, `gate` — `feedback_file_level_coverage_gate_cascade` (god-module cascade)
- `observer`, `council` — observer review cycle quirks + stale-delta workaround
- `producer`, `consumer`, `scheduled` — wake drift + next-check-at hint patterns
- `validator` — `feedback_validator_per_semantic_category`

## Council Mode workflow

Я в этой сессии 2026-05-14 запустил живой council pair для PR 2c — orchestrator `db56339e-1e17-43ac-93ee-fda0ac64653b`, observer `1afc7b70-9517-405b-8f7f-91bb6657c436`, group `grp_4f15985bfcc15b0661e6fcbbe71daab8`. Свежая сессия будет с РАЗНЫМИ session_id'ами — observer переспаунить или текущий продолжать (зависит от server state).

Workflow на Task 11:
1. `git checkout main && git pull --ff-only origin main`
2. `git checkout -b feat/auto-proceed-send-pipeline`
3. Pre-emptive memory grep на тему `coverage|observer|producer|consumer|scheduled` (см. правило выше).
4. Реализация по subsection'ам #1–9 выше.
5. `cd web && bun run typecheck && bun run test` — green.
6. Локально проверить coverage gate: `bun run test -- --coverage` + grep coverage-summary.json для трёх god-modules + новых файлов.
7. POST council-implement checkpoint:
   - phase change `council-implement` форсит observer re-read (не `council-plan` — это другая фаза)
   - artifact_paths = реально изменённые .ts файлы
   - `expected_next_consumer_tick_at` field в payload (или structured log) — см. `feedback_producer_emit_next_check_at_hint`
8. WAIT ≥ 1 full consumer-tick (>= 5 min) перед re-posting. НЕ burst-POSTить (см. `feedback_producer_emit_next_check_at_hint` + `feedback_aura_observer_stale_delta_same_artifact`).
9. Address observer findings → amend → re-post с RENAMED artifact path для force re-read.
10. Commit + push + PR + gh pr merge --squash --delete-branch after CI green.

## Не делай

- НЕ трогай auto-proceed observer-side STOP resolution (это Task 14 surface, UI зона).
- НЕ делай Task 2 (skill canary) — требует моих правок ~/.claude/skills/council-*-aura/SKILL.md.
- НЕ propagate новые feedback memories в другие проекты БЕЗ explicit user request "запиши для всех" (см. `feedback_universal_findings_stored_once_not_per_project`).
- НЕ burst-POST observer checkpoint'ы — wait ≥ 5 min между posts.
- НЕ re-POST с same artifact_paths — rename / 2nd-path / phase-change to force observer re-read.

## Если контекст забивается

Стопни. Дай аналогичный handoff prompt для следующей сессии. PR-каждый-Task бьёт PR-3-Tasks-в-одном.

## Pending TASK файлы в repo root

- `TASK-ui-stale-observer-and-pr-context-panel.md` — UI/UX bugs (observer-offline-while-alive + stale PR Context panel). Не scope Task 11; отдельная сессия.
- `TASK-sidebar-chip-redundancy-full-suppression.md` — pre-existing.
- `CLEANUP-AUDIT.md` — общий статус.
- `PLAN-aura-orchestrator-idle-auto-proceed.md` — каноничный мастер-план.
- `PLAN-tasks-10-11-boundary-and-send-pipeline.md` — PR-2c-specific (Task 10 shipped; Task 11 sections + observer findings live here).
