# Spec: Model Registry + Graceful Failover

**Tier:** Feature · **Status:** Draft for review

## Problem & Context

Aura spawns CLI subprocesses (`claude`, `codex`) and passes the chosen model via `--model` argv; it is not a raw `/v1/messages` client. Today the offered models are **hardcoded** in `web/src/utils/backends.ts` (`CLAUDE_MODELS`, `CODEX_MODELS`). When a frontier model arrives (e.g. a future "Fable") or is retired / region-blocked, that is a code change + redeploy — "tech debt with a timer."

Failover is also partial and inconsistent: Codex validates a model *before* relaunch and scores a fallback (`codex-models.ts`, `cli-launcher.ts:914`), while Claude only reacts to a runtime `404` by reverting to the previously working model (`ws.ts:814`, PR #116). There is no single source of truth for which models exist, their status, or their replacement.

This feature externalizes the model catalog into an operator-editable registry and unifies failover into one cheap, energy-aware policy. **Capability-role routing and active health-pinging are explicitly out of scope** (see Non-goals).

## Job Stories

### Story 1 — Operator updates the model catalog without a code release

When a model is announced or retired, I want to change Aura's offered models by editing a config file, so I can react in minutes without redeploying.

- **Given** a model entry with `status: "retired"` in `~/.companion/models.json`, **when** the model list for its backend is requested, **then** that model is excluded from the offered list.
- **Given** a new model entry added to the registry, **when** the model list is requested, **then** the new model appears with its label and description.
- **Given** no `~/.companion/models.json` on disk, **when** the registry loads, **then** the bundled default registry is used and the offered models match today's behavior (zero-config parity).
- **Given** a malformed entry (missing required field, or id failing the existing `CLAUDE_MODEL_ID_RE` / exceeding `MODEL_ID_MAX_LEN`), **when** the registry loads, **then** that single entry is skipped, a structured `WARN` is logged, and all other valid entries still load — the registry never crashes the server.
- **Given** an entry whose id fails validation, **when** any session spawns, **then** that id is never passed into CLI argv.

### Story 2 — Switching to an unavailable model wastes no turn

When I pick a model Aura already knows is unavailable, I want it to switch me to a working replacement before calling the CLI, so I don't burn a turn discovering it's dead.

- **Given** the selected model has registry `status: "retired"` or `"blocked"`, **when** the switch is requested, **then** Aura switches to the configured `replacement` instead, shows a notice naming both models, and never sends the unavailable id to the CLI.
- **Given** the selected model has `status: "active"`, **when** the switch is requested, **then** it is issued unchanged.
- **Given** a retired model whose `replacement` is `null`, **when** the switch is requested, **then** the current working model is retained and the user is told the model is unavailable with no replacement (no silent no-op).
- **Given** the configured replacement is itself retired/blocked, **when** resolving, **then** resolution stops after **one** hop, retains the current model, and surfaces a single notice — no replacement cascade.

### Story 3 — Runtime model failure recovers cheaply

When a model fails mid-session, I want the cheapest safe recovery, so a transient error never loops or strands me.

- **Given** an active session receives a `result` with `api_error_status: 404` following a pending model switch, **when** the error is handled, **then** the session reverts to the **last-known-good** model (existing behavior preserved) and appends an explanatory system message.
- **Given** a `403` / region-blocked / policy-blocked error for the current model, **when** handled, **then** the model is marked blocked for that session and is **not** retried.
- **Given** any runtime model failure, **when** recovering, **then** Aura performs **at most one** automatic fallback hop per failure and never enters a retry loop.
- **Given** an unrelated `404` arrives with no pending model switch, **when** a result is processed, **then** no model revert is triggered.

## Boundaries

✅ **Always**
- Load the registry at startup (bundled default ← disk override merge) and validate every id against the existing regex + length cap before it reaches argv.
- Hide `retired` / `blocked` models from the picker; mark `degraded` ones.
- Log every error classification (`retired` / `region_blocked` / `overloaded`) as structured JSON.
- Resolve & validate a replacement *before* issuing a switch (proactive path).

⚠️ **Ask first**
- Falling back across **providers** (claude ↔ codex) or to a model in a **different cost tier** than requested — surface and require user action, don't do it silently.

🚫 **Never**
- Pass a model id that fails validation into a spawn/`set_model`.
- Retry a `403` / policy-blocked model in a loop.
- Chain more than one automatic replacement hop on a runtime failure.
- Hardcode a concrete model id in agent/skill code paths — the registry is the sole source of truth.

## Success Metrics

- Simulated retirement of the current default model → the proactive switch lands on the replacement with **0 failed CLI turns**.
- A new model is offered to users via a **config edit only** — no code change, no redeploy.
- **0** hardcoded model-id string literals remain in agent/skill code paths (registry-sourced everywhere).

## Assumptions (confirmed this session)

- Config lives at `~/.companion/models.json` with a bundled default in the repo; disk overrides bundle.
- Capability roles (`frontier_coder`, etc.) are **dropped** — model slots stay orchestrator/observer/subagent.
- Active health-check pinging is **out of scope** (burns OAuth-subscription quota; availability is read lazily from `/v1/models` + observed errors).

## Non-goals

IncidentWatcher (status-page / export-control news scraping); raw-API provider adapters (OpenAI/Google) and local-vLLM backend; JSON-Schema structured-output validator (agents already speak the protocol); circuit-breaker; the full 5-level auto-degradation engine (Council Mode already provides the "council + deterministic gates" path — v1 may add a "running on fallback model" banner only).

---

*After implementing, compare results against each acceptance criterion above and list any unmet requirements.*
