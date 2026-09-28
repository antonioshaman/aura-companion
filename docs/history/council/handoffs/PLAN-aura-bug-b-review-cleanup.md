# Council Plan (Aura): Bug B Review P2/P3 Cleanup

**Scope:** Apply 6 P2 + 4 in-scope P3 findings from Council Review 2026-05-15-0820 to close the bundled observer-prompt fallback review fully. Server-only refactor; no wire-protocol, no UI surface, no persistence schema bump.
**Context:** Bug B (commit `ccfe8ba`) shipped the bundled fallback. P1 fixes landed in `bf5da12`. This plan addresses the remaining structural cleanup + observability sharpening.
**Boundaries:** Server-side only. NO UI chip for `observerPromptSource` (separate cycle). NO full Task 12 drift-detection across happy-path `--resume` (Claude bakes prompt — out of scope). NO bundled-body CLI-portability edits (Willison W2 — separate ticket).
**Council dispatched:** Hunt (6 recs), Fowler (8), Backend (6), Subprocess (5), Willison (4), Beck (6), Persistence (no recs — defers to Backend), Realtime (1 rec on emit cardinality), Deploy (no recs — drift gate already wired).

---

## Convergent Decisions (3+ experts → structural truth)

**D1. Open decision (a) — Error.cause discriminator — RESOLVED: stamp `code` on loader wrapper, drop chain-walk.** Fowler + Backend independently converge: chain-walk loses to drift the first time another layer wraps; stamping `code` directly on `loadObserverSystemPrompt`'s thrown `new Error(...)` makes the contract one-place-grep-able. Cause-chain stays preserved for forensic depth. Resolver reads ONE named field. Hunt's cycle-detection / depth-cap concern (rec #4) is moot — no chain-walk to attack.

**D2. Open decision (b) — Runtime bundled-SHA re-check — RESOLVED: KEEP, with comment annotation.** Fowler explicitly REVERSED his own prior P3 #3 ("delete speculative"). Backend + Willison sided keep. Three independent reasons: (a) the parser already hashes — no double-hash cost; (b) catches bundler/preprocessor mutation (CRLF, minify-syntax) — a real class on the npm distribution path; (c) replay attribution depends on `BUNDLED_OBSERVER_PROMPT_SHA256` being the build-time witness AND the as-loaded witness. Annotate the comment to name the bundler-mutation hypotheses so future cleanup PRs don't delete the guard.

**D3. Open decision (c) — `resolveObserverPromptForSpawn` location — RESOLVED: free function in new file `web/server/observer-prompt-spawn.ts`.** Fowler + Backend converge: the function has zero `this` references — private-method form would close over nothing. Pure transform takes (cwd, options, info) → ({body, sha256, source, expectedPath, fallbackReason}). Unit-testable without CliLauncher instantiation. The launcher shrinks.

**D4. Subprocess override — emit `session:relaunch-failed` NOT `session:exited`** on prompt-config throw. Subprocess discovered the existing typed channel `session:relaunch-failed: {sessionId, reason}` (event-bus-types.ts:28) — already wired in `session-orchestrator.ts:711` to fast-fail the coordinator's reconnecting state through `reconnect_failed → group:degraded`. The original plan's `session:exited` proposal would have duplicated semantics under the wrong event name AND falsely incremented metrics-collector's exit-code histogram. Realtime's emit-cardinality concern is moot — using the right channel resolves it.

**D5. WARN log `expectedPath` — `(present, depth)` integer pair, NOT SHA hash.** Hunt's reasoning: workspace paths are guessable; a 16-hex truncated SHA is reversible against a small dictionary (`/Users/X/code/<repo>`, `/home/X/work/<repo>`). Categorical signal preserves diagnostic value without topology disclosure.

**D6. EC-19 canary — split placement.** Beck overrides Fowler #8: call-site canary lives in cli-launcher.test.ts (mirrors dispatchObserverWake canary at observer-prompt.test.ts:643-658 — but for the OPPOSITE direction). Pin presence of `resolveObserverSystemPrompt(` AND absence of `loadObserverSystemPrompt(` in the renamed spawn-config function's body.

---

## Task Sequence

### 1. Stamp `code` on loader wrapper + wrap `readFileSync` symmetrically

| | |
|---|---|
| **Domain** | Fowler × Backend × Persistence — convergent (3-expert structural truth) |
| **Ref** | `references/quality-backend.md` → P1 (operational errors handled) + P8 (type safety at boundary); `references/refactoring.md` → P4 (names reveal design) |
| **Depends on** | — |

In `observer-prompt.ts:loadObserverSystemPrompt`'s `statSync` catch, after wrapping with `new Error(msg, {cause: err})`, also stamp `(wrapped as Error & {code?: string}).code = (err as {code?: string}).code` before throwing. Apply the SAME wrap+stamp idiom to a new try/catch around `readFileSync` (currently unwrapped — the resolver's ENOENT gate is asymmetric). Persistence concern addressed: the contract becomes symmetric across both fs calls; the resolver discriminates by reading one named property.

---

### 2. Drop cause-chain walk in resolver; read direct `err.code`

| | |
|---|---|
| **Domain** | Fowler × Backend × Hunt — convergent |
| **Ref** | `references/refactoring.md` → P4; `references/security.md` → P5 (shrink attack surface) |
| **Depends on** | Task 1 |

In `resolveObserverSystemPrompt`, replace the `(err as {cause?: unknown}).cause` then `(cause as {code?: unknown})?.code` two-hop with a single `(err as {code?: unknown})?.code === "ENOENT"` check. Catch param typed as `Error & {code?: string}`. Hunt rec #4 (cycle detection / depth cap) becomes structurally moot — no chain to walk.

---

### 3. Keep runtime bundled-SHA re-check; annotate the comment with bundler-mutation hypotheses

| | |
|---|---|
| **Domain** | Backend × Fowler × Willison — convergent (3-expert structural truth) |
| **Ref** | `references/quality-llm.md` → P9 (determinism — same bytes, same effect); `references/quality-backend.md` → P1 |
| **Depends on** | — |

The check at observer-prompt.ts:224-228 stays. Comment expanded to name the three hypotheses each gate covers: CI canary (source-tree drift) + test-time pin (build-output drift) + runtime re-hash (post-build bundler mutation: CRLF normalization, minify-syntax, template-literal preprocessing, npm pack/unpack line-ending shifts). No double-hash — parser already returns `bundled.sha256`; the gate just compares against the stamped constant.

---

### 4. Half-rename `sourcePath → sourceLabel` at the validator + interface field; KEEP `loadObserverSystemPrompt(sourcePath)` argument

| | |
|---|---|
| **Domain** | Fowler — P4 (names reveal design — names that lie are P2) |
| **Ref** | `references/refactoring.md` → P4 |
| **Depends on** | — |

`ObserverPromptArtifact.sourcePath` and `parseObserverSystemPromptBody`'s second arg become `sourceLabel`. The loader's own argument stays `sourcePath` — its contract IS path-shaped. The lie lives in downstream consumers who might `dirname(artifact.sourcePath)` against the bundled sentinel `<bundled:observer-system-v1>`. Touches ~6 sites; cheap honesty win. JSDoc-only would compound the doc-vs-code-drift class.

---

### 5. Add `loadBundledObserverPromptValidated()` helper in `observer-prompt.ts`; drop sentinel-path entirely

| | |
|---|---|
| **Domain** | Fowler × Hunt — convergent |
| **Ref** | `references/refactoring.md` → P2 (extract pure logic); `references/security.md` → P1 (eliminate attack surface) |
| **Depends on** | Task 1, Task 4 |

New private helper inside `observer-prompt.ts` (NOT in `observer-prompt-bundled.ts` — the bundle carrier stays dumb-by-design per Fowler #4): wraps the existing `parseObserverSystemPromptBody(BUNDLED_OBSERVER_PROMPT, BUNDLED_OBSERVER_PROMPT_SOURCE_PATH)` + SHA assert + source-tag block. Called from BOTH the resolver's ENOENT branch AND the new spawn-helper (Task 7). Eliminates the `/__aura_no_workspace_cwd_for_observer_prompt__/...` sentinel-path-as-control-flow indirection (Hunt rec #3 — closes multi-tenant-host plant vector).

---

### 6. Extract `resolveObserverPromptForSpawn` to new file `web/server/observer-prompt-spawn.ts`

| | |
|---|---|
| **Domain** | Fowler × Backend — convergent |
| **Ref** | `references/refactoring.md` → P2 (extract pure) + P6 (boundaries earn themselves); `references/quality-backend.md` → P7 (decouple) |
| **Depends on** | Task 5 |

Pure free function: `(opts: {cwd: string | undefined; sessionId; sessionGroupId}): {artifactBody, artifactSha, source, expectedPath, fallbackReason}`. Owns workspace-vs-bundled decision + no-cwd branch. Calls `resolveObserverSystemPrompt` for cwd-present, `loadBundledObserverPromptValidated()` for cwd-absent. Zero `this` references. The function is co-located with prompt resolution logic, not buried inside the launcher class.

---

### 7. Rename `applyCouncilObserverSpawnConfig → buildObserverSpawnOverrides`; shrink to compose-only

| | |
|---|---|
| **Domain** | Fowler — P4 (names reveal design) |
| **Ref** | `references/refactoring.md` → P4 |
| **Depends on** | Task 6 |

After extraction, the method shrinks to ~40 LOC: (a) early-return for non-observer; (b) call `resolveObserverPromptForSpawn`; (c) stamp `info.observerPromptSha256` + `info.observerPromptSource` + `info.permissionMode`; (d) compose LaunchOptions return. The "apply" verb in the old name promised side-effect-heavy behavior; the new name says "compose return value, with three named mutations on info". Mutations stay inline (not extracted into a helper — N=1 economic test fails per Fowler).

---

### 8. Replace WARN log `expectedPath` with `(present, depth)` integer pair

| | |
|---|---|
| **Domain** | Hunt — Security P3 (minimise state) |
| **Ref** | `references/security.md` → P3 |
| **Depends on** | Task 6 |

WARN log `council.observer-prompt.bundled-fallback` shape change: drop `expectedPath` (workspace dirname leak on shared log sinks); add `expectedPathPresent: boolean` + `expectedPathDepth: number` (segment count). The `<no-cwd>` sentinel value path is dropped along with the sentinel-path itself (Task 5). Preserves "did the operator have a workspace?" + "how nested was it?" diagnostic without dirname/username PII.

---

### 9. Rename WARN log field `bundledSha256 → observerPromptSha256`; add `source` + `observerPromptSourcePath` for grep parity

| | |
|---|---|
| **Domain** | Backend — P6 (structured logging — consistent field names) |
| **Ref** | `references/quality-backend.md` → P6 |
| **Depends on** | Task 8 |

`bundledSha256` in the WARN log entry currently differs from `observerPromptSha256` (the field on `SdkSessionInfo`). Same value, two names. Rename to match. Add `observerPromptSource: "bundled"` literal and `observerPromptSourcePath: BUNDLED_OBSERVER_PROMPT_SOURCE_PATH` for grep-symmetry with the EC-9 invocation log triplet (Task 12).

---

### 10. Emit `session:relaunch-failed` on relaunch's prompt-config throw (NOT `session:exited`)

| | |
|---|---|
| **Domain** | Subprocess — P4 (auto-relaunch bounded + visible); P7 (exit handler must not omit visibility) |
| **Ref** | `references/quality-subprocess.md` → P4, P7 |
| **Depends on** | Task 1 |

In `cli-launcher.ts:651-658`, BEFORE the `return {ok: false, error}`, emit `companionBus.emit("session:relaunch-failed", {sessionId, reason: "observer-prompt-config-failed: " + err.message})`. The channel is already typed at `event-bus-types.ts:28` and already wired at `session-orchestrator.ts:711` (`reconnect_failed → group:degraded` fast-fail). Coordinator's 45s reconnect-grace correctly skipped — the failure is deterministic, retry has zero chance. `intentionalKills` EC-2 invariant preserved.

---

### 11. Drift-detection in spawn helper: emit `council.observer-prompt.source-drift` on transition

| | |
|---|---|
| **Domain** | Subprocess × Willison — convergent |
| **Ref** | `references/quality-subprocess.md` → P5 (state drift after resume); `references/quality-llm.md` → P4 (replay determinism) |
| **Depends on** | Task 6 |

In the new spawn-helper, after resolving the new artifact: if `info.observerPromptSha256` was previously set AND new `(source, sha256)` differs, emit one-liner `log.warn("council.observer-prompt.source-drift", "observer prompt source drifted across relaunch", {event, sessionGroupId, sessionId, role:"observer", backend: info.backendType, relaunchCount: info.relaunchCount ?? 0, previous: {sha256, source, sourcePath}, current: {sha256, source, sourcePath}, cause: "session_exited"})`. Emit ONLY on real transition (identity transitions are noise). Inline emit per Fowler #7 — no helper at N=2.

---

### 12. Add `observerPromptSource` + `observerPromptSourcePath` to `formatObserverInvocationLog` (EC-9 triplet)

| | |
|---|---|
| **Domain** | Willison — P6 (recorder = observability) + P9 (determinism — same bytes, same effect) |
| **Ref** | `references/quality-llm.md` → P6, P9 |
| **Depends on** | Task 11 |

In `observer-attribution.ts:formatObserverInvocationLog`, add two sibling fields to existing `promptSha256`: `observerPromptSource: "workspace" | "bundled"` and `observerPromptSourcePath: string` (sentinel for bundled, abs path for workspace). The triplet (`promptSha256` + `observerPromptSource` + `observerPromptSourcePath`) is what replay tooling needs to reconstruct the loader decision; sha256 alone collides when workspace copies bundled body verbatim. `SdkSessionInfo` already carries both — plumb through the existing call site at `session-orchestrator.ts:2114`.

---

### 13. argv `--append-system-prompt` cardinality guards in Task 9 integration tests

| | |
|---|---|
| **Domain** | Beck × Backend — convergent |
| **Ref** | `references/quality-testing.md` → P6 (assertions are the test) |
| **Depends on** | Task 7 |

In `cli-launcher.test.ts` lines 1442-1447 + 1471-1474: prepend `expect(argv.filter(a => a === "--append-system-prompt").length).toBe(1)` before the `indexOf` → body assertion. For the non-observer row (line 1477): add negative assertion `expect(argv.indexOf("--append-system-prompt")).toBe(-1)` for symmetry. `.filter().length` form chosen over `.reduce()` (Backend/Beck convergent — readability of the assertion).

---

### 14. EC-19 canary on `buildObserverSpawnOverrides` body — lives in cli-launcher.test.ts

| | |
|---|---|
| **Domain** | Beck × Hunt — convergent (Beck overrides Fowler #8 placement) |
| **Ref** | `references/quality-testing.md` → P2 (structure-insensitive); conventions.md EC-19 |
| **Depends on** | Task 7 |

Mirror the `dispatchObserverWake` canary pattern. Read `cli-launcher.ts` source, extract `buildObserverSpawnOverrides` body via brace-counting, assert: positive `/resolveObserverPromptForSpawn\s*\(/` matches AND `/loadObserverSystemPrompt\s*\(/` does NOT match (negative-control load-bearing — closes the revert vector). Hunt rec #6: promote EC-19 to convention floor in CLAUDE.md so future reviewers don't relitigate the test-body anchoring contract. Also add a repo-grep canary asserting the literal `__aura_no_workspace_cwd_for_observer_prompt__` appears in ZERO non-test files (Hunt rec #3 — guards against sentinel-resurrection).

---

### 15. Test layer: `observer-prompt-spawn.test.ts` + 4 `loadBundledObserverPromptValidated` tests + drift-log spy + relaunch-failed assertion

| | |
|---|---|
| **Domain** | Beck — P4 (Beck economics — test what might break) + P5 (test list is analysis) |
| **Ref** | `references/quality-testing.md` → P4, P5 |
| **Depends on** | Task 6, Task 10, Task 11 |

(a) New `observer-prompt-spawn.test.ts` — 4 rows: workspace-present, cwd-absent → bundled, cwd-present + ENOENT → bundled, cwd-present + EACCES → throws. (b) `loadBundledObserverPromptValidated` minimum set: independent SHA (`createHash` direct), shape pin, header-parses canary, sourcePath sentinel pin. (c) Drift-log: `vi.spyOn(log, "warn")` + assert called with `("council.observer-prompt.source-drift", expect.any(String), expect.objectContaining({previous, current, cause}))`. (d) Relaunch-failed test: `vi.spyOn(companionBus, "emit")` + assert `("session:relaunch-failed", {sessionId, reason: /observer-prompt-config-failed/})` AND `expect(...).not.toHaveBeenCalledWith("session:exited", ...)` — Beck's negative-control discipline pins the BOTH directions.

---

## Risks & Watchpoints

- **Willison W2 — bundled body CLI-specific references (`--resume`, `-p` mode):** OUT OF SCOPE per Willison rec #4. Filing as separate ticket — requires `claude+codex` pair replay corpus before body edits ship.

- **Hunt #5 — `loadBundledObserverPromptValidated` export tampering surface:** Module-load canary asserting the SHA at module-init is optional defence-in-depth. The existing build-time + test-time + runtime gates already triple-cover the failure modes. Worth flagging if a future refactor adds the constants to the public export surface; currently they stay module-local. Skip module-load canary for this pass.

- **Subprocess #5 — Source-axis breakdown in exhaustion log:** Recommendation IS to add `(attempt, source, sha256)` tuples to the `relaunchExhaustedNotified` log entry when budget exhausts. DEFERRED to a separate cycle — this plan focuses on the drift-log itself (Task 11); the exhaustion-log enrichment is observability-only follow-up.

- **Deploy P2 #4 — `Dockerfile.fly-managed` missing:** Pre-existing finding from prior review; not feature-introduced. Tracked there. Out of scope.

- **Fowler #6 method rename `applyCouncilObserverSpawnConfig → buildObserverSpawnOverrides`:** Touches the EC-19 canary anchor name. If the rename lands, Task 14's regex must update in lockstep. Test fixture const at top of cli-launcher.test.ts holds the function name so renames touch one place.

- **Drift detection scope:** Only fires on RELAUNCH path (Task 11). Initial spawn never emits drift (no previous to compare). The `--resume` happy-path on Claude doesn't re-receive the prompt argv anyway — drift detection is meaningful only on fresh-spawn relaunch (uptime<5000ms-fallback path per Subprocess prior finding #3).

---

## External Setup Required

No external setup required. All tasks implementable in codebase.

---

## Summary

| # | Task | Domain | Depends on |
|---|------|--------|------------|
| 1 | Stamp `code` on loader wrapper + wrap readFileSync | Fowler × Backend × Persistence | — |
| 2 | Drop cause-chain walk in resolver; read direct `err.code` | Fowler × Backend × Hunt | 1 |
| 3 | Keep runtime SHA check; annotate bundler-mutation hypotheses | Backend × Fowler × Willison | — |
| 4 | Half-rename `sourcePath → sourceLabel` at validator + interface | Fowler | — |
| 5 | New `loadBundledObserverPromptValidated()` helper; drop sentinel-path | Fowler × Hunt | 1, 4 |
| 6 | Extract `resolveObserverPromptForSpawn` to `observer-prompt-spawn.ts` | Fowler × Backend | 5 |
| 7 | Rename `applyCouncilObserverSpawnConfig → buildObserverSpawnOverrides` | Fowler | 6 |
| 8 | Replace WARN `expectedPath` with `(present, depth)` integer pair | Hunt | 6 |
| 9 | Rename WARN field `bundledSha256 → observerPromptSha256` + add triplet siblings | Backend | 8 |
| 10 | Emit `session:relaunch-failed` (NOT `session:exited`) on prompt-config throw | Subprocess | 1 |
| 11 | Drift-detection in spawn helper; emit `council.observer-prompt.source-drift` | Subprocess × Willison | 6 |
| 12 | Add `observerPromptSource` + `observerPromptSourcePath` to EC-9 invocation log | Willison | 11 |
| 13 | argv cardinality guards in Task 9 integration tests | Beck × Backend | 7 |
| 14 | EC-19 canary on `buildObserverSpawnOverrides` body + sentinel grep | Beck × Hunt | 7 |
| 15 | Test layer: observer-prompt-spawn.test.ts + loadBundled tests + drift spy + relaunch-failed test | Beck | 6, 10, 11 |

## Verdict

The single most consequential structural decision: **D4 — use `session:relaunch-failed`, not `session:exited`** (Subprocess #1). The original brief proposed the wrong event channel; the typed channel already exists with the right semantics already wired into the coordinator's fast-fail path. Without this correction, the plan would have shipped duplicate exit semantics under a misleading event name AND falsified the metrics-collector exit-code histogram. **Most critical expert: Subprocess** for catching the event-channel error; tightly followed by **Fowler** for reversing his own prior P3 #3 on the SHA re-check (the three-gate trichotomy is real defense-in-depth, not ceremony). Start with Task 1 (loader wrap discipline) — every subsequent task either depends on it or benefits from the cleaner discriminator. Tasks 13/14/15 (test layer) should NOT be deferred until after implementation; sequence them WITH the corresponding production task per Beck P1 (red step is proof).

If a pair agent is valuable during build: surface `quality-subprocess.md` for Task 10 (the event-channel correction is structural truth from the spec, not from review prose).
