# Council Plan (Aura): Dynamic Claude Model List via Anthropic /v1/models

**Scope:** When `anthropicApiKey` is configured, replace the hardcoded `claude-opus-4-7 | sonnet-4-6 | haiku-4-5` triplet with a server-fetched dynamic model list from Anthropic `/v1/models` (mirror of the existing Codex pattern). Empty key → static fallback, current behaviour preserved.

**Context:** `GET /api/backends/:id/models` already exists at `routes.ts:1528-1565` with Codex wired (reads `~/.codex/models_cache.json`) and Claude returning 404 by design. Frontend has three consumers (HomePage Wizard, CronManager, ModelSwitcher) — two duplicate the same local-React-state fetch pattern with a `backend === "codex"` gate, the third doesn't fetch at all. The `toModelOptions` converter at `backends.ts:32` is already wired for Codex.

**Boundaries:** No WebSocket protocol changes. No subprocess changes. No Codex side modifications (already wired). No OAuth-token fallback (key-only). No manual-refresh UI, no periodic refresh, no toast/loading-skeleton. Static fallback STAYS as zero-config/offline path.

**Council dispatched (12/12):**
- ✅ Hunt (security) — 6 recommendations
- ✅ Fowler (refactoring) — 3 recommendations
- ✅ Backend-TS — 6 recommendations
- ✅ Persistence-FS — 5 recommendations
- ✅ Realtime/NDJSON — 1 recommendation (parser boundary generalised)
- ✅ Subprocess — 1 recommendation (defensive non-action)
- ✅ Frontend-React — 1 multi-part recommendation
- ✅ a11y — 4 recommendations
- ✅ Saarinen (visual) — 1 recommendation
- ✅ Friedman (UX) — 4 recommendations
- ⚪ Willison (LLM pipeline) — no recommendations (concerns transitively covered by Hunt/Backend/Realtime)
- ✅ Deploy (Docker+GHA) — 5 recommendations

---

## Task Sequence

### 1. New module `web/server/anthropic-models-cache.ts` — skeleton + negative-space header

| | |
|---|---|
| **Domain** | Fowler × Backend × Persistence-FS — Module boundaries earn themselves |
| **Ref** | `references/refactoring.md` → Principle 1 (economic); `references/quality-backend.md` → Principle 8; `references/quality-persistence.md` → Principle 5 |
| **Depends on** | — |

Create the module with a discriminated-union return type (`{ source: "memory"|"disk"|"network", outcome: "ok"|"no-key"|"upstream-auth"|"upstream-unavailable", models, status }`), schema-versioned cache record (`SCHEMA_VERSION = 1` exported constant), and a header comment documenting what this module **deliberately does not do**: no debounce, no rotation, no orphan-sweep, no `fs.watch` (cache is poll-on-request). The Hono handler will become a thin dispatch on the union. Co-locate writer + reader + parser per AP-3.

---

### 2. Anthropic `/v1/models` response parser — strict shape rejection, id allowlist, fixture replay

| | |
|---|---|
| **Domain** | Hunt × Backend × Realtime/NDJSON × Persistence — Validate at every boundary |
| **Ref** | `references/security.md` → P1 (syntactically possible = exists); `references/quality-backend.md` → P2; `references/quality-realtime.md` → P7 (protocol drift, generalised to vendor APIs); conventions EC-5, EC-6 |
| **Depends on** | Task 1 |

Parse the upstream JSON behind a typed `parseAnthropicModelsResponse(raw): ParsedModels | InvalidShape` function. Reject top-level shape mismatch with a typed `InvalidUpstreamResponse` error mapped to `models-cache.invalid-response` log → fallback to disk-or-502 path (never 200-with-empty). Per-element: require `id: string` matching `^claude-[a-z0-9.\-]+$` AND `type === "model"`, bound all strings ≤256 chars, tolerate missing `display_name`/`created_at` (EC-5 polymorphic-by-spec). Drop non-conforming entries via `onDropped("schema_violation")` not whole-list-fail. Replay test against captured fixture in `web/server/fixtures/anthropic-models-response.json`. Cross-ref: Hunt R6 (XSS prevention via id regex), Realtime R1 (fixture-based replay).

---

### 3. HTTPS fetch — AbortController 5s timeout, body-drain on every branch, httpFetch indirection

| | |
|---|---|
| **Domain** | Backend × Deploy — Resource lifecycle + healthcheck floor |
| **Ref** | `references/quality-backend.md` → Principle 5 (response bodies not consumed); Principle 7 (async correctness); `references/quality-deploy.md` → Principle 8 (graceful shutdown) |
| **Depends on** | Task 1 |

Wrap the `fetch(api.anthropic.com/v1/models)` call in `AbortController` with 5s `setTimeout`, clear timer in `finally`, read/cancel body on every status branch (including 401/403/5xx — Bun holds connection open until drained). Headers: `x-api-key: <anthropicApiKey>`, `anthropic-version: 2023-06-01`. On `AbortError` → fold into 5xx/network fallback path. Type caught errors as `unknown`, narrow with `instanceof`. Route via a `httpFetch` indirection (module-internal const) so tests mock the indirection, not global `fetch` (Vitest fights Bun's native fetch). Cross-ref: Deploy R5 (behavioural timeout test via fake timers).

---

### 4. Dual-tier cache — in-memory + disk with atomic 3-check hit predicate

| | |
|---|---|
| **Domain** | Persistence-FS × Hunt × Backend — Cache invalidation discipline + fail-CLOSED on key drift |
| **Ref** | `references/quality-persistence.md` → Principle 1 (atomic write or it didn't happen), Principle 3 (sentinel discipline translated to cache integrity); `references/security.md` → P3 (minimise state); convention EC-17 |
| **Depends on** | Task 1 |

In-memory `Map<keyFingerprintPrefix, CachedModelsRecord>` (TTL 1h). Disk: `~/.companion/anthropic_models_cache.json` schema `{ schema_version: 1, fetched_at: number, key_fingerprint: string (16-hex), models: BackendModelInfo[] }`. Writes via `writeAtomicJson` (tmp-in-same-dir, never $TMPDIR — atomic rename requires same-fs). Hit predicate is **atomic single check**: `schema_version === 1` AND `key_fingerprint === sha256(currentKey).hex.slice(0,16)` AND `Date.now() - fetched_at <= 24h`. Any mismatch → miss. `key_fingerprint` computed per-request (not cached in memory — user editing settings.json mid-runtime must be picked up). File mode `0o600`, parent dir `0o700`. Realpath bounds check on write target (`startsWith(realpath(COMPANION_HOME) + sep)`) per EC-7/EC-36 — defensive against future refactor. Defensive runtime assertion: the serialised cache payload MUST NOT contain the raw API key bytes (substring check on last-8-chars of key). On disk write failure: log + return success (in-memory still authoritative). Cross-ref: Hunt R1 (file mode + EC-7), Persistence R3 (3-check predicate), Backend R5 (fail-closed key handling), Persistence R5 (negative-space header in Task 1).

---

### 5. Single-flight + escape-hatch refusal

| | |
|---|---|
| **Domain** | Hunt × Backend — Rate-limit floor + shrink attack surface |
| **Ref** | `references/security.md` → Principle 7 (rate limiting on expensive endpoints); Principle 5 (shrink attack surface) |
| **Depends on** | Task 3 |

Coalesce concurrent in-flight fetches behind a single Promise lock per process (key: `keyFingerprintPrefix`) so 10 simultaneous cold-cache requests trigger ONE Anthropic call. Hard refuse any future query-string escape hatches: `?refresh=1`, `?nocache=1`, `?force=1` — the handler MUST NOT honour them even as undocumented debugging knobs. Per scope, refresh is mount-only + Settings-save-only.

---

### 6. Hono Claude branch — thin dispatcher + structured logs + sanitised error envelopes

| | |
|---|---|
| **Domain** | Backend × Hunt × Persistence × Deploy — Structured logging + secret hygiene at every emit |
| **Ref** | `references/quality-backend.md` → Principle 6 (structured logging); `references/security.md` → P3 (sensitive content in logs); `references/quality-deploy.md` → P4 (secrets never in logs); conventions EC-9, EC-21, EC-23 |
| **Depends on** | Tasks 1, 2, 3, 4, 5 |

Implement the Claude branch at `routes.ts:1564` as a **thin** dispatcher: read `getSettings().anthropicApiKey` → if empty → 404; else call cache module → map discriminated union `outcome` → HTTP status (200 ok, 404 no-key, 502 upstream-auth, 502 upstream-unavailable). 502 body is a **fixed enum** `{ error: "upstream_unavailable" | "upstream_unauthorized" }` — NEVER the upstream JSON, NEVER upstream status text, NEVER the originating URL. Structured logs via project logger emit `anthropic_models.cache.hit | cache.miss | cache.stale | refresh | fetch_failed | parse_failed | schema_mismatch | fingerprint_mismatch` — each line sources `(fetched_at, key_fingerprint_prefix, model_count, source, status, latency_ms)` from the **single `CachedModelsRecord`** (EC-21 triplet discipline), with cache path as sentinel `<companion-cache:anthropic-models>` (EC-23), never raw key, never raw body, never raw path. Confirm bearer middleware applies (EC-17 fail-CLOSED at auth layer — 401 before 404, no pre-auth 200 oracle).

---

### 7. Server tests — split existing 404 test + EC-22 behavioural emit-path assertions + fixture replay

| | |
|---|---|
| **Domain** | Backend × Beck (test quality) × Deploy — Behavioural emit-path coverage |
| **Ref** | `references/quality-backend.md` → Principle 8 (type safety at boundary); conventions EC-6, EC-22; `references/quality-deploy.md` → Principle 6 (CI gates) |
| **Depends on** | Task 6 |

Split existing `routes.test.ts:3778` ("returns 404 for claude backend (uses frontend defaults)") into two named tests: `(anthropicApiKey: "")` → 404 with fixed body; `(anthropicApiKey: "sk-ant-test-...")` → 200 with parsed model list from mocked fetch. New `web/server/anthropic-models-cache.test.ts` covers: parser-strict-on-bad-shape, parser-drop-bad-items, in-memory hit, disk hit on cold start, fingerprint mismatch → miss, schema mismatch → miss, stale (>24h) → miss, AbortController 5s timeout via `vi.useFakeTimers()` + never-resolving fetch, single-flight (concurrent N requests → 1 upstream call), corrupted disk file → treat as miss-not-crash, EC-22 log emit per line with EC-21 triplet shape. Recording-tee regression: `COMPANION_RECORD=1` MUST NOT produce a recordings line containing the API key (Hunt R5). Mock `httpFetch` indirection from Task 3, NOT global `fetch`. Cross-ref: Deploy R1 (hermetic CI — no live Anthropic calls).

---

### 8. Zustand `settings-slice` extension — dynamicBackendModels + inflight-token guard + status enum

| | |
|---|---|
| **Domain** | Frontend-React × Fowler — Single source of truth + race-guard |
| **Ref** | `references/quality-frontend.md` → Principle 2 (eliminate derivable state + colocate); `references/refactoring.md` → Principle 3 (state colocation) |
| **Depends on** | — (parallel to server tasks) |

Extend `web/src/store/settings-slice.ts` with `dynamicBackendModels: { claude?: ModelOption[]; codex?: ModelOption[] }`, `dynamicBackendModelsStatus: { claude: "idle"|"pending"|"resolved"|"rejected", codex: ... }`, `loadBackendModels(backend) → Promise<void>` action. Inflight-token guard: store `inflightToken: Record<backend, symbol>` — each call mints a new token, only commits results whose token still matches at resolution time (prevents stale fetch from clobbering a fresh post-save refetch — Frontend R1 race). Silent error fallback (`.catch(() => {})` preserved per scope). Hook into existing `updateSettings` slice action: when patch includes non-empty `anthropicApiKey` AND it differs from prior, dispatch `loadBackendModels("claude")` AFTER successful PUT. Status enum not surfaced to UI yet but typed internally (Frontend R1).

---

### 9. `pickSessionDefaultModel(backend, dynamic?, sticky?)` helper — sticky preference wins

| | |
|---|---|
| **Domain** | Fowler × Frontend-React × Friedman — Single rule site, sticky-preference correctness |
| **Ref** | `references/refactoring.md` → Principle 4 (names reveal design — `getDefaultModel` stays accurate as the *static* default); `references/quality-ux.md` → P9 (trust through preserved user choice) |
| **Depends on** | Task 8 |

Add `pickSessionDefaultModel(backend, dynamic?, stickyPreference?)` to `web/src/utils/backends.ts` — keep `getDefaultModel(backend)` single-arg and unchanged (Fowler R3). New helper picks in priority: (a) `dynamic.find(m => m.value === stickyPreference)` if both exist and match, (b) `stickyPreference` if user picked something but Anthropic no longer returns it (treat as custom — already handled by existing `ModelSwitcher.tsx:30` fallback path), (c) `dynamic[0].value` if dynamic non-empty, (d) `getDefaultModel(backend)` static. Call sites: `HomePage.tsx:245 switchBackend`, anywhere else a session-default is materialised. This is the single site where "newest available" vs "user's saved preference" is reconciled — Frontend R1's rule-lives-once without Fowler's signature pollution.

---

### 10. HomePage + CronManager — drop the `!== "codex"` gate, kill local `dynamicModels` state

| | |
|---|---|
| **Domain** | Frontend-React × Fowler × Friedman — Eliminate parallel React-local copies |
| **Ref** | `references/quality-frontend.md` → Principle 2; `references/refactoring.md` → Principle 5 (Feature Envy — things-that-change-together stay together); `references/quality-ux.md` → P9 (same-data inconsistency = trust break) |
| **Depends on** | Tasks 8, 9 |

`HomePage.tsx:258-276`: remove the `if (backend !== "codex") return;` early-return, remove `useState dynamicModels` + `setDynamicModels` calls, read `useStore(s => s.dynamicBackendModels[backend])`, derive `models = dynamicBackendModels[backend] ?? getModelsForBackend(backend)` in render. `switchBackend(newBackend)` calls `pickSessionDefaultModel(newBackend, dynamicBackendModels[newBackend], settings.anthropicModel)`. Same shape for `CronManager.tsx:707-720`. CronManager is the canary (Friedman R4) — it's the longest-lived open form; verify it re-renders on slice update via Zustand selector subscription (default behaviour, just verify).

---

### 11. ModelSwitcher — subscribe to slice for available list, preserve session.model for current

| | |
|---|---|
| **Domain** | Frontend-React × Fowler — Distinguish "current active" (session lifecycle) from "available choices" (slice cache) |
| **Ref** | `references/quality-frontend.md` → Principle 2; `references/refactoring.md` → Principle 4 |
| **Depends on** | Task 8 |

`ModelSwitcher.tsx:25` currently uses ONLY static `getModelsForBackend(backend)`. Replace with `const dynamic = useStore(s => s.dynamicBackendModels[backendType]); const models = dynamic ?? getModelsForBackend(backendType);`. **Do not collapse the current-selection logic** — `currentModel` continues to read from `runtimeSession.model || sdkSession.model` (CLI's `system.init`-reported model). The existing fallback at `ModelSwitcher.tsx:29-30` (user has a pinned model not in known list → render as unknown-icon entry) MUST be preserved (Fowler R2 — "current" and "available" are different nouns; do not collapse).

---

### 12. ModelSwitcher a11y — APG listbox keyboard model + truncation + scroll + verify-no-aria-live

| | |
|---|---|
| **Domain** | a11y — APG Listbox conformance + WCAG 2.4.11 |
| **Ref** | `references/quality-a11y.md` → Principle 7 (keyboard navigation); Principle 5 (roles, names, labels); WCAG 2.4.11 Focus Not Obscured |
| **Depends on** | Task 11 |

The list grows from 3 → ~5-7 items (more as Anthropic publishes snapshots). Current Tab-only traversal of individual `<button role="option">` degrades. Adopt APG single-select listbox keyboard model (mirror `CouncilToggle` provider dropdown): single tab-stop on listbox, Arrow Up/Down move roving `aria-activedescendant`, Home/End jump to first/last, Enter/Space commits, Escape closes + returns focus to trigger. Add `max-h` + `overflow-y-auto` on dropdown; active-descendant transitions call `scrollIntoView({ block: "nearest" })` (a11y R3). Truncated long labels: `title={fullLabel}` + ensure full text is the accessible name (a11y R2 — `aria-label` MUST NOT substitute a shortened "marketing" name). Verify-by-absence test: ModelSwitcher root has no `aria-live` / `role="status"` / `role="log"` attribute (a11y R4 — prevents future contributor wrapping dropdown in live-region "to help screen-reader users"). Cross-ref: CLAUDE.md mandates `toHaveNoViolations()` + keyboard behavioural tests.

---

### 13. Visual treatment — Claude entries icon-less, dropdown width clamp, server-side tier sort

| | |
|---|---|
| **Domain** | Saarinen × Backend (server-side sort lives in Task 2) — Quiet asymmetry distinguishes Claude from Codex |
| **Ref** | `references/quality-ui.md` → Principle 1 (reduce noise to reveal hierarchy); Principle 8 (component consistency) |
| **Depends on** | Task 11 |

`web/src/utils/backends.ts pickIcon()`: return `""` for any `claude-*` slug (preserve Codex's existing icon assignment). The icon-less Claude column is intentional asymmetry — growing to 7 items is exactly when geometric fallback icons (`◆ ● ◕ ✦`) would read as noise. ModelSwitcher dropdown: change `min-w-[160px]` → `min-w-[180px] max-w-[280px]`, add `truncate` on label span so long Anthropic `display_name` ("Claude Opus 4.8 (2026-04-01 snapshot)") sizes within grid instead of pushing trigger off bottom-bar. Server-side sort (lives in Task 2's parser/normaliser, NOT here): opus > sonnet > haiku; within tier `created_at` desc with version-aware-numeric tiebreaker on `id` for missing `created_at`.

---

### 14. Discoverability — "Latest" tag per tier-newest + no-key footnote

| | |
|---|---|
| **Domain** | Friedman — Trust through reasoning visibility (P9), structure complexity (P1) |
| **Ref** | `references/quality-ux.md` → P9 (trust compounds slowly), P1 (structure don't simplify) |
| **Depends on** | Task 11 |

ModelSwitcher dropdown row: render small inline "Latest" badge next to the newest snapshot per tier (Opus/Sonnet/Haiku). No toast, no banner. User with sticky `claude-opus-4-7` sees `4-8 "Latest"` and decides for themselves — sticky preference still stays sticky (Frontend R1), just discoverable (Friedman R1). When rendered list IS the static fallback AND `settings.anthropicApiKey === ""` (no key): append a single grey footer row "Add an API key in Settings to see more models" (Friedman R3 — connects no-key state to its resolution path). When key IS set but fetch failed: show nothing (silent fallback per scope; brief explicitly excludes error toast).

---

### 15. Frontend tests — HomePage/CronManager Claude path, ModelSwitcher dynamic + axe + APG, inflight-guard

| | |
|---|---|
| **Domain** | Beck × a11y × Frontend-React — CLAUDE.md mandates axe + behavioural a11y on every component test |
| **Ref** | `references/quality-testing.md` → mutation resistance + structure-insensitive assertions; CLAUDE.md global mandate |
| **Depends on** | Tasks 10, 11, 12, 13, 14 |

`HomePage.test.tsx`: drop the existing "Claude path is skipped" assertion (contract change); add render-with-dynamic-list + axe + switchBackend correctly picks via `pickSessionDefaultModel`. Same for `CronManager.test.tsx`. `ModelSwitcher.test.tsx`: render with empty store → static fallback path + axe; render with `dynamicBackendModels.claude: [...]` → dynamic list rendered + axe; render with 7-item list inside constrained container → ArrowDown × 3 + Enter commits correct model + active-option `scrollIntoView` stays visible; verify-by-absence assertion `expect(root).not.toHaveAttribute("aria-live")`; assertion `expect(root).not.toHaveAttribute("role", "status")`; truncated long label has `title={fullText}` AND accessible name === fullText. Settings-slice inflight-guard test: dispatch `loadBackendModels("claude")` twice in quick succession with different fetch resolution timing → assert only the latest token's result commits to store.

---

## Risks & Watchpoints

- **Subprocess R1 — Probe-spawn temptation:** Do NOT add a "verify model exists by spawning `claude --list-models` or `claude --version`" canary during implementation. Model validity is upstream Anthropic's concern; CLI's own rejection on spawn is the only acceptable runtime check (matches today's behaviour). Adding a probe-spawn would create an unlogged subprocess class on every cache refresh with no PID registry / no idle-kill / no stdio drain.

- **Willison — LLM lane intentionally empty:** All LLM-pipeline concerns transitively covered: renderer trust → Hunt R6 (id regex + React default escape), parser replay → Realtime R1 + Task 2 fixture, fail-CLOSED → Backend R5 + Task 4. Do not re-litigate during implementation review.

- **Fowler stretch — Codex move-into-same-module:** Fowler R1 hinted at moving Codex inline (`routes.ts:1531-1561`) into a shared `backend-models-cache.ts` for symmetric reads. **Parked.** Codex pattern works; Codex reads CLI-managed disk file, Claude fetches HTTPS — these are NOT symmetric paths, they're parallel-but-different. Sharing them is speculative generality (Principle 5). Re-evaluate if duplication later justifies.

- **Hunt R3 — Pre-auth oracle:** `/api/backends/:id/models` is already gated by the bearer middleware applied to `/api/*`. Verify during Task 6 that this remains true — don't accidentally hoist the cache lookup before middleware. EC-17 fail-CLOSED order is: 401 (no auth) → 404 (no key) → 200 (key + cache/fetch ok).

- **Recording exclusion (Hunt R5):** Task 7 includes a regression test that `COMPANION_RECORD=1` produces no recordings line containing the API key. Watch for any future change to recorder fan-out that might tee REST handler outputs.

- **Sticky vs dynamic[0] (Frontend R1, Friedman R1):** When `settings.anthropicModel === "claude-opus-4-7"` AND dynamic includes both 4-7 and 4-8, `pickSessionDefaultModel` returns 4-7 (sticky wins). Only when sticky is absent OR no longer in dynamic list AND no custom-entry fallback path applies, drop to `dynamic[0]`. Test explicitly.

- **EC-22 emit-path coverage:** Every structured log line in Task 6 (`hit | miss | stale | refresh | fetch_failed | parse_failed | schema_mismatch | fingerprint_mismatch`) requires a behavioural assertion test in Task 7. Typecheck pin is not sufficient.

- **EC-10 future-proofing:** The cache discriminated union `outcome` is internal today (not rendered as a UI state pill). If a future UX surfaces it (e.g., "model list status" indicator), add `const _exhaustive: never = outcome;` exhaustiveness check at the consumer switch. Not required now.

- **Aria-live regression footgun (a11y R4):** Verify-by-absence test in Task 15 is the canary. If a future contributor wraps dropdown in `aria-live="polite"` "to help screen reader users notice new models," the test fires red. Document the inversion intent inside the test comment.

- **Cache file location across deployments (Deploy R2):** `~/.companion/anthropic_models_cache.json` lives in the same volume-mounted directory as `settings.json`. The current Docker deploy already preserves this dir via volume mount. `.dockerignore` already excludes `.companion/` from build context. Verify during PR review.

---

## External Setup Required

| # | What | Why | Blocking task |
|---|------|-----|---------------|
| 1 | Capture a real Anthropic `/v1/models` response with the developer's own API key (NOT committed) → snapshot a redacted version to `web/server/fixtures/anthropic-models-response.json` | Required for EC-6 replay test + parser regression coverage. Hand-crafted JSON literals do not substitute per convention floor. | Task 2 |

That is the only external setup. No new env vars. No new GitHub Actions secrets. No new Docker base image deps. No new third-party package installs (uses Bun native `fetch`, `node:fs`, `node:crypto`).

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | New module `anthropic-models-cache.ts` skeleton + discriminated union + negative-space header | Fowler × Backend × Persistence | — |
| 2 | Anthropic response parser + id regex + drop-bad-items + fixture replay | Hunt × Backend × Realtime × Persistence | 1 |
| 3 | HTTPS fetch + AbortController 5s + body-drain + httpFetch indirection | Backend × Deploy | 1 |
| 4 | Dual-tier cache (memory+disk) with atomic 3-check hit predicate + EC-7 realpath + 0o600 mode | Persistence × Hunt × Backend | 1 |
| 5 | Single-flight Promise lock + refuse `?refresh=1` escape hatch | Hunt × Backend | 3 |
| 6 | Thin Hono Claude branch + structured logs (EC-21/EC-23) + sanitised 502 envelopes | Backend × Hunt × Persistence × Deploy | 1, 2, 3, 4, 5 |
| 7 | Server tests — split 404 test + EC-22 emit assertions + fixture replay + recording-exclusion regression | Backend × Beck × Deploy | 6 |
| 8 | `settings-slice` extension + inflight-token guard + status enum + refetch on Settings save | Frontend-React × Fowler | — (parallel) |
| 9 | `pickSessionDefaultModel` helper — keeps `getDefaultModel` single-arg | Fowler × Frontend × Friedman | 8 |
| 10 | HomePage + CronManager — drop gate, kill local state, subscribe to slice | Frontend × Fowler × Friedman | 8, 9 |
| 11 | ModelSwitcher subscribes to slice for available list; preserve session.model for current | Frontend × Fowler | 8 |
| 12 | ModelSwitcher a11y — APG listbox keyboard + truncate `title=` + scroll + verify-no-aria-live | a11y | 11 |
| 13 | Visual — claude-* icon-less, dropdown width clamp, server-side tier sort (in Task 2) | Saarinen × Backend | 11 |
| 14 | Discoverability — "Latest" tag per tier + no-key footnote | Friedman | 11 |
| 15 | Frontend tests — Claude path, dynamic list + axe + APG keyboard + inflight-guard | Beck × a11y × Frontend | 10, 11, 12, 13, 14 |

## Verdict

**Most important architectural decision:** Extracting the new logic into `web/server/anthropic-models-cache.ts` rather than inlining alongside the Codex branch in `routes.ts`. Three independent experts (Fowler, Backend, Deploy) converged on this from different reasoning chains — Fowler from `routes.ts` god-module risk, Backend from testability (the four EC-22 emit assertions reduce from flaky integration to crisp unit tests), Deploy from preserving file-granular coverage gate (per `feedback_file_level_coverage_gate_cascade.md`). Three-expert convergence on the same axis is the structural truth signal.

**Most critical expert domain:** Persistence-FS combined with Hunt — the cache invalidation predicate (Task 4) is the load-bearing correctness invariant. If `key_fingerprint` matching is implemented as a side-check rather than part of the atomic hit predicate, key rotation silently serves prior-account entitlements until the 24h ceiling expires. Get Task 4 right; everything else is plumbing.

**Where to start:** Tasks 1 + 2 + 8 can land in one slice as foundations (server module skeleton, parser, slice extension) before any of the wiring tasks. Task 4 is the highest-risk task and should follow immediately with Task 7's tests starting concurrently (TDD-friendly: write the test for the 3-check predicate first, then implement). UI tasks 10-14 can parallelise once Task 8 lands. The plan reads cleanly even if a pair agent isn't used during build, but if it is — `subprocess-lifecycle` is the most valuable observer for Task 4 (catches a stray probe-spawn temptation per Risks & Watchpoints).
