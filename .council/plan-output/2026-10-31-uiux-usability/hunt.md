# Hunt — integrity and permission acceptance boundaries

Planning only. Read `security.md`, the confirmed brief, current assigned source and narrow dependencies/tests, applicable EC-7/EC-8 conventions, and the KB permissions entry. Verification below is independent source validation; I did not execute destructive probes, mutate KB/session state, or inspect a running browser. These are data-integrity findings, not claims of a remote exploit. Severity uses the brief's 0–4 usability scale.

## 1. Reject malformed nested reports before exposing decision controls

- **AC8; verified current code; severity 3.** `web/server/diagnostics/kb-analysis-store.ts:80–110` only checks finding ids/signals and the mergeTasks array. `signals:[null]` dereferences `s.signal` outside the JSON parse catch. A finding with no `entry` passes, then `KbCards.tsx:207` reads `f.entry.fact`; `memory:{findings:null}` passes and fails in `KbCards.tsx:369` or `kb-decisions.ts:49`. Concrete vector: malformed locally persisted analyzer output makes Diagnostics or decision validation throw rather than returning an unavailable report. No attacker control or XSS demonstrated.
- **Principle:** security P2 (runtime boundary validation), P9 (design for failure). **Heuristic:** error prevention and recovery.
- **What to get right:** Make report validation total over unknown JSON. Validate every nested field read by cards or decision validation, including object/non-null checks, arrays, scalar types/enums, finite numeric values and nullable memory/createdAt; reject the whole malformed report as `report-invalid`. Preserve newer-schema behavior, and avoid coercing missing entry content into a usable destructive decision.
- **Risk if skipped:** A report advertised as available can break the page or mutation endpoint and strand recovery.
- **Red-first verifier:** Table-driven `kb-analysis-store.test.ts` fixtures for null signal, missing entry, malformed affectedFiles/provenance, bad memory findings/signals and merge task items; assert no throw and unavailable/report-invalid. Add status/route coverage proving invalid reports cannot produce valid decisions or writes. Render the unavailable state in the existing component tests with axe and recovery behavior.
- **Depends on:** —. No schema migration or generic validation framework required.

## 2. Recheck analysis state after request parsing, immediately before decisions

- **AC8; verified current code; severity 3.** `web/server/routes/diagnostics-routes.ts:60–67` checks `isRunning()` before awaiting JSON. Analysis may start while that promise is pending; validate/apply then execute during the run. Disabling a button cannot close this server-side window.
- **Principle:** security P7 (assertions as tripwires), P9. **Heuristic:** error prevention and system-status accuracy.
- **What to get right:** Retain the early check if useful, then recheck after body parsing directly before the synchronous currentReport/validate/apply sequence. A newly running analysis returns the existing stable 409 and performs no apply, afterDecisions, sentinel or ledger write; stale report runId must still yield 409 after a completed intervening run. With the present single-process synchronous critical section this closes the demonstrated await gap; introducing another await would require re-evaluating exclusion.
- **Risk if skipped:** An owner decision can mutate the KB against an analysis currently calculating its findings.
- **Red-first verifier:** In `diagnostics-routes.test.ts`, defer request-body resolution, flip mocked running false→true while pending, release body and assert 409 plus zero validate/apply/afterDecisions calls. Separately swap report runId during the wait and prove stale-request rejection. Preserve the success case.
- **Depends on:** Nested validation above for malformed-report cases; race fix itself is independent. This is not a cross-process locking guarantee.

## 3. Make archive content-safe before retaining the “nothing is deleted” assurance

- **AC8; verified current code; severity 4.** `web/server/knowledge/kb-store.ts:455–475` treats any matching archived id as proof the live content is saved, sets completed-partial, and removes the live row. An owner-restored, edited row with the same id loses its new content while the archive retains the old version. `KbCards.tsx:272` explicitly promises “nothing is deleted”; `kb-decisions.ts:104` regards completed-partial as completed.
- **Principle:** security P9; P8 (state the concrete failure). **Heuristic:** error prevention, match between system and real world.
- **What to get right:** Before removing a live row, prove an equivalent content version is already durable, or durably archive that version first. Compare substantive entry content excluding archive-only bookkeeping, not id alone. The minimum safe alternative is refusing the differing-version conflict and leaving live bytes intact; do not mark it completed or fold it into a successful owner decision. Preserve same-content crash-retry idempotence and sentinel-before-act ordering.
- **Risk if skipped:** The action presented as a reversible move destroys unique user-authored knowledge.
- **Red-first verifier:** `kb-store.test.ts`: archive OLD + restored live NEW sharing id; assert NEW remains recoverable after the operation, OLD survives, unrelated raw lines survive, and retry is safe. Cover refusal/failure in decision tests so neither ledger nor UI claims success when live content was not safely archived. Existing identical-content partial-recovery tests must remain.
- **Depends on:** Coordinate content equivalence and outcomes with filesystem/persistence expert. Cross-process append between identity check and rename remains a hypothesis requiring its own deterministic verifier; do not call this fix a complete concurrent-writer guarantee.

## Permission and scope acceptance notes

`Composer.tsx:102–106` defaults missing permission mode to `acceptEdits` and displays an unmatched raw value; this independently supports the reported confusing badge, but does not establish actual Codex permission escalation. AC4 acceptance must distinguish loading/unknown/incompatible values, derive a truthful label from backend-confirmed state, and assert rendering does not call mode-changing APIs. Do not map an unknown effective mode to a more permissive familiar mode merely to make the badge readable. Test both backends with missing mode, known mode and incompatible mode; confirm selected versus backend-effective state in a real CLI smoke separately. No additional security finding or protocol change justified by the screenshot alone.

No broad spawn/WS/auth/XSS sweep proposed: these fixes introduce no new endpoints, spawn paths or HTML rendering. Preserve authenticated route placement and existing resolving wrappers; report fields remain text through React. Physical iPhone/VoiceOver acceptance and live Claude/Codex permission confirmation remain separate, explicitly unverified evidence.
