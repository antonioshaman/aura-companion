# Council Implementation Log (Aura): Portable project history

Plan: PLAN-aura-portable-project-history.md. Scope: specs/portable-project-history-v1.md.
Authorship: AI implementation and AI expert planning; no human code review.
TodoWrite is not exposed in this Codex tool registry; task transitions are recorded here instead of claiming tool calls.

| Task | Status | Verification |
|---|---|---|
| 1. Portable contract / full archive / bounded context | completed | 10 tests + typecheck passed; initial failing test observed by implementer |
| 2. Durable imported store / source enumeration | completed | 46 tests + typecheck; red missing-module test then green; restart/private mode/dedup/symlink cases |
| 3. Authenticated routes / continuation | completed | routes + real auth + store: 10 tests; no-store red→green; typecheck production passed |
| 4. Settings workflow | completed | component 8 + Settings 74 + API 173 tests; typecheck green |
| 5. Landing / integration verification | completed | 526 suites / 11,436 tests passed; typecheck + build + browser smoke + diff check |

Conventions: EC-7 resolving filesystem access; EC-20 shared contract; EC-32 handoff; EC-37 watchpoint behavior+callsite evidence; EC-46 durable atomic writes. No commits requested, so multi-commit tmux gate is not triggered. Council checkpoint probe: no connected orchestrator role in current cwd; silent skip per skill.

Baseline: 9 failures in 2 existing suites traced to inherited host timeout/catalog/Python environment overrides. Re-run those suites with those overrides unset: 346 tests passed. No tests weakened or application behavior altered.

Task1 follow-up (Willison independent reproduction): three failing regression tests observed, then fixed latest-goal loss, untyped JSON field loss and active Markdown. All 13 pure transformation tests pass.

Independent Beck check reproduced normalization accepting 10,001 review notes after a binary warning. Root observed failing regression then enforced normalized limits before commit; 17 pure/store tests pass. Diff matches recommendation: yes, no accepted write can cross review-note/node limits after normalization.

## Task details and attribution

### 1 — Fowler × Carmack; Hunt P2/P3, Willison P1/P8
`portable-history-types.ts`, `portable-history.ts` and tests separate allowlisted evidence from executable sessions and lossy context. Strict limits, origin, full tool content, byte-exact binary with review notice, stream uncertainty, generic JSON preservation and literal Markdown are exercised. Initial tests failed before implementation; independent reproductions drove three red→green corrections. The continuation retains early setup/latest user goal/recent evidence within 24 KiB.

### 2 — Hunt × Carmack P1/P3/P7; Fowler P6
`portable-history-store.ts` and tests use canonical normalized content identity, independent private durable files and validated id/path access. `session-store.ts` adds read-only root/cleanup export inventory, with tests preserving original `loadAll` behavior. Missing-module red step recorded; 46 targeted tests passed. Beck's normalization finding was reproduced with a failing store test and corrected before final verification.

### 3 — Willison × Carmack P1/P7/P8; Hunt P2/P7
`routes/portable-history-routes.ts`, routes/auth tests, minimal `routes.ts` registration and `index.ts` injection. Actual streamed-body cap rejects forged Content-Length; all routes are behind real authentication. Only explicit cwd/backend/conservative permission mode/isolation reach the existing orchestrator; then `setPickupDraft` persists a held draft. Both target backends and unavailable/bad-directory branches tested. No-store omission found by test and fixed; 11 route/auth/store tests and typecheck passed.

### 4 — Fowler × Carmack P3/P6; frontend P1, a11y P4
`PortableHistorySettings.tsx` + tests, SettingsPage integration + tests, typed api.ts + tests. Lazy inventory load, project selection, bounded-file import, literal paginated content, separate context, JSON/Markdown downloads and explicit continuation. 8 component, 74 Settings and 173 API tests passed, plus typecheck. Machine JSON uses compact serialization so a valid near-limit export is not expanded beyond import limits. No message component changed, so Playground is unaffected.

### 5 — Beck × Carmack; Willison P7
RU/EN deployed-source landing files add the fourth scenario with contextual portability and local-agent deferral. `web/scripts/portable-history-landing.test.ts` plus existing FAQ/meta tests: 8 passed after the new announcement test first failed. Documentation describes actual scope/limits and is linked from CLAUDE.md per its budget guard (6 passing tests). No production deployment or git commit/push was performed.

## Watchpoints addressed (EC-37)

Production call-site evidence: `callsite-evidence.txt` captures `git grep --no-index` against new and tracked production files, including index.ts registration.

| Watchpoint | Behavioral verifier | Production wiring |
|---|---|---|
| Inert untrusted import | store rejection/symlink/restart tests; routes real-auth and conservative continuation tests | store.import → parsePortableArchive → writeAtomicJson; never SessionStore.save |
| Archive vs bounded brief | `portable-history.test.ts`: full tool/binary preservation, latest goal, UTF8 bound, literal fences | createPortableArchive export; archiveMarkdown download; continuationDraft detail/continue |
| Complete available inventory | session-store test `includes live-directory and cleanup-archived histories`; route archived/live precedence tests | loadForPortableExport → inventory; bridge snapshots overwrite saved ids |
| Explicit destination, no auto-send | route both-provider/default config/failure tests; component both-provider held-draft tests | orchestrator.createSession then bridge.setPickupDraft; API has no send/execution call |

## Browser evidence

`agent-browser` only; isolated fixture backend uses real portable routes/store and synthetic content, with live providers deliberately unavailable. Actual import, reconnect/list/view, JSON and Markdown file download, literal hostile HTML/media, keyboard provider-failure path retaining content, mobile/desktop overflow checks passed. No `never-fetch.invalid` resources requested and no img/iframe/script nodes created. Screenshots are under `screenshots/`.

Browser continuation success is covered at deterministic spawn boundary, not by real model calls. Live Claude/Codex execution and production deployment remain unverified/unperformed. Raw protocol adapters were not changed; existing replay tests remain intact. Temporary smoke HTML removed; fixture backend stopped.

## Verification notes

Host-only overrides unset for full suite: AURA_INIT_FRAME_TIMEOUT_MS, AURA_INIT_FRAME_TIMEOUT_RESUME_MS, AURA_SILENT_STDIO_TIMEOUT_MS, AURA_COUNCIL_CATALOG_DIR, PYTHONDONTWRITEBYTECODE. Initial 9 existing failures were caused by these inherited settings; the two affected suites passed 346 tests in the clean environment. Tests were not skipped or weakened.

First final run: 525 passing suites, one missing-doc-index assertion; added the required CLAUDE.md link and the six-test budget/doc suite passed. Final clean full-suite result appended below after completion. Production typecheck and build passed (only the existing bundle-size advisory). `git diff --check` passed.

## AC reconciliation

AC1–6: archive/store/enumeration/auth tests. AC7–9: bounded context plus both-backend route/component tests. AC10–12: literal Markdown/viewer and empty/import states. AC13–14: RU/EN landing tests. AC15: component error/keyboard retry tests and browser provider-failure check. No functional AC intentionally dropped. Live-provider execution remains a verification limitation, not a claim of tested model quality.

## Final verification

Final clean run `/tmp/aura-portable-verified-suite.log`: 526 suites passed, 1 pre-existing skipped suite; 11,436 tests passed, 5 pre-existing skipped tests. Typecheck and production build passed. No new skipped tests.

## Plan–diff reconciliation

All five tasks have actual source/test diffs (new files included through git untracked inventory); none DROPPED. Task 1: portable-history.ts/types/tests; Task 2: portable store and SessionStore/tests; Task 3: routes/auth/tests/index; Task 4: Settings/API/components/tests; Task 5: RU/EN HTML, landing tests and indexed documentation.

## Ready for Review

AI-generated implementation with independent AI expert checks; no human code review.
- `CLAUDE.md`
- `docs/architecture/overview.md`
- `docs/architecture/portable-project-history.md`
- `landing-legacy/site/en/index.html`
- `landing-legacy/site/index.html`
- `specs/portable-project-history-v1.md`
- `web/scripts/portable-history-landing.test.ts`
- `web/server/index.ts`
- `web/server/portable-history-store.test.ts`
- `web/server/portable-history-store.ts`
- `web/server/portable-history-types.ts`
- `web/server/portable-history.test.ts`
- `web/server/portable-history.ts`
- `web/server/routes.ts`
- `web/server/routes/portable-history-auth.test.ts`
- `web/server/routes/portable-history-routes.test.ts`
- `web/server/routes/portable-history-routes.ts`
- `web/server/session-store.test.ts`
- `web/server/session-store.ts`
- `web/src/api.test.ts`
- `web/src/api.ts`
- `web/src/components/PortableHistorySettings.test.tsx`
- `web/src/components/PortableHistorySettings.tsx`
- `web/src/components/SettingsPage.test.tsx`
- `web/src/components/SettingsPage.tsx`

## Landing publication — 2026-11-03

User reported the announcement missing on auraco.space and requested follow-through. Confirmed the site still served the prior version. Published RU/EN landing through `landing-legacy/deploy-timeweb.sh` after its DNS gate and a dry run, with a pre-deploy site backup on Timeweb at `/tmp/auraco-space-before-portable-20261103T155103Z.tar.gz`.

Because the application feature remains unreleased, both announcements now explicitly say “готовится к выпуску / coming in a future release”; removed the link to a not-yet-published GitHub document. Eight relevant landing tests passed. The script verified HTTP200 and origin/local SHA256 equality; agent-browser confirmed the live announcement at `https://auraco.space/#portable-history`. This publishes the announcement only; it does not release/deploy the app feature. Publication and copy were performed by AI, without a new human code review.
