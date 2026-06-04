# Context Brief for Aura Council Review

## What this code does

PR #91 (`feat/dynamic-claude-models`, commit `fdf88e0`) replaces the hardcoded
Claude model triplet (`claude-opus-4-7 | sonnet-4-6 | haiku-4-5`) with a live
list from Anthropic `/v1/models`. Server-side: new module
`web/server/anthropic-models-cache.ts` (1221 LOC) implements a dual-tier cache
(in-memory TTL 1h, disk staleness ceiling 24h), atomic 3-check hit predicate,
single-flight Promise lock, AbortController-bounded fetch, structured-log
discipline. Frontend lifts the previously-local `dynamicModels` React state
in HomePage + CronManager to a new `settings-slice.dynamicBackendModels`
surface; ModelSwitcher subscribes to the same source and gains an
APG-conformant listbox keyboard model, "Latest" badge per tier, and
discoverability footnote when no key is configured.

## Architecture

This PR touches three Aura subsystems:

1. **Server REST** — `web/server/routes.ts` `GET /api/backends/:id/models`
   Claude branch (was hard 404, becomes 200/404/502 depending on key + cache
   + upstream). The new module `anthropic-models-cache.ts` owns fetch +
   cache + sort + log discipline.
2. **Frontend state** — `web/src/store/settings-slice.ts` extended with
   `dynamicBackendModels: { claude?, codex? }`, `dynamicBackendModelsStatus`
   (idle/pending/resolved/rejected), and `loadBackendModels(backend)`
   action with module-scope inflight-token guard.
3. **Frontend UI** — `HomePage.tsx`, `CronManager.tsx`, `ModelSwitcher.tsx`
   all drop their previous local-state fetches and subscribe to the slice.
   ModelSwitcher additionally gains APG keyboard model, width clamp, Latest
   badge per tier, and no-key footnote.

Existing Codex pattern at `routes.ts:1531-1561` reads CLI-managed
`~/.codex/models_cache.json` — preserved unchanged for symmetry budget.

## Stack in use within scope

- **Bun 1.0+ native `fetch()`** for HTTPS to `api.anthropic.com/v1/models`
  (NO WebSocket — REST only this PR).
- **Hono 4.7** REST handler in `routes.ts`.
- **`node:fs`** sync (`readFileSync`, `realpathSync`) + existing
  `writeAtomicJson` helper from `web/server/atomic-write.ts` (tmp+rename+
  fsync, mode 0o600).
- **`node:crypto`** `createHash("sha256")` for key fingerprint.
- **React 19** hooks (`useState`, `useEffect`, `useMemo`, `useId`,
  `useRef`, `useCallback`) + **Zustand 5** slice extension.
- **Vitest + vitest-axe** for tests (255 test files / 6652 tests / 4 skip
  — all green pre-review).

**Untouched** (do not re-review): `ws-bridge.ts`, `cli-launcher.ts`,
`session-orchestrator.ts`, NDJSON/JSON-RPC protocol adapters, council mode,
recordings, subprocess spawn argv, ws auth, env profiles, sandboxes.

## Accepted conventions (relevant subset from `conventions.md`)

The PR's PLAN-aura-dynamic-model-list.md was authored against these. Do NOT
re-flag:

- **AP-3** writer+reader+parser schemas co-located in one module — followed
  for the disk cache shape inside `anthropic-models-cache.ts`.
- **AP-14** multi-producer wire shapes route through one assembly site —
  `toModelOptions` is the single converter for both Codex and Claude.
- **EC-5/EC-6** protocol parsers reject unknown shapes + replay-tested.
  Applied here to the Anthropic `/v1/models` JSON response (parser boundary
  even though it's not over WS).
- **EC-7 / EC-36** filesystem-access predicates inline realpath or via
  resolving wrapper. `assertCachePathInBounds()` in
  `anthropic-models-cache.ts` is the implementation.
- **EC-8** reconciliation actions sentinel-before-sweep. The cache
  `key_fingerprint` IS the sentinel; no proactive sweep is performed
  (read-time predicate handles invalidation).
- **EC-9** structured JSON logs with `event` + context fields. Cache
  module emits `anthropic-models.{cache.hit|cache.miss|upstream.success
  |upstream.auth-failed|upstream.unavailable|upstream.parse-failed
  |stale-served|cache.write-failed|pagination-needed|no-key}`.
- **EC-17** defence-in-depth gates fail-CLOSED. Empty key → 404 (not 200
  with empty list).
- **EC-21** documented log triplets derive from single source. Triplet
  `(fetched_at, key_fingerprint, model_count)` always sourced from
  `CachedModelsRecord`.
- **EC-22** typed-channel emit paths need behavioural-assertion tests.
- **EC-23** filesystem paths in log payloads use sentinel; raw bytes never
  in logs. Path sentinel `<companion-cache:anthropic-models>` is used.
- **EC-30** Council Mode phases ≤100k working tokens. This PR's plan +
  implement chain was bounded inside the council pipeline.

## Key observations

1. **anthropic-models-cache.ts is 1221 LOC** — second-largest single-file
   surface this PR introduces. Fowler should weigh god-module risk against
   AP-3 (writer+reader+parser+orchestrator+fetch+cache co-located).
2. **`pickIcon` in `backends.ts`** now branches on `slug.startsWith("claude-")` —
   side-effect on Codex sort behaviour because it's the same function. Worth
   Backend/Fowler confirmation that Codex column is unchanged.
3. **`settings-slice.ts` softened its JSDoc invariant** — the existing
   comment said "server-authoritative facts only"; this PR added `dynamicBackendModels`
   (server-derived cache, NOT a setting). Plan flagged this as a Fowler R4
   divergence and parked. Review whether this should be a separate slice now
   or live with it.
4. **In-memory cache (`memoryCache`) is module-scope global** — shared
   across all requests. Single Bun process is single-tenant for now, but
   note for any future multi-tenant deploy concerns.
5. **Inflight-token in settings-slice is module-scope** (NOT Zustand
   state) — shared across components but not across browser tabs. Verify
   this is the intended trade-off.
6. **Sticky preference NOT yet plumbed** — `pickSessionDefaultModel`
   accepts `stickyPreference` but HomePage / CronManager don't currently
   pass `settings.anthropicModel`. Plan flagged as parked. Watchpoint.
7. **APG keyboard model in ModelSwitcher uses queueMicrotask + manual
   focus** — a11y / React experts should verify focus discipline.
8. **`__deleteDiskCacheForTests()` uses `require("node:fs")`** for the
   reset helper — an inline `eslint-disable` annotation appears. Backend/
   Beck should comment on test-only escape hatch hygiene.
9. **Fixture is SYNTHETIC** (`web/server/fixtures/anthropic-models-response.json`)
   — uses synthesised `claude-opus-4-8-20260415` id. Documented in
   `fixtures/README.md` as placeholder, instructions to refresh from real
   `/v1/models` capture.

## Automated check results

- **Typecheck**: `bun run typecheck` — clean, exit 0.
- **Tests**: `bun run test` — **255 files / 6652 pass / 4 skipped (all
  green)**. Includes 60 new tests added by this PR.
- **A11y dedicated**: `bun run test:a11y` — **41 files / 67 pass /
  214 skipped (out-of-scope)** — green.

**Pre-existing failures**: none — clean baseline. Any new finding cannot
attribute to prior breakage.

## Domain File Assignments

**Hunt (Security):** `web/server/anthropic-models-cache.ts`,
`web/server/routes.ts`

**Fowler (Refactoring):** `web/server/anthropic-models-cache.ts`,
`web/server/routes.ts`, `web/src/store/settings-slice.ts`,
`web/src/utils/backends.ts`, `web/src/components/ModelSwitcher.tsx`

**Bun/Hono/TS Backend Expert:** `web/server/anthropic-models-cache.ts`,
`web/server/routes.ts`, `web/src/store/settings-slice.ts`

**FS-JSON Persistence Expert:** `web/server/anthropic-models-cache.ts`,
`web/server/fixtures/anthropic-models-response.json`,
`web/server/fixtures/README.md`

**Realtime/NDJSON Protocol Expert:** `web/server/anthropic-models-cache.ts`
(parser-boundary discipline only — feature touches no WS surface)

**Subprocess Lifecycle Expert:** `web/server/anthropic-models-cache.ts`
(indirect — model id flows into future CLI spawn argv; no subprocess
changes this PR)

**React/Web UI Expert:** `web/src/components/ModelSwitcher.tsx`,
`web/src/components/HomePage.tsx`, `web/src/components/CronManager.tsx`,
`web/src/components/SettingsPage.tsx`, `web/src/store/settings-slice.ts`,
`web/src/utils/backends.ts`

**a11y Auditor:** `web/src/components/ModelSwitcher.tsx`

**Saarinen (UI Quality):** `web/src/components/ModelSwitcher.tsx`,
`web/src/utils/backends.ts` (pickIcon)

**Friedman (UX Quality):** `web/src/components/ModelSwitcher.tsx`,
`web/src/components/HomePage.tsx`,
`web/src/components/SettingsPage.tsx`

**Willison (LLM Pipeline):** `web/server/anthropic-models-cache.ts`
(Anthropic metadata trust boundary, display_name rendering),
`web/src/components/ModelSwitcher.tsx` (renders Anthropic-controlled
strings as React innerText)

**Beck (Test Quality):**
`web/server/anthropic-models-cache.test.ts`,
`web/server/routes.test.ts`,
`web/src/store/settings-slice.test.ts`,
`web/src/utils/backends.test.ts`,
`web/src/components/ModelSwitcher.test.tsx`,
`web/src/components/HomePage.test.tsx`,
`web/src/components/Composer.test.tsx`,
`web/server/fixtures/anthropic-models-response.json`

**Docker/GHA Deploy:** SKIPPED — no Dockerfile / workflow / scripts
changes in this PR.

---

**Reminder for every expert:** the PR went through a 12-expert plan-time
dispatch via `/council-plan-aura`. Read the PLAN's
"Risks & Watchpoints" section (in `PLAN-aura-dynamic-model-list.md` at
repo root) — items already addressed there should NOT be re-flagged.
Findings should focus on what slipped through implementation OR on
genuine new concerns the plan didn't surface.
