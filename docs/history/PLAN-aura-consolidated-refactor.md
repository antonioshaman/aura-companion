# Council Plan (Aura): Consolidated Refactor + UX Spec ("Aura 2.0" meta-spec)

**Scope:** Single audited spec covering ALL outstanding work threads — unfixed P1 findings from Council Review 2026-05-12-2211, PR #7 partial-pair restart completion, Settings/Codex UI auth bug, Claude MAX 20x package auth verification, systematic UI/UX improvements, upstream 0.95.0 sync, and refactor opportunities (identify, do NOT execute beyond what the P1 fixes structurally require).

**Context:** Aura Companion has shipped Council Mode (paired orchestrator + observer) across 5 PRs (#2, #4, #5, #8, #10) plus rebrand + 1.2.1 release. Remaining open work mixes correctness fixes (pendingCouncilCall race, deriveSideEffects untested, PR #7 conflicted) with feature surfacing (Codex auth UI bug, MAX 20x verification) and structural debt (session-orchestrator.ts at 1959 lines, SettingsPage.tsx at 1070 lines). This plan ships as spec only — implementation is deferred to subsequent PRs grouped by reviewability block.

**Boundaries:**
- ✅ Identify all outstanding work + sequencing + risk attribution
- 🚫 Execute the refactor (spec only)
- 🚫 New features beyond the P1 backlog + the explicit scope items
- 🚫 Touch `Playground.tsx` or `HomePage.tsx` structurally — both stable, both contracted by CLAUDE.md
- 🚫 Decompose `ws-bridge.ts` — explicitly deferred fear-zone, future separate PR

**Council dispatched (12):** Hunt (12 recs), Fowler (8), Bun/Hono/TS Backend (10), FS-JSON Persistence (10), Realtime/NDJSON Protocol (9), Subprocess Lifecycle (9), React/Web UI (7), a11y Auditor (8), Saarinen (9), Friedman (12), Willison (8), Deploy (10). All 12 returned non-empty recommendations. Total ~112 recommendations synthesised into 16 sequenced tasks (15 originally + Task 15 split into 15a/15b per observer review v1).

---

## Task Sequence

### 1. `deriveSideEffects` keystone — pure-table regression tests

| | |
|---|---|
| **Domain** | Backend × Realtime × Fowler × Carmack — *Pure-function decision tables are exactly what to test directly* |
| **Ref** | `references/quality-backend.md` → Principle 8; `references/quality-realtime.md` → Principle 4; `references/refactoring.md` → Principle 7 |
| **Depends on** | — |

The AP-2 keystone — `deriveSideEffects(prev, next, event)` — decides which `group:*` bus events fire and which EC-9 logs land on each transition. Council review flagged zero direct unit coverage; every applyEvent correctness claim rests on integration happenstance today. **First step — grep both `web/server/group-state-machine.ts` AND `web/server/session-group-coordinator.ts` for the `deriveSideEffects` symbol to locate the canonical home before opening a test file.** CLAUDE.md's split-of-concerns documentation is ambiguous between "pure transition file" vs "coordinator-state-machine surface"; whichever module hosts the function is the test target. Then add table-driven tests enumerating the cartesian `(prev_status × event_type)` matrix, asserting BOTH the descriptor list AND (via a thin coordinator harness with captured bus) the actual `group_*` wire frames emitted. **Additionally assert sequence-number coverage as an acceptance criterion** (promoted from Risks v2): every `group_*` and `observer_review` emit MUST pass through the same `sequenceEvent` + `eventBuffer` path as `assistant`/`stream_event`, so reconnect-replay (`session_subscribe { last_seq }`) covers them; the table-driven test asserts each emitted descriptor carries a monotonic `seq` field of the expected type. `group_created` re-broadcast on `reconnect_ok` and synthetic-replay in `handleBrowserOpen` are expected duplicates — document the client-side dedup contract `(sessionGroupId, type)` for `group_created` + `(checkpointId, findings[].id)` for `observer_review`. Cross-ref: Realtime — same harness asserts broadcast ordering for synthetic-replay-vs-live-emit equivalence.

---

### 2. `pendingCouncilCall` race fix via explicit spawn-context plumbing

| | |
|---|---|
| **Domain** | Backend × Fowler × Carmack — *Async correctness — the event loop is not magic* |
| **Ref** | `references/quality-backend.md` → Principle 7; `references/refactoring.md` → Principle 3 (State is the primary source of bugs) |
| **Depends on** | Task 1 (deriveSideEffects tests catch any regression in side-effect emission during the refactor) |

The P1 race exists because `pendingCouncilCall` is an instance scalar mutated from multiple concurrent async entry points (two-tab `createCouncilGroup` races interleave their drains, second overwrites first's context). Fix structurally — extend `coordinator.createGroup(req, { spawnContext })` to plumb per-call context through the API into the injected SessionSpawner closure argument list, never via shared state. Apply same shape to `intentionalKills` if its mutation surface exceeds three sites. Pair with a concurrent-call test (`Promise.all` two creates with distinguishable spawn options) so the regression has a tripwire. Cross-ref: Hunt — passing argv through allowlisted helpers is required at the spawn site (EC-1 floor).

---

### 3. PR #7 partial-pair restart redo from current main + port coverage backfill

| | |
|---|---|
| **Domain** | Subprocess × Persistence × Hunt × Carmack — *Track PID, but never trust PID across reboots; identity binding must actually bind* |
| **Ref** | `references/quality-subprocess.md` → Principles 2, 4; `references/quality-persistence.md` → Principle 3 |
| **Depends on** | Task 1 (state-machine tests guard the redo), Task 2 (spawn-context plumbing changes the coordinator surface PR #7 must rebase onto) |

PR #7's existing branch has 16 conflict regions vs current main (post-rebrand + post-merges) — close it. Redo the fix from current main: when `reconcileCouncilGroups` detects a partial pair on restart, register the group in `active` then immediately `applyEvent({type: "half_died", role: deadRole})` so the state machine emits the standard `group:degraded` + EC-9 log entry (approach (b) from the FINAL-REVIEW). NO synthetic `__missing_*` placeholder sessionIds — they cannot ever bind to a real handshake by construction. Preserve EC-2: mark BOTH session ids intentional BEFORE either kill on the recover-failure paths. Port previously-pushed coverage tests (commit `25a27c4`, claimed 23 behavioural tests across coordinator + orchestrator). **Verification gate before porting** — implementer MUST: (i) `git cat-file -e 25a27c4` to confirm the commit exists on a reachable ref (it may have been garbage-collected if PR #7 was closed without merge), (ii) `git show 25a27c4 --stat` to verify test files match the claim, (iii) `git show 25a27c4 -- web/server/session-orchestrator.test.ts web/server/session-group-coordinator.test.ts` and grep each `it(...)` block for non-trivial assertions (no empty bodies, no vacuous `expect(true).toBe(true)` per `feedback_verify_test_bodies_not_just_names`), (iv) cherry-pick onto a throwaway branch from current main, run `cd web && bun run test -- --coverage --coverage.reporter=json-summary` and confirm both files land ≥80% on the post-merge file shape (gate is on current shape, not pre-PR-#7 shape). Only then port.

---

### 4. Reconcile-on-initialize: rebuild in-memory derived state + init-scan FS watchers

| | |
|---|---|
| **Domain** | Persistence × Backend × Carmack — *In-memory derived state populated only inside one event handler is lost on restart* |
| **Ref** | `references/quality-persistence.md` → Principle 3; `references/quality-backend.md` → Principle 5 |
| **Depends on** | Task 3 (partial-pair redo provides the reconcile-action contract) |

PR #7's `state.sessionGroupId` persists across restart, but the in-memory coordinator map, `councilWatchers`, and derived role are populated only inside `createCouncilGroup` event handlers — survivors aren't rejoined to their coordinator and watchers don't re-arm. Add an explicit reconcile pass in `session-orchestrator.initialize()` that iterates persisted sessions with `sessionGroupId`, rebuilds coordinator group records, classifies pair-state, and re-arms `councilWatchers` for live groups. `fs.watch` is event-only and does NOT replay existing files on attach — `watchCheckpoints`/`watchReviews` re-arming must immediately readdir + stat the dirs and feed each unseen `(file, mtimeNs)` through the EC-4-keyed pipeline so any checkpoint written during downtime reaches the in-memory findings store. Idempotent — re-running reconcile produces same map; skip-and-log partial entries. **Acceptance criterion for idempotent state transitions** (promoted from Risks v2): every reconcile-driven state mutation function MUST be safe to call twice — `markGroupDegraded(id)` called by both the reconnect-grace expiry path AND the cascading-second-half-death path MUST produce identical disk state. No counter increments inside a state setter; no list-append where set-membership is what's meant. Test: invoke each transition function twice with the same arguments under a concurrent-signal harness, assert byte-identical persisted JSON and identical EC-9 log emission count. Cross-ref: Backend — listener dispose-before-reattach in `initialize()` to prevent fanout amplification on re-entry. Cross-ref: Persistence — `writeAtomicJson` already enforces all-or-nothing on disk; idempotency closes the in-memory ↔ on-disk race that atomic writes alone don't.

---

### 5. Settings/Codex UI auth bug — diagnose via runtime artifact + integration test

| | |
|---|---|
| **Domain** | React/Web UI × Friedman × a11y × Saarinen — *Diagnose runtime, not source; the input renders unconditionally* |
| **Ref** | `references/quality-frontend.md` → Principle 4 + Principle 10; `references/quality-ux.md` → Principle 4 |
| **Depends on** | — |

Code at `SettingsPage.tsx:622-643` renders the OpenAI key input unconditionally; user-reported "не могу выбрать" maps to **four** runtime hypotheses, each needing a distinct verification path because no single RTL test can disambiguate them all: (a) **running build older than disk source** — invisible to RTL by construction (it always mounts disk source), needs runtime check at the live failing browser: `ss -tlnp` to find listening pid + start time, compare against the latest commit on disk; verify the served JS bundle hash contains the literal string "OpenAI API Key (Codex)"; (b) **IntersectionObserver re-attach race on `loading` flip** — `SettingsPage.tsx:118` re-creates the observer whenever the `loading` dependency flips, racing section-ref population on the same tick; disambiguated by integration test mounting SettingsPage, clicking "Providers" nav, asserting OpenAI input is in viewport; (c) **ancestor overflow-y locks scroll position** — `contentRef` carries the intended `overflow-y-auto` at line 315 but ancestors of `contentRef` are uninspected from this file alone; invisible to jsdom (no scroll containment impl), needs Playwright/agent-browser test against the running dev server; (e) **masked-value React control input race** — `SettingsPage.tsx:633` reads `value={openaiApiKeyConfigured && !openaiKeyFocused && !openaiApiKey ? "••••••••••••••••" : openaiApiKey}`; if the focus event fails to fire (mobile webview quirks, CSS `pointer-events` on ancestor, overlay z-index intercepting the click), the input stays in masked-display mode and user-typed chars append AFTER the dots into `openaiApiKey` state, saving "••••••••••••••••a" silently. Runtime check: DevTools observe `openaiKeyFocused` state on click; type "a" and read `openaiApiKey` state. Step 1 of Task 5: live-environment runtime check covers (a), (b), (c), (e) by direct DevTools/network/source inspection and tells the implementer which one to commit to before writing any test. Step 2: write the disambiguating test for the actual cause. **Hypothesis (d) — stale preflight-probe cache — retired by observer review on commit `fc25af8` (post-PR-#17):** `web/server/preflight-probe.ts` exists + is tested but is NEVER CALLED FROM PRODUCTION CODE; frontend `HomePage.tsx:127-133` derives `codexAvailable` live from the `backends` array every render with no cache. There is no cache to be stale, so (d) cannot apply. Separate backlog: `preflight-probe.ts` is unwired exported code — either wire (per its module docstring) or delete (YAGNI). Cross-ref: a11y — section nav must use real `<button>`/`<a href>` (not `<div onClick>`), participate in DOM tab order, move focus to first interactive on activation. Cross-ref: Friedman — the IA fix in Task 8 is the durable answer once the active defect is closed.

---

### 6. SettingsPage targeted split + settings-slice (Zustand) for server-authoritative facts

| | |
|---|---|
| **Domain** | React/Web UI × Fowler × Carmack — *Slice cohesion, single write path; refactor only sections actively edited* |
| **Ref** | `references/quality-frontend.md` → Principle 2 + Principle 4; `references/refactoring.md` → Principle 1 (economic test) + Principle 5 (anti-speculative-generality) |
| **Depends on** | Task 5 (Codex bug must be closed before structural moves around the Providers section) |

`SettingsPage.tsx` is 1070 lines with ~25 `useState`s including server-authoritative flags (`claudeCodeTokenConfigured`, `openaiApiKeyConfigured`, `aiValidation*`). Create `store/settings-slice.ts` with one `hydrateSettings()` action on app boot + narrow selectors per field; transient form draft state stays component-local. Extract ONLY the Providers section (Codex bug lives there) + any section the Claude MAX 20x verification touches into `components/settings/<Section>.tsx`, each wrapped in `SectionErrorBoundary` — leave Profile/QR/Notifications/AI-Validator/Auto-Renaming inline. Selectors must be narrow (never expose whole settings object) to prevent render storms on the Council pairing-availability gate consumer. Cross-ref: Fowler — do not pre-split all seven sections "for consistency"; that's speculative-generality with no near-term payoff.

---

### 7. Claude MAX 20x auth tier verification — server-side probe with explicit knowable/unknowable bounds

| | |
|---|---|
| **Domain** | Subprocess × Backend × Realtime × Willison × Friedman × Hunt — *Verify what the API exposes, surface what you can't infer* |
| **Ref** | `references/quality-subprocess.md` → Principles 1, 7; `references/quality-backend.md` → Principle 6; `references/quality-llm.md` → Principle 10 |
| **Depends on** | Task 6 (settings-slice provides the cache slot for the verified-tier result) |

Implement as one-shot server-side fetch (Anthropic OAuth token introspection or `/v1/me`-equivalent) with cached result + explicit TTL, surfaced as REST `POST /api/auth/verify-claude-tier`. Pick the wire shape upfront — REST (NOT a `control_request` subtype): the call is request/response, not server-pushed; using REST avoids inventing a timeout-reaper for a new control flow and keeps `ws.ts` as the streaming-only channel. Document scope clearly: probe establishes `{tier, plan, daily_limit}` only — never infer Opus availability or token allotment from model-listing heuristics (would create a false-positive trust signal when Anthropic changes gating). Surface three discrete UI states: verified-MAX-20x, verified-other-tier, unknown. Cross-ref: Subprocess — if option A (spawn `claude --print --version-and-account-info`) ever revisited, mandate dedicated ephemeral-spawn channel excluded from idle-kill/auto-relaunch/sessions map. Cross-ref: Hunt — env vars (`ANTHROPIC_API_BASE_URL`) runtime-only, never Dockerfile `ENV`. Cross-ref: Friedman — verify-on-demand from Providers card, never on session start; cache shown with relative timestamp + re-verify affordance. **Acceptance criterion: preflight-probe cache invalidation** (promoted from Risks v2) — Task 7 ships a `POST /api/preflight/invalidate` endpoint called by the Settings UI when the user saves Codex credentials or hits "Re-verify", PLUS lazy revalidation on the first `claude+codex` pairing attempt where the in-memory cache says "no Codex" (re-run `which codex && codex --version` once before failing the pairing). Document that cache TTL is "until invalidated"; the lazy path is the only freshness guarantee. Both subprocess invocations use the same exit/timeout/stdio discipline as the MAX 20x probe channel.

---

### 8. UX systemic — Settings IA + ObserverPanel 3-tier mental model + degraded recoverability

| | |
|---|---|
| **Domain** | Friedman × Saarinen × Carmack — *Structure complexity, don't simplify it away; design all five screen states* |
| **Ref** | `references/quality-ux.md` → Principles 1, 2, 4, 9 |
| **Depends on** | Task 6 (settings-slice and section split create the seams), Task 7 (MAX 20x verification surface lands inside the new Providers card design) |

Three convergent UX fixes that share design vocabulary: (a) **Settings IA** — left-rail or sticky-top section navigator with first-class Providers entry + status glyph ("Claude: connected · Codex: not configured"); progressive disclosure for advanced sections (Notifications, AI Validator, Auto-Renaming collapse by default); Providers section uses provider-card pattern with status pill + "Add credentials" primary CTA, not bare password inputs. (b) **ObserverPanel** — collapse the 7-state machine into 3 user-facing tiers (Acting: blocker-found/degraded; Working: reviewing/reconnecting/spawning; Idle: sleeping/never-checkpointed); underlying states stay accurate for telemetry. (c) **Degraded recoverability** — show which half is alive + clear next moves ("Restart observer" / "Convert to solo" / "Archive group"), never a dead-end yellow banner. BlockerBanner destructive action labelled with consequence ("Dismiss STOP — continue without fix"), never generic "Resolve."

---

### 9. Visual UI tokens consolidation + elevation ladder + Playground mirror

| | |
|---|---|
| **Domain** | Saarinen × Carmack — *Tokens before surfaces; design system before features* |
| **Ref** | `references/quality-ui.md` → Principles 2, 3, 4, 5, 6, 8, 9 |
| **Depends on** | Task 8 (IA changes drive token usage; tokens must precede surface refactor) |

Land a single source-of-truth tokens file (Tailwind config + CSS variables, mirrored in Playground) declaring every `cc-*` role with documented contrast pairs and surface assignment. Add three explicit elevation levels (page / card / overlay = cc-surface-0/1/2) lifted by background lightness, not borders. Establish 4/8/16/24/32/40-48 spacing scale with "increase between groups, reduce within" applied at Settings cards. Lock typography to six-style scale (section-title / card-title / body / label / caption / mono). Build one StatusPill primitive serving all seven ObserverPanel states from `{label colour, dot colour, background}` token triple per state. Reserve fixed slot heights for BlockerBanner/PermissionBanner (permission-first stacking) and ObserverPanel header to prevent layout shifts. Single motion contract (150ms hover, 200ms state change, non-blocking). Every refactored surface added to Playground in all states (idle / hover / focus / loading / success / error / empty) per CLAUDE.md contract.

---

### 10. a11y systemic floor — behavioural tests + landmarks + reduced-motion + 44×44

| | |
|---|---|
| **Domain** | a11y Auditor × Carmack — *Axe is a floor, not a ceiling; behaviour over decoration* |
| **Ref** | `references/quality-a11y.md` → Principles 1, 2, 3, 4, 5, 7, 8 |
| **Depends on** | Task 5 (Settings keyboard reachability), Task 8 (ObserverPanel state announcements), Task 9 (motion-contract integration with prefers-reduced-motion) |

Three-part component test floor for every new component: (1) `toHaveNoViolations()` on initial AND each state branch (loading, error, populated), (2) keyboard-activation via `userEvent.tab()` + `userEvent.keyboard('{Enter}')`, NOT `fireEvent.click`, (3) role-and-name assertion via `getByRole('button', { name: /add codex key/i })`. Settings section nav uses real interactives + DOM tab order + focus moves to section's first interactive on activation. ObserverPanel state pill uses `role="status" aria-live="polite" aria-atomic="true"` (whole-pill re-read on transition); FindingsLog stays `role="log" aria-live="polite" aria-atomic="false"` (incremental). Gate state-transition announcements on prior-state comparison, not mount, to prevent re-render spam. BlockerBanner moves focus to primary action on mount + returns focus on dismiss. ARIA landmarks: `<main>` ChatView, `<aside aria-label="Observer panel">` ObserverPanel, `<nav aria-label="Sessions">` Sidebar, `<nav aria-label="Settings sections">` Settings nav. Reduced-motion audit on every new + existing transition via matchMedia mock in tests. 44×44 tap target enforced on every new interactive (icon-only Dismiss/Refresh are common regressions).

---

### 11. Recordings redaction policy + secrets at rest

| | |
|---|---|
| **Domain** | Hunt × Persistence × Subprocess × Backend — *Verify at-disk, not at-source; redact at recorder boundary* |
| **Ref** | `references/security.md` → Principles 3, 5; `references/quality-persistence.md` → Principles 7, 10 |
| **Depends on** | — (precondition to MAX 20x landing — Task 7) |

Recordings under `~/.companion/recordings/*.jsonl` capture exact CLI/browser bytes including initial init frames with API keys, OAuth bearers, and orchestrator env injection. Define a redaction allowlist of patterns (`sk-...`, `Bearer ...`, `openai_api_key`, OAuth token JSON fields, `companion_auth_token`, `OPENAI_API_KEY`, the Claude MAX tier-verification payload). Apply redaction at write-time in `recorder.ts` using **format-aware logic** (per `feedback_format_transformation_validation`) — naive streaming regex over JSONL can span JSON escape sequences and produce unparseable lines. Pick one of two safe shapes: **(i) parse-then-mutate-then-restringify** with an explicit `raw_sha256` sidecar field in the recording header preserving replay-integrity for replay tests that need exact-bytes invariance OR **(ii) streaming-regex with mandatory post-validate** — each redacted line must parse as JSON before write; lines that fail post-validate quarantine to `recordings/quarantine/<original-name>.failed.jsonl` with a log entry. Document which approach is chosen + the acceptance test (`cat -A` the recording, attempt `JSON.parse` per line, confirm both redaction landed AND every line still parses). Enforce `0600` file mode + `0700` dir mode at creation. Auth-probe spawns (MAX 20x verification, Codex smoke probe) excluded from recording entirely via `record: false` flag on spawn options. Verify with `cat -A` post-write, not source review (per `feedback_verify_runtime_argv_not_source`). Cross-ref: Subprocess — pass token via `env:` option on spawn, never argv (argv leaks via `ps`/`/proc`).

---

### 12. Schema versioning + durable storage migration to `~/.companion/sessions/`

| | |
|---|---|
| **Domain** | Persistence × Backend × Carmack — *Version every schema; rotation invariants bound storage without losing meaning* |
| **Ref** | `references/quality-persistence.md` → Principles 5, 8, 9 |
| **Depends on** | Task 3 (partial-pair redo changes session shape), Task 4 (reconcile must know which shape it's reading) |

Every persisted JSON family gets explicit `schemaVersion: N` integer + load-side validator with known-older migrations + loud-reject on unknown: `vibe-sessions/*.json`, `settings.json`, `.council/state/wake-*.json`, `.council/checkpoints/*.json`, recordings JSONL header. **Add `streamStatus: "streaming" | "complete" | "errored" | "interrupted"` field to persisted assistant messages** (was an orphan Risks bullet — promoted into this task because schema versioning is its natural home + the migration semantics are identical to other field additions): partial-pair restart and any server-restart-mid-stream race a stream-in-flight against process death; without an explicit status field, resume renders a truncated bubble as if complete, and downstream tool calls in the same session reference content the model never finished producing. Migration sets status to `interrupted` for any message that was the active streaming target at save time, `complete` otherwise. Replay test feeds a recording terminated mid-frame, asserts persisted message ends in `interrupted`. Migrate durable session state from `$TMPDIR/vibe-sessions/` to `~/.companion/sessions/` with one-shot best-effort copy on first boot of the new version — `$TMPDIR` wipes on reboot on most Linux distros, breaking partial-pair restart's durability contract; kills the cross-FS-rename atomic-write hazard at the same time. Bound `.council/checkpoints/` and `.council/reviews/` growth with explicit count-based or age-based cap per workspace; before deletion verify no in-flight watcher mid-debounce on that key. `writeAtomicJson` used for ALL new state introduced by P1 fixes + tier marker + settings mutations. Force-flush bypass for `group:exited`, `group:degraded`, council-checkpoint persistence, settings mutation, MAX tier result. `process.on("SIGTERM")` + `process.on("SIGINT")` flush all dirty sessions synchronously.

---

### 13. Protocol parser replay coverage + observer-review fixtures + drop telemetry

| | |
|---|---|
| **Domain** | Realtime × Willison × Subprocess × Carmack — *EC-6 extended to LLM-content parsers; switch-without-default defence* |
| **Ref** | `references/quality-realtime.md` → Principle 7; `references/quality-llm.md` → Principles 4, 7 |
| **Depends on** | — |

Capture a recording corpus on the current Codex/Claude CLI vintage BEFORE the 0.95.0 sync (Task 14): at least one recording per pairing + one with observer review JSON write. Replay through `claude-adapter`, `codex-envelope.parseCodexFrame`, and `parseObserverReview` post-sync; assert every line produces typed event OR tracked `onDropped(reason, frame)` — never silent drop, never throw. Add fixtures under `web/server/__fixtures__/observer-reviews/` exercising: STOP grounded in modifiedFiles, STOP with `evidence_path` outside delta (must downgrade), STOP with non-existent evidence (downgrade), claim with multi-word/unicode/control (validator-per-semantic-category), polymorphic-but-unknown extra fields (EC-5 tolerate), structurally malformed JSON (reject). Wire every drop site to structured `{event: "protocol.frame_dropped", backend, reason, methodOrType, sessionId}` so upstream drift is observable from the first frame. Stamp `claude --version` + `codex --version` into recording header + `SdkSessionInfo` at spawn time alongside `observerPromptSha256`. Cross-ref: pre-refactor inventory of every `switch (msg.type)` site (`ws.ts`, `claude-adapter`, `codex-adapter`, ws-bridge, browser-side reducers) — confirm default branch logs unknown, never throws.

---

### 14. Upstream sync 0.95.0 — quarantined merge + Codex smoke spawn + Dockerfile audit

| | |
|---|---|
| **Domain** | Backend × Subprocess × Deploy × Realtime × Friedman — *Merge as distinct phase, validate before resolving conflicts* |
| **Ref** | `references/quality-backend.md` → Principles 1, 10; `references/quality-subprocess.md` → Principles 5, 9; `references/quality-deploy.md` → Principles 1, 3, 7 |
| **Depends on** | Task 13 (replay corpus captured BEFORE merge), Task 4 (listener-reconcile fix in case sync touches `initialize()`) |

Capture two pre-merge baselines (`bun run typecheck` + `bun run test`): one on the merge-base, one on current `main` HEAD — these are the comparison points. Merge upstream into a topic branch; do **NOT** run typecheck/test on the unresolved tree (Git conflict markers `<<<<<<< / ======= / >>>>>>>` make `.ts` files syntactically invalid — typecheck/test would universally fail regardless of upstream's behavioural delta, producing a useless red "baseline" the implementer would silently skip). Resolve conflict file-by-file with per-file test re-run, comparing each file's result against the two captured baselines to isolate "upstream's regression" vs "fork's existing failure" vs "this conflict resolution introduced the break." Audit every new route upstream registers against the Hono auth middleware ordering — any registered before auth is an unprotected surface. Re-verify EC-9 log invariants via structured-log grep over a test session. Add Codex one-shot smoke spawn (non-interactive, gated on first emitted frame per `feedback_noninteractive_cli_handshake_emit_on_input`, exit clean) before flipping `claude+codex` pairing-available flag for the new version; smoke fail → surface version mismatch to UI, do not retry-on-resume-failure with new binary against old `cliSessionId`. Dockerfile diff: confirm `oven/bun:<X.Y.Z>` still satisfies engines, no new postinstall scripts beyond documented `core-js`/`protobufjs`, builder/runner stage split still prunes upstream devDeps. Triage upstream user-visible surface changes against five screen states before merge ships; upstream "ideal-only" UIs must get Aura blank/loading/partial/error states added before users encounter them.

---

### 15a. Security baseline — WS upgrade + IDOR floor + renderer trust + CSP

| | |
|---|---|
| **Domain** | Hunt × Backend — *Defence in depth at the request boundary* |
| **Ref** | `references/security.md` → Principles 1, 2, 4, 6, 7, 9 |
| **Depends on** | — |

Two convergent security correctness bundles in one reviewable PR (one expert lens — Hunt). **WS upgrade + IDOR floor:** bearer-token check at upgrade handler (not post-upgrade), `Origin` allowlist matching dev `:5174` + prod origin, reject `null`/cross-origin; shared `requireOwnedGroup(req, sessionGroupId)` + `requireOwnedSession(req, sessionId)` middleware applied to EVERY new route (checkpoint producer, MAX 20x verify, settings mutation, recording GET endpoints — recording filenames embed session id and are IDOR-prone); rate-limit on `/sessions/create`, `/sessions/create-stream`, council-pair spawn, MAX 20x verify per-token + per-origin token-bucket. **Renderer trust + CSP:** forbid `dangerouslySetInnerHTML` in council-rendering components; observer claim already JSX-escaped at BlockerBanner — extend contract to any new mirror; baseline `Content-Security-Policy: default-src 'self'; script-src 'self'; ...` forbidding `'unsafe-eval'`/`'unsafe-inline'` on script; X-Content-Type-Options/Referrer-Policy/Permissions-Policy headers; Zod-validate every Hono request body at boundary with discriminated unions on enum-shaped fields; shared `respondError(c, status, code)` helper returning `{error: <code>}` with NO stack/path/details, full error to structured log only.

---

### 15b. CI/Deploy hygiene bundle

| | |
|---|---|
| **Domain** | Deploy × Backend — *CI gates that actually fire; reproducible builds* |
| **Ref** | `references/quality-deploy.md` → Principles 3, 4, 5, 6, 7, 8 |
| **Depends on** | — |

Process/hygiene work, separate reviewable unit from 15a (different expert lens — Deploy, different blast radius). `/healthz` endpoint + Dockerfile HEALTHCHECK (NOT against `/` which 404s), bound to transport-liveness not protocol-readiness; `--frozen-lockfile` on all six workflows' `bun install`; husky `prepare` install verification as CI step (typecheck/test still runs even for un-husky'd PRs); pin exact every threshold-gated dev tool matching jscpd@4.0.9 precedent (vitest, vitest-axe, axe-core, c8, typescript); rename `Dockerfile.the-companion` → `Dockerfile.aura-companion` atomically with all references in workflows + scripts; SIGTERM teardown drains council watchers + auth-probe timers + session-store debounce within `docker stop` 10s window; decide Docker-publish posture upfront (re-enable to `antonioshaman/aura-companion` OR remove dead paths) — no limbo.

---

## Risks & Watchpoints

Expert-attributed risks that aren't tasks but need awareness during build.

- **Hunt — Stored XSS via observer findings:** If a future markdown renderer for findings is added, force `html: false` + DOMPurify on output; treat observer `evidence_path` as untrusted (no auto-linking without href sanitisation). Stored because findings persist in `.council/reviews/` + session JSON. Pair with @pair-hunt review on any FindingsLog enhancement.

- **Fowler — `ws-bridge.ts` deferred fear-zone:** Explicitly NOT in scope. Including it would mix refactoring with feature work in violation of Principle 8 and balloon scope. Future separate PR. Name in CLAUDE.md so next session doesn't pull it in under "while we're here" pressure.

- **Backend — Bus listener accumulation across `initialize()` re-entry:** `wireGroupListeners` attaches handlers to `companionBus`. If `initialize()` is called twice (test hot-reload, PR #7 redo's reconcile path, server-restart-without-process-exit), each `group:checkpoint` fires N handlers, fanout amplifies. Track attached listeners in `Set<() => void>` of detach functions; `initialize()` calls `disposeListeners()` first idempotently. Covered partly in Task 4 — flag here for vigilance.

- **React/Web UI — Wallclock-tick source for time-anchored panel state:** `deriveObserverPanelState` accepts `nowMs`; spawning/reviewing/reconnecting states depend on wallclock comparison. If panel re-renders only on store changes, `spawning` past its 30s deadline sits stale until unrelated update. Prefer server-driven state transitions via `group:*` events (derivation stays pure, time-axis server-authoritative) over client tick source.

- **a11y — `prefers-reduced-motion` test honoring:** vitest + jsdom does NOT honor reduced-motion by default. Tests must inject matchMedia mock to assert no-motion variant renders. Streaming token-cursor blink + council "spawning" loading indicator are most common WCAG 2.3.3 offenders.

- **Deploy — Coverage gate file-level cascade:** Large refactor PRs trip gate broadly. Sequence refactor commits in dedicated PRs ahead of feature commits — never mix `routes.ts`/`ws-bridge.ts` refactor with behaviour change in same PR. Run gate locally per PR before push. Reference `feedback_file_level_coverage_gate_cascade`.

- **Friedman — Tier mismatch reasoning visibility:** When MAX 20x verification doesn't match user expectation (paid for MAX but API reports Pro), show raw evidence + plain-language interpretation + "Report mismatch" link to Anthropic billing. Silent downgrade/hide kills trust in one screen.

---

## External Setup Required

| # | What | Why | Blocking task |
|---|------|-----|---------------|
| 1 | Generate npm token with **Bypass 2FA** enabled (already done in prior session) | Re-publish path stays open for follow-on `aura-companion@1.3.x` after meta-spec ships | Task 14 (upstream sync) → triggers release-please bump |
| 2 | Confirm Anthropic OAuth token introspection endpoint URL + response shape | Task 7 needs to know exactly which fields are knowable from the probe | Task 7 |
| 3 | Decide Docker-publish target (`antonioshaman/aura-companion` Docker Hub OR ghcr.io OR none) + corresponding `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` GHA secrets if pushing | Task 15 needs the posture decision before unblocking the workflow audit | Task 15 |
| 4 | Capture recording corpus of current Codex/Claude vintage BEFORE merging upstream 0.95.0 | Task 13 fixtures must predate the sync to detect drift | Task 13 (before Task 14) |
| 5 | Manual decision: re-introduce Docker publish workflow OR remove dead paths | Avoids orphan-asset supply-chain risk | Task 15 |

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | `deriveSideEffects` pure-table tests | Backend × Realtime × Fowler | — |
| 2 | `pendingCouncilCall` race fix via spawn-context plumbing | Backend × Fowler | 1 |
| 3 | PR #7 partial-pair restart redo + port coverage tests | Subprocess × Persistence × Hunt | 1, 2 |
| 4 | Reconcile-on-initialize + watcher init-scan | Persistence × Backend | 3 |
| 5 | Settings/Codex UI auth bug — runtime diagnose + integration test | React × Friedman × a11y × Saarinen | — |
| 6 | SettingsPage targeted split + settings-slice | React × Fowler | 5 |
| 7 | Claude MAX 20x auth tier verification REST + UI | Subprocess × Backend × Realtime × Willison × Friedman × Hunt | 6 |
| 8 | UX systemic — Settings IA + ObserverPanel 3-tier + degraded recovery | Friedman × Saarinen | 6, 7 |
| 9 | Visual tokens + elevation + Playground mirror | Saarinen | 8 |
| 10 | a11y systemic floor — behavioural tests + landmarks + reduced-motion | a11y Auditor | 5, 8, 9 |
| 11 | Recordings redaction policy + secrets at rest | Hunt × Persistence × Subprocess | — |
| 12 | Schema versioning + durable storage migration | Persistence × Backend | 3, 4 |
| 13 | Protocol parser replay corpus + drop telemetry | Realtime × Willison × Subprocess | — |
| 14 | Upstream sync 0.95.0 — quarantined merge + Codex smoke spawn | Backend × Subprocess × Deploy × Realtime × Friedman | 13, 4 |
| 15a | Security baseline — WS upgrade + IDOR + renderer trust + CSP | Hunt × Backend | — |
| 15b | CI/Deploy hygiene bundle | Deploy × Backend | — |

---

## Verdict

The structural keystone is `session-orchestrator.ts` — Task 3 (PR #7 redo) and Task 4 (reconcile-on-initialize) land inside it, and Tasks 1–2 build the test floor that makes those changes safely reviewable. **Start with Task 1** — pure-function table tests for `deriveSideEffects` are the cheapest high-leverage prerequisite in this entire spec; every subsequent council-lifecycle move sits on top of that safety net.

The Codex auth bug (Task 5) is independent of the council thread and should run in parallel — it's the highest-visibility user-reported defect and pure runtime diagnosis. The MAX 20x verification (Task 7) sequences naturally after the settings-slice + Codex bug close because both surfaces share the Providers card pattern Task 8 designs.

The block discipline (Fowler Principle 8) is **load-bearing**: each task is either correctness OR refactor, never both, AND each is a single expert lens per PR — Task 15 originally bundled security correctness with CI/Deploy hygiene; observer correctly flagged the self-contradiction so the spec now ships 15a (Hunt lens) + 15b (Deploy lens) as separate reviewable units. Pair `@pair-hunt` on Tasks 7, 11, 15a (secrets-touching surfaces). Pair `@pair-friedman` on Tasks 5, 6, 7, 8 (UX-load-bearing seams). `ws-bridge.ts` decomposition is explicitly NOT in scope and must remain so — naming the deferral is itself a structural decision per Fowler's Principle 8.

The meta-spec deliberately does **NOT** execute. Its job is to compress 112 council recommendations into 16 sequenced, attributed, dependency-graphed tasks so subsequent agents (or the same developer across multiple sessions) can pick up any task and know exactly which expert's reference doc to consult, which conventions floor applies, and which sibling tasks must land first. Cap the scope; trust the attribution; let the sequence do the work.

**Spec review history** lives in `.council/reviews/PLAN-aura-consolidated-refactor.review-log.md` (kept out of this file so the spec remains a stable artifact, not a negotiation transcript).
