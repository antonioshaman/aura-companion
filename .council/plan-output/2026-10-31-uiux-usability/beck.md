# Beck — test-first implementation plan

Planning only, 2026-10-31. Read the confirmed brief, `quality-testing.md`, applicable EC-39/41/42/46 conventions, current paired tests and narrow production paths. The catalog has no `beck/plan-aura.md`; this applies the actual Beck review testing reference to planning. No tests or browser/device scenarios were executed in this seat. PR449 is the accepted baseline; its navigation, PWA and SessionEditorPane fixes are retained.

The following are five recommendations, ordered by consequence. “Code-confirmed” means the unsafe branch is visible in current code, not that this seat executed a new reproduction. Each implementation task must first record the targeted test failing on unchanged code, then passing after the fix; assertion weakening, deleting prior tests, sleep-based race tests and source-string checks as the sole evidence are unacceptable (EC-42).

## 1. Preserve every distinct KB content version before removing a live row

**AC8; severity 4/4; heuristic: error prevention/recovery. Code-confirmed and independently reproduced in the accepted backlog report.** `web/server/knowledge/kb-store.ts:445–459` treats archived id membership as proof of identical content. OLD in archive + NEW live with the same id removes NEW without appending it. Existing `kb-store.test.ts:73` covers an identical half-completed move, which must remain valid.

**Minimal change:** distinguish identical archived payload from another version; remove a live payload only after its exact content has a durable archive copy. Preserve existing crash/idempotency guarantees. Do not prescribe a new public storage schema without the filesystem/security owners' decision.

**Red-first tests:** temporary directories and real filesystem implementation: archive OLD; restore same id with literal content `NEW`; archive again; assert OLD and NEW payloads both survive and only the selected live row disappears. Repeat the operation: byte-identical archive and no duplicate NEW. Keep raw malformed/unselected live lines byte-for-byte. Inject archive-write failure: NEW must remain live. Inject failure after durable archive before live replacement, retry: exactly one copy of each version. Verify contents, not only `archived`/`completed-partial` status.

**Dependency:** persistence owner fixes archive semantics before Diagnostics acceptance. The append-between-identity-check-and-rename window is a separate **hypothesis**: use a deterministic barrier and independent writer in a temporary directory to prove it before prescribing a writer protocol. A mocked callback that never performs a real append cannot establish cross-process safety.

## 2. Make report validation total and gate decisions at the actual apply boundary

**AC8/AC5; severity 3/4; heuristic: error prevention and visible recovery. Code-confirmed; accepted backlog contains reproductions.** `kb-analysis-store.ts:80–97` dereferences `s.signal` for `signals:[null]` and accepts incomplete findings; `diagnostics-routes.ts:60–69` checks `isRunning` before awaiting the request body, allowing analysis to start before apply.

**Minimal change:** validate the complete nested shape consumed by the card/decision path without throwing; malformed reports return `unavailable/report-invalid`. Recheck running immediately after body parsing and before the synchronous validate/apply sequence.

**Red-first tests:** in `kb-analysis-store.test.ts`, table of on-disk JSON mutations from a valid fixture: null signal, primitive signal, missing finding entry, malformed entry fields, null memory findings, malformed merge tasks, wrong finite timestamps where consumed. Assert an exact `report-invalid` result and no throw; preserve valid full report and schema-newer cases. Supplement with deterministic JSON-value corpus to establish totality, not a random nondeterministic fuzz-only gate. In `diagnostics-routes.test.ts`, defer body delivery, begin request while idle, set running=true, release body; expect 409 and zero apply/afterDecisions calls. Add idle happy path asserting actual recorded outcome; keep ordinary pre-existing busy coverage. API boundary mocks are appropriate for this timing test; report parsing uses real temporary files.

**Dependencies:** schema producer/consumer inventory by backend owner; total validation before UI card recovery checks. No new backend protocol is implied.

## 3. Give drafts explicit ownership across session and Home transitions

**AC2/AC7; severity 3/4; heuristic: user control/error prevention. Code-confirmed local-state risk; route-level reproduction still required.** `Composer.tsx:40` owns text locally without per-session text reset/storage, while `ChatView.tsx:327` renders it without a session key and `App.tsx:423` reuses ChatView. `HomePage.tsx:105,133–134` holds text/project/images locally and `App.tsx:427` keys Home by reset generation. These are distinct cases from PR449's stale launch-navigation fix.

**Minimal change:** define draft ownership per session and a Home draft for supported departures/returns. Prevent A's draft being sent to B; restore A on return. Explicit “start new with this draft” remains an intentional transfer. Do not claim a remount-only fix preserves drafts.

**Red-first tests:** first reproduce through the real App/ChatView navigation and real Zustand selectors, mocking network boundary only. Type `draft-A`, switch to B: B contains no A text and sending B never submits A; type `draft-B`, return A: exact A text restored. Home → supported page/session → Home restores text, selected project and attachment metadata without fabricating attachment upload success. Explicit discard/reset clears only the intended draft. Test failed launch/reconnect/background list updates without resetting input. Parameterize Claude/Codex; exercise intentional failure-banner transfer and server pickup draft once without overwriting a typed draft. Add focused `Composer.test.tsx` cases after proving the parent path, rather than claiming rerender alone proves routing. Playground includes affected chat states.

**Dependencies:** frontend owner establishes supported transitions and existing session ownership, then component/store implementation. No persistence across reload is promised until separately specified.

## 4. Keep CLAUDE.md save/load results attached to their originating edit

**AC2/AC5; severity 3/4; heuristic: error prevention/visibility. Code-confirmed.** `ClaudeMdEditor.tsx:26–47` applies any completed load; `:67–78` clears dirty after save even if text or selected file changed. Existing tests cover ordinary save/failure, not these orderings. PR449 fixed SessionEditorPane, which is precedent rather than an open duplicate.

**Minimal change:** scope load completion to current cwd/open generation and save completion to originating path/content revision; acknowledge only the saved revision. Avoid unsolicited reload overwriting newer text.

**Red-first tests in ClaudeMdEditor.test.tsx:** start load A, change cwd/open B, resolve B then A; only B appears. Save `first`, type `second` before completion; after success editor remains `second` and Unsaved remains visible; next Save sends `second`. Save A, select B/edit it, resolve or reject A; B's text/dirty/error state stays correct. Create-file save followed by reload must not erase a newer edit. Reject load/save: show actionable failure and preserve draft; retry success updates only the correct revision. Use explicit deferred promises, single mounted instance and scoped queries. Preserve existing discard-confirmation behavior.

**Dependency:** frontend owner chooses revision guard locally; reuse demonstrated SessionEditorPane behavior where appropriate without speculative abstraction.

## 5. Make Runs latest-request and failure states observable

**AC1/AC5/AC6; severity 2/4; heuristic: system-status visibility/consistency. Code-confirmed.** `RunsPage.tsx:63–77` allows old filter/poll responses to replace newer results; failures only log and fall through to `loading=false`, presenting an apparent empty or stale success. `RunsPage.test.tsx` already tests refreshed details; retain that baseline.

**Minimal change:** only the latest issued request for current filters may publish rows/total/error/loading; show initial failure with retry, and distinguish refresh failure while retaining prior rows. Provide a meaningful pending state when filters change.

**Red-first tests in RunsPage.test.tsx:** issue all-filter request A, select failed-filter B, resolve B with a named failed run then A with a named successful run: filter, rows and total still describe B. Repeat with stale A rejection after B success; no stale error. Reverse two same-filter polls to pin latest-issued semantics, not latest-resolving semantics (EC-41). Reject initial fetch: visible error/retry, no misleading empty-success message; retry succeeds. Reject refresh: existing rows remain with refresh error; next success clears error. After unmount, settle deferred calls without updates. Use API boundary promises and controlled interval advancement, not arbitrary sleeps.

**Dependencies:** frontend owner defines error copy/retry; a11y checks run on loading, error, expanded details and recovered states.

## Acceptance evidence and limits

Every modified frontend component keeps render + actual `axe(container)`/`toHaveNoViolations()` + user interaction tests, including post-interaction error states. Use existing tests as a base; avoid five internal-module mocks and assertions solely on callback wiring. Focus/escape/trigger restoration must follow EC-39. Add changed message-flow states to Playground. Run relevant suites, typecheck and repository-required checks after fixes; record commands and actual results rather than treating this plan as passed validation.

Keep rendered browser checks at 320/390/439 CSS px in both themes with `agent-browser` only. Preserve PR449's red regressions. Axe incomplete findings require adjudication; they are not passes. Physical iPhone Safari/PWA keyboard/safe-area, VoiceOver, differing-build update flow and actual Claude/Codex launch/recovery remain separately recorded acceptance. Mock API success cannot certify real CLI compatibility, model/account availability, Anthropic verification or the user's +30% usability target. No production KB/session mutation is an acceptable exploratory test.
