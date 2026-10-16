# Self-hosted / open-weight модели в Aura Companion — исследование осуществимости

> Дата: 2026-09-12 · Автор: исследование по запросу (Anton Shmonin)
> Статус: research / feasibility. Реализации ещё нет. Цены и модели актуальны на сентябрь 2026 и меняются быстро.

## TL;DR

- **Главное архитектурное препятствие:** вся система построена вокруг **долгоживущего CLI-подпроцесса** (`claude`, `codex`), который сам владеет agent-loop'ом, исполнением инструментов и контекстом. OpenAI-совместимый endpoint не даёт ни того, ни другого, ни третьего. Поэтому «третий провайдер» — это **не новая ветка в switch**, если делать нативно.
- **Обходной путь (рекомендуется):** не писать in-server runtime, а запускать **тот же самый Claude CLI** с `ANTHROPIC_BASE_URL` → локальный прокси-транслятор (**LiteLLM**), который перекладывает Anthropic Messages ⇄ OpenAI `/chat/completions`. Тогда agent-loop, исполнение инструментов, контекст (`--resume`) и даже Council-observer остаются как есть — потому что адаптер по-прежнему `ClaudeAdapter`.
- **Стартовая модель:** **Qwen3-Coder-Next** (Apache 2.0, 80B MoE/3B активных, 256k контекст, нативный tool calling, ~$0.12/$0.80 за 1M через OpenRouter). Запасные: **GLM-5.2** (сильнейший открытый кодер, MIT) и **DeepSeek V4-Flash** (дёшево + 1M контекст).
- **Стоимость при solo-нагрузке ~500M вход / 50M выход в месяц:** API открытой модели ≈ **$100–150/мес**; локально на 24 ГБ VRAM — только слабые 20–30B модели (+электричество); Mac 64 ГБ тянет Qwen3-Coder-Next, но медленно; GPU VPS 24/7 под vLLM — **$750–1950/мес** (дорого для одного пользователя).
- **Сделать первым:** спайк Path A на LiteLLM — возможно **вообще без изменений кода**, через существующие env-профили (`env-manager.ts`, `~/.companion/envs/`). Проверить tool calling на реальных задачах, потом продуктизировать UI.

---

## Часть 1. Текущая архитектура подключения LLM и что нужно менять

### 1.1 Как устроено сегодня

Сервер Aura — это **транспортный мост + оркестратор**, а не runtime агента. Есть ровно два backend-типа, и оба — бинарники CLI.

| Слой | Где | Что делает |
|---|---|---|
| Тип провайдера | `session-types.ts:663` | `type BackendType = "claude" \| "codex"` — корневой union, ~30 downstream-мест |
| Манифест провайдера | `backend-provider.ts:11–51` | `BackendProvider {backendType, binaryName}`, `CLAUDE_BACKEND`/`CODEX_BACKEND`, `getBackend()`, `SUPPORTED_PAIRINGS` (`claude+claude`, `claude+codex`) |
| Выбор при создании | `routes.ts:444` → `orchestrator.createSession/createCouncilGroup` | body несёт `backend?: "claude"\|"codex"` (`api.ts:224`) |
| Запуск | `cli-launcher.ts:1048–1056` | **инлайн-ветка** по `backendType`: `spawnCodex` / `spawnClaudeStdio` / `spawnCLI` |
| Реальный seam | `backend-adapter.ts:21–101` | `IBackendAdapter` — общий интерфейс; `ClaudeAdapter` + `CodexAdapter` реализуют, мост роутит через него |
| Транспорт Claude | `claude-adapter.ts`, `ws-bridge.ts:1471` | NDJSON `stream-json`; tool-permission через `control_request`/`can_use_tool` (`session-types.ts:201`) |
| Транспорт Codex | `codex-envelope.ts:73`, `codex-adapter.ts` | JSON-RPC 2.0 subset; approvals как JSON-RPC-запросы с id |
| Нормализация | `session-types.ts:336–576` | каждый адаптер → общий union `BrowserIncomingMessage` (контракт с фронтом) |
| Контекст | `cli-launcher.ts:1570` (`--resume`), `codex-adapter.ts:766` (`thread/resume`) | **владеет подпроцесс**; сервер хранит лишь `cliSessionId` и `eventBuffer` для реплея в браузер (не для модели) |
| UI выбор backend | `HomePage.tsx:96–104,260`; список из `GET /backends` (`routes.ts:1960–1986`, **хардкод** claude+codex) | |
| UI выбор пары (Council) | `council/CouncilToggle.tsx:50–70`; `PAIRING_OPTIONS` хардкод | |
| Модели в дропдауне | `utils/backends.ts:71–241` | Claude — из API-ключа `/v1/models`; Codex — из `~/.codex/models_cache.json` (`routes.ts:1988–2014`) |

### 1.2 Главное препятствие

**Система предполагает долгоживущий CLI-подпроцесс, который владеет (a) agent-loop, (b) исполнением инструментов, (c) контекстом. OpenAI-совместимый endpoint не владеет ничем из этого:**

- **Запуск** делает `Bun.spawn` бинарника; `BackendProvider.binaryName` и `preflight-probe.ts` (`binaryNameFor`, `<bin> --version`) предполагают наличие бинарника. У HTTP-endpoint нет процесса.
- **Адаптеры** оборачивают процесс/транспорт (`isConnected()`, `disconnect()`, `CodexAdapter(proc,…)`). Между stateless HTTP-вызовами нет транспорта, который надо держать живым.
- **Инструменты + разрешения** текут *из* подпроцесса: Claude шлёт `control_request`/`can_use_tool`, CLI сам исполняет `Read`/`Write`/`Bash` и **продолжает ход**. OpenAI-ответ возвращает `tool_calls` и **останавливается** — исполнять инструмент и продолжать некому.
- **Контекст** держит подпроцесс (`--resume`/`thread/resume`). Сервер хранит только browser-replay `eventBuffer` — это лог в браузерном формате, не message-массив для модели.

### 1.3 Два пути реализации

**Path A — прокси-шим (рекомендуется).** Запускаем **тот же Claude CLI** с `ANTHROPIC_BASE_URL` на локальный LiteLLM, который транслирует в OpenAI-совместимый endpoint (Ollama/vLLM/OpenRouter/…). Agent-loop, исполнение инструментов, контекст и Council-observer работают **без изменений**, т.к. адаптер остаётся `ClaudeAdapter`.

**Path B — нативный `OpenAIAdapter` (in-server runtime).** Реализовать самому: хранилище истории сообщений, цикл `completion→tool_calls→исполнить инструменты→повторный вызов`, слой исполнения инструментов (которого у сервера сегодня нет — им владеет CLI), мост каждого tool call в существующий `control_request`/`permission_request` UX, трансляцию SSE-дельт в `BrowserIncomingMessage`. Это и есть основной объём работы.

### 1.4 Оценка трудоёмкости

| Этап | Что входит | Оценка |
|---|---|---|
| **A0. Спайк (proxy, без кода)** | Поднять LiteLLM локально; env-профиль с `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN` (через существующий `env-manager.ts`); выбрать профиль при старте; прогнать реальные задачи | **2–4 ч** (0 dev) |
| **A1. Первоклассный UI (proxy)** | Явный backend «OpenAI-compatible (via proxy)»: типы, `/backends`-запись, дропдаун моделей из `/models` прокси, config-UI base URL + model id + api key, арм в `provider-auth-env.ts` | **24–40 ч** |
| **A2. Council для proxy-провайдера** | Пары `claude+custom`/`custom+custom` в `SUPPORTED_PAIRINGS` + **два** хардкод-чека в `routes.ts:457,495` + опции в `CouncilToggle` + probe по reachability вместо бинарника. Observer-review работает «бесплатно», т.к. это `ClaudeAdapter` | **16–24 ч** |
| **B. Нативный `OpenAIAdapter`** | In-server agent runtime: история, tool-loop, исполнение инструментов, permission-мост, SSE→union | **120–200+ ч** |

> Рекомендация по объёму: A0 → A1 → (по желанию) A2. Path B делать только если появится жёсткое требование не запускать вспомогательный прокси-процесс.

### 1.5 Файлы, которые затронет (Path A1 + A2)

Сервер: `cli-launcher.ts` (инъекция env при спавне Claude), `provider-auth-env.ts:59,73` (арм base-URL/auth-token), `backend-provider.ts` (вариант провайдера или sub-mode claude), `session-types.ts:663,667,689` (`BackendType` / поле `customProvider` в `SessionState`), `routes.ts:457,495,1976–2014` (пары + `/backends` + список моделей), `preflight-probe.ts:50` (reachability вместо `--version`), `env-manager.ts` (или переиспользовать для base-URL), `session-group-coordinator.ts:210` (уже backend-agnostic — минимум правок), `session-orchestrator.ts:374` (dispatch observer-wake — при Path A уже `ClaudeAdapter`, менять не нужно).

Фронт: `api.ts:224,243,246` (`CreateSessionOpts`, `BackendInfo`), `HomePage.tsx:96–104` (опция + config-поля), `council/CouncilToggle.tsx:50–70` (пары), `utils/backends.ts:167–241` (геттеры моделей/режимов), `src/types.ts` (`BackendType`).

Тесты: рядом с каждым модулем (обязательно по CLAUDE.md), + `.test.tsx` с render + axe для новых/изменённых компонентов, + Playground-моки.

---

## Часть 2. Как это сделано в open-source harness'ах

### 2.1 OpenCode (sst/opencode)

Каталог провайдеров из **models.dev**; произвольный OpenAI-совместимый endpoint добавляется блоком `providers` в `opencode.json`:

```jsonc
{
  "providers": {
    "acme": {
      "name": "Acme",
      "env": ["ACME_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://llm.acme.example/v1" },
      "models": { "qwen3-coder": { "name": "Qwen 3 Coder" } }
    }
  }
}
```

- `package: openai-compatible` — ключевой переключатель на OpenAI-формат (поверх Vercel AI SDK `@ai-sdk/openai-compatible`).
- Per-model: `modelID`, `name`, `capabilities` (в т.ч. **флаг поддержки tools**), `limit` (контекст/выход), `cost`, `headers`/`body`.
- **Локальные модели**: авто-дискавери Ollama/LM Studio/vLLM по дефолтным портам (`http://127.0.0.1:11434` и т.п.).
- Автоматический fallback между моделями в доках **не подтверждён** (в отличие от CCR).

### 2.2 OpenClaw

`openclaw/openclaw` **не является** Claude-Code-совместимым harness'ом в транспортном смысле. Это **слой оптимизации** (skills, memory, hooks, MCP-конфиги) *поверх* существующих harness'ов (Claude Code, Codex, OpenCode, Cursor). Своего формата провайдера/base-URL у него **нет** — подключение модели делегируется обёрнутому harness'у. (Спутники: `crisandrews/ClawCode`, `goldmar/openclaw-code-agent`, `guixiang123124/openclaw-harness`.)

### 2.3 Router-шимы Anthropic ⇄ OpenAI (главный практический паттерн)

Все эксплуатируют один seam: Claude Code уважает `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`. Направляешь на прокси-транслятор.

- **Нельзя** направлять `ANTHROPIC_BASE_URL` прямо на OpenAI-endpoint — будет 400/мусор. Слой трансляции обязателен. Частый баг: шлюз **молча теряет tool-call ответы** → Claude «работает», но «забывает» файлы/не запускает команды. **Трансляция `tool_use` — самое хрупкое место.**
- **LiteLLM proxy** — самый надёжный, активно поддерживается, есть нативный `/v1/messages`:
  ```yaml
  model_list:
    - model_name: your-model-id
      litellm_params:
        model: openai/qwen3-coder      # или ollama/…, gemini/…
        api_key: os.environ/YOUR_API_KEY
  ```
  `litellm --config config.yaml`, затем `ANTHROPIC_BASE_URL=http://0.0.0.0:4000`, `ANTHROPIC_AUTH_TOKEN=$LITELLM_MASTER_KEY`. Рантайм-переключение моделей через `/model` при `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`.
- **claude-code-router (CCR)** — `Providers` + `Router` с выбором модели **по сценарию** (`default`/`background`/`think`/`longContext`) + ordered fallbacks/retries + **transformers** (пофиксить payload под провайдера, в т.ч. подтолкнуть модель к tool calls). Точный список трансформеров требует проверки в репо (офф-доки отдавали 403).
- **y-router** — Cloudflare Worker/Docker, **архивирован 11.01.2026** (OpenRouter выпустил офф-интеграцию с Claude Code). Форки: `elusznik/open-claude-router`, `duyet/ccr`. Вывод источников: **однофайловые прокси быстро гниют**, т.к. гонятся за двумя движущимися API сразу.

### 2.4 Tool calling у локальных моделей (по убыванию эффективности)

1. **Нативный tool calling через chat-template** — самое надёжное; решает *обучение под агентность*, а не размер. Хорошие: Qwen3-Coder, Devstral-2 22B, Qwen 3.6 27B.
2. **Grammar-constrained / guided decoding** — самый мощный фикс: невалидный JSON **не генерируется** вовсе. llama.cpp — GBNF из JSON Schema; Ollama (≥0.3.0) — `format` = JSON Schema; vLLM — `--guided-decoding-backend xgrammar/outlines/lm-format-enforcer`. Цена — пара % throughput.
3. **Prompted JSON** — описываешь инструменты в system-prompt, парсишь сам; выше процент сбоев.
4. **Edit-форматы вместо tool calls** (Aider search/replace-блоки) — на малых моделях бьют вложенный JSON. Это и есть «XML/текстовый fallback».
5. **Parse-repair retries** — как бэкстоп, желательно без расхода итерационного бюджета; **низкая температура (0.0–0.2)** и **узкий набор инструментов (6–8)**.

### 2.5 Каноничная форма provider-config (свод OpenCode/LiteLLM/CCR)

| Поле | Назначение |
|---|---|
| `id`/`name` | уникальный ключ, на него ссылается роутинг |
| `baseURL` | endpoint (обычно `.../v1`) |
| api key **через env** | никогда не инлайнить секрет |
| adapter/`package`/`transformer` | явно выбрать OpenAI-формат + пофиксы под провайдера |
| `modelID` | on-wire id, отвязан от локального алиаса |
| `capabilities`/tool-flag | нативные tools / grammar-JSON / prompted-fallback |
| `limit` (контекст/выход) | для compaction и роутинга |
| `cost` | для бюджета/роутинга |
| routing/fallback | сценарный выбор + failover |

**Вывод для Aura:** самый дешёвый путь — spawn Claude CLI с `ANTHROPIC_BASE_URL` на LiteLLM, а не учить мост второму wire-протоколу. Provider-config должен нести **явный флаг стиля tool-calling** — именно он деградирует у локальных моделей, а tool-approval UI Aura зависит от надёжных `tool_use` фреймов.

---

## Часть 3. Сравнение open-weight моделей для агентного кодинга (сентябрь 2026)

> ⚠️ Некоторые цифры получены из вторичных источников (блоги/агрегаторы), т.к. это очень свежие релизы. Где источник ненадёжен — помечено. Цены — за 1M токенов, вход/выход.

| Модель | Лицензия | Размер (всего / активных) | Контекст | Локально: VRAM/квант | Влезает в 24–32 ГБ? / Mac 64 ГБ? | Tool calling | Цена API (перв.) | Цена OpenRouter | Кодинг-бенч |
|---|---|---|---|---|---|---|---|---|---|
| **Qwen3-Coder-Next** | **Apache 2.0** | 80B MoE / **3B** | 256k | Q4_K_M ≈ **48.8 ГБ** | 24 ГБ — **нет**; Mac 64 — **да** (впритык, медленно) | Нативный, agentic-обучен, `tools`+`tool_choice`, JSON-schema | — | **$0.12 / $0.80** | ~44% SWE-bench Pro; ~70% SWE-bench Verified (вторич.) |
| **GLM-5.2** | **MIT** | ~744B MoE / ~40B | до 1M | не для 24–64 ГБ (нужен кластер) | нет / нет | Function calling, structured output, тысячи tool-call'ов/сессия | **$1.40 / $4.40** | $1.40 / $4.40 | **62.1 SWE-bench Pro** (> GPT-5.5); 77.8 SWE-bench Verified (GLM-5) — топ открытый |
| **DeepSeek V4-Flash** | **MIT** | 284B MoE / 13B | **1M** | не влезает локально на потреб. железо | нет / нет | Native FC | **$0.22 / $0.66** off-peak ($0.44/$1.32 peak) | ~ | **79.0 SWE-bench Verified** |
| **DeepSeek V4-Pro** | **MIT** | 1.6T MoE / 49B | 1M | нет | нет / нет | Native FC | **$0.66 / $1.98** off-peak ($1.32/$3.96 peak) | ~ | **80.6 SWE-bench Verified** (≈ Opus 4.6) |
| **Kimi K2.7 Code** | Modified MIT | 1T MoE / 32B | 262k | нет | нет / нет | Сильный agentic tool-use (OpenRouter «Exacto» для max tool-accuracy) | — | **$0.68 / $3.40** (K2.5: $0.45/$2.25) | сильный agentic-кодер |
| **Gemma 4** ⚠️ | **Apache 2.0** | E2B/E4B/12B/**31B dense**/26B-A4B MoE (4B акт.) | 128k–256k | 31B Q4 ≈ 18–22 ГБ; 12B ≈ 8–10 ГБ | **да** (12B/31B) / да | Native structured tool use, но **не coder-специализирован** | — (Google API/Vertex) | есть провайдеры | мультимодал/reasoning; кодинг **слабее** специализированных |
| **gpt-oss-120b** | Apache 2.0 (+usage policy) | 120B MoE | 128k | MXFP4 ≈ **80–96 ГБ** (1×H100) | нет / нет (нужно 80 ГБ) | Harmony-формат, function calling, browsing, python | — | дёшево (~$0.1–0.3 порядка) | сильный reasoning; кодинг — средне-высоко |
| **gpt-oss-20b** | Apache 2.0 (+usage policy) | 20B MoE | 128k | MXFP4 ≈ **12–16 ГБ** | **да** (RTX 4080/4090, Mac 24 ГБ) / да | Harmony function calling | — | дёшево | приличный reasoning; кодинг — средний |

⚠️ **Gemma 4:** источники разнятся по размерам линейки; несколько выглядели как AI-сгенерированный шум. Apache 2.0 подтверждается несколькими независимыми источниками (для Gemma это отход от прежней кастомной лицензии — но сходится). **Для агентного кодинга Gemma 4 — слабейший кандидат**: она мультимодально-универсальная, не coder-tuned.

### Ранжирование

**Для self-hosted (реально влезает в потребительское железо + tool calling + лицензия):**
1. **gpt-oss-20b** — влезает даже в 16 ГБ, Apache 2.0, нативный function calling. Кодинг средний, но для лёгких задач/фоновых ролей ок.
2. **Qwen3-Coder-Next** — лучший *специализированный* кодер, что вообще реально держать локально (Mac 64 ГБ Q4, впритык; десктоп нужен ≥48 ГБ VRAM). Apache 2.0, agentic-обучен.
3. **Gemma 4 (12B/31B)** — если хватает 24 ГБ и нужен просто «нормальный» ассистент, но **не** топ по кодингу.

**Для API по стоимости/качеству:**
1. **Qwen3-Coder-Next** (~$0.12/$0.80) — лучшее цена/агентность.
2. **DeepSeek V4-Flash** (~$0.22/$0.66, 1M контекст) — дёшево + огромный контекст, 79% SWE-bench.
3. **GLM-5.2** (дороже, $1.40/$4.40) — когда важно максимальное качество открытого кодера (топ SWE-bench Pro).

> Ключевой вывод по железу: **по-настоящему сильные открытые кодеры (GLM-5.x, DeepSeek V4, Kimi K2.x) физически не помещаются** ни в 24–32 ГБ VRAM, ни в Mac 64 ГБ — это модели датацентрового класса. Локально доступны либо *специализированный, но пограничный по памяти* Qwen3-Coder-Next (только Mac 64 ГБ / десктоп ≥48 ГБ), либо *умещающиеся, но более слабые* gpt-oss-20b / Gemma 4 / Qwen 30B-класса.

---

## Часть 4. Сценарии стоимости

**Допущения о нагрузке** (solo power-user Aura, укажи, если другое):
- ~6 активных часов кодинга/день × ~22 дня = ~132 ч/мес.
- Агентный кодинг **input-dominated**: контекст пересылается на каждом шаге tool-loop'а.
- Оценка: **~500M входных + ~50M выходных токенов/мес** (heavy solo). Prompt caching, если поддерживается провайдером, режет вход в 5–10×.

### (а) API открытой модели

| Модель | Вход $/1M | Выход $/1M | Стоимость/мес (500M+50M) |
|---|---|---|---|
| **Qwen3-Coder-Next** (OpenRouter) | 0.12 | 0.80 | **≈ $100** |
| gpt-oss-120b (OpenRouter, оценка) | ~0.15 | ~0.60 | ≈ $105 |
| **DeepSeek V4-Flash** (off-peak) | 0.22 | 0.66 | **≈ $143** (peak ≈ $286) |
| Kimi K2.7 Code | 0.68 | 3.40 | ≈ $510 |
| DeepSeek V4-Pro (off-peak) | 0.66 | 1.98 | ≈ $429 |
| GLM-5.2 | 1.40 | 4.40 | ≈ $920 |

Для сравнения: те же токены на Claude Opus-классе (~$15/$25) → **≈ $8 750/мес**. Открытая модель по API дешевле в **~60–90×**.

### (б) Локально: 24–32 ГБ VRAM (RTX 4090) или Mac 64 ГБ

| | 24 ГБ VRAM (RTX 4090) | Mac Studio M4 Max 64 ГБ |
|---|---|---|
| Что влезает | gpt-oss-20b (16 ГБ), Qwen 30B-A3B Q4 (~18 ГБ), Gemma 4 12B/31B | **Qwen3-Coder-Next Q4 (~49 ГБ, впритык)**, gpt-oss-20b, Gemma 4 |
| Не влезает | Qwen3-Coder-Next 80B (49 ГБ), gpt-oss-120b (80 ГБ) | gpt-oss-120b (80 ГБ), GLM/DeepSeek/Kimi |
| Скорость | 20–30B Q4 ≈ 40–80 tok/s | Qwen3-Coder-Next Q4 ≈ 15–30 tok/s (медленно для agent-loop); MoE 30B-класс ≈ 80–110 tok/s (MLX) |
| Электричество | ~350 Вт × 132 ч ≈ 46 кВт·ч ≈ **$8–15/мес** | ~50–100 Вт ≈ **$3–8/мес** |
| Capex (аморт. 24 мес) | 4090 ~$1600–2000 → **~$70–85/мес** | M4 Max 64 ГБ ~$2500–3000 → **~$105–125/мес** |
| Итого маржинально | **~$80–100/мес** (capex+эл.) | **~$110–135/мес** |

Плюсы: приватность, оффлайн, нет метринга. Минусы: **на 24 ГБ доступны только более слабые модели**; Mac 64 ГБ тянет топ-локальный Qwen3-Coder-Next, но медленно и близко к пределу памяти (мало места под KV-cache длинного контекста).

### (в) GPU VPS под vLLM

| Конфиг | $/час | Только рабочие часы (132 ч) | 24/7 (720 ч) | Что запустит |
|---|---|---|---|---|
| 1×H100 80 ГБ (on-demand) | ~$2.5–3 | **≈ $356** | **≈ $1 944** | gpt-oss-120b, Qwen3-Coder-Next |
| 1×H100 (spot) | ~$1.5 | ≈ $198 | ≈ $1 080 | то же |
| 1×A100 80 ГБ | ~$1.05–1.5 | ≈ $140–200 | ≈ $756–1 080 | Qwen3-Coder-Next, gpt-oss-120b (впритык) |
| RTX 4090 24 ГБ | ~$0.39 | ≈ $52 | ≈ $281 | только 20–30B |

vLLM даёт высокий throughput/батчинг — но для **одного пользователя** GPU простаивает бóльшую часть времени, поэтому 24/7-VPS **дороже API**, если нет требований always-on/приватность/полный контроль. Для сильнейших моделей (DeepSeek V4-Pro 1.6T, GLM-5.x 744B) нужен мульти-GPU-узел — экономически не оправдано для solo.

### Сводка

Для одиночной нагрузки **API открытой модели — безоговорочно дешевле и проще** (~$100–150/мес). Локально оправдано ради приватности/оффлайна, и тогда realistically — Mac 64 ГБ + Qwen3-Coder-Next или 24 ГБ + gpt-oss-20b/Gemma. GPU VPS 24/7 экономически осмыслен только при высокой утилизации или командном использовании.

---

## Часть 5. Вывод и план внедрения

### Что сделать первым

**Спайк Path A (без кода).** Поднять LiteLLM, направить Claude CLI через `ANTHROPIC_BASE_URL` на прокси; ключ/URL положить в **существующий env-профиль** (`env-manager.ts`, `~/.companion/envs/`) и выбрать его при старте сессии. Есть шанс, что базовый сценарий заведётся **вообще без правок кода** — это дешёвая проверка гипотезы до любых инвестиций в UI.

### Стартовая модель

**Qwen3-Coder-Next** — Apache 2.0, agentic-обучен, нативный tool calling, 256k контекст, ~$0.12/$0.80 через OpenRouter. Через OpenRouter — быстрый старт (0 инфраструктуры); при переходе на приватность — тот же вес на Mac 64 ГБ / GPU VPS. Запасные: **DeepSeek V4-Flash** (дёшево + 1M контекст), **GLM-5.2** (макс. качество).

### Риски

| Риск | Суть | Митигейшн |
|---|---|---|
| **Tool calling** | Локальные/некоторые открытые модели ломают/не выдают `tool_calls`; шлюз может молча их терять → «модель забывает файлы» | Прокси с грамматикой/guided-decoding (vLLM `xgrammar`, Ollama `format`); температура 0.0–0.2; узкий набор инструментов (6–8); OpenRouter routing «Exacto»; в provider-config **явный tool-style флаг** |
| **Длинный контекст** | Заявленные 256k–1M деградируют по качеству к хвосту; KV-cache съедает память локально | Опираться на compaction-advisory Aura; не полагаться на самый хвост; на Mac 64 ГБ держать реальный контекст скромнее |
| **Скорость** | Локально Qwen3-Coder-Next Q4 ≈ 15–30 tok/s — заметно для многошаговых агентов | Для интерактива — API/vLLM; локаль — для фоновых/приватных задач |
| **Council observer** | Нативный `OpenAIAdapter` не поддержан в dispatch observer-wake (`session-orchestrator.ts:374` `unsupported_backend`) | **Path A решает бесплатно** — адаптер остаётся `ClaudeAdapter` |
| **Гниение прокси** | Однофайловые шимы отстают от двух API | Брать LiteLLM (активная поддержка, нативный `/v1/messages`), не самопал |
| **Лицензии/приватность** | Разные лицензии; API-провайдер видит код | Apache 2.0/MIT — коммерчески чисто; для секретного кода — локаль/приватный VPS |

### План по шагам

1. **Спайк (Path A0).** LiteLLM + `openai/qwen3-coder-next` (через OpenRouter-ключ). Env-профиль с `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`. Прогнать чеклист тестов (ниже). *Решение go/no-go по качеству tool calling.*
2. **Первоклассный UI (Path A1).** Backend «OpenAI-compatible (via proxy)»: типы (`BackendType`/sub-mode), `/backends`-запись, config-UI (base URL + model id + api key через env), дропдаун моделей из `/models`, арм в `provider-auth-env.ts`. Тесты + Playground-моки + axe.
3. **Council (Path A2).** Пары `claude+custom`/`custom+custom`: `SUPPORTED_PAIRINGS` + оба хардкод-чека `routes.ts:457,495` + `CouncilToggle` + probe по reachability. Проверить, что observer-review фанится (адаптер `ClaudeAdapter`).
4. **Приватный бэкенд (опц.).** Заменить OpenRouter на локальный vLLM/Ollama (Mac 64 ГБ / GPU VPS) с guided-decoding — тот же LiteLLM-конфиг, меняется только upstream.
5. **Доки + `/learn`.** Зафиксировать паттерн прокси и грабли tool calling в knowledge base.

### Чеклист тестов на реальных задачах

- [ ] **Простой tool-call:** «прочитай файл X и покажи строки N–M» → корректный `Read`, без потери контента.
- [ ] **Многошаговый:** «найди определение функции, отрефактори, прогони typecheck» → цепочка `Grep→Read→Edit→Bash` без срыва loop'а.
- [ ] **Permission-gate:** `Write`/`Bash` поднимают approval-баннер в UI (фреймы `control_request` доходят).
- [ ] **Длинный контекст:** задача поверх большого файла/нескольких файлов ближе к пределу окна — качество не рушится.
- [ ] **Восстановление после ошибки:** намеренно битая команда → агент читает stderr и исправляется.
- [ ] **`--resume`:** перезапуск сессии продолжает диалог (контекст жив через прокси).
- [ ] **Council pair:** checkpoint от оркестратора → observer выдаёт review → BlockerBanner/ObserverPanel в UI.
- [ ] **Скорость:** замерить tok/s и время типичной задачи vs Claude — приемлемо ли интерактивно.
- [ ] **Стоимость:** снять реальный расход токенов за день → экстраполяция в месяц против оценок Части 4.
- [ ] **Стабильность tool calling:** прогнать 10–20 задач, посчитать % сорванных/битых tool-call'ов (порог годности, скажем, <5%).

---

### Приложение: источники

- Qwen3-Coder-Next: [OpenRouter](https://openrouter.ai/qwen/qwen3-coder-next) · [HF](https://huggingface.co/Qwen/Qwen3-Coder-Next) · [Unsloth (локальный запуск)](https://unsloth.ai/docs/models/qwen3-coder-next) · [willitrunai (VRAM 48.8 ГБ)](https://willitrunai.com/models/qwen-3-coder-next)
- DeepSeek V4: [Morph](https://www.morphllm.com/deepseek-v4) · [OpenRouter Flash](https://openrouter.ai/deepseek/deepseek-v4-flash) · [ofox (MIT, цены)](https://ofox.ai/blog/deepseek-v4-release-guide-2026/)
- GLM-5.x: [zai-org/GLM-5](https://github.com/zai-org/GLM-5) · [OpenRouter 5.2](https://openrouter.ai/z-ai/glm-5.2) · [The Batch](https://www.deeplearning.ai/the-batch/top-agentic-performance-low-cost) · [docs.z.ai 5.3](https://docs.z.ai/guides/llm/glm-5.3)
- Kimi K2.x: [OpenRouter K2.7 Code](https://openrouter.ai/moonshotai/kimi-k2.7-code) · [OpenRouter K2.6](https://openrouter.ai/moonshotai/kimi-k2.6)
- Gemma 4: [ai.google.dev core](https://ai.google.dev/gemma/docs/core) · [ai.google.dev model card](https://ai.google.dev/gemma/docs/core/model_card_4) · [Wikipedia](https://en.wikipedia.org/wiki/Gemma_(language_model))
- gpt-oss: [HF gpt-oss-120b](https://huggingface.co/openai/gpt-oss-120b) · [YingTu (память 120B)](https://yingtu.ai/en/blog/gpt-oss-120b-memory-requirements) · [IntuitionLabs (20B)](https://intuitionlabs.ai/articles/hardware-requirements-gpt-oss-20b)
- Harness'ы: [OpenCode providers](https://opencode.ai/v2/docs/providers/) · [LiteLLM + Claude Code](https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models) · [LiteLLM /v1/messages](https://docs.litellm.ai/docs/anthropic_unified/) · [claude-code-router](https://github.com/musistudio/claude-code-router) · [Local tool calling (2026)](https://llmconfigurator.com/en/guides/coding-agents/tool-calling-local-models)
- Железо/облако: [Mac M4 Max LLM (Tom's Hardware)](https://www.tomshardware.com/desktops/exploring-apple-silicons-local-ai-performance-with-the-mac-studio-and-m4-max-m4-max-beats-gb10-and-strix-halo-in-decode-throughput-but-memory-bandwidth-isnt-everything/2) · [H100 цены (IntuitionLabs)](https://intuitionlabs.ai/articles/h100-rental-prices-cloud-comparison) · [GPU cloud (Spheron)](https://www.spheron.network/blog/gpu-cloud-pricing-comparison-2026/)
