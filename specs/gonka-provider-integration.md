# Spec: Gonka Provider Integration (third AI line)

**Tier:** Product/system · **Status:** Draft for review · **Author:** AI-generated (not yet human-reviewed)

Add **Gonka** as a third selectable AI provider in Aura Companion, alongside Claude Code and Codex. Gonka is treated as an **OpenAI-compatible inference backend** reached through the `gonka-openai` TypeScript SDK — **not** as a ready-made coding-agent CLI.

---

## Problem

Aura Companion today supports exactly two backends: `claude` and `codex`. Both are **full coding-agent CLIs** — the server spawns a subprocess, and that subprocess owns its own tool loop and executes tools itself. The server only relays messages and gates permission approvals; it **never executes tools server-side** (confirmed: `codex-adapter.ts` proxies `requestApproval` → browser → JSON-RPC respond; the Codex process runs the tool).

Users want a third AI line, Gonka. But Gonka is architecturally different: it is a distributed, OpenAI-compatible inference endpoint accessed via `gonka-openai` (which signs requests with a private key and optionally verifies proofs). There is **no Gonka CLI subprocess** and **no built-in tool loop**. Naively slotting Gonka in as a "backend like Codex" would falsely imply coding-agent parity that does not exist and would strand users in broken sessions.

We need to (a) introduce a clean third-provider abstraction and (b) ship a minimal, honest v1 where Gonka is a **chat/inference provider** clearly marked experimental — while scoping what a future Gonka-backed coding agent would actually require.

## Goals

- Introduce `gonka` as a first-class `BackendType` without breaking existing Claude/Codex sessions.
- Ship v1: create a Gonka chat session, send a prompt, receive a streamed or non-streamed model response.
- Store Gonka config server-side only (`GONKA_PRIVATE_KEY`, `GONKA_SOURCE_URL` **or** `GONKA_ENDPOINTS` as `url;transferAddress` pairs, default model, optional `GONKA_ADDRESS`, `GONKA_VERIFY_PROOF`), masked in UI, never in browser/logs/recordings.
- Surface Gonka in the provider setup wizard as **experimental / limited**.
- Fail honestly: an unreachable Gonka endpoint produces a clear error and does **not** flip the session to a false `active` state.
- Keep Council Mode from offering unsupported Gonka pairings.
- Record `provider=gonka` in recordings with all signing-sensitive data redacted.

## Non-goals (v1)

- **No** Claude Code / Codex tool parity — Gonka v1 has no tool use, no file edits, no Bash.
- **No** Gonka-backed autonomous coding agent (server-side tool loop). Scoped in Architecture Options / Risks; **deferred**.
- **No** Gonka participation in Council Mode in any role (orchestrator or observer) in v1. Deferred until a tool loop exists.
- **No** deep proof-verification UX beyond storing and honoring a boolean flag passed to the SDK.
- **No** migration of existing sessions to Gonka; new sessions only.
- **No** multi-key / per-org key management; a single server-side config profile.

## Verified API surface (`gonka-openai`, github.com/gonka-ai/gonka-openai, TypeScript, MIT)

Source read directly from the repo, not assumed:

- **Drop-in OpenAI client.** `class GonkaOpenAI extends OpenAI`. Usage is `client.chat.completions.create({ model, messages, ... })` — the stock OpenAI SDK surface. **Streaming works natively** via the OpenAI SDK's `stream: true` (async iterator); non-streaming is the default. No Gonka-specific streaming path needed.
- **Auth is request signing, not an API key.** The lib installs a custom `fetch` that, per request: ECDSA-signs `(body + nanosecond timestamp + endpoint transferAddress)` with the private key → sets `Authorization` (signature), `X-Timestamp`, and `X-Requester-Address` (derived public gonka address). The OpenAI `apiKey` is a throwaway `"mock-api-key"`. **The private key never leaves the server and is the only real secret.**
- **Endpoint discovery is a separate ASYNC step.** `resolveEndpoints({ sourceUrl })` / `resolveAndSelectEndpoint(...)` must run *before* constructing the client, or use the static `GonkaOpenAI.create(options)` which resolves internally. **The constructor does NOT auto-resolve `GONKA_SOURCE_URL`** (documented explicitly). This maps cleanly to Story 3's "confirm reachability before `active`" — discovery is the reachability probe.
- **Endpoints require a `transferAddress`.** Each endpoint is `{ url, transferAddress }` (Cosmos address of the provider), mandatory — it's part of the signature payload. `GONKA_ENDPOINTS` is a comma-separated list of `url;transferAddress` (semicolon) pairs — **not bare URLs**.
- **Env vars (exact):** `GONKA_PRIVATE_KEY` (ECDSA key), `GONKA_SOURCE_URL` (discovery URL — resolver helpers only), `GONKA_ENDPOINTS` (`url;transferAddress,...`), `GONKA_ADDRESS` (optional derived-address override), `GONKA_VERIFY_PROOF=1` (opt-in ICS23 proof verification **during endpoint discovery only**, skipped by default). Chain id is hardcoded `gonka-testnet-1`.
- **Models are vLLM-served (e.g. `Qwen/Qwen3-235B-A22B-Instruct-2507-FP8`)**, OpenAI chat-completions spec — *not* OpenAI models and *not* the Assistants API (`code_interpreter` / `file_search` unavailable).
- **Function tool-calling exists but the caller executes.** The README documents `type: "function"` tools: the model returns structured `tool_calls`, and — quoting — *"You decide what to do with them."* The SDK/network **never executes tools**. This *confirms* (not assumes) the Option B analysis below: a Gonka coding agent = Aura must build the entire tool loop + server-side execution itself.

Remaining assumptions (still override if wrong):
1. Gonka credentials are operator-level (one config per deployment), not per-end-user entered in the browser.
2. The `IBackendAdapter` interface (`send` / `isConnected` / `onBrowserMessage` / `onSessionMeta` / `onDisconnect` / optional `isReadyForServerFrame`) is sufficient for an adapter that **is itself the process** (no subprocess). No subprocess lifecycle (PID, `--resume`) applies to Gonka.
3. A reduced Gonka UI (no permission banners, no tool blocks) is acceptable in v1.

---

## Architecture Options

### Option A — Gonka as inference-only chat provider *(recommended for v1)*

A new `GonkaAdapter implements IBackendAdapter` that holds a `gonka-openai` client instead of a child process. Browser `user` messages become `chat.completions.create` calls; streamed deltas are translated to the existing `stream_event` → `content_block_delta` browser frames (same shape the Codex adapter already emits). No subprocess, no tool loop, no permission flow.

- **Pros:** Reuses the entire browser rendering path and recorder unchanged. Honest about capabilities. Smallest blast radius. The adapter seam is already provider-agnostic.
- **Cons:** Gonka sessions are "chat only" — a visibly different, lesser experience. Requires the launcher and lifecycle code to tolerate a "process-less" backend (skip PID tracking, `--resume`, orphan reaping).

### Option B — Gonka-backed coding agent (new server-side tool loop)

Aura builds its own agentic loop: model returns OpenAI function-calls → server maps them to the existing `can_use_tool` permission UX → **server executes the approved tool** → feeds results back. This is a **major new subsystem** because the server has never executed tools; today the CLI subprocess does.

- **Pros:** True third coding agent; unlocks Council roles.
- **Cons:** Large surface: tool registry, sandboxing, server-side execution security, permission-loop parity, observer read-only enforcement without a subprocess to enforce it. High risk. **Defer.**

### Option C — Gonka observer-only in Council

Even a read-only observer needs to read files and write one review file — i.e. a constrained tool loop that does not exist today (observer boundaries are enforced by **CLI spawn flags**, `observer-permissions.ts`, not by the adapter). With no Gonka subprocess, Aura must enforce the read-only boundary itself.

- **Pros:** Smaller than B; lower stakes than orchestrator.
- **Cons:** Still requires a mini server-side tool loop + boundary enforcement. **Defer past v1.**

### Recommended v1 = **Option A**

Ship Gonka as an experimental **chat/inference provider only**. No tools, no Council role. Options B and C are documented as follow-ups with their prerequisites named, but are explicitly out of scope. The provider abstraction is built so B/C can layer on later without re-plumbing the type union.

---

## Concrete insertion points (for the implementing agent — behavioral contract, not a plan)

- `BackendType` union (`web/server/ws-bridge-types.ts:663`) gains `"gonka"`.
- `BackendProvider` seam (`web/server/backend-provider.ts:11-51`): add a `GONKA_BACKEND` descriptor; **do not** add any Gonka pairing to `SUPPORTED_PAIRINGS` in v1.
- `IBackendAdapter` (`web/server/backend-adapter.ts:21-80`): no interface change; add `GonkaAdapter`.
- `cli-launcher.ts`: gonka branch must **not** spawn a subprocess or register PID/`--resume`/orphan-reaper hooks.
- `recorder.ts` (`:123-276`): existing redaction (`REDACTED_KEY_NAMES`, secret-shaped values, v3 `redactionApplied`) already covers `authorization` + `token`/`key`/`secret`. Confirm it redacts the `Authorization` (ECDSA signature) and `X-Timestamp` headers the signing `fetch` adds, and never records `GONKA_PRIVATE_KEY`. `X-Requester-Address` is a derived public address (safe). Add explicit patterns if any of these header names slip through.
- `review-watcher.ts:40`: the `(claude|codex)` filename regex is **left unchanged** in v1 (no Gonka reviews). Adding `gonka` to it is a Council-follow-up prerequisite.
- UI: `CouncilToggle` `PAIRING_OPTIONS` unchanged; `ProviderBadges.providerChipClass` gains a `gonka` token for the single-session badge; provider setup wizard gains a Gonka entry flagged experimental.

---

## Stories (Job Stories)

### Story 1 — Configure the Gonka provider (server-side, masked)
**When** an operator opens the provider setup wizard and selects Gonka, **I want to** enter and save `GONKA_PRIVATE_KEY`, `GONKA_SOURCE_URL` or `GONKA_ENDPOINTS`, a default model, and a verify-proof toggle, **so I can** enable Gonka without exposing the key.

- **Given** the setup wizard, **When** it renders the Gonka form, **Then** the private-key field is masked (obscured input) and the provider is labeled "Experimental".
- **Given** a saved config, **When** the browser re-fetches provider settings, **Then** the private key is returned masked/absent — never in plaintext to the client.
- **Given** the operator provides `GONKA_SOURCE_URL`, **When** they also leave `GONKA_ENDPOINTS` empty, **Then** the config saves successfully (either source-url or endpoints is sufficient).
- **(negative)** **Given** neither `GONKA_SOURCE_URL` nor `GONKA_ENDPOINTS` is provided, **When** the operator saves, **Then** the save is rejected with a message naming the missing field, and no partial config is persisted.
- **(negative)** **Given** a saved config, **When** any log line or crash report is emitted during save, **Then** the private key value does not appear in it.

### Story 2 — Create a Gonka chat session and get a response
**When** a user creates a new session with provider Gonka, **I want to** send a prompt and receive the model's reply, **so I can** use Gonka as an AI line.

- **Given** a valid Gonka config, **When** the user selects Gonka and creates a session, **Then** the session reaches `active` only after `resolveEndpoints`/`resolveAndSelectEndpoint` returns a usable endpoint (this async discovery IS the reachability probe).
- **Given** an active Gonka session, **When** the user sends a prompt, **Then** the configured default model's response is rendered in the chat feed as assistant text.
- **Given** streaming is available, **When** the model streams tokens, **Then** the UI renders incremental text using the existing streaming frames (no Gonka-specific rendering path).
- **Given** streaming is unavailable/disabled, **When** the model returns a single completion, **Then** the full response renders once as a completed assistant message.
- **(negative)** **Given** an active Gonka session, **When** the user attempts a tool-requiring action (there is none in the UI for Gonka), **Then** no permission banner or tool block appears — the Gonka session exposes chat only.

### Story 3 — Honest failure when Gonka is unreachable
**When** the configured Gonka endpoint is unreachable or rejects the request, **I want to** see a clear error instead of a session that looks alive but is dead, **so I can** fix config rather than chase a ghost.

- **Given** an unreachable endpoint, **When** the user creates a Gonka session, **Then** session creation surfaces a clear, human-readable error and the session is **not** shown as `active`.
- **Given** an active Gonka session, **When** a prompt fails (endpoint down / auth rejected / proof-verify failure), **Then** the failure renders as a visible error message in the chat and the session state reflects the error rather than silently succeeding.
- **Given** multiple endpoints in `GONKA_ENDPOINTS`, **When** one endpoint fails, **Then** the adapter's degraded/fallback behavior is defined and observable (either it tries the next endpoint, or it reports failure) — never a silent hang.
- **(negative)** **Given** an invalid `GONKA_PRIVATE_KEY`, **When** the first request is signed and rejected, **Then** the error message does not echo the key or signature material.

### Story 4 — Recordings tag provider=gonka without leaking secrets
**When** a Gonka session runs, **I want** its raw protocol recorded like other backends but with all signing-sensitive data redacted, **so I can** debug without creating a secret-leak artifact.

- **Given** a Gonka session, **When** the recording header is written, **Then** `backend_type` is `"gonka"`.
- **Given** Gonka request/response frames are recorded, **When** a frame contains the private key, an `Authorization` header, or a signed payload, **Then** those values appear as `[REDACTED]` and the header carries `redactionApplied: true`.
- **(negative)** **Given** any recorded Gonka frame, **When** the recording file is grepped for the configured private key, **Then** there are zero matches.

### Story 5 — Council Mode never offers unsupported Gonka pairings
**When** a user opens Council Mode, **I want** only supported pairings offered, **so I can't** create a broken Gonka pair.

- **Given** the Council pairing dropdown, **When** it renders in v1, **Then** it offers only the existing supported pairings (`claude+claude`, `claude+codex`) — no Gonka pairing appears.
- **(negative)** **Given** a crafted create-council request naming a Gonka pairing, **When** it hits `POST /sessions/create`(`-stream`), **Then** the server rejects it via the `SUPPORTED_PAIRINGS` allow-list with a clear error, and no half-spawned group is left behind.

---

## Acceptance Criteria (release gate)

The feature is done when **all** of the following hold:

1. Existing Claude and Codex single-sessions and Council pairs create, stream, and archive exactly as before (regression suite green).
2. The provider setup wizard lists Gonka as an **experimental** provider with a masked private-key field.
3. A user can create a Gonka chat session and receive a response from the configured default model (streamed or non-streamed).
4. When the Gonka endpoint is unavailable, the UI shows a clear error and the session is **not** in a false `active` state.
5. Council Mode does **not** offer any Gonka pairing, and the server rejects any Gonka pairing request via the allow-list.
6. Recordings for Gonka sessions contain `backend_type: "gonka"` and contain **no** private key or signature-sensitive material.
7. `bun run typecheck` and `bun run test` pass; new components have render + axe + behavior tests.
8. Replay/contract tests exist for the new Gonka adapter (a recorded/synthetic Gonka exchange replays to the correct browser frames), mirroring the Codex replay-regression convention (EC-6).

---

## Boundaries

### ✅ Always (implementing agent proceeds without asking)
- Add `"gonka"` to the `BackendType` union and a `GONKA_BACKEND` descriptor.
- Build `GonkaAdapter` behind the existing `IBackendAdapter` interface.
- Store Gonka config server-side only; mask in every client-facing surface.
- Extend recorder redaction patterns to cover Gonka key/signature field names.
- Add tests (render/axe/behavior for UI; replay/contract for the adapter).

### ⚠️ Ask first (human approval before proceeding)
- Adding **any** Gonka entry to `SUPPORTED_PAIRINGS` or the Council pairing UI.
- Introducing **any** server-side tool execution or agentic tool loop.
- Changing the `review-watcher` filename regex or the `.council/reviews/<phase>-<provider>-observer.md` contract.
- Changing the shared recorder redaction behavior for existing (Claude/Codex) frames.
- Adding a new npm dependency beyond `gonka-openai` (and confirm `gonka-openai` exists/version before pinning).

### 🚫 Never
- Send `GONKA_PRIVATE_KEY` (or signatures) to the browser, logs, recordings, or crash reports.
- Report a Gonka session as `active` before an endpoint is confirmed reachable.
- Spawn a subprocess, PID-track, `--resume`, or orphan-reap a Gonka "session" — it has no child process.
- Claim or imply Gonka has Claude/Codex tool parity anywhere in the UI.
- Break or modify existing Claude/Codex session behavior to accommodate Gonka.

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `gonka-openai` API shape differs from assumptions | Adapter rework | Verify SDK surface (streaming, client ctor options) before building; confirm the package/version exists before pinning. |
| Private key leaks via new SDK field names redaction doesn't know | Secret breach → mandatory rotation | Add explicit redaction patterns + a test that greps recordings/logs for the key; fail-closed. |
| Process-less backend breaks lifecycle assumptions (PID, `--resume`, reaper) | Crashes / phantom sessions | Gate all subprocess lifecycle code on backend type; Gonka path skips it. |
| Users expect coding-agent parity | Trust erosion | "Experimental / chat-only" labeling is an acceptance criterion, not optional polish. |
| False `active` on a dead endpoint | Ghost sessions (known failure mode) | Confirm reachability before `active`; failures render as errors, not silence. |
| Multi-endpoint fallback ambiguity | Silent hangs | Define and test degraded behavior explicitly (next-endpoint or reported failure). |
| Scope creep into Option B/C | Missed v1 | B/C are Ask-first boundaries; the type union is built to accept them later without rework. |

## Testing Plan

- **Unit — adapter:** browser `user` message → `gonka-openai` call mapping; streamed deltas → `content_block_delta` frames; single completion → completed assistant message.
- **Contract/replay:** a recorded/synthetic Gonka exchange replays to the expected browser frame sequence (EC-6 parity with Codex replay tests).
- **Redaction tests (mandatory):** a fixture frame containing a fake private key + `Authorization` header + signed payload → recorder output has `[REDACTED]` and zero key matches; assert `redactionApplied: true`; assert nothing leaks to a captured log sink.
- **Failure-path tests:** unreachable endpoint on create → not `active` + clear error; prompt failure → visible error message; invalid key → error without echoing key; multi-endpoint fallback behaves as defined.
- **Council allow-list test:** crafted Gonka pairing request rejected by `SUPPORTED_PAIRINGS`; no half-spawned group.
- **UI tests:** setup wizard render + axe + masked-field behavior; provider badge renders `gonka` token; session create/response flow for a mocked Gonka adapter.
- **Regression:** full existing Claude/Codex + Council suite green; `typecheck` + `test` gates pass (pre-commit hook honored).

## Migration & Compatibility

- **Additive only.** `BackendType` widens from a 2-value to a 3-value union; every existing `switch`/branch on backend type must have a `gonka` case or a safe default — audit `cli-launcher.ts`, `ws-bridge.ts`, `session-orchestrator.ts`, `recorder.ts`.
- **No data migration.** Existing session-store JSON and recordings are unchanged; `backend_type` was already typed as `BackendType`, so older files stay valid.
- **Council contract untouched in v1.** The `.council/reviews/<phase>-<provider>-observer.md` filename regex and pairing allow-list are unmodified; Gonka simply never produces council artifacts.
- **Settings compatibility.** Gonka config is a new, optional, absent-by-default block; installs without it behave identically to today.
- **Forward path.** Options B (coding agent) and C (observer) can be added later by introducing a server-side tool loop; nothing in v1 blocks them, and the type/adapter seams already accommodate a third provider.

## Effort estimate (for scoping only — implementation not yet planned)

Rough size, given the verified API surface. "Points" are relative complexity, not calendar time.

| Area | v1 (Option A, inference-only) | Notes |
|---|---|---|
| Type union + `BackendProvider` descriptor | **S** | Additive; audit every `switch (backendType)`. |
| `GonkaAdapter` (implements `IBackendAdapter`) | **M** | The core work. Maps browser `user` → `chat.completions.create`; OpenAI stream deltas → existing `content_block_delta` frames. Adapter *is* the process — no subprocess. |
| Process-less lifecycle handling | **M** | Gate PID tracking / `--resume` / orphan-reaper / relaunch on backend type. Highest regression risk — touches shared launcher/orchestrator paths. |
| Async endpoint discovery + reachability gate | **S–M** | `resolveEndpoints` before `active`; map failure to a clean error (no false `active`). |
| Server-side config store + masked settings UI | **M** | New optional config block; wizard entry flagged experimental; never echo the key. |
| Recorder redaction confirmation + tests | **S** | Mostly verifying existing redaction covers `Authorization`/`X-Timestamp`; add fixtures. |
| Provider badge (single-session `gonka` token) | **S** | No Council changes. |
| Tests (unit + replay/contract + failure paths + UI) | **M** | Replay/contract test for the adapter is the EC-6 gate. |
| **v1 total** | **~M (bounded)** | One adapter + lifecycle gating + config/UI + tests. No new tool subsystem. |

**Deferred (Option B/C) — the expensive part, NOT in v1:**

| Area | Size | Why it's big |
|---|---|---|
| Server-side tool loop + execution | **XL** | Does not exist today; Aura has never executed tools. Needs tool registry, sandboxing, result feedback loop. |
| Function-call → `can_use_tool` permission parity | **L** | Map OpenAI `tool_calls` into the existing permission UX and back. |
| Read-only observer boundary without a subprocess | **L** | Today enforced by CLI spawn flags (`observer-permissions.ts`); Gonka has no subprocess, so Aura must enforce it in its own loop. |
| Council pairing + review-filename `(claude\|codex\|gonka)` | **M** | Allow-list + regex + UI, only meaningful once a tool loop exists. |

**Takeaway:** v1 (chat-only) is a **bounded medium** effort — one adapter plus lifecycle gating and config/UI. The coding-agent ambition is where cost explodes (**XL+**), entirely because the server-side tool-execution subsystem must be built from scratch — the `gonka-openai` SDK returns tool calls but never runs them.

---

*After implementing, compare results against each acceptance criterion above and list any unmet requirements.*
