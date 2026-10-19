# Council Review (Aura): PR #91 — Dynamic Claude Model List

**Scope:** 17 source files in PR #91 (`feat/dynamic-claude-models`, commit `fdf88e0`). New `web/server/anthropic-models-cache.ts` (1221 LOC) + tests, `routes.ts` Claude branch, `settings-slice.ts` extension, `ModelSwitcher.tsx` overhaul (APG keyboard + Latest badge + no-key footnote), HomePage/CronManager/SettingsPage wiring, `pickIcon`/`pickSessionDefaultModel` in utils. 60 new tests, full suite green pre-review (typecheck + 6652 tests + 67 axe).

**Context:** Mirror of the existing Codex pattern (`~/.codex/models_cache.json`) for Claude — when `anthropicApiKey` is configured, the server fetches `/v1/models` with a dual-tier cache (1h memory / 24h disk), atomic 3-check hit predicate, single-flight Promise lock. Frontend lifts previously-local `dynamicModels` React state to `settings-slice.dynamicBackendModels`. ModelSwitcher gains APG-conformant listbox keyboard + Latest badge per tier + no-key footnote. Existing static `CLAUDE_MODELS` stays as zero-config / offline fallback.

**Council dispatched (12/12 — Deploy skipped, no Dockerfile/workflow changes):** Hunt (3 P3 only, clean), Fowler (3 P3 only, clean), Backend-TS (3 P2 + 4 P3), Persistence (6 P2 + 5 P3), Realtime/NDJSON (3 P2 + 3 P3), Subprocess (2 P3 only, hold-the-line verified), React/Web UI (2 P1 + 6 P2 + 3 P3), a11y (3 P1 + 5 P2 + 4 P3), Saarinen (1 P2 + 6 P3), Friedman (1 P1 + 4 P2 + 1 P3), Willison (2 P2 + 2 P3), Beck (3 P1 + 5 P2 + 5 P3).

---

## P1 — Fix Now

### 1. Sticky `anthropicModel` preference silently dropped at backend switch

| | |
|---|---|
| **File** | `web/src/components/HomePage.tsx:253`, `web/src/components/CronManager.tsx:850-856` |
| **Council** | Friedman × Carmack — Trust through preserved user choice (Principle 9) |
| **Ref** | `references/quality-ux.md` → Principle 9; cross-ref React/Web UI lane (P2-5) "call-site presence not just symbol export" |

**Finding:** `switchBackend` calls `pickSessionDefaultModel(newBackend, dynamicForNew)` with the `stickyPreference` argument **omitted**. The helper signature exists with 3 args, the tests at `backends.test.ts:303-325` assert the contract (`stickyPreference` wins over `dynamic[0]`), but no production caller passes it. The PLAN's "Risks & Watchpoints" section (line 219) explicitly required preserving sticky preference and demanded a test — the test was written, the call site was not wired.

**Consequence:** User who pinned `claude-opus-4-7` in Settings → toggles to Codex → returns to Claude → New Session form silently defaults to `claude-opus-4-8` (or whatever Anthropic publishes next). Token bill on a model the user didn't choose; assistant behaviour silently shifts. Classic `feedback_call_site_presence_not_just_symbol_export` shape: helper + test exist, production never reaches the contract.

**Fix:** Pipe `settings.anthropicModel` into the third arg at both call sites. The settings-slice doesn't currently carry the saved string (only `*Configured` booleans) — this PR is already touching the slice, so extend `SettingsHydratePayload` with `anthropicModel?: string` and select it at the call sites. Alternative: explicitly remove the third arg from `pickSessionDefaultModel`'s signature with a comment "sticky deferred to follow-up" so future readers don't think it's wired.

---

### 2. ModelSwitcher click-outside dismissal does NOT restore focus to trigger

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx:107-116` (click-outside handler) vs `:170-174` (Escape handler) |
| **Council** | a11y Auditor × Carmack — WCAG 2.4.3 Focus Order, APG dismissal contract |
| **Ref** | `references/quality-a11y.md` → Principle 4 (focus management on dynamic UI) |

**Finding:** The Escape handler properly restores focus via `triggerRef.current?.focus()`. The click-outside handler at `:107-116` calls only `setOpen(false)` — no focus restoration. Asymmetric dismissal contract: same overlay, same close, two different focus outcomes. `CouncilToggle.tsx:189,211` already implements the symmetric pattern (`requestAnimationFrame` + focus on trigger) — precedent in the codebase, not followed here.

**Consequence:** Keyboard-only user with focus inside the listbox who clicks elsewhere (or whose screen reader triggers click-outside via rotor navigation) loses focus to `<body>`. Next Tab lands at document start, not at the bottom-bar trigger. Loss of orientation point in the most-used in-session control.

**Fix:** Mirror `CouncilToggle.tsx`'s pattern — wrap the close in `requestAnimationFrame(() => triggerRef.current?.focus())`, gated on `document.activeElement` being inside `listboxRef.current` so pointer-click on another element doesn't yank focus from where the user clicked.

---

### 3. `queueMicrotask` autofocus is non-deterministic + untested (interlocked with Space activation)

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx:123-132` (autofocus effect), `:165-169` (Space handler) |
| **Council** | a11y Auditor × Carmack — Behavioural a11y beyond axe (Principle 1) |
| **Ref** | `references/quality-a11y.md` → Principle 1 (axe is a floor, not ceiling) |

**Finding:** The open effect schedules focus via `queueMicrotask(() => listboxRef.current?.focus())`. Two interlocked concerns: (a) React 19 StrictMode double-invokes effects in dev — the first invocation queues a microtask, cleanup runs before second invocation, microtask fires against a null ref, silently swallowed. Sibling `CouncilToggle.tsx` uses `requestAnimationFrame` (defers past React's commit phase). (b) **No test asserts focus actually lands** — the existing escape test dispatches `keyDown(listbox, ...)` which works regardless of focus location, masking the contract. (c) Symptom-of-(a): if focus didn't land, a Space keypress hits `<body>` instead of the listbox → browser default Space = page scroll → user perceives "dropdown ignores Space + page jumps."

**Consequence:** Keyboard user opens dropdown → visual state says "open" → arrow/Space keys silently dispatch to wrong element. The aria-live verify-by-absence canary catches one regression class; the focus-landing canary is missing entirely.

**Fix:** Swap `queueMicrotask` → `requestAnimationFrame` to match codebase precedent and defer past React's commit. Add a behavioural assertion in `ModelSwitcher.test.tsx`: after `fireEvent.click(trigger)`, `await waitFor(() => expect(listbox).toHaveFocus())`. Once focus is deterministic, Space activation is correct by construction.

---

### 4. EC-22 structured-log emit-path coverage NOT delivered — PLAN watchpoint missed

| | |
|---|---|
| **File** | `web/server/anthropic-models-cache.test.ts` — zero `log.info`/`log.warn` spy assertions across 55 tests |
| **Council** | Beck × Carmack — Behavioural emit-path assertions (Principle 11) |
| **Ref** | `references/quality-testing.md` → Mutation resistance + EC-22 |

**Finding:** `grep "log\.\|event:"` against `anthropic-models-cache.test.ts` returns zero hits. The source emits 10 distinct structured events (`anthropic-models.{no-key, cache.hit.memory, cache.hit.disk, cache.miss, upstream.success, upstream.auth-failed, upstream.unavailable, upstream.parse-failed, stale-served, cache.write-failed, pagination-needed}`). None are asserted to fire. The PLAN's "Risks & Watchpoints" section explicitly demanded these tests; the implementation log claimed coverage; the actual assertions are missing.

**Consequence:** Future refactor that renames `event: "anthropic-models.cache.hit"` → `event: "anthropic.cache.hit"` silently breaks operator forensic-triage and every dashboard/log search built on those names. Same gap as `feedback_council_documented_contract_canary` — JSDoc + plan invariants are doku, not enforcement. Type-system check on `event` string is absent (string literal); a one-character typo ships green.

**Fix:** Add `vi.spyOn(log, "info")` + `vi.spyOn(log, "warn")` per outcome branch (~10 tests). Assert each event-name fires with the expected `event` string + `key_fingerprint` field shape. ~80 LOC test addition; pattern proven elsewhere in the codebase.

---

### 5. Disk-cache subsystem behaviourally unrendered

| | |
|---|---|
| **File** | `web/server/anthropic-models-cache.test.ts` — no direct tests of `writeDiskCache` / `readDiskCache` outcomes |
| **Council** | Beck × Carmack — Risk-calibrated coverage (Principle 4); cross-ref Persistence lane |
| **Ref** | `references/quality-testing.md` → Risk-calibrated coverage |

**Finding:** The PLAN's own verdict named "Persistence-FS combined with Hunt — cache invalidation predicate is the load-bearing correctness invariant" as the most critical expert domain. Yet ~25 tests target the pure parser (low-risk, easy to reason about) while ZERO directly cover: cold-start disk hit returning `source: "disk"` + warming memory, upstream-5xx + disk-stale-beyond-ceiling returning stale instead of 502 (the Backend R2 / Persistence R3 "availability beats freshness" invariant), schema_version mismatch on disk → cache-miss + re-fetch (NOT silent migration), fingerprint mismatch on disk → cache-miss persists across restart, `has_more: true` upstream → `pagination-needed` log canary, defensive runtime assertion that disk payload contains no raw key bytes.

**Consequence:** Risk-calibrated coverage inverted. The cache's documented load-bearing contract (stale-served-on-upstream-fail) ships green; a regression there is operator-invisible until the next Anthropic outage when users see static fallback instead of last-known-good. Reallocate: parser is over-tested for what it does.

**Fix:** Six new tests, behavioural (mock `readFileSync` + `writeAtomicJson` via existing seam, OR use a temp `COMPANION_HOME` override): cold-start disk hit, stale-served on 5xx, schema mismatch → miss, fingerprint mismatch → miss across simulated restart, `has_more: true` → log warn, payload-contains-key-suffix assertion fires.

---

### 6. HomePage rewrite weakened consumer-contract assertion

| | |
|---|---|
| **File** | `web/src/components/HomePage.test.tsx:964-994` (rewritten "renders dynamic models from the settings-slice when populated") |
| **Council** | Beck × Carmack — Specific desideratum (Principle 11) |
| **Ref** | `references/quality-testing.md` → "Specific" desideratum + `feedback_verify_test_bodies_not_just_names` |

**Finding:** The deleted test `"fetches dynamic models for codex backend"` asserted the lifecycle wiring — that `mockApi.getBackendModels` was called and produced "GPT Custom" which then rendered. The new test mutates `mockStoreState.dynamicBackendModels` directly and asserts the label renders. The lifecycle assertion is gone. The mock `loadBackendModels: vi.fn(async () => undefined)` exists in `mockStoreState` but is never asserted-called. A regression that drops the `useEffect(() => { void loadBackendModels(backend); }, [backend])` at HomePage.tsx:271-273 (e.g., refactor lifting load to a global App effect) passes this test silently with the slice pre-warmed.

**Consequence:** The new test pins a render snapshot, not a behaviour. The settings-slice tests prove the action's lifecycle; the consumer-contract (HomePage actually invokes it on mount + backend-switch) is now unowned across the suite. The two together are NOT equivalent to the one deleted test.

**Fix:** Add to the rewritten test: `expect(mockStoreState.loadBackendModels).toHaveBeenCalledWith("codex")` after mount completes. One assertion, restores the lifecycle pin.

---

### 7. `pickIcon` position-dependent fallback regresses Codex icon stability on response reorder

| | |
|---|---|
| **File** | `web/src/utils/backends.ts:23-34` (`pickIcon`) + `web/src/components/ModelSwitcher.tsx:53` (icon flows through `toModelOptions`) |
| **Council** | React/Web UI × Carmack — Stable identity invariant (Principle 2) |
| **Ref** | `references/quality-frontend.md` → Principle 2 (eliminate state that can be derived, keep stable) |

**Finding:** `pickIcon(slug, index)` is invoked for BOTH backends via the AP-14 single converter `toModelOptions`. For Codex slugs that don't match the substring map (`gpt-5.2` has no `codex`/`max`/`mini` hit), the fallback is `["◆", "●", "◕", "✦"][index % 4]`. The `index` is the upstream array position — silent, no test catches it. If the cache is partially refreshed and the response now has 6 items instead of 5, `gpt-5.2` may land at index 3 today and index 4 tomorrow, flipping `●` → `✦` for the same slug. The icon is supposed to be a type marker (mini/max/codex), not a position marker. The Claude branch escapes (`return ""` unconditionally) — but the Codex contract is now position-dependent.

**Consequence:** Stable-identity invariant breaks on the next Codex CLI cache refresh that reorders entries. Users see icon jitter; no warning, no test guard. The PR introduced the Claude-icon-less branch without auditing the existing position-dependent fallback.

**Fix:** Either hash the slug into the fallback set (`fallback[hash(slug) % fallback.length]`) so identity is content-derived, OR drop the fallback entirely (return `""` for unrecognised slugs — already the pattern this PR establishes for Claude). One-liner; the second option is more honest about the lack of tier semantics.

---

## P2 — Fix Soon

### 8. Parent directory mode 0o700 dropped from PLAN Task 4 implementation

| | |
|---|---|
| **File** | `web/server/atomic-write.ts:24-25` (`mkdirSync(dir, { recursive: true })` — no mode) — affects new cache file inheritance |
| **Council** | Persistence × Hunt × Carmack — Sentinel discipline + minimise state side-channels |
| **Ref** | `references/quality-persistence.md` → Principle 3 (close every state); `references/security.md` → Principle 3 |

**Finding:** PLAN Task 4 explicitly named "File mode `0o600`, parent dir `0o700`." File mode is inherited correctly from `writeAtomicJson` (O_CREAT with 0o600 at line 43). Parent dir mode is NOT set — `mkdirSync(dir, { recursive: true })` creates with `0o777 & ~umask`, typically 0o755 (world-readable). On a shared host, `ls -la ~/.companion/` reveals `anthropic_models_cache.json` exists. While the cache file itself is unreadable, the filename + mtime disclose that an Anthropic key is configured and approximately when the user last opened a session. Same leak applies transitively to `~/.companion/envs/` and council artifacts.

**Fix:** Add `mode: 0o700` to `mkdirSync` in `atomic-write.ts:25`. The chmod path is necessary because mkdir mode is umask-masked — pair with a one-shot `chmodSync(COMPANION_HOME, 0o700)` on module load to retrofit existing installs. Touches all writers (env profiles, council artifacts) which is the correct scope — same side-channel applies there.

---

### 9. Module-scope inflight-token can discard a successful late-resolving fetch in favour of an earlier-resolving failure

| | |
|---|---|
| **File** | `web/src/store/settings-slice.ts:144-240` (`loadBackendModels` action) |
| **Council** | Backend-TS × React/Web UI × Carmack — Async correctness (Principle 7) |
| **Ref** | `references/quality-backend.md` → Principle 7 (async correctness) |

**Finding:** Token counter increments per call; both success and error paths commit only when `inflightModelLoadTokens[backend] === myToken`. Race: Call A (token 1) starts a slow fetch. Call B (token 2) starts a fast fetch that REJECTS. B's rejection check `2 === 2` → commits status="rejected". A's slow SUCCESS arrives → check `1 !== 2` → result discarded. Net: slice ends in "rejected" with no data, even though one concurrent call returned a clean list. UI shows static fallback indefinitely until next manual reload.

**Consequence:** Transient network blip on a concurrent call inverts a successful fetch into a permanent-until-reload rejection. The "latest call wins" contract documented in the JSDoc actually means "latest-resolving call wins regardless of outcome" — a subtle leak that surfaces on flaky networks.

**Fix:** Don't flip status to "rejected" if a newer token is still pending — track the highest-tokened result and prefer success on ties. Minimum acceptable: a comment documenting the trade-off so the next reader knows it's intentional.

---

### 10. Wall-clock TTL predicate fails-open under negative clock skew

| | |
|---|---|
| **File** | `web/server/anthropic-models-cache.ts:762` (`if (now - r.fetched_at > ttlMs) return false`) |
| **Council** | Persistence × Carmack — Replay determinism (Principle 7) |
| **Ref** | `references/quality-persistence.md` → Principle 7 (clock not monotonic) |

**Finding:** Both `fetched_at` (write time) and `now` (read time) use `Date.now()`. If the host clock jumps backward (NTP correction after drift, VM resume from snapshot, developer laptop suspended for a week), `now - fetched_at` becomes negative → `> ttlMs` evaluates false → cache appears fresh. Worst case: 25h-old cache survives until wall-clock advances past `fetched_at + 24h` again. Stale models served as fresh.

**Fix:** Clamp at zero: `Math.max(0, now - fetched_at) > ttlMs`. Negative skew treated as zero-age; still bounded by ttlMs going forward. Document the choice in the predicate comment. Alternatively: detect `now < fetched_at - SKEW_TOLERANCE_MS` and force refetch.

---

### 11. `AbortSignal.any` silent demote drops parent cancellation

| | |
|---|---|
| **File** | `web/server/anthropic-models-cache.ts:597-602` (signal coalescing in `fetchAnthropicModelsRaw`) |
| **Council** | Backend-TS × Carmack — Resource lifecycle (Principle 5) |
| **Ref** | `references/quality-backend.md` → Principle 5 (resource management) |

**Finding:** `(AbortSignal as any).any?.([timeoutController.signal, deps.parentSignal]) ?? timeoutController.signal` — if `AbortSignal.any` is undefined at runtime, the fallback drops `parentSignal` silently. No log, no test exercises the missing-`any` branch. Bun 1.0+ and Node 20.3+ have it, so this is dormant — but a runtime downgrade or polyfill regression turns parent-cancel into a 5s tail of upstream traffic per cancelled request. Worst with the inflight lock active: a series of cancel-then-retry users all wait the timeout for the leader to give up before any progress.

**Fix:** Crash loudly on `AbortSignal.any === undefined` at module load (programmer-error-is-a-crash per Principle 1 — Bun has it; absence means wrong runtime), OR log `signal-coalesce-degraded` warn on the first occurrence and fall through. Current silent demote is the worst-of-both.

---

### 12. No-key footnote is non-clickable text — breaks 3-click rule to Settings

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx:263-267` |
| **Council** | Friedman × Carmack — Settings buried without clear path (Principle 7) |
| **Ref** | `references/quality-ux.md` → Principle 7 |

**Finding:** The footnote renders as plain `<div>` — no `<a>`, no `onClick`, no `cursor-pointer`. The word "Settings" reads like a navigation target but isn't one. New user with no API key has to remember the suggestion, close the dropdown, find the Settings entry in some other surface (sidebar / `#/settings` hash they don't know about), navigate there, scroll to the Anthropic section. Each step is a chance to lose the user.

**Fix:** Render as `<a href="#/settings">Add an API key in Settings to see more models.</a>` with `text-cc-primary hover:underline` + `onClick={() => setOpen(false)}` so the dropdown closes before navigation. 2 lines.

**Cross-ref a11y P2.1:** The footnote currently lives inside the `role="listbox"` container. Move it OUTSIDE the listbox div (but inside the dropdown wrapper) so SR doesn't iterate it as a phantom option — fix both issues in one edit.

---

### 13. ModelSwitcher does NOT call `loadBackendModels` on mount — JSDoc contradicts the code

| | |
|---|---|
| **File** | `web/src/components/ModelSwitcher.tsx` (no mount-fetch useEffect) vs `web/src/store/settings-slice.ts:130-133` (JSDoc claims concurrent caller) |
| **Council** | React/Web UI × Carmack — Stored state hygiene (Principle 2) |
| **Ref** | `references/quality-frontend.md` → Principle 2 |

**Finding:** The slice JSDoc names ModelSwitcher as one of the concurrent mount callers (`HomePage + CronManager + ModelSwitcher`); ModelSwitcher in fact never fires `loadBackendModels`. Today this works because every path to a ModelSwitcher goes through HomePage first (HomePage mounts → fetches → slice populated → ModelSwitcher reads). Recent "Continue in new session" feature (commit `3412955`) bypasses HomePage; a session restored from disk after server restart re-mounts ModelSwitcher without an intervening HomePage mount. Same issue.

**Fix:** Either add `useEffect(() => { void loadBackendModels(backendType); }, [backendType, loadBackendModels])` to ModelSwitcher (idempotent, server-side cache makes cost zero), OR hoist the fetch to a single `App.tsx` mount effect (one per backend per session) and update the JSDoc to reflect single-call ownership. The JSDoc/code disagreement is the canary — fix one of the two.

---

## P3 — Consider

### 14. Single-flight lock-released-on-reject invariant not tested

| | |
|---|---|
| **File** | `web/server/anthropic-models-cache.test.ts:557-590` (single-flight happy-path test only) |
| **Council** | Beck × Carmack — Mutation resistance |

The existing test asserts N concurrent → 1 upstream call → all resolve ok. The `finally`-delete in `inflightFetches` is what guarantees a FAILED batch doesn't pin subsequent requests to a dead promise. No test covers: "N concurrent → upstream rejects → next request re-fetches." A refactor moving `inflightFetches.delete` outside `finally` (e.g., success-only branch) goes green. Add one test: after a single-flight rejection, a subsequent `getAnthropicModels` call must observe the cleared lock and retry the fetch.

---

### 15. Fixture lacks coverage for hostile-input reject branches

| | |
|---|---|
| **File** | `web/server/fixtures/anthropic-models-response.json` + `web/server/anthropic-models-cache.test.ts` |
| **Council** | Persistence × Realtime — EC-6 replay protective value |

The fixture exercises 4 valid + 1 `model_snapshot` reject + 1 non-claude reject. Does NOT exercise: bidi control in `display_name` (Trojan-Source defence in `isBoundedSafeString`), length-cap overflow on `id`/`display_name`, ambiguous `created_at` (e.g., `Date.parse("January 15")` returns clock-injected year). The whole point of `isBoundedSafeString` rests on rejecting these — yet no fixture entry exercises the reject path on-wire. Add a sibling fixture (or extend) with adversarial entries, one per reject branch, and assert each lands in `droppedItems` for the expected reason. Document the line → reject-reason map in `fixtures/README.md`.

---

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---------|----------|---------|------------|
| 1 | Sticky `anthropicModel` dropped at switchBackend | P1 | Friedman | ~20 LOC + slice ext (1-2h) |
| 2 | Click-outside doesn't restore trigger focus | P1 | a11y | ~10 LOC |
| 3 | `queueMicrotask` autofocus race + Space interlocked | P1 | a11y | ~5 LOC + 1 test |
| 4 | EC-22 emit-path coverage missing (10 events) | P1 | Beck | ~80 LOC test |
| 5 | Disk-cache subsystem behaviourally unrendered | P1 | Beck | ~100 LOC test |
| 6 | HomePage rewrite dropped lifecycle assertion | P1 | Beck | 1 assertion |
| 7 | `pickIcon` Codex stable-identity regression | P1 | React/Web UI | ~3 LOC |
| 8 | Parent dir 0o700 not set | P2 | Persistence × Hunt | ~3 LOC |
| 9 | Inflight token clobbers slower success | P2 | Backend-TS × React | ~10 LOC |
| 10 | TTL fails-open under negative clock skew | P2 | Persistence | 1 LOC |
| 11 | `AbortSignal.any` silent demote | P2 | Backend-TS | ~5 LOC |
| 12 | No-key footnote not clickable + inside listbox | P2 | Friedman × a11y | ~5 LOC |
| 13 | ModelSwitcher missing `loadBackendModels` mount | P2 | React/Web UI | ~5 LOC or JSDoc fix |
| 14 | Single-flight reject-clears-lock invariant untested | P3 | Beck | 1 test |
| 15 | Fixture lacks hostile-input reject coverage | P3 | Persistence × Realtime | +1 fixture |

## Verdict

**Ship after fixing P1 cluster — particularly #1 and #4-6.** The PR is structurally tight on the backend axes (resource discipline, body-drain, single-flight, EC-9/21/23 log shape, atomic write, fingerprint-as-sentinel, EC-7 realpath) and the parser/sort/keyboard model are excellent. Convention floor honored; PLAN watchpoints addressed except where called out below.

The single most important finding is **#1 sticky preference dropped at switchBackend** — the PLAN's "Risks & Watchpoints" section explicitly required the test, the test was written, the helper exists, but no production caller passes the argument. This is the canonical `feedback_call_site_presence_not_just_symbol_export` shape: symbol exists, test asserts contract, production never reaches it. User-visible trust regression for any operator with a saved preference. Either finish the wire (~20 LOC + slice extension) or remove the dead arg from the helper signature so the contract isn't lying.

**Council member whose domain is most critical right now: Beck.** Three P1 test-coverage gaps (#4 EC-22, #5 disk subsystem, #6 HomePage lifecycle) mean the PR's load-bearing correctness contracts (structured-log forensic triage, stale-served-on-upstream-fail availability invariant, consumer-mount-fetch wiring) ship green on a test suite that doesn't actually verify them. Risk-calibrated coverage is inverted — heavy parser tests vs zero disk-cache behavioural tests. This is the gap that ships hidden regressions across the next quarter. Reallocate: parser is over-tested for what it does.

**Persistence-FS is the second-most-critical domain.** P2-1 (parent dir 0o700) is a direct PLAN drop with a real operator-metadata side channel. P2 wall-clock skew is realistic on developer laptops + cloud VMs. Together they're cheap one-line fixes that close the floor.

The a11y P1 cluster (#2 #3) all roots in focus contract incompleteness — APG keyboard MODEL is correct, focus PLUMBING slipped through. Once focus deterministically lands on the listbox AND returns to the trigger on all dismissal paths, the keyboard story is solid.

Friedman's P1 #1 + the 4 P2s constitute the "user-visible UX trust" axis — addressing them transforms the PR from "works mechanically" to "actually trust-preserving for users who pinned a preference or rely on discoverability."

Subprocess and Realtime lanes returned clean (no P1/P2) — the hold-the-line against probe-spawn temptation held; the parser-boundary discipline is solid. Hunt and Fowler P3-only — convention floor honored, no security or structural surprises.

---

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key Areas |
|--------|----|----|----|-------|-----------|
| Hunt (Security) | 0 | 0 | 3 | 3 | Convention floor honored — no findings escalated to FINAL |
| Fowler (Refactoring) | 0 | 0 | 3 | 3 | 1221 LOC justified by AP-3 — no findings escalated |
| Bun/Hono/TS Backend | 0 | 2 | 0 | 2 | Inflight clobber, AbortSignal.any demote |
| FS-JSON Persistence | 0 | 2 | 1 | 3 | Parent dir mode, clock skew, fixture coverage |
| Realtime/NDJSON | 0 | 0 | 1 | 1 | Fixture coverage (cross-ref Persistence) |
| Subprocess Lifecycle | 0 | 0 | 0 | 0 | Hold-the-line verified — no findings |
| React/Web UI | 2 | 1 | 0 | 3 | pickIcon, ModelSwitcher mount, (sticky cross-ref Friedman) |
| a11y Auditor | 2 | 1 | 0 | 3 | Focus restoration, queueMicrotask race, footnote-in-listbox |
| Saarinen (UI Quality) | 0 | 0 | 0 | 0 | Convention drift findings not escalated to FINAL |
| Friedman (UX Quality) | 1 | 1 | 0 | 2 | Sticky preference, footnote clickability |
| Willison (LLM Pipeline) | 0 | 0 | 0 | 0 | Convention floor honored — no findings escalated |
| Beck (Test Quality) | 3 | 0 | 1 | 4 | EC-22 coverage, disk-cache subsystem, HomePage lifecycle, single-flight reject |
| Docker/GHA Deploy | – | – | – | – | NOT DISPATCHED — no Dockerfile/workflow changes in PR |
| **TOTAL** | **7** | **6** | **2** | **15** | Within 15-finding cap |

**Review output written to:** `.council/review-output/2026-06-04-0823/FINAL-REVIEW.md`

**Expert output files:**
- Hunt: `.council/review-output/2026-06-04-0823/hunt.md`
- Fowler: `.council/review-output/2026-06-04-0823/fowler.md`
- Bun/Hono/TS: `.council/review-output/2026-06-04-0823/backend-ts.md`
- FS-JSON: `.council/review-output/2026-06-04-0823/persistence.md`
- Realtime/NDJSON: `.council/review-output/2026-06-04-0823/realtime.md`
- Subprocess: `.council/review-output/2026-06-04-0823/subprocess.md`
- React/Web UI: `.council/review-output/2026-06-04-0823/react-ui.md`
- a11y: `.council/review-output/2026-06-04-0823/a11y.md`
- Saarinen: `.council/review-output/2026-06-04-0823/saarinen.md`
- Friedman: `.council/review-output/2026-06-04-0823/friedman.md`
- Willison: `.council/review-output/2026-06-04-0823/willison.md`
- Beck: `.council/review-output/2026-06-04-0823/beck.md`
