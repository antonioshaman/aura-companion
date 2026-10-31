# Friedman — UX planning findings

Scope: assigned Home, launch, Sidebar, Composer, KB cards, Agents and Runs source; paired tests reviewed narrowly. Planning only. Evidence below is current-code inspection, not a claim of browser or physical-device reproduction. No production/KB actions or CLI sessions executed. Read quality-ux.md, evaluation-method.md, platform-ios.md and applicable conventions (including explicit stale/error semantics). Aura remains a web/PWA; native iOS navigation rules are not automatically imposed on it.

## R1 — Fetch failures impersonate valid empty/live lists

- **Verified current code; AC5, AC9. Platform:** web/PWA, both CLI backends. **Nielsen:** visibility of system status; help users recognize, diagnose and recover from errors. **Severity 3 / P2.**
- **Evidence:** `web/src/components/AgentsPage.tsx:85–109` catches list failure without setting error, then clears loading; the initial failure renders “No agents yet” at line 566. `web/src/components/RunsPage.tsx:63–79` only logs list failure; line 173 renders “No executions found” on initial failure. After successful polling, a failed poll retains old executions without any stale/error indication. Users cannot tell that their data was unavailable and can wrongly conclude there are no agents/runs or that a stale run remains active.
- **Smallest change:** distinguish initial unavailable, successful empty, loaded and stale-after-refresh states. Show an inline explanation and Retry in the failed list; retain last good rows during refresh failure and mark them stale. Preserve filters and selection. Agents load and Runs executions failures should not suppress unrelated usable controls; agent-name lookup failure on Runs needs a quiet separate fallback rather than blanking executions.
- **Red-first verifier:** paired page tests reject `listAgents`/`listExecutions`; assert an unavailable state and retry recovery, and no false empty-state claim. Resolve one poll, reject the next: prior rows remain with stale notice, then recovery clears it. Include normal empty render, axe and Retry interaction. Document these failure states in the scenario register.
- **Dependencies:** none; implementation can be one list-state task spanning the two pages. Respect the convention that initial error and stale-data error have explicit semantics.

## R2 — Runs filters can show results from an earlier filter

- **Verified current code race; AC1 (same late-response principle), AC5, AC9. Platform:** web/PWA, both backends. **Nielsen:** consistency and standards; visibility of system status. **Severity 3 / P2.**
- **Evidence:** `web/src/components/RunsPage.tsx:63–79,93–99`: each filter change starts another asynchronous request; old requests and 5-second polls have no cancellation/generation guard. Every completion assigns executions and total. A delayed “all” response arriving after “error” replaces the error-filtered rows while the Error filter stays selected. Earlier pending polls can similarly overwrite newer results. This is distinct from the Home navigation defect fixed in PR449.
- **Smallest change:** discard results and failure/finalization state from superseded request generations; guarantee the newest request for the active filters owns rows, total and loading. Keep prior rows during refresh, with pending indication if their filter no longer matches, rather than silently presenting them as current.
- **Red-first verifier:** use two deferred list promises in `RunsPage.test.tsx`: select Error, resolve its response, then resolve the old All request; only Error rows/count remain. Add overlap of successive same-filter polls and a late rejection to ensure it cannot overwrite the latest success/error state.
- **Dependencies:** coordinate with R1 in the same Runs state patch to avoid two competing request-state implementations.

## R3 — Composer exposes an internal permission enum as the mode label

- **Verified current code rendering path; AC4, AC7. Platform:** web/PWA, both backends. **Nielsen:** match between system and real world; error prevention. **Severity 3 / P2** because the label describes operational permissions.
- **Evidence:** `web/src/components/Composer.tsx:102–106` defaults missing permission mode to `acceptEdits` and displays the raw value when it is not in the backend mode options. `web/src/utils/backends.ts:124–132` offers only bypassPermissions and plan, so acceptEdits is raw for either backend (including the Codex screenshot scenario). The label is rendered in both Composer layouts at lines 671 and 883. This proves the display behavior; it does not prove which producer supplied the screenshot value or the actual Codex enforcement policy.
- **Smallest change:** map known legacy modes to truthful human language and explain their effective behavior; show “Mode unavailable” or an equivalent honest loading/unknown state when enforcement cannot be determined. Keep backend permission value unchanged. Never label acceptEdits “Auto/Agent” merely to hide the enum. Trace the screenshot producer before deciding whether a backend normalization bug is also present.
- **Red-first verifier:** parameterize Composer tests for Claude/Codex × plan/bypass/acceptEdits/missing/unknown modes. Assert readable, accurate labels in both layouts and zero permission-change messages caused solely by rendering. Preserve explicit toggle tests and add utility tests for any display-only helper. Reflect changed chat states in Playground.
- **Dependencies:** backend/LLM seat confirms legacy-mode meaning; display-only fix does not require a protocol migration.

## R4 — Reconnect prevents preparing the next message

- **Verified current code; AC2, AC5. Platform:** web/PWA, both backends. **Nielsen:** flexibility and efficiency of use; user control and freedom. **Severity 2 / P3.**
- **Evidence:** `web/src/components/Composer.tsx:774–780` disables the textarea whenever CLI connection is absent. A temporary reconnect prevents even typing/editing a local draft. The comment above cliFailed promises a typeable composer, but disconnected terminal sessions still hit the disabled attribute. This finding concerns local preparation, not authorization to send while offline.
- **Smallest change:** allow editing during reconnect/offline/terminal states while retaining existing submission gates and visible connection/recovery explanation; keep the draft when connectivity returns. This does not require an offline dispatch queue.
- **Red-first verifier:** start connected, type, disconnect, edit draft, reconnect: full edited text survives; send via button/Enter while disconnected emits nothing. Repeat with cliFailed. Update existing tests that encode disabled textarea behavior only where the intended contract changes, and add the affected Playground state.
- **Dependencies:** coordinate with Composer mode change; no backend change.

## Explicit non-findings and acceptance gaps

- PR449's navigation/update/editor fixes are not reopened here. No evidence for sweeping IA, modal or decorative changes was found in this narrow review.
- KB archive is one-click (`KbCards.tsx:228`) but has a visible consequence statement at line 270 and records an archive, so I do not add confirmation friction solely from the presence of an Archive button. The reproduced archive data-loss and report/race defects in the existing backlog require the backend owners' verifiers under AC8; a reassuring “nothing is deleted” sentence cannot substitute for those fixes.
- No browser verification is claimed. Physical iPhone/PWA acceptance still needs keyboard open/close, safe areas, 320/390/439 CSS px layouts, background/reconnect, and VoiceOver/focus checks. Existing axe incomplete results remain unresolved evidence, not PASS. Device outcomes should be attached to the consolidated scenario register after implementation.
- Optional subsequent usability round: five actual Aura users, 3–5 goal-phrased tasks (resume yesterday's work; prepare a follow-up while the connection recovers; discover whether an automated job failed; change a mode and explain its consequence), neutral facilitation, success/partial/fail and time on task, then retest fixes. This is additional human evidence, not a prerequisite for the proven code-path repairs above.
