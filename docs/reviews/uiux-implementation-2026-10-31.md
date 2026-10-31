# UI/UX implementation — 2026-10-31

Plan: PLAN-aura-uiux-usability-followup.md. Scope and fixes authorized by owner.

Task status: 1–12 complete; 14 protocol fix implemented, typecheck/CI verification in progress; 13 delivery pending.
TodoWrite tool is not exposed in this session; this file records transitions.
Council checkpoint: API probe performed; no unrelated pair will be woken.

Evidence: planning reports under .council/plan-output/2026-10-31-uiux-usability/; temporary-file KB probe /tmp/aura-review-repro.ts reproduces version loss, malformed report throw, and decisions/body race. Hardware iPhone/VoiceOver and live CLI acceptance remain separate from browser mocks.

## Task 2 — Ritchie/Hunt
Read persistence B1–B9 and security boundary principles. Preserve current version by content; disable destructive production callers until external writers share a protocol. Existing offline algorithm tests remain relevant; production refusal gets separate tests.

Task 2 verified: version test failed before (completed-partial instead of archived), now passes. Separate child process after-stat barrier proves the offline rewrite race. Production apply rejects entire mixed batches before writes; boot recovery retains pending intent. UI Archive disabled, CLI requires dry-run. Existing quiescent tests retained with explicit test-only guard mock. 75 targeted tests and typecheck passed; extra guard/route tests added. No matching connected orchestrator at this workspace; checkpoint skipped.

## Task 3 — Hunt/Fowler
Six malformed nested reports failed on baseline (throw or incorrectly available). Validate all card/decision fields at disk boundary; no new schema library.

Task 3: 30 targeted tests passed, typecheck passed. All six malformed cases now report-invalid; newer schema remains distinct.

Task 4: streaming request test failed before (200 while analysis running). Repeat isRunning after body read, no async gap before validation/apply. No side effects on 409. Ritchie ownership boundary applied.

Task 4: 12 route tests and typecheck passed. Task 5 in progress. Abramov state identity: dedicated transient Zustand draft owner, per-session text/images and separate Home text/images/project; explicit reset invalidates old asynchronous setters, success clears only submitted revision. Main store reset/removal cleans drafts. Tests first corrected to native value assertions (Composer suite has no jest-dom matchers); rerun against baseline proves A→B leakage for both backends, /tmp/uiux-task5-real-red.log.

Task 5 verified: 226 targeted store/component/Playground tests and typecheck passed. Explicit draft epoch avoids delayed attachment/default setters resurrecting a cleared form. No browser disk persistence added.
Task 6 verified: all three regression tests failed first; 51 editor tests + axe and typecheck pass. Tree refresh errors keep document/tree and offer Retry; CLAUDE save/load results own their revision/context.
Task 7 in progress (Friedman five states, Beck deferred requests). Three baseline failures confirmed: unavailable agents/runs shown empty, old All result overwrites Error filter. Add honest errors, last-good retention and latest-request ownership.

Task 7 verified: 114 component tests including axe, overlapping poll/filter rejection, stale rows/count retained, and typecheck passed. Test harness corrected: deferred poll must not return unresolved promise from act; Agents also has a public-URL alert, so target the actual error sentence.
Task 8 in progress: 12 red cases confirm raw/fabricated mode labels and disabled reconnect input. Display-only helper maps backend semantics; Codex Auto/Plan does not imply reduced filesystem access. Existing toggles retain their original wire values.

Task 8: 88 Composer tests pass including both layouts, known/unknown/missing modes, unchanged toggle wire values, Enter/Send disconnected guards and axe. Typecheck caught only missing required initialPath in the newly added Task 9 harness; corrected.
Task 9: baseline Escape/selection return focus to BODY. Use existing useModalDialog focus stack, retain manual-path Escape and close animation. Arrow navigation only owns focus inside its picker.

Task 9 verified: 44 picker tests + axe and typecheck passed. Task 10: four repeated-instance tests failed before; useId scopes help/title/listbox/option relationships per component. Named provider/CI containers are groups; finding annotations use note semantics, preserving full visible and accessible explanations.

Task 10 verified: 330 targeted component tests + axe and typecheck passed; repeated-instance IDs local, roving active descendant resolves actual option ID. Tests caught and fixed an accidental data-testid replacement and inappropriate role on the dismiss button before proceeding.

## Task 11 — integration
Tasks 1–10 implemented. Full sanitized suite/coverage, build and final typecheck in progress. Playground includes restored draft, reconnect editing, and truthful Codex mode states. Broadened nested-report roundtrip/malformed cases and real prune refusal tests: 53 pass. Physical iPhone/PWA/VoiceOver remain unverified by desktop automation.

Browser follow-up: Home→Settings→Home retains text in the same document; FolderPicker Escape restores actual project opener. First matrix attempted theme toggle from Playground (no global TopBar) and did not switch; it is not counted as a dark-theme pass. Corrected harness navigates Home before toggling and asserts actual HTML theme. Browser incomplete exposed two remaining held/dismissed plain-string chip names; a red semantic regression test was added and both given note semantics. Conditional closed listbox controls are retained as manual/incomplete candidates, not claimed defects automatically.

Task 12 discovered a concrete additional PWA defect: in a first-install document Workbox-window captures _isUpdate=false forever; explicit Update activated B but did not reload A (same performance.timeOrigin, B cached). /tmp/uiux-pwa-proof.log records the failing two-build proof. Minimal registration owner replaces the virtual prompt wrapper with native SW registration, retaining the existing Workbox worker/caches. Only this tab's explicit consent permits reload; another tab's activation cannot discard local edits. Existing registration tests retain their behavioral intents with native EventTarget fixtures, plus first-install and cross-tab cases. Update copy explicitly mentions unsent drafts. Final suite/build/browser proof will be rerun.

Final component triad inventory: all 17 changed components have .test.tsx render/axe/interaction coverage. First full sanitized run: 520 test files passed, one skipped; 11379 tests passed, six skipped. All 27 then-changed source files exceeded 80% line coverage. Latest PWA registration change passed 14 targeted tests and a fresh production build. Repeat full suite and typecheck now running.

PWA two-build proof now PASS: same document/timeOrigin and draft while B waits; explicit Update changes timeOrigin and loads B. Source index.html restored byte-for-byte; B exists only in /tmp, final web/dist is clean A. Browser matrix rerun on final registration build, asserting actual light/dark class.

Final full UI/PWA run passed: 11383 tests, six skipped; 520 files passed/one skipped; all 29 changed source files ≥85.45% lines; typecheck clean. Browser 22 light/dark states: zero confirmed WCAG axe violations, conditional listbox-controls incomplete retained. Responsive Home/Settings at 320/430/1280: no document overflow. HTTP503→Retry browser proof passed on isolated no-SW readonly preview; initial interception attempt was bypassed by an active SW, and first retry click hit an open sidebar backdrop — harness corrected, not claimed app defects.

## Task 14 — live Codex compatibility, Dahl B7/B8
Actual SSE creation + public-Origin WS subscription exposed turn/moderationMetadata protocol drift on codex-cli 0.162.1. Captured replay and generated CLI JSON schema retained. Red tests fail for valid envelope; malformed/unknown methods remain rejected. Accept only this known informational method with required string IDs and opaque metadata (schema says ANY JSON, including null). Claude real create/subscribe succeeded but provider returned Anthropic account verification requirement, not an application fix. Smoke sessions stopped/archived, history retained. Original loopback-Origin3456 probe was rejected by allowlist as designed; corrected to actual public Origin.

Task 14 regression verification: five valid-case tests failed before; malformed cases already failed closed. After fix: all 210 Codex adapter/contract/drift tests pass, including captured frame followed by reply delta and all opaque JSON metadata alternatives. Unknown notification regression remains. Typecheck caught the deliberately malformed array passed through the typed test transport; marked its explicit unknown-wire cast. No protocol/sandbox/approval policy changed.
