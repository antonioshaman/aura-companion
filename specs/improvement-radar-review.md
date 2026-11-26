# Council Review (Aura): Improvement Radar and model freshness

**Scope:** 31 changed feature files; supporting consumers followed. **Context:** opt-in bounded public discovery, persisted user decisions, quiet home disclosure and truthful local model metadata. No automatic implementation or CLI installation.
**Council dispatched:** hunt, dahl, ritchie, fowler, abramov, beck, watson, friedman, willison returned findings; saarinen and hashimoto returned no findings. All eleven output files verified non-empty before synthesis.
**Deterministic checks:** typecheck/build/deadcode/DRY pass; full suite 12122 pass,3 environment failures,9 skip; corrected PATH rerun39 pass clears all three failures. Dedicated axe119 pass; rendered axe6 states pass,zero violations/incomplete. Browser component smoke pass. Original skipped scanner artifact retained; successful retry used fresh ephemeral profile only.
**Confidence:** High for checked scope. Full HomePage/Settings rendered pages and actual screen-reader speech not verified; component preview used to avoid touching real session lifecycle.

## Deterministic Check Failures (fix first)
None outstanding. Initial failures were spawn bun ENOENT in supply-chain/kb-health/CLI tests caused by the transient unit PATH, reproduced and cleared without source changes.

## P1 — Fix Now
None. Findings below are bounded feature-local failures/defense or regression gaps; no existing session/auth compromise reproduced.

## P2 — Fix Soon

### 1. HUNT-1 — Malformed decisions corrupt persisted state

| | |
|---|---|
| File | web/server/routes/radar-routes.ts:22 |
| Council | hunt × Carmack — Principle 2 |
| Ref | references/security.md → Principle 2 |

**Finding / reproduction:** See substantiated scenario in hunt.md (HUNT-1); source and actual consumers checked.

**Fix:** Require an actual string enum at route and store boundaries; rejected mutations preserve bytes.

### 2. HUNT-2 — Identical metadata reads spawn duplicate CLI probes

| | |
|---|---|
| File | web/server/model-freshness.ts:23 |
| Council | hunt × Carmack — Principle 7 |
| Ref | references/security.md → Principle 7 |

**Finding / reproduction:** See substantiated scenario in hunt.md (HUNT-2); source and actual consumers checked.

**Fix:** Share one in-flight version probe per backend and cache success/failure for sixty seconds.

### 3. DAHL-1 — Non-success HTTP bodies remain unclosed

| | |
|---|---|
| File | web/server/radar/radar-sources.ts:12 |
| Council | dahl × Carmack — Resource lifecycle |
| Ref | references/quality-backend.md → Resource lifecycle |

**Finding / reproduction:** See substantiated scenario in dahl.md (DAHL-1); source and actual consumers checked.

**Fix:** Cancel error response bodies without replacing sanitized source errors.

### 4. RIT-1 — Partial scans evict previous evidence at the cap

| | |
|---|---|
| File | web/server/radar/radar-runner.ts:64 |
| Council | ritchie × Carmack — Bounded persistence |
| Ref | references/quality-ritchie.md → Bounded persistence |

**Finding / reproduction:** See substantiated scenario in ritchie.md (RIT-1); source and actual consumers checked.

**Fix:** Retain previous evidence first and append only fitting new partial results.

### 5. FOWLER-1 — Decision history loses its title and restorable proposal

| | |
|---|---|
| File | web/server/radar/radar-types.ts:15 |
| Council | fowler × Carmack — Principles 3,6 |
| Ref | references/refactoring.md → Principles 3,6 |

**Finding / reproduction:** See substantiated scenario in fowler.md (FOWLER-1); source and actual consumers checked.

**Fix:** Persist a bounded descriptive decision snapshot independently; restore rehydrates the proposal. Cross-ref Friedman UX-1.

### 6. ABR-1 — Stale polling overwrites acknowledged decisions

| | |
|---|---|
| File | web/src/components/ImprovementRadar.tsx:40 |
| Council | abramov × Carmack — Async state ownership |
| Ref | references/quality-frontend.md → Async state ownership |

**Finding / reproduction:** See substantiated scenario in abramov.md (ABR-1); source and actual consumers checked.

**Fix:** Serialize polling and reject status responses initiated before a mutation.

### 7. BECK-1 — No positive daily scheduling regression

| | |
|---|---|
| File | web/server/radar/radar-runner.test.ts:30 |
| Council | beck × Carmack — Principles 4,5 |
| Ref | references/quality-testing.md → Principles 4,5 |

**Finding / reproduction:** See substantiated scenario in beck.md (BECK-1); source and actual consumers checked.

**Fix:** Verify enabled due ticks persist findings exactly once each day; prove mutation resistance.

### 8. BECK-2 — Probe test does not verify its bounded command

| | |
|---|---|
| File | web/server/model-freshness.test.ts:19 |
| Council | beck × Carmack — Principle 6 |
| Ref | references/quality-testing.md → Principle 6 |

**Finding / reproduction:** See substantiated scenario in beck.md (BECK-2); source and actual consumers checked.

**Fix:** Assert trusted binary, literal version argv, timeout/output cap and failures; prove mutation resistance.

### 9. WATSON-1 — Restore removes the focused control

| | |
|---|---|
| File | web/src/components/ImprovementRadar.tsx:89 |
| Council | watson × Carmack — Principle 4 |
| Ref | references/quality-a11y.md → Principle 4 |

**Finding / reproduction:** See substantiated scenario in watson.md (WATSON-1); source and actual consumers checked.

**Fix:** Return focus to a surviving target after successful restore; keep control on failure.

### 10. UX-2 — Initial loading failure has no retry

| | |
|---|---|
| File | web/src/components/ImprovementRadar.tsx:77 |
| Council | friedman × Carmack — Principles 2,10 |
| Ref | references/quality-ux.md → Principles 2,10 |

**Finding / reproduction:** See substantiated scenario in friedman.md (UX-2); source and actual consumers checked.

**Fix:** Offer an in-panel GET retry restoring usable controls.

### 11. WILLISON-1 — Radar can recommend integrating Aura itself

| | |
|---|---|
| File | web/server/radar/radar-evaluator.ts:10 |
| Council | willison × Carmack — Principle 7 |
| Ref | references/quality-llm.md → Principle 7 |

**Finding / reproduction:** See substantiated scenario in willison.md (WILLISON-1); source and actual consumers checked.

**Fix:** Suppress actual fork identity and upstream, including case variants.

### 12. WILLISON-2 — Refresh reports semantic failure as completion

| | |
|---|---|
| File | web/src/components/ImprovementRadar.tsx:51 |
| Council | willison × Carmack — Principle 7 |
| Ref | references/quality-llm.md → Principle 7 |

**Finding / reproduction:** See substantiated scenario in willison.md (WILLISON-2); source and actual consumers checked.

**Fix:** Respect per-backend refresh outcomes, preserve model choices on failed acquisition.

## P3 — Consider
None.

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---|---|---|---|
| 1 | HUNT-1: Malformed decisions corrupt persisted state | P2 | hunt | Small |
| 2 | HUNT-2: Identical metadata reads spawn duplicate CLI probes | P2 | hunt | Small |
| 3 | DAHL-1: Non-success HTTP bodies remain unclosed | P2 | dahl | Small |
| 4 | RIT-1: Partial scans evict previous evidence at the cap | P2 | ritchie | Small |
| 5 | FOWLER-1: Decision history loses its title and restorable proposal | P2 | fowler | Small |
| 6 | ABR-1: Stale polling overwrites acknowledged decisions | P2 | abramov | Small |
| 7 | BECK-1: No positive daily scheduling regression | P2 | beck | Small |
| 8 | BECK-2: Probe test does not verify its bounded command | P2 | beck | Small |
| 9 | WATSON-1: Restore removes the focused control | P2 | watson | Small |
| 10 | UX-2: Initial loading failure has no retry | P2 | friedman | Small |
| 11 | WILLISON-1: Radar can recommend integrating Aura itself | P2 | willison | Small |
| 12 | WILLISON-2: Refresh reports semantic failure as completion | P2 | willison | Small |

## Verdict
Hold release until all twelve findings are resolved and the full deterministic checks rerun. Persistence and request ordering are the most consequential domains. User explicitly authorized every severity, deployment and release; no additional approval requested.

## Findings Breakdown by Expert

| Expert | P1 | P2 | P3 | Total | Key areas |
|---|---|---|---|---|---|
| hunt | 0 | 2 | 0 | 2 | Scoped domain |
| dahl | 0 | 1 | 0 | 1 | Scoped domain |
| ritchie | 0 | 1 | 0 | 1 | Scoped domain |
| fowler | 0 | 1 | 0 | 1 | Scoped domain |
| abramov | 0 | 1 | 0 | 1 | Scoped domain |
| saarinen | 0 | 0 | 0 | 0 | Scoped domain |
| watson | 0 | 1 | 0 | 1 | Scoped domain |
| friedman | 0 | 1 | 0 | 1 | Scoped domain |
| beck | 0 | 2 | 0 | 2 | Scoped domain |
| hashimoto | 0 | 0 | 0 | 0 | Scoped domain |
| willison | 0 | 2 | 0 | 2 | Scoped domain |
| TOTAL |0|12|0|12| Deduplicated Friedman UX-1 under Fowler |

## Cross-cut verification
Protected route registration, decision write/read/render contracts, runner replacement semantics, settings refresh typed outcomes and HomePage reload consumer checked. Existing CLI model arrays/registry remain authoritative, external announcements never enter selector. No new CLI/WS frame contract.

## Accessibility limits
 (not verified)

- [ ] not verified: Keyboard: every control reachable with Tab in a logical order, no focus trap, Escape closes dialogs (2.1.1, 2.1.2, 2.4.3)
- [ ] not verified: Focus visible on every control in both themes, not hidden under sticky bars (2.4.7, 2.4.11)
- [ ] not verified: Screen reader: names, roles and states announced correctly; live updates (streaming, toasts) announced once (4.1.2, 4.1.3)
- [ ] not verified: Text alternatives are meaningful, not just present (1.1.1)
- [ ] not verified: Reflow at 320 CSS px and 400% zoom without loss of content (1.4.10); text spacing override (1.4.12)
- [ ] not verified: Contrast of states axe cannot compute: hover, focus, disabled, text over images/gradients (1.4.3, 1.4.11)
- [ ] not verified: Motion: animations respect prefers-reduced-motion; nothing flashes (2.3.1, 2.3.3)
- [ ] not verified: Errors identified in text with a suggestion for the fix (3.3.1, 3.3.3)
- [ ] not verified: Target size of touch controls at the phone viewport (2.5.8)
- [ ] not verified: Consistent navigation and identification across the changed screens (3.2.3, 3.2.4)


**Expert outputs:** hunt.md, dahl.md, ritchie.md, fowler.md, abramov.md, saarinen.md, watson.md, friedman.md, beck.md, hashimoto.md, willison.md.

## Fix-pass status
All12 findings fixed. One follow-up round (Hunt/backend, Abramov/UI, Beck/tests) returned zero remaining/new findings and no new P1. Original pre-fix report preserved above; implementation log records red/green and mutation evidence. Post-fix verification is enforced by the pre-commit hook and PR checks; see implementation log and PR for final totals.

## Expert evidence (pre-fix)

### hunt

FINDING:
- Title: Coerced decision validation permits persistent store corruption
- File: web/server/routes/radar-routes.ts:19-23
- Principle: Validation at every Hono boundary — Principle 2
- Severity: P2
- What's wrong: The allowlist checks String(decision), but passes the original value into RadarStore.decide; a JSON array containing implemented therefore passes validation and is persisted as an array instead of the required string. Reproduced with a real Hono router and temporary RadarStore: POST a known idea id with decision equal to a one-element implemented array returns 400 after the write, and every subsequent GET radar returns 503 because the persisted decisions fail read validation.
- Consequence: A malformed authenticated mutation permanently disables this installation’s Radar until the state file is repaired manually; the rejected request has already changed durable state.
- Fix: Require decision to be a string before applying the enum allowlist, and enforce the same runtime decision invariant in RadarStore.decide before writing. Add a route regression asserting malformed arrays and objects leave state byte-for-byte unchanged and subsequent reads succeed.

FINDING:
- Title: Metadata GET starts unbounded concurrent CLI probes
- File: web/server/routes/settings-routes.ts:464-477
- Principle: Rate limiting absent on expensive endpoints — Principle 7
- Severity: P2
- What's wrong: Each freshness GET unconditionally resolves both binaries and starts two independent execFile version probes, with no cache or shared in-flight work; the two-second timeout only bounds each individual child. A burst of N authorized requests therefore starts up to 2N CLI processes, and the HomePage now invokes this endpoint on every mount.
- Consequence: A noisy client can consume process and memory capacity in the live Aura service through a read-only metadata endpoint, affecting running sessions even though all requests are for identical installation metadata.
- Fix: Cache version observations briefly per backend and share an in-flight promise so overlapping metadata reads use at most one probe per backend. Test a burst of concurrent freshness requests against a delayed probe and assert bounded probe count while all callers receive the result.


### dahl

# Dahl backend / protocol review

Scope: radar backend, model freshness, route registration and accompanying tests in the assigned diff. Existing CLI/WebSocket wire protocols are unchanged. Phase 0 results and reference were reviewed. No production requests or source edits.

## DAHL-1 — Cancel non-success HTTP response bodies
- Severity: **P2**
- Location: `web/server/radar/radar-sources.ts:12`
- Finding: The non-2xx branch throws before entering the response-body reader/finally. A GitHub 403/429 or an official-source error therefore leaves its body unread and uncancelled. These are expected operational paths for unauthenticated public GitHub requests. The runner moves on to other sources and clears its overall abort timer after completion, so that timer does not subsequently clean up these abandoned bodies. Streaming error responses can retain network/buffer resources beyond the failed source operation.
- Reproduction: Inject `fetcher` returning a `Response` with status 429 and a `ReadableStream` that enqueues a chunk without closing and records `cancel()`. Await `fetchRadarSource`, catch the expected rate-limit error. Observed with Bun: `{cancelled:false, bodyUsed:false, locked:false}`. The success/oversize paths correctly reach their cancellation finally; the error-status path does not.
- Proportionate fix: Explicitly cancel the non-success response body before throwing the same sanitized `RadarSourceError`, retaining the existing response-size and deadline policy. Add a regression test asserting cancellation on at least 403/429 and generic upstream failure; cancellation failure must not replace the public sanitized source error.
- Fix effort: small.

No P1 findings. No findings on unchanged protocol behavior.


### ritchie

# Ritchie review — Process lifecycle and filesystem persistence

## §A Process lifecycle

No findings in the changed surface. The added fixed-argv CLI version probe is bounded; radar shutdown cancels the timer and aborts network work. No CLI session lifecycle or PID ownership protocol changes were introduced.

## §B Filesystem persistence

### RIT-1 · P2 — Partial scans evict the last good evidence when the bounded list fills

**Location:** `web/server/radar/radar-runner.ts:62–65`.

**Trigger / evidence:** Seed the persisted store with 100 existing recommendations. Configure six valid sources: five searches each returning 20 distinct new MCP repositories, and a sixth source that fails (403/offline). The runner merges the old ideas first and appends the 100 new IDs, then `slice(-100)` drops every old entry before atomically persisting the partial result. The limit is reachable with the supported source limit (20) and real per-search cap (20). A temporary-store reproduction using injected acquisition returned `{outcome:"partial",before:100,after:100,retainedOld:0}`; no production requests or source edits were made.

**User impact:** A transient source failure permanently removes the previous recommendations, including evidence belonging to the unavailable source. The UI says previous results were preserved, but none need survive. Decisions survive as IDs, while their original title/provenance can become unavailable.

**Proportionate fix:** On a partial scan, retain existing evidence first within the 100-item budget, update matching IDs, and append only new items that fit; alternatively preserve the entire prior snapshot when a successful bounded replacement cannot be established. Add a regression at the 100-item boundary with successful and failed sources, asserting old IDs/evidence remain after a new store instance reads the file.

## Verification and scope

Read all eleven assigned files and the lifecycle/persistence reference, plus atomic-write helper and HTTP/UI consumers. The shared atomic writer fsyncs the temporary file and renames within the target directory; no new atomicity or path-construction defect found. Full Phase 0 results and rendered axe scope are recorded in context-brief.md. No source or test edits.


### fowler

# Fowler — structural review

FINDING FOWLER-1:
- Title: Durable decisions lose their only descriptive record when replaceable scan results change
- File: `web/server/radar/radar-types.ts:15`, `web/server/radar/radar-runner.ts:63`, `web/src/components/ImprovementRadar.tsx:59`
- Principle: Principle 3 — Minimise and contain state; Principle 6 — Architecture earns its boundaries
- Severity: P2
- What's wrong: A durable decision stores only an opaque hash and enum, while its title/source live exclusively in the replaceable `ideas` array. A successful scan replaces that array with `next`. A decided repository that falls out of the top-20 search results, is removed from configured sources, or yields no release loses its entire descriptive record. The UI then intentionally falls back to indistinguishable “Ранее найденная идея”; restoring deletes the remaining decision without restoring any proposal. This is a current data-model ownership error, rather than a request for a generic persistence abstraction.
- Reproduction/evidence: Executed an isolated real `RadarStore` + `RadarRunner` with one `openai/codex` finding; marked its ID implemented; advanced the injected clock 61 seconds and returned an empty successful acquisition. The view was `ideas: []`, one implemented decision, count 5. Restoring that ID produced `ideas: []`, proposals 0, implemented 4. No title/source remained anywhere in the persisted snapshot. The same replacement happens when ordinary search ordering changes.
- Consequence: The requested list of already implemented ideas degrades into unnamed entries as the radar operates, and “Вернуть в предложения” does not perform its named action. Later improvements to that list require reconstructing lost evidence, which is impossible locally. This will compound immediately with daily scanning and source edits.
- Fix: Persist a bounded descriptive snapshot (at least title/source plus the fields needed to restore a proposal) with each durable decision, or retain decided idea records independently from replaceable scan candidates. Derive the decided lists from that durable record and have restore put its idea back into candidates. Keep existing IDs/decision compatibility; add a behavior test across successful replacement, process recreation, and restore. This does not require a new generic storage layer.

No other structural findings. The new feature keeps acquisition, pure evaluation, bounded persistence and lifecycle ownership separate; source mutations remain visible in the runner, frontend state is local, and the integration avoids widening ws-bridge or changing the existing catalog array contract. Formatting preferences and pre-existing large route/component modules were not reported.


### abramov

# React architecture review — Abramov

Reviewed the assigned frontend diff and its component tests, API transport, HomePage model-loading consumer, SettingsPage refresh consumer, and existing inflight-token protection in settings-slice.ts. Phase 0 results and quality-frontend.md were read. No source changes.

## P2 — ABR-1: An older status response can overwrite a confirmed decision and stop polling

**Location:** `web/src/components/ImprovementRadar.tsx:40` and `:45`.

**Evidence / reproduction:** Open the home page while a daily scan is running so the initial view has `running: true`. Let a polling GET read the just-completed scan snapshot (`running: false`, no decision) but delay delivery of its response. Click “Уже реализовано” on a visible existing idea and let the decision POST return first. The POST correctly replaces the view with the implemented decision. Deliver the older polling response: its unconditional `setView(s)` restores the pre-decision proposal/counts, and its `running: false` tears down the only polling effect. The UI now permanently shows the idea as unimplemented until a page reload even though its decision is persisted correctly. Decisions remain enabled during a known running scan, so this ordering is reachable; no malformed server response is necessary.

**Cost:** Users see an acknowledged decision reversed and inaccurate proposal/implemented counts, potentially repeat the action or misjudge saved state. Multiple overlapping interval requests have the same stale-commit problem.

**Proportionate fix:** Give status reads and mutations a shared request-generation/commit guard, invalidating reads initiated before a successful mutation, and serialize polling requests (or otherwise reject out-of-order status responses). Keep the last confirmed view when stale reads finish. Add a deferred-promise component regression test with the exact GET → POST success → stale GET ordering and verify the implementation decision/count remains visible after polling stops.

No P1 or P3 findings. Existing narrow Zustand subscriptions and type-only server imports introduce no additional architectural defect in this scoped diff.


### beck

# Kent Beck — test quality

Scope: current improvement-radar diff. Phase 0 results accepted from the context brief; source/test pairs and changed consumer wiring reviewed. No source edits. Existing assertions are preserved, API mocks sit at the frontend boundary, runner/store tests use real persistence/evaluation, and radar has render + post-interaction axe + interaction coverage. No P1 findings.

## BECK-1 — P2: opted-in daily scheduling has no positive behavioral test

**Location:** `web/server/radar/radar-runner.test.ts:30–44`; corresponding producer `web/server/radar/radar-runner.ts:23–31`.

**Evidence:** The only calls to `start()` assert that acquisition does **not** occur (disabled configuration, and a restart less than a day after the last attempt). All successful collection is driven directly by `run()`. Removing the scheduled `this.run()` call, or changing its enabled predicate to always false, leaves every current runner assertion satisfied. Thus the user's primary automatic-discovery behavior can disappear while the new suite stays green.

**Consequence:** AC1's explicitly enabled automatic check is not regression protected, despite the implementation log reporting scheduling complete.

**Proportionate fix:** Add a fake-clock test with a real temporary store and enabled configuration. Advance to a due scheduled tick and assert persisted findings/counts/attempt time; verify no second scan within the next day and exactly one scan on a later due tick. Keep the disabled/restart-negative cases. Demonstrate the test fails when the scheduled invocation is suppressed.

**Principle:** Quality testing 4/5 — test the feature's positive behavior as well as its guards.

## BECK-2 — P2: subprocess probe test does not verify the bounded read-only contract it claims

**Location:** `web/server/model-freshness.test.ts:19–24`.

**Evidence:** The `execFile` mock ignores `_file`, `_args`, and `_opts` and always calls back with `codex-cli fixture`. The test checks only returned text and an absent executable. Replacing `["--version"]` with a session-starting argument, or removing timeout/maxBuffer, would still pass. Neither the claimed fixed command nor its bounds are actually checked.

**Consequence:** The safety distinction between observing the CLI version and launching an interactive CLI process has no regression assertion, while this probe runs when the home screen loads metadata.

**Proportionate fix:** Make the subprocess boundary a spy and assert trusted resolved executable, literal `--version` argv, finite timeout and output limit. Exercise callback failure and oversized output handling separately from successful output. These are externally meaningful process-boundary assertions, not internal module coupling.

**Principle:** Quality testing 6 — assert the contract the test name/comment promises.

## Limits

No new CLI stream protocol is introduced, so recording replay is not applicable. Radar is a home-screen disclosure, so message Playground coverage is not required. Rendered scanner coverage is as stated in the shared brief; this review does not claim screen-reader verification.


### watson

FINDING:
- Title: Restoring an idea removes the focused control without returning focus
- File: web/src/components/ImprovementRadar.tsx:89,103
- Principle: Focus management on dynamic UI — Principle 4; WCAG 2.4.3
- Severity: P2
- What's wrong: Both restore buttons call act() without selecting a surviving focus target. The successful response removes the button's own list item. Reproduced in the actual component preview using agent-browser: mark the fixture idea implemented, open «Уже в Aura», focus «Вернуть в предложения», press Enter, await the response. document.activeElement.tagName becomes BODY. The same removal occurs for «Снова предлагать» in dismissed ideas. The existing status region still contains unchanged scan timestamps, so it supplies no restoration feedback either. In contrast, the new dismiss/implemented actions deliberately focus the surviving radar summary.
- Consequence: Keyboard and screen-reader users lose their position after undoing a decision and must rediscover the radar/results; successive restores cannot be performed predictably from the current list.
- Fix: After a successful restore, focus a surviving logical target such as the radar summary or restored idea action. Add behavioural tests with a genuinely focused restore button, an awaited response, and an explicit focus assertion for both restored states. Keep the current item/focus intact on a failed restore.

## Rendered scan and manual scope

Read a11y-scan-ephemeral/a11y-scan.md (collapsed light/dark, PASS) and a11y-expanded/a11y-scan.md (four expanded/settings light/dark states, PASS). Both have zero violations and zero incomplete checks. The initial skipped artifact is preserved and provides no browser verification. These passes concern the component preview only, not the complete HomePage or SettingsPage, and do not prove accessibility.

Read the assigned component/API files and their changed consumers/tests; inspected both assigned mobile screenshots. The tests include render, axe, keyboard disclosure activation, and interactive coverage. No new animation, dialog, streaming region, icon-only action, or embedded editor is introduced.

### Scanner checklist follow-through (artifacts unchanged)

- [x] Keyboard reachability supported by native summary/buttons/input/textarea/link semantics in ImprovementRadar.tsx:65-104; actual Enter restore exercised. Focus return has the concrete finding above. No modal/Escape requirement introduced.
- [ ] Focus visibility in both themes not fully verified manually. Explicit focus-visible styles exist at lines6,65, with global fallback in web/src/index.css:363-369; no changed outline removal.
- [ ] Actual screen-reader speech not verified. Names/states use visible text and native controls, with labelled textarea at84, aria-expanded at81-82, polite scan status at73, errors at77. Restoration feedback remains deficient as reported.
- [x] Text alternatives: the changed radar introduces no image/icon needing alternatives; all actions use visible text (lines65-104).
- [ ] Full 400% zoom and text-spacing override not verified. Actual component preview at320 CSS pixels had document scrollWidth320 and innerWidth320; no horizontal overflow in that fixture.
- [ ] Hover/focus/disabled-state contrast not verified. Rendered normal-state axe scans passed; screenshots inspected in both themes.
- [x] Motion: radar adds no animation (line9); browser computed no active animation in its descendants. Existing global reduced-motion override is index.css:372-380.
- [ ] Error correction guidance not fully verified for every server error. Textual API errors are exposed through role=alert at77; model retry outcome is text at104.
- [ ] All touch targets not exhaustively verified. Visible fixture action buttons measured28 CSS px high at320px viewport (control styles line6); checkbox's labelled hit area requires a separate full touch audit.
- [x] Changed navigation/control identification is consistent: native disclosures and text-labelled controls, with explicit new-tab source wording at96. No changed global navigation pattern.


### friedman

# UX review — Friedman × Carmack

Reviewed the assigned feature diff and its consumer flows, plan, component tests, and radar contract. Followed the history flow through `radar-runner.ts` and `radar-store.ts`. Safe rendered preview on port 3468 checked via `agent-browser` (collapsed summary → expanded panel); no production requests or source changes. No P1 findings.

## P2 — Fix Soon

### UX-1. Persist recognizable history for dismissed and implemented ideas

| | |
|---|---|
| **File** | `web/src/components/ImprovementRadar.tsx:61`, `:89`, `:104`; `web/server/radar/radar-runner.ts:59` |
| **Council** | Friedman × Carmack — Dashboards and lists drive action; trust through data consistency |
| **Ref** | `references/quality-ux.md` → Principles 6, 9 |

**Finding:** Durable decisions only retain opaque IDs; history labels are looked up exclusively in the replaceable current scan. After a successful scan no longer returns a decided repository (normal with a changing top-20 search or an edited source list), its row becomes “Ранее найденная идея”. Multiple rows become indistinguishable, including inside “Уже в Aura”, whose count remains positive. The restore button also immediately removes the decision without restoring a proposal when its idea no longer exists.

**Reproduction:** Mark idea A implemented and B dismissed; run a successful scan returning neither; open the two history sections. Both lose their titles/source, and clicking “Вернуть в предложения” on A reduces the implemented count but adds nothing to proposals. Verified the underlying path with a temporary store and actual `RadarRunner`: after a successful empty result `ideas=[]`, the implemented decision persists, implemented count remains 5.

**Consequence:** The user cannot identify which past improvement was implemented/dismissed or reliably undo the chosen item. This directly undermines the requested implemented-ideas drill-down.

**Fix:** Retain bounded identifying metadata for decided ideas independently of the replaceable scan, and use it to render distinguishable history with source. Restore should either rehydrate the identifiable archived proposal or explicitly explain that it only permits a future finding. Add a failing runner/component test that decides two ideas, completes a scan omitting them, then verifies recognizable history and truthful restore behavior. Estimated effort: small persistence/contract/UI change.

### UX-2. Initial load failure has no retry path inside the radar

| | |
|---|---|
| **File** | `web/src/components/ImprovementRadar.tsx:20–34`, `:71`, `:77` |
| **Council** | Friedman × Carmack — Design all five states; errors in place with recovery |
| **Ref** | `references/quality-ux.md` → Principles 2, 10 |

**Finding:** If the initial `api.radar()` request fails transiently, `view` stays null, “Проверить новинки” stays disabled by `!view`, and the one mount-only load is never retried. “Радар временно недоступен” provides no recovery action. The existing failed-load test checks only the message, so it confirms the dead-end state without checking recovery.

**Reproduction:** Reject the first radar GET, then make the endpoint healthy. Expand the panel: the scan button remains disabled indefinitely, and no control retries loading. Navigating away and back or reloading the whole page is required.

**Consequence:** A brief initial network failure leaves the new feature unusable for the rest of the home-page visit despite server recovery.

**Fix:** Offer an explicit “Повторить загрузку” action in this error state, reusing the initial GET and preserving model metadata independently. Add a failing interaction test where the first GET fails, the retry succeeds, and scan/settings controls become usable. Estimated effort: small component change.

## Summary

| # | Finding | Severity | Council | Fix effort |
|---|---|---|---|---|
| UX-1 | Decision history loses recognizable identity after later scans | P2 | Friedman | Small persistence/contract/UI change |
| UX-2 | Initial request failure has no in-panel retry | P2 | Friedman | Small component change |

## Verdict

Two concrete recovery/history issues; normal collapsed/expanded discovery, bounded proposal listing, per-source partial diagnostics, and manual scheduling affordances are present. No visual/a11y findings claimed in this seat.


### willison

# Willison — LLM/content and model portability review

Reviewed all assigned files and the LLM quality reference. No new LLM execution, permission, stream or recording boundary is introduced; public document content is extracted deterministically and rendered as React text. No P1 findings.

## WILLISON-1 — P2 — The product can recommend integrating itself

- **Location:** `web/server/radar/radar-evaluator.ts:10`.
- **Evidence:** The exclusion names `aurashaman/aura-companion`, but this checkout's actual origin is `git@github.com:antonioshaman/aura-companion.git`.
- **Reproduction:** Call `evaluateFindings([{repo:"antonioshaman/aura-companion",title:"",url:"https://github.com/antonioshaman/aura-companion",publishedAt:null,topics:["ai-agents"]}])`. Executed locally against the unchanged source: returns `Оценить интеграцию antonioshaman/aura-companion` rather than an empty list. A matching public topic search therefore proposes the installed product as a missing integration.
- **Impact:** Violates the explicit implemented-capability/self-product suppression contract and consumes one of the ten visible recommendation slots with a demonstrably irrelevant idea.
- **Proportionate fix:** Exclude the actual Aura repository identity, preserve the upstream exclusion, and cover the real fork identity and casing with a deterministic evaluator test. No Git remote probing at scan time is required.

## WILLISON-2 — P2 — Model refresh discards the server's failure outcome

- **Location:** `web/src/components/ImprovementRadar.tsx:51–54`; consumer contract `web/server/routes/settings-routes.ts:424–440`.
- **Reproduction:** Have `POST /settings/models/refresh` return its normal HTTP-200 typed result `{claude:"unavailable",codex:"local-cache"}` (e.g. Anthropic upstream fails). Let catalog reload/freshness GET resolve, as they normally can with cached data. In the Claude radar, click `Проверить каталог Claude`. The response is discarded and the component announces `Проверка завершена...`; its failure catch never executes. Similarly `{codex:"absent"}` produces `Локальный каталог перечитан` despite no catalog existing.
- **Impact:** The central new model-currentness action does not distinguish failed upstream acquisition or an absent Codex cache from a completed reread. Existing stale metadata is useful but cannot communicate whether this explicit attempt failed; this undermines the plan's truthful refresh requirement.
- **Proportionate fix:** Branch on the existing typed per-backend refresh outcome, display unavailable/absent/no-key distinctly, and reserve the completion/reread message for the corresponding successful result. Preserve the previous model list on failure. Add component tests for HTTP-200 semantic failure, not only rejected requests.

No further concrete defects in the assigned LLM/content lane. General persistence, transport resource cleanup and UI behavior belong to the other expert reports.


### saarinen

# Saarinen — visual UI quality

No actionable visual findings in the scoped improvement-radar diff.

Reviewed the new component and its tests, HomePage placement, SettingsPage changed result copy and matching test, API contract changes, implementation/plan documentation and knowledge-base addition. Inspected all four committed preview screenshots (desktop collapsed/expanded, mobile light/dark) and the supplied rendered-check evidence.

The collapsed muted disclosure keeps the composer dominant. Expanded content uses existing semantic foreground/muted/border/hover tokens, a clear title/benefit/secondary-information hierarchy, consistent spacing and quiet controls; mobile wraps without clipping in the supplied 390px views. No new modal, shadow, animation, raw palette value or saturated status decoration was introduced. The Settings copy uses the existing banner treatment.

Evidence limits: screenshots are fixture-based component previews rather than a full production HomePage capture; this visual review does not certify unrelated existing HomePage/Settings UI. Accessibility and interaction-flow judgments remain with their respective reviewers. No source edits made.


### hashimoto

# Hashimoto — deployment and release review

## Findings

No actionable findings introduced by the reviewed diff (P1: 0, P2: 0, P3: 0).

## Evidence and scope

Read all assigned files, the deployment reference, relevant deployment/isolation knowledge entries and the Phase 0 brief. Followed the new persistence dependency into `radar-store.ts` and the existing atomic writer packaging boundary.

- The new scheduler is installation scoped, disabled by default, bounded by a 60-second deadline, uses an unreferenced interval and catches asynchronous scheduled failures. Shutdown disposes the interval and aborts acquisition before other teardown; it does not introduce additional shutdown grace or session lifecycle changes.
- Radar state uses the existing `COMPANION_HOME` root and atomic JSON helper. The new server modules are included by the existing npm `server/` package entry; no new dependency, lockfile, binary installation, credential, image input or external service is required.
- CLI version probes use the existing service-aware executable resolver with fixed arguments, a two-second timeout and a bounded output buffer.
- The existing release workflow has SHA-pinned actions and explicit least-privilege permissions; this diff does not change its behavior. The package, hook and production deployment documentation are unchanged by the feature.
- Phase 0 records passing typecheck/build/a11y and successful reruns of the environment-dependent test failures. This review did not execute a production request, restart, deployment or release.

## Deployment verification boundary

A server restart is needed for the new backend routes. The authorized deployment should continue to use an independent supervisor process, existing systemd `KillMode=process`, service-user ownership, readiness checks and listener-PID identity verification. Those are deployment acceptance checks, not defects in this source diff. No claim is made here that the production rollout has already passed them.


## One follow-up round

# Security/backend fix follow-up

No remaining or new concrete security/backend defects found in the assigned fix diff. No NEW P1 in fixes.

HUNT-1 is resolved at both route and store boundaries: only literal string decisions are accepted before writes, with route regressions preserving bytes and later GET availability. HUNT-2 is resolved by per-backend shared promises and a sixty-second cache for both success and unavailable observations; fixed argv, two-second timeout and output limits remain intact.

DAHL-1 cancels non-success bodies while preserving sanitized errors. RIT-1 retains prior evidence first at the hundred-item partial-scan cap. FOWLER-1 retains independently validated decision evidence, keeps older version-one stores readable, restores available evidence without deleting decisions on capacity errors, and retains the overall 512KB atomic-write limit. The documented restore-at-cap rejection is bounded behavior, rather than corruption or silent loss.

Verification: five targeted suites passed, 28 tests passed (model freshness, store, runner, sources and radar routes). Reviewed original FINAL-REVIEW.md, implementation red/green evidence, full unstaged assigned fix diff and associated tests. No source edits.


# Single follow-up fix review — Abramov

Reviewed unstaged frontend changes against index, FINAL-REVIEW.md, the implementation fix log, and the updated component regressions. No source edits.

**Remaining findings: none. New findings: none. NEW P1 in fixes: none.**

- ABR-1: polling now serializes status reads, skips mutation windows and rejects responses from an earlier revision. The deferred GET → POST success → stale GET regression preserves the acknowledged decision and counts.
- WATSON-1: successful restore/dismiss/implement actions return focus to the stable outer summary; failed actions do not move focus away from their control.
- UX-2: failed initial loading offers an explicit retry, repopulates source configuration, clears the error and enables scanning after recovery.
- FOWLER-1: archived decisions resolve title/source from decisionIdeas rather than relying on replaceable current scan candidates; both implemented and dismissed lists consume archived evidence.
- WILLISON-2: semantic unavailable/absent/no-key results have accurate messages, and unsuccessful outcomes do not trigger selector reload.

Independent verification: `bun run test src/components/ImprovementRadar.test.tsx --maxWorkers=1` — 1 suite, 14 tests PASS. Existing jsdom canvas warnings from axe are nonfatal; render/axe/interaction assertions passed. This scoped follow-up does not replace the full deterministic post-fix gate.


# Kent Beck — one follow-up review of fixes

Reviewed the unstaged fix/test diff against the index, the twelve-item synthesis, implementation mapping, and supplied red/mutation logs. No source edits or additional review round performed.

**Verdict: no remaining/new concrete test-quality findings. No NEW P1 in the fixes.**

All twelve synthesized findings have a corresponding meaningful regression test:

- HUNT-1: real Hono/store rejection checks status, byte preservation and subsequent readable state; direct untyped store input is independently rejected.
- HUNT-2: twenty simultaneous callers exercise actual in-flight sharing, resolved reuse, expiry and cached failure, with the subprocess as the only new mocked boundary.
- DAHL-1: actual streaming HTTP responses exercise body cancellation for three failure statuses and preserve sanitized error text when cancellation itself rejects.
- RIT-1: real persistence/evaluation exercise a full hundred-record old dataset against a hundred new records with one failed source, checking retained identities.
- FOWLER-1/UX-1: successful scan replacement removes live candidates, a newly constructed store reads archived evidence, and restore rehydrates the original proposal. The separate frontend test checks visible archived title, actual provenance href and axe after expansion.
- ABR-1: a controlled deferred GET completes after acknowledged POST; the visible count must remain the mutation result.
- BECK-1: the positive fake-clock schedule persists findings at a due tick, avoids another run inside the day, then runs once at the next due tick. The supplied scheduled-call-deletion mutation fails with zero calls instead of one.
- BECK-2: exact trusted executable/version argv and finite subprocess bounds are now asserted, plus callback failure and output truncation. The supplied argv mutation fails the command-boundary assertion.
- WATSON-1: both restore variants assert actual surviving focus after a successful API result, rather than simulating the final focus state.
- UX-2: the initial GET rejection recovers through the real retry button and re-enables scan while removing the alert.
- WILLISON-1: actual fork identity and case variants have explicit suppression expectations.
- WILLISON-2: both backend semantic failures produce backend-specific failure copy and prevent selector reload.

The supplied UI/probe/final red logs show behavior-specific pre-fix failures; the two Beck mutation logs show the newly protected contracts are mutation-sensitive. Existing assertions were retained. No claim is made that targeted test review substitutes for the final full deterministic checks, which the release gate still requires.
