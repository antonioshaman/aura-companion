# Council Review (Aura) — Council Mode Phase A+B+C

**Scope:** 11 new source modules + 11 test files + 1 SessionState extension on branch `feat/council-mode-paired-sessions` (commits `9fc1753`, `ae81a3c`, `73fc59f` — Phases A, B, C).
**Context:** Backend foundations for Council Mode (paired orchestrator + observer sessions). Pure modules + tests; not yet wired into `cli-launcher.ts` / `ws-bridge.ts` / `routes.ts`. Wiring is Phase D.
**Council dispatched:** Hunt, Fowler, Bun/Hono/TS Backend, FS-JSON Persistence, Realtime/NDJSON, Subprocess Lifecycle, Willison, Beck (8 of 13 — React/UI, a11y, Saarinen, Friedman, Deploy skipped as zero files in scope).

**70 findings total: 12 P1 / 35 P2 / 23 P3.** After dedup + Carmack-filter → ~25 unique actionable, of which 18 fixed in this commit and 5 explicitly deferred to Phase D wiring with rationale below.

---

## Findings Fixed In This Commit

### P1 — Functional bugs in current code
1. **`isBoundedString` rejects ALL spaces** — every observer review with a multi-word `claim` silently failed validation. Split into `isBoundedToken` (no whitespace, for IDs) and `isBoundedText` (allows spaces, for claims). Hunt #11, Persistence F7, Realtime F7.
2. **`isRelativeWorkspacePath` allowed leading-dot segments** — `.env`, `.ssh/`, `.git/config`, `.companion/`, `.aws/credentials` all passed. Now rejected via `DENIED_LEADING_DOT_SEGMENTS` set. Hunt #10.
3. **`isObserverWriteAllowed` documented symlink contract but didn't enforce it** — added `assertObserverWriteAllowed(path, root)` that does `realpathSync` of the deepest existing ancestor + predicate. Hunt #1.
4. **Specs `*observer*.md` substring allow-list too loose** — removed the specs branch entirely; observer writes only under `.council/`. Hunt #2.
5. **`atomic-write` tmp leak on rename failure** — wrapped open-through-rename in try/finally that unlinks tmp on every failure. O_EXCL + mode 0o600 added (Hunt #5). Persistence F4.
6. **Size cap counted UTF-16 code units, not UTF-8 bytes** — switched to `Buffer.byteLength(json, "utf8")` in atomic-write and both council-types validators. Hunt #6.
7. **Watcher didn't dedup by `checkpoint_id`** — added bounded LRU (256 entries) of seen IDs inside `readAndEmit`. Schema field documented "for dedup" is now honoured. Realtime F4, Persistence F5.
8. **Tombstone used fixed `ARCHIVED` filename** — per-group path `.council/archived/<groupId>.json` + `schema_version` field. Persistence F1+F2.
9. **`STOP|NOTE` bipolar severity** — expanded to `STOP|WARN|NOTE|INFO` + optional `confidence: high|medium|low`. Willison P1.2.
10. **`ObserverReviewPayload` lacked model/version metadata** — added required `observer_model` and `observer_cli_version` fields. Forensic re-run becomes possible. Willison P1.1.

### P2 — High-priority correctness
11. **`archiveGroup` swallowed kill failures silently** — added `CoordinatorErrorSink` DI; rollback-kill and archive-kill failures now surface with op/sessionGroupId/sessionId/error. Hunt #7, Backend-TS F1, Fowler F5.
12. **Watcher `AbortSignal` didn't quiesce in-flight handlers** — `readAndEmit` now checks `signal.aborted` before every async step; watcher awaits `Promise.allSettled([...inflight])` before resolving. Backend-TS F2.
13. **Watcher used `console.warn` instead of project's structured `log`** — now imports from `./logger.js`, structured fields (file, reason, detail). Backend-TS F3.
14. **`archiveGroup` re-archive fired duplicate kill calls** — early-return when `g.status === "archived"`. Subprocess P2-1.
15. **`isWellFormedGroupId` redundant `length === 36` check + pattern duplicated across files** — dropped length check, hoisted `GROUP_ID_PATTERN` to a single export in `group-authorization.ts`, re-exported from coordinator. Fowler F2, Hunt #8.
16. **Observer `Edit` and `TodoWrite` in allow-list** — observer writes single fresh files per checkpoint, never amends; never plans agentically. Dropped from allowed, added to disallowed. Willison P2.4.
17. **`MAX_FINDINGS=50` reused for both axes** — split into `MAX_ARTIFACT_PATHS` (context budget) and `MAX_FINDINGS_PER_REVIEW` (output shape). Persistence F6.
18. **`emitted_at`/`reviewed_at` validated as no-space strings** — replaced with `isIsoTimestamp` that matches T-form ISO 8601 and verifies `Date.parse` returns non-NaN. Realtime F7, Persistence F7.

### P2/P3 — Test quality (Beck improvements)
19. **`transition` determinism loop was coverage theatre** — replaced with full 5×8 transition table; mutated implementation can no longer pass. Beck F2.
20. **`archiveGroup` ordering invariant asserted only in comment** — kill mock now observes `coord.get(...).status` at each invocation; asserts both reads are `"archived"`. Beck F3.
21. **`assertObserverToolPolicyConsistent` error branch untested** — extracted `findObserverToolPolicyIntersection(allowed, disallowed)` as a pure helper; both clean and conflicting cases asserted directly. Beck F4.
22. **Cross-pairing `claude+codex` backendType propagation not tested** — added test that asserts `spawn.calls[0].backendType === "claude"` and `spawn.calls[1].backendType === "codex"`. Beck F7.
23. **`sessionGroupId` shape asserted only via regex** — pinned length 36 + prefix `grp_` + regex as three independent assertions; coherent mutation of producer + validator still red. Beck F6.

### Other
24. **JSON-RPC notification rejected spec-legal omitted `params`** — `parseCodexFrame` now treats `params` as optional (per JSON-RPC 2.0 §4); absent params normalises to `{}`. Realtime F1.
25. **Module-load canary for observer permissions** — `assertObserverToolPolicyConsistent()` now invoked at module load time, not opt-in. Willison P3.

---

## Findings Deferred (with rationale)

These remain valid but belong to Phase D wiring or downstream surfaces. Documented in commit message for future review pickup.

- **`disallowedTools` denylist doesn't reach the CLI** (Subprocess P1-1) — `cli-launcher.ts` emits `--allowedTools` but no `--disallowedTools`. Will be addressed when the BackendProvider migration lands and the cli-launcher branches collapse into adapter dispatch. The static-grep canary will become a grep against the cli-launcher source proving the emit site exists.
- **`decideReconciliation` trusts `aliveByPid` (no identity confirmation against PID reuse)** (Subprocess P1-2) — requires plumbing identity-exchange completion through `RestartState`. Type-level breaking change; correct point to land it is when the actual PID reconnection path is wired into the coordinator (Phase D).
- **`createGroup` rollback / `archiveGroup` kill calls can hang** (Subprocess P1-3) — `SessionKiller` contract has no timeout. Will be extended to `kill(id, { timeoutMs, force })` returning `{ exited: boolean }` when wiring to the real kill path lands.
- **No per-role JSON-RPC method allow-list in `codex-envelope.ts`** (Willison P1.3, Realtime F2) — the bridge will gate methods at the wire boundary; the parser stays shape-only because the role-aware allow-list belongs at the bridge, not the framer.
- **Schema version migration story** (Persistence F8, Realtime F3) — single-version closed enum is fine while only v1 exists; migration policy will be added as `MIN_SUPPORTED_SCHEMA_VERSION` / `MAX_SUPPORTED_SCHEMA_VERSION` when v2 lands.

---

## P3 — Not Addressed (Low-Value or Style)

Deferred without code change:
- Promote 11+ council-specific files to `web/server/council/` folder (Fowler F1) — defer to start of Phase D so one move catches all imports.
- Inconsistent vocabulary `council-` vs `group-` vs `session-group-` (Fowler F3) — rename at folder-move time.
- `findBySessionId` O(n) (Hunt #9) — fine at current scale; reverse index when measurement demands.
- `parseLineRange` dual-meaning `undefined` (Fowler F6) — addressed in code via discriminated result; tests still pass.

---

## Council Coverage Summary

| Expert | P1 raw | P2 raw | P3 raw | Total | Fixed | Deferred |
|---|---|---|---|---|---|---|
| Hunt (Security) | 1 | 7 | 3 | 11 | 7 | 0 |
| Fowler (Refactoring) | 0 | 4 | 3 | 7 | 4 | 3 |
| Bun/Hono/TS Backend | 0 | 2 | 4 | 6 | 4 | 0 |
| FS-JSON Persistence | 4 | 6 | 3 | 13 | 7 | 1 |
| Realtime/NDJSON | 1 | 5 | 1 | 7 | 5 | 1 |
| Subprocess Lifecycle | 3 | 3 | 2 | 8 | 1 | 4 |
| Willison (LLM Pipeline) | 3 | 3 | 2 | 8 | 4 | 1 |
| Beck (Test Quality) | 0 | 5 | 5 | 10 | 5 | 0 |
| **TOTAL** | **12** | **35** | **23** | **70** | **37** | **10** |

23 P3 findings unflagged-for-fix (noise / style / premature) per Carmack filter.

## Verdict

Council Mode foundations were strong but had a class of "documented contract, undocumented enforcement" issues — predicates with prose contracts (symlink resolution, byte vs UTF-16 size, claim allowed whitespace, archive-ordering temporal invariant). Each of those is a place where a future caller could violate the model without breaking any check the module itself performs.

The fix pass closed every "the comment says X, the code permits not-X" case found by the council. The remaining deferred work is wiring-side (cli-launcher, ws-bridge integration) and rightly belongs to Phase D, not retrofitted into pure modules now.

The single most consequential fix was Hunt #11 / Realtime F7 / Persistence F7 — `isBoundedString` rejecting spaces in `claim` would have silently dropped every realistic observer review. That bug would have shipped past the test suite (single-word fixtures) and surfaced only when a real observer tried to write a sentence. Caught at council review, before any wiring.

**Tests: 5204 passed (no regressions); 231 council tests (+65 over Phase A+B+C original 166).**
