# Spec Review Log — `PLAN-aura-consolidated-refactor.md`

External review history for the consolidated refactor meta-spec. Kept here (not inside the spec) so the spec itself stays a stable artifact rather than a negotiation transcript across cycles.

Findings are summarised; raw observer JSON is at `.council/reviews/council-plan-<provider>-observer.md` (overwritten on each new checkpoint — git history preserves prior contents per commit).

---

## v1 — checkpoint sequence 8

- **Emitted:** 2026-05-13T08:08 UTC
- **Observer:** claude-opus-4-7
- **Findings:** 1 STOP, 4 WARN, 2 NOTE

| Sev | Finding | Resolution |
|---|---|---|
| STOP | Task 14 baseline-capture timing operationally invalid — conflict markers break typecheck on unresolved tree, "baseline" universally red | **Fixed** — split into pre-merge + post-resolution baselines with explicit reasoning for skipping conflicted tree |
| WARN | Task 3 commit `25a27c4` claim unverified (trust-diff-not-prose in spec form) | **Fixed** — 4-step verification gate added (cat-file existence / show --stat / grep test bodies / re-measure coverage on throwaway cherry-pick) |
| WARN | Task 5 single integration test covers only 1 of 4 hypotheses (running-build invisible to RTL, overflow-y invisible to jsdom, stale preflight cache server-side) | **Fixed** — expanded to 4-step disambiguation path: step 1 live-environment runtime check, step 2 disambiguating test for actual cause |
| WARN | "Persisted message `streamStatus` field" orphaned in Risks despite being concrete implementable work | **Fixed** — promoted into Task 12 (schema versioning) with explicit migration semantics + mid-frame replay test |
| WARN | Task 15 bundle violates own block-discipline by mixing Hunt (security correctness) with Deploy (CI/Docker hygiene) in one reviewable unit | **Fixed** — split into 15a (security baseline) and 15b (CI/Deploy hygiene) |
| NOTE | Task 1 `deriveSideEffects` file citation ambiguous vs CLAUDE.md (pure-transition file vs coordinator surface) | **Fixed** — first step is now grep-both-files before opening test, implementer follows the symbol |
| NOTE | Task 11 redaction "streaming regex, not parse-and-restringify" misses that streaming regex over JSONL escape sequences can produce unparseable lines | **Fixed** — format-aware redaction with two safe shapes documented (parse-then-mutate with `raw_sha256` sidecar OR streaming-regex with mandatory post-validate + quarantine path) |

---

## v2 — checkpoint sequence 9

- **Emitted:** 2026-05-13T08:18 UTC
- **Observer:** claude-opus-4-7
- **Findings:** 1 WARN, 1 NOTE, 1 INFO

| Sev | Finding | Resolution |
|---|---|---|
| WARN | v1 promoted ONE orphan from Risks (streamStatus) but missed others — Realtime sequence-number coverage on `group_*` + `observer_review`, Persistence idempotent state transitions, Subprocess preflight-probe cache invalidation all named concrete implementable work without a task owner | **Fixed** — Realtime sequence-number coverage promoted into Task 1 acceptance; Persistence idempotent state transitions promoted into Task 4 acceptance with concurrent-signal harness; Subprocess preflight-probe cache invalidation promoted into Task 7 acceptance with `POST /api/preflight/invalidate` endpoint + lazy revalidation; Risks bullets removed |
| NOTE | "Observer Review History" section inline in spec creates spec/review coupling that compounds across cycles, spec ceases to be stable artifact | **Fixed** — review history extracted to this external log file; spec carries only a one-line pointer |
| INFO | All seven v1 findings landed cleanly; fixes are precise across STOP+4 WARN+2 NOTE | (confirmation only) |

---

## v3 — checkpoint sequence 10

- **Emitted:** 2026-05-13T08:31 UTC
- **Observer:** claude-opus-4-7
- **Findings:** 1 WARN, 2 NOTE, 1 INFO
- **Outcome:** SHIPPED AS STABLE per stop rule (residual findings recorded below as known follow-ups, no v3 patch round)

| Sev | Finding | Disposition |
|---|---|---|
| WARN | v2 row in this log misrepresents the v2 finding — observer claims v2 enumerated FIVE orphan sub-findings (Realtime sequence, Persistence idempotent, Subprocess preflight, React Wallclock-tick source, Friedman tier-mismatch reasoning), not three. v2 row lists only first three, claims "Risks bullets removed" as if that closed the WARN. | **Known follow-up.** During implementation of Tasks 1/4/7/8, re-evaluate whether the React Wallclock-tick source and Friedman tier-mismatch reasoning need explicit acceptance criteria or whether existing task coverage subsumes them. Spec ships as stable; this is implementer-vigilance, not blocking. |
| NOTE | Task 1 acceptance — "monotonic seq" is necessary but not sufficient proxy for "passes through the same `sequenceEvent` + `eventBuffer` path". Two divergent implementations could both emit monotonic seq from independent counters and pass the test. | **Known follow-up.** When implementing Task 1, tighten the assertion to verify the seq originates from the shared `sequenceEvent` call site (e.g. spy on it, assert call count) rather than just observing monotonicity on captured descriptors. |
| NOTE | Task 4 acceptance — "identical EC-9 log emission count" leaves "identical to what" implicit. Two divergent implementations could both produce two identical-to-each-other (but wrong) counts and pass. | **Known follow-up.** When implementing Task 4, name the expected count explicitly (e.g. "exactly 1 emission across both calls — the second call must be a no-op at the log level too, not a duplicate emission"). |
| INFO | Three of five v2 orphan promotions landed precisely; review-history extraction landed correctly (spec footer carries only one-line pointer, spec body is stable). | (confirmation) |

---

## Post-ship plan mutations

The plan was marked stable at v3, but observer review during Task 5 source-side preparation surfaced a hypothesis the original plan got wrong. Recorded here so future readers don't read the v3 stable snapshot as final without context.

### Task 5 hypothesis mutation — 2026-05-13T15 UTC

- **Trigger:** Observer source-side prep on `SettingsPage.tsx` + `HomePage.tsx` + `preflight-probe.ts`.
- **Mutation:** Retire hypothesis (d), add hypothesis (e).

| Action | Hypothesis | Rationale |
|---|---|---|
| **Retire** | (d) stale preflight-probe cache disabling the Codex path | `web/server/preflight-probe.ts` exists + is tested but is NEVER CALLED FROM PRODUCTION CODE. `HomePage.tsx:127-133` derives `codexAvailable` live from the `backends` array every render with no cache. There is no cache to be stale. Hypothesis cannot apply. Separate backlog item: `preflight-probe.ts` is unwired exported code — wire (per its module docstring) or delete (YAGNI). |
| **Add** | (e) masked-value React control input race | `SettingsPage.tsx:633` reads `value={configured && !focused && !key ? "••••••••••••••••" : key}`. If focus event fails to fire (mobile webview, CSS `pointer-events`, overlay z-index), input stays in masked-display mode and typed chars append AFTER the dots into state, saving `"••••••••••••••••a"` silently. Runtime check: DevTools observe `openaiKeyFocused` state on click; type "a" and read `openaiApiKey` state. |
| **Preserve** | (a) running build older than disk source | Runtime check at live browser: `ss -tlnp` start time vs latest commit; bundle hash grep. |
| **Preserve** | (b) IntersectionObserver re-attach race on `[loading]` deps | Confirmed code path exists at `SettingsPage.tsx:118`. RTL integration test disambiguates. |
| **Preserve** | (c) ancestor overflow-y locks scroll | `contentRef` has intended `overflow-y-auto` at line 315; ancestors uninspected. Playwright/agent-browser needed. |

Spec body updated in same commit; v3 stable snapshot superseded for Task 5 only. Tasks 1-4 / 6-15 v3 snapshot remains stable.

---

## Stop rule

Per `feedback_agent_self_review_loop_gates` — self-review loops without objective gate hit diminishing returns. Hard cap: if v3 returns ONLY NOTE/INFO findings, ship spec as stable. Any new STOP/WARN at v3 → still ship spec with residual findings recorded here as known follow-ups, NOT another patch round. The spec's job is to converge to "good enough for first implementation task to start"; perfection across review cycles costs more than it saves.
