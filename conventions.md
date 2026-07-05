# Project Conventions

Accepted patterns and enforced conventions from council reviews. The council reads this file before every review to avoid re-flagging resolved decisions.

---

## Accepted Patterns

These are intentional — do not flag as findings.

### AP-1: Coordinator decoupled from session-orchestrator via dependency injection

**Pattern:** `web/server/session-group-coordinator.ts` consumes spawn/kill through injected `SessionSpawner` / `SessionKiller` callbacks and never imports `session-orchestrator.ts` directly. Group lifecycle composes on top of the existing single-session machinery without branching it.
**Origin:** Fowler — Council Review 2026-05-11-1953
**Rationale:** This is the structural keystone (PLAN Task 4) that keeps the single-session happy path unbranched; collapsing it would force every future change to reason about paired vs solo.

---

### AP-2: `group-state-machine.ts` is single source of truth for group lifecycle status

**Pattern:** Group status is a discriminated union (`pairing | active | degraded | archived | reconnecting`) mutated only through a pure `transition(state, event)` function. Callers consume `GroupRecord.status` directly; they do not introduce parallel booleans (`isDegraded`, `isOperable`, etc.) or re-derive lifecycle facts inline.
**Origin:** Fowler — Council Review 2026-05-11-1953
**Rationale:** Eliminates the "three diverging boolean expressions in three files" anti-pattern the union was designed to prevent.

---

### AP-3: `council-types.ts` hosts both writer- and reader-side schemas in one file

**Pattern:** `CheckpointPayload` (orchestrator-emitted) and `ObserverReviewPayload` (observer-emitted) live in the same module alongside their parsers and the shared `COUNCIL_SCHEMA_VERSION`. Validators reject schema drift on either side from one place.
**Origin:** Fowler — Council Review 2026-05-11-1953
**Rationale:** Non-speculative because two consumers exist on day one; the shared file prevents writer/reader drift that would otherwise be silent.

---

## Enforced Conventions

These must be followed — flag violations as findings.

### EC-1: Observer SDK permission profile must be applied AT spawn (in argv), with a boot-time canary

**Convention:** The observer subprocess's `allowedTools`, `disallowedTools`, and `permissionMode` from `getObserverSpawnOverrides(backendType)` must be passed through `SessionSpawner` → `LaunchOptions` → spawn argv at process-creation time. Runtime/post-spawn injection is not enforcement. Server bootstrap must invoke `assertObserverToolPolicyConsistent()` so a future allow-list edit that overlaps the deny list goes red at startup.
**Origin:** Subprocess Lifecycle × Hunt × Willison × Beck — Council Review 2026-05-11-1953 (finding #1, cross-ref #7, #8)
**Principle:** `references/quality-subprocess.md` → Principle 1; `references/security.md` → Principle 7

---

### EC-2: Group-aware kills must mark BOTH session IDs as intentional before either kill executes

**Convention:** Before calling `kill(primary)` or `kill(observer)` on a paired session group, BOTH IDs must be present in `session-orchestrator.intentionalKills` (or via the injected `markIntentional()` surface on `SessionKiller`). Coordinator-internal status flips alone are insufficient — they do not gate `scheduleProactiveRelaunch`. Tests must exercise the cross-listener race (fake spawner emitting `session:exited` on the first kill).
**Origin:** Subprocess Lifecycle — Council Review 2026-05-11-1953 (finding #2)
**Principle:** `references/quality-subprocess.md` → Principle 3

---

### EC-3: Coordinator types must distinguish Companion `sessionId` from CLI `cliSessionId`

**Convention:** Anywhere the coordinator, group records, or reconciliation actions reference "the observer's ID" or "the primary's ID", the type must carry `sessionId` (Companion routing UUID) AND `cliSessionId?: string` (CLI's `--resume` token, populated after `system.init`). Never collapse both concepts into one string slot. Relaunch paths that need a resume token must read it from the launcher's live record, not from coordinator-owned state.
**Origin:** Subprocess Lifecycle — Council Review 2026-05-11-1953 (finding #3)
**Principle:** `references/quality-subprocess.md` → Principle 5

---

### EC-4: Filesystem watcher debounce must never silently coalesce distinct payloads

**Convention:** Any debounce on a filesystem watcher (currently `checkpoint-watcher.ts`) must guarantee that every payload that crossed the rename barrier is either read-and-emitted OR read-and-dropped-with-reason via `onDropped`. Debouncing by filename alone is forbidden when two distinct payloads can land on the same path within the window — use `(file, mtime|size|content-hash)` keying or read inside the debounce window and emit per distinct payload. Required test: two `writeAtomicJson` calls to the same path within the debounce window emit both payloads (or log the drop).
**Origin:** FS-JSON Persistence × Beck — Council Review 2026-05-11-1953 (finding #4)
**Principle:** `references/quality-persistence.md` → Principles 1, 4

---

### EC-5: Protocol parsers reject unknown METHODS and FRAME SHAPES; tolerate polymorphic-by-spec FIELDS

**Convention:** Codex JSON-RPC and Claude NDJSON parsers must reject frames whose discriminator (method name, type tag) is outside the known set. They must NOT reject legitimate polymorphic shapes within a known frame: JSON-RPC `id` may be `string | number | null`; `params` may be `object | array | omitted`. Strict-on-discriminator + permissive-on-polymorphic-fields is the correct shape. Every `return null` rejection must invoke an `onDropped(reason, frame)` hook — silent rejection is forbidden.
**Origin:** Realtime/NDJSON Protocol — Council Review 2026-05-11-1953 (finding #5)
**Principle:** `references/quality-realtime.md` → Principle 7

---

### EC-6: Load-bearing protocol parsers require replay-based regression tests against captured recordings

**Convention:** Every parser that sits on the bridge's protocol boundary (currently `claude-adapter.ts`, `codex-envelope.ts`; future: any new envelope/adapter module) must have a regression test that loads a captured `~/.companion/recordings/*.jsonl` fixture and feeds each line through the parser, asserting non-null typed output. Hand-crafted JSON literals do not substitute. Fixtures live under `web/server/fixtures/` and are refreshed when the upstream CLI ships a protocol change.
**Origin:** Realtime/NDJSON Protocol — Council Review 2026-05-11-1953 (finding #6)
**Principle:** `references/quality-realtime.md` → Principle 7

---

### EC-7: Filesystem-access predicates must inline path resolution or only be reachable through a resolving wrapper

**Convention:** Allowlist/denylist predicates that take a path argument (currently `isObserverWriteAllowed`; future: any analogous helper) must either call `realpathSync` internally (climbing to nearest existing parent for non-existent paths) OR be NOT exported directly — only an `assertObserverCanWrite`-style wrapper that performs realpath + predicate as one unit may be exported. Defence by JSDoc convention is forbidden for security boundaries.
**Origin:** Hunt — Council Review 2026-05-11-1953 (finding #9)
**Principle:** `references/security.md` → Principle 7

---

### EC-8: Reconciliation actions require sentinel-before-sweep helpers

**Convention:** Every reconciliation action that mutates group state (`archive_dead`, `mark_orphan`, `relaunch_observer`) must have a `writeAtomicJson`-backed sentinel-write helper (`writeArchiveTombstone`, `writeOrphanMarker`, `writeRelaunchIntent`, etc.). The caller pattern is: decide → writeMarker → act → (optionally) deleteMarker. A crash between writeMarker and act must leave the next reconciliation looking at the marker and resuming idempotently. Silent swallow of action-side failures (`try { ... } catch { /* swallow */ }`) is forbidden — emit a structured log line with `event`, `sessionGroupId`, `role`, and propagate via `Error.cause` / `AggregateError`.
**Origin:** FS-JSON Persistence × Bun/Hono/TS Backend — Council Review 2026-05-11-1953 (finding #11, cross-ref persistence P2-4)
**Principle:** `references/quality-persistence.md` → Principle 3; `references/quality-backend.md` → Principle 1

---

### EC-9: Group-lifecycle log lines must be structured JSON with required context fields

**Convention:** Every log call on the group-lifecycle surface (`session-group-coordinator.ts`, `checkpoint-watcher.ts`, `group-reconciliation.ts`, future group code) must use a structured logger emitting JSON with at minimum `event` + `sessionGroupId` + (where applicable) `sessionId` + `role`. `console.log` / `console.warn` are forbidden in production paths on this surface. A child-logger pattern bound at group-creation time is the canonical wiring.
**Origin:** Bun/Hono/TS Backend — Council Review 2026-05-11-1953 (finding #15)
**Principle:** `references/quality-backend.md` → Principle 6

---

### EC-10: Discriminated-union state renderers must compile-fail on missing variants

**Convention:** Any UI component that switches on a discriminated-union state (e.g. `ObserverPanelState`, `SessionPhase`, group lifecycle pills) must include a `const _: never = state;` (or equivalent exhaustiveness check) in the `default` branch. Adding a new variant to the union without extending the switch must fail typecheck rather than silently render an empty header. The pattern is mandatory on any state-pill, status-banner, or stage-indicator component whose union has ≥3 variants.
**Origin:** Friedman (UX Quality) — Council Review 2026-05-13-0100 (finding #5)
**Principle:** `references/quality-ux.md` → Principle 2 (Design all five screen states)

---

### EC-11: Wallclock-anchored derived state requires an explicit clock-tick subscription

**Convention:** Any derived state whose transition is gated on `nowMs > someDeadline` (e.g. `reviewing → reviewing-stalled` at `lastCheckpointAt + wakeTimeoutMs`, idle-kill timers, grace-window expiries) must be paired with either (a) a `setInterval` / `useTimer` subscription that re-renders periodically, or (b) a server-emitted deadline-fired event the client consumes via `ws.ts`. Pure derivation alone is structurally unreachable in production because the component re-renders only on state changes — not on the wallclock passing through a deadline. Option (b) is preferred because it preserves the "single mutation channel via ws.ts" discipline; option (a) is acceptable when the deadline is short (< 30s).
**Origin:** React/Web UI — Council Review 2026-05-13-0100 (finding #4)
**Principle:** `references/quality-frontend.md` → Principle 1 (single source of truth for derived state)

---

### EC-12: `fs.watch`-driven pipelines require an explicit pre-scan reconcile on initialize

**Convention:** Any pipeline that depends on `fs.watch` events to drive durable state mutation (council checkpoint→wake, review-watcher→grounding, future filesystem-driven flows) must implement a scan-on-initialize reconciler that enumerates pre-existing files in the watched directory, compares them against the persisted sentinel state, and fires the corresponding action for any gap. `fs.watch` is event-only post-attach — it does NOT replay existing files on watcher start. A pipeline that promises "restart-idempotent" behaviour without the scan ships green but loses state across crashes. The reconciler must be idempotent (the sentinel-before-sweep wrapper from EC-8 is the canonical pattern).
**Origin:** FS-JSON Persistence — Council Review 2026-05-13-0100 (finding #6)
**Principle:** `references/quality-persistence.md` → Principle 7 (Replay determinism)

---

### AP-4: Late-injection via setter is the blessed shape for mutual-cycle DI

**Pattern:** When two long-lived classes have a reference cycle (e.g. `IdleTimerManager` needs `getSession`/`getGroupStatus` closing over the orchestrator + bridge; the orchestrator's rehydrate path calls into the manager), the canonical resolution is: construct the first dependency with a noop placeholder, build the second dependency closing over the first, then inject the real instance back via a `set<Name>` method BEFORE `initialize()` runs. Mirrors the `orchestrator.setIdleTimerManager` + `wsBridge.setIdleTimerProbe` pattern in `index.ts`. Lazy proxies / `Lazy<T>` pushers off the type system are explicit non-options — late-injection keeps cycle resolution visible in the bootstrap code.
**Origin:** Council Review 2026-05-15-0336 — Task 11 wire-up established the pattern at three sites (orchestrator↔manager, bridge↔probe, adapter↔probe). Convergent recommendation from Backend + Subprocess + Fowler experts.
**Rationale:** Cycle is real; lazy alternatives hide it. Setter pattern surfaces the ordering in one place.

---

### EC-14: Late-injected probe interfaces must live as a named exported type at the producer

**Convention:** Any narrow-surface "probe" interface (a subset of a manager's API passed via late-injection to a consumer) MUST be exported as a named type from the producer module (e.g. `export type IdleTimerProbe = { ... }` in `idle-timer-manager.ts`) and imported via `import type` at every consumer site. Inline duplicate `{ method1(): boolean; method2(): void }` declarations at the consumer's field + setter parameter + closure-passing site are forbidden — 3-to-5-way inline duplication creates a drift footgun that ships green-locally / red-on-CI under any interface widening (proven: PR #54 commit `8cdbc74` shipped 11.7 widening, `ws-bridge.test.ts` stubs not updated, CI typecheck caught it, fix landed in `ffb48d3`).
**Origin:** Fowler × Backend — Council Review 2026-05-15-0336 (finding #9)
**Principle:** `references/refactoring.md` → Principle 4 (Names that lie or mislead)

---

### EC-15: Bridge-boundary discriminated unions require exhaustive consumer-site `switch`

**Convention:** Any consumer that maps a typed discriminated union crossing the `WsBridge` boundary (`BridgeObserverWakeOutcome`, future `BridgeEnqueueOutcome` from PR #52, etc.) MUST use `switch (outcome.kind) { case "x": ...; case "y": ...; }` followed by `const _exhaustive: never = outcome; void _exhaustive;` tail. If/else cascades with terminal `else` fall through are forbidden — a future variant added to the producer will silently stringify at the consumer site, hiding protocol drift. Wake-path consumer at `session-orchestrator.ts:1808-1953` is the reference; the auto-proceed mapping at `index.ts:147-158` is the regression that broke this convention and is finding #4 of this review.
**Origin:** Realtime/NDJSON Protocol — Council Review 2026-05-15-0336 (finding #4)
**Principle:** `references/quality-realtime.md` → Principle 7 (Protocol drift)

---

### EC-16: Server-originated WS frames must carry an `origin` discriminator through `routeBrowserMessage`

**Convention:** Any code path that injects a frame into `routeBrowserMessage` from a non-browser source — `cron-scheduler`, `agent-executor`, `linear-agent-bridge`, REST `POST /sessions/:id/message`, future synthetic auto-proceed paths — MUST thread an `origin: "browser" | "server:cron" | "server:agent" | "server:linear" | "server:auto-proceed"` discriminator on the frame. Observers registered via `onUserFrameObserved` filter on origin and skip non-browser-originated frames; `IdleTimerManager.noteUserMessage` only fires for `origin === "browser"`. Mirrors the recorder origin pattern already documented in CLAUDE.md. Without this, server-originated injections silently advance the auto-proceed turn-token and cancel pending fires — cron+council sessions never reach auto-proceed.
**Origin:** Bun/Hono/TS Backend — Council Review 2026-05-15-0336 (finding #12)
**Principle:** `references/quality-backend.md` → Principle 2 (Validate at every protocol boundary)

---

### EC-17: Defence-in-depth gates must fail-CLOSED on probe-null or runtime-shape-violation

**Convention:** Any gate that the codebase positions as a "defence-in-depth" safety check (denylist gates, permission predicates, type-narrowing guards) MUST fail-CLOSED on the absence of its decision input — `null` probe, non-string `tool_name`, malformed `tool_input`, etc. Tested explicitly via probe-null and malformed-input paths. The current shape "optional-chain short-circuit + `&&` operator" produces fail-OPEN (the gate is bypassed when the probe is null) and is the regression at finding #1 of this review (3-expert convergence Willison × Hunt × Subprocess). The rule generalises: optimising for test ergonomics (no probe required) by trading away the safety promise is the wrong tradeoff for any gate marketed as defence-in-depth.
**Origin:** Willison × Hunt × Subprocess — Council Review 2026-05-15-0336 (finding #1)
**Principle:** `references/quality-llm.md` → Principle 3 (LLM-graded permission with no rule-based fallback is fail-open)

---

### EC-18: Cross-module probe-coupled wiring (3+ classes via DI) requires integration-level test, not only component-level coverage

**Convention:** When a contract spans 3+ classes via late-injection (the Task 11 pattern: `IdleTimerManager` ↔ `WsBridge` ↔ `ClaudeAdapter` coupled through `idleTimerProbe`), component-level tests are necessary but not sufficient. Required: at least one integration-level test that drives the full pipeline through its 5-step state machine (arm → fire → user-frame races → can_use_tool gate → result-frame transition) with FakeClock + spy harnesses on every probe method. Without it, cross-module probe-state desync (the bridge probe says `synthetic-in-flight` but the adapter's closure captured a stale probe at construction time) is invisible — every component test passes, the integration boundary fails silently. Per `feedback_partial_fix_passed_as_complete`: the integration boundary IS the defect surface for cross-class probe wiring.
**Origin:** Beck — Council Review 2026-05-15-0336 (finding #7, P1.4 from beck.md)
**Principle:** `references/quality-testing.md` → Risk-calibrated coverage

---

### EC-19: Static-grep canaries must anchor on function name, brace-counted body extraction, never literal substring

**Convention:** Any test-side canary that asserts "this mutation/symbol occurs only inside function F's body" MUST use a regex anchored on the function name (e.g. `\bfunctionName\s*\([^)]*\)\s*:?\s*[a-zA-Z]*\s*\{`) followed by brace-counting body extraction, NOT literal substring search of the function's expected body bytes. Literal-substring canaries weaken silently under parameter renames, access modifier changes, return-type annotation additions, and any other source-cosmetic edit. The 11.7 EC-6 canary at `ws-bridge.test.ts:2862-2880` is the reference implementation — survives renames of `session` parameter, `private` ↔ public toggle, and TypeScript return-type changes. Universal sibling: `feedback_static_grep_canary_regex_over_substring`.
**Origin:** Beck × Kent Beck (Test Quality) — Council Review 2026-05-15-0336 (positive recognition, codified as convention)
**Principle:** `references/quality-testing.md` → Structure-insensitive assertions

---

### EC-20: Producer↔consumer path/filename conventions live as exported constants, never in agent prompts or self-memory

**Convention:** Any cross-module producer↔consumer contract over filesystem path or filename shape (observer review files, checkpoint files, recording files, council artifacts, future conventions) MUST be expressed as ONE exported constant + helper pair (regex/pattern for consumers, builder function for producers) co-located with the canonical consumer module. Agent harnesses, monitoring code, prompts, and external tooling MUST import the constant — never hardcode the pattern in system prompts or agent self-memory. Reference implementation: `web/server/review-watcher.ts` exports `OBSERVER_REVIEW_FILE_PATTERN` (consumer regex) + `buildObserverReviewFilename(phase, provider)` (producer helper). Each helper MUST throw on inputs that would produce a name failing the pattern — silent fallback to a "best-effort" name is forbidden because consumer parse-fail then masquerades as producer silence (`feedback_consumer_path_drift_before_silent_claim`). The om_event_bot incident (2026-05-15) was a consumer-side self-prompt filter on `FIXES-applied-from-observer-*` while producer wrote canonical `<phase>-<provider>-observer.md` — exactly the drift class this convention closes.
**Origin:** Council Review 2026-05-15-0520 Prevention #5 (consumer path drift) — emergent from cross-pair debugging
**Principle:** `references/refactoring.md` → P4 (names reveal design) + `references/quality-persistence.md` → P9 (don't build on filesystem assumptions); sibling memory `feedback_consumer_path_drift_before_silent_claim` (universal)

---

### EC-21: Documented log/event triplet fields must derive from a single source — never independent optional spreads

**Convention:** When a log line or event payload documents a forensic-replay triplet (or N-tuple) of fields that MUST appear together — e.g. `(promptSha256, observerPromptSource, observerPromptVersion)` for observer invocation, `(sessionId, sessionGroupId, role)` for EC-9 — the producer MUST construct them from a single source-of-truth artifact or capture them through a single discriminated tuple shape. Independent optional spread idioms (`...(x !== undefined && { x: ... }), ...(y !== undefined && { y: ... })`) are forbidden because they let half the triplet ship while the other half silently drops; the documented contract is asserted at JSDoc level but unenforced at runtime. The CR-1 / CR-13 incident at `observer-attribution.ts:formatObserverInvocationLog` shipped `observerPromptSource` without `observerPromptSourceLabel` for every restart-recovered group because the orchestrator's reconstruction path only captured one of the two — type-system accepted it, contract was silently violated.
**Origin:** Council Review 2026-05-15-1015 Backend P2-3 + Fowler P2 + Hunt P1 (CR-1 multi-expert convergence)
**Principle:** `references/quality-backend.md` → P8 (catch typing as `unknown`, narrow explicitly) + `references/refactoring.md` → P5 (Primitive Obsession); sibling memory `feedback_council_documented_contract_canary` (contract-in-JSDoc-only is doku-not-enforcement)

---

### EC-22: Typed-channel event emit paths require behavioural-assertion tests, not just typecheck pins

**Convention:** Any code path that emits on a typed event channel (`companionBus.emit("X", ...)`), writes a structured log line (`log.warn("event-name", ...)` with stable schema), or fans out on a side-effect surface MUST have a behavioural test that subscribes to the channel/spies on the log and asserts the emit fired with the right payload shape. Tests that exercise only the happy-path return value while leaving the side-effect path covered by typecheck alone silently green-stamp a refactor that flips the conditional, inverts the emit order, or replaces the emit with a `noop`. Reference: the γ fix-pass added 3 P1 test rows for `session:relaunch-failed` (positive + negative-control), `council.observer-prompt.source-drift` (3 transition rows including no-change), and `council.observer-prompt.bundled-fallback` (shape pin + negative key assertion). Pair this with EC-19 for static-grep canaries when behavioural tests can't reach the path (initialisation-time code, type-system-only assertions). Same defect class as `feedback_call_site_presence_not_just_symbol_export` and `feedback_recovery_branch_reachability`.
**Origin:** Council Review 2026-05-15-1015 Beck B1+B2+B3 (CR-4 — three side-effect emit paths shipped with zero behavioural assertion)
**Principle:** `references/quality-testing.md` → Mutation resistance + structure-insensitive assertions; sibling memories `feedback_verify_test_bodies_not_just_names`, `feedback_call_site_presence_not_just_symbol_export`

---

### EC-23: Filesystem paths in log/event payloads MUST be `(present, depth)` pair, SHA, or sentinel — never raw path bytes

**Convention:** Structured log lines and event payloads (companionBus events, EC-9 invocation logs, audit trails, monitoring fanout) MUST NOT contain raw absolute filesystem path strings on production code paths. Allowed shapes: `(present: boolean, depth: number)` integer pair, SHA-256 hex of the path, or a sentinel token like `<bundled:observer-system-vN>`. Raw paths leak operator topology (username inside `/home/X/`, project name inside `/Users/X/work/<repo>/`, container internals) if logs egress to a shared sink (managed Loggly, multi-tenant Honeycomb, screen-shared debug session). Apply transitively: if a path bytes enters via `Error.message`, `Error.cause.path`, or wrapper construction, redact at the boundary — `wrapFsError` in `observer-prompt.ts` is the reference (operation + code only; cause preserved but JSDoc warns consumers must redact `.path`/`.dest` before serialising). EC-23 is the egress sibling of EC-7 (filesystem-access predicates inline resolution) — together they bound both ingress and egress of path bytes.
**Origin:** Council Review 2026-05-15-1015 Hunt P1 + Fowler P2 + Backend P2-5 (CR-1 multi-expert convergence) + Hunt P2 (CR-7 — wrapFsError echoed path bytes into Error.message)
**Principle:** `references/security.md` → P3 (minimise state / `console.log` of bodies) + P9 (assume breach — stack traces in error responses); sibling memory `feedback_format_transformation_validation` (universal — format-aware redaction at the wrapper boundary)

---

### EC-24: Council subagent prompts live in the shared `_council-experts/` catalog, named by ID — never inlined in consumer SKILL.md

**Convention:** Consumer skills (`council-plan`, `council-plan-aura`, `council-review`, `council-review-aura`) MUST reference subagent prompts by expert ID via a `### Council panel` section listing `- <id>` entries. The prompt body for each (expert, phase) pair lives at `~/.claude/skills/_council-experts/<id>/<phase>.md` and is consumed verbatim at dispatch time (with the brief's domain-file list substituted into the `[list ONLY <X>'s domain files]` placeholder). Inline `### Subagent N: <Name>` blocks in SKILL.md are forbidden — `verify-catalog.sh` (canary C1 in `_council-experts/.verify/`) fails on any reappearance. Expert IDs MUST match `^[a-z][a-z0-9-]{1,31}$` (canary C3); catalog files MUST NOT be symlinks (canary C4); catalog data files MUST be mode 644 (canary C5). Byte-identity between current catalog and the baseline pre-refactor inline blocks is asserted by `verify-panels.py` (AC-3.2 contract from `specs/council-experts-catalog.md`).
**Origin:** Council Review β 2026-05-15 (catalog refactor) — Fowler (structure), Beck (verifiability), Hunt (defences). Memory entry: `feedback_shared_global_infra_refactor_requires_dedicated_window` (pre-flight checklist for shared `~/.claude/skills/` infra).
**Principle:** `references/refactoring.md` → P4 (names reveal design) + `references/security.md` → P3 (filesystem-string injection); spec `specs/council-experts-catalog.md` AC-1/AC-3/AC-5

---

### EC-30: Council Mode phases MUST fit within ≤100k working tokens; mandatory HANDOFF + sub-phase split when scope exceeds the budget

**Convention:** Each Council Mode phase (`/council-plan-aura`, `/council-review-aura`, `/council-implement-aura`, multi-commit catalog refactor phases like Phase 2a/2b/2c/2d) MUST be scoped so the writer instance's working tokens (system prompt + conversation + all artifact reads + plan + spec) stay ≤100k. Working tokens drift past 100k cost the Anthropic 5-min prompt cache on every wake-up and silently degrade output quality before any test fails. If a phase's natural scope exceeds the budget, split it into sub-phases (`2a/2b/2c/2d` shape) with explicit HANDOFF artifacts bridging Claude session boundaries — never extend a single session past the budget by deferring artifact reads or relying on `/compact`. Reference symptom: Phase 2 plan-gen hit 190k → forced restart; Phase 2 implementation split into 2a/2b/2c/2d for emergent token-budget reasons (not semantic ones). The budget IS the convention because token-window pressure is non-locally observable inside the writing instance but immediately observable downstream as compaction-induced drift, missed instruction details, and fabricated empirical claims (`feedback_trust_diff_not_prose`).
**Origin:** Phase 2 council-v2 refactor (2026-05-15 / 2026-05-16) — emergent split shape captured retroactively. Memory entry: `feedback_phase_decomposition_by_token_budget` (universal, propagated to all 13 memory dirs Phase 2c-N3 sign-off).
**Principle:** `references/refactoring.md` → P1 (refactoring is economic — pay attention to cycle cost); sibling memories `feedback_two_process_validator_pipeline`, `feedback_check_pipeline_output_before_rerun`

---

### EC-31: Multi-commit Council Mode phases require writer-tmux + reader-validator pipeline; bridge through `/tmp/<phase>-NX-validator-brief.md` artifacts

**Convention:** Any Council Mode phase that produces ≥2 commits whose correctness depends on cross-commit invariants (atomic merge sequences, schema-then-implementation, content-authorship-then-cutover) MUST be executed as TWO parallel Claude sessions — a writer-tmux instance that produces the commits and a reader-validator instance in a separate tmux that picks up `/tmp/<phase>-NX-validator-brief.md` files and independently re-runs the writer's empirical claims (grep / sha256 / exit-code-check). The writer's report convention is ONE line per commit: `"phase <X>-NY done, brief @ /tmp/<phase>-NY-validator-brief.md"` (per `feedback_validator_pipeline_one_line_report`). The validator either PASS or returns FAIL with concrete corrections. Single-process loops are forbidden because the writer's confirmation bias green-stamps its own claims (`feedback_agent_self_review_loop_gates`) and live-context mutation can flip claims silently between commits (`feedback_two_process_validator_pipeline`). Validator empirical-claim discipline applies symmetrically per `feedback_runtime_check_applies_symmetrically` — BOTH writer and validator grep/sha256/exit-code-check every claim BEFORE landing in commit body or brief. Batched validator PASS across multiple commits is acceptable ONLY when comprehensive canaries (C-series verify-catalog gates, replay-tests, behavioural assertions per EC-22) catch all structural invariants; content-only commits where canaries don't cover quality drift MUST be serialised through the validator one-at-a-time.
**Origin:** Phase 2a/2b/2c/2d council-v2 refactor (writer-side serialisation became unworkable past commit ~3 of multi-commit phases without external rigor). Memory entry: `feedback_two_process_validator_pipeline` (universal — multi-commit phased work with live-mutation/compaction risk requires the parallel pipeline shape).
**Principle:** `references/quality-llm.md` → P3 (rule-first / model-second) + P4 (replay-based regression); sibling memories `feedback_validator_pipeline_one_line_report`, `feedback_runtime_check_applies_symmetrically`, `feedback_validator_self_grep_format_variations`

---

### EC-32: Every Council Mode phase MUST end with a `HANDOFF-phase-X-after-NY.md` artifact bridging Claude session boundaries

**Convention:** No Council Mode phase may close without producing a HANDOFF artifact at the repo root capturing `commits[]` (SHA + one-line summary per commit), `decisions[]` (the inherited corrections / clarifications / scope deltas this phase locked in), `inherited_corrections[]` (re-asserted-from-prior-phases items, not redundant — surfaces drift if next phase author silently re-flips), and `next_phase_scope` (sub-phase table with column-per-merge). The NEXT phase's writer instance starts from THIS HANDOFF + auto-memory (`MEMORY.md`), NEVER from the previous Claude session's working memory — even when the same human is running the pickup, the new tmux's working tokens start at zero and must be hydrated from the artifact. HANDOFF filename convention: `HANDOFF-phase-<X>-after-<NY>.md` at repo root (or `<phase>/<sub-phase>` for skill-host nested cases). Pickup-prompt MUST cite the HANDOFF path verbatim. Multi-source-instruction-contradiction discipline applies (per `feedback_multi_source_instruction_contradiction_defer_surface`) — if pickup-prompt and HANDOFF disagree on concrete action, defer + surface to user in the next brief, ask for resolution. Never silently pick. Reference: Phase 2c-after-N3 HANDOFF (Phase 2d entry) included the bug that omitted Task 10 step 3 (prompt-author gap) — the explicit listing format made the gap surface-able at pickup; an implicit "ready to ship" handoff would have masked it.
**Origin:** Phase 2a/2b/2c/2d council-v2 refactor — three successive HANDOFFs (after-N3-2a, after-N3-2b, after-N3-2c) each successfully bridged Claude session boundaries; the missing prompt-author step in 2c handoff surfaced at 2d pickup and was reconciled via explicit AskUserQuestion. Memory entry: `feedback_multi_source_instruction_contradiction_defer_surface` (universal).
**Principle:** `references/refactoring.md` → P4 (names reveal design — `HANDOFF-phase-X-after-NY.md` literal pattern); sibling memories `feedback_handoff_narrative_vs_runtime_state`, `feedback_check_kb_before_amnesia`, `feedback_pushback_is_not_correction`

---

### EC-33: Mid-session-created skills under `~/.claude/skills/` require a fresh Claude session before invocation; build runners MUST warn on detection

**Convention:** Skills (slash-commands, agent definitions, build runners) created inside `~/.claude/skills/<name>/` during an active Claude session are NOT visible to the current session's skill registry — registry-scan happens at session-start only. Any user attempting `/<new-skill>` mid-session sees "skill not found" with no useful diagnostic. To prevent silent confusion: (a) skill-creation build runners (e.g., `cp-mirrors.py`, `bootstrap-skill.sh`, future skill scaffolders) MUST detect creation of a new top-level directory under `~/.claude/skills/` and emit a stderr WARNING line `"⚠ skill <name> created — restart Claude session before invoking via /<name>"`; (b) skill-definition refactors that rename a directory must emit the same warning for the new name AND surface the path of the deleted old directory (consumers may have cached the old slug); (c) Phase-N HANDOFF documents that introduce or rename skills MUST include a "Skills affected — restart required" subsection listing the new/renamed skill names. This is universal infrastructure discipline (`~/.claude/skills/` is shared across all Claude Code sessions on the host) — silent post-creation invocation failures look like bugs in the user's typing, not in our skill-registry locality contract.
**Origin:** Phase 2c-N2 cp-mirrors.py development — runner created mirror files but the (`/cp-mirrors`) invocation slot was empty; no skill-creation in this exact case, but observed pattern on prior `~/.claude/skills/` additions. Memory entry: `feedback_skill_registry_restart_locality` (universal).
**Principle:** `references/quality-deploy.md` → P10 (know your gaps — operator surprise = unshipped capability) + `references/quality-llm.md` → P3 (rule-first / model-second — fail with structured diagnostic, not "skill not found"); sibling memories `feedback_skill_md_vs_references_drift`, `feedback_skill_fork_dont_replace`, `feedback_skill_refs_copy_not_symlink`

---

### AP-14: Multi-producer wire shapes route through one assembly site

**Convention:** Any wire variant emitted by ≥2 server-side producers MUST funnel through a single assembly helper. The helper accepts the *minimum data the wire shape needs* — each producer passes whatever fields it has locally — and owns *every* derived field (concatenated labels, server-owned constants, defaults for transiently-absent inputs). No producer constructs the wire record in-line. Examples of canonical-application: `buildBrowserGroupRecord` in `web/server/browser-group-record.ts` is the assembly site for the `group_created` wire variant, consumed by all three producers (`session-orchestrator.ts` live push listener, `session-orchestrator.ts` REST bootstrap snapshot, `ws-bridge.ts` synthetic hydration). Field ordering, pairing concatenation (`primary+observer`), `wakeTimeoutMs` from the server-owned constant, and the launcher-propagation-lag fallback for `backendType: undefined` are mechanically un-driftable across producers because there is only one assembly site. Counter-pattern: per-producer inline construction, even when identical at a moment in time, ships a drift footgun that fires the day a new field is added at one site and forgotten at another — exactly how the PR #68 bug class (Sidebar lost ☼/☽ glyph + role suffix on browser reload) was constructed.

**Origin:** Council Review 2026-05-18-1121 — `buildBrowserGroupRecord` keystone refactor for PR #68 (council-mode-bootstrap-rest). Convergent recommendation from Fowler (refactoring, finding 4) + dahl (Bun/NDJSON/WS, finding 1) + beck (Test Quality, parity test for cross-site behavioural equivalence).

**Rationale:** Producer-side defaults applied inline at each call site are silently load-bearing — a "well-formed" wire record at producer A and a malformed one at producer B is the canonical symptom of mapper drift. Centralising the assembly into one helper turns "every producer must remember to apply the fallback" into "the helper applies it once" — a refactoring of capability rather than discipline.

**Principle:** `references/refactoring.md` → P1 (Don't Repeat Yourself across producers of the same wire shape); `references/quality-llm.md` → P3 (rule-first / model-second — encode the invariant in code, not in producer-side review checklists).

---

### EC-34: Expert seating in the v2 catalog is by ideological tension axis, not domain coverage

**Convention:** When adding a new expert to `~/.claude/skills/_council-experts-v2/<id>/`, the `meta.yaml` MUST declare either (a) a paired seating via `paired_with: <existing-expert-id>` + `tension_axis: "<short-phrase>"` if the new expert sits across a genuine ideological tension from an existing catalog member, OR (b) an explicit-unpaired seating via `paired_with: null` + `unpaired_reason: "<short-reason>"` if no genuine tension counterpart exists. Both forms are explicit — the absence of the keys (legacy 2-key shape) is no longer a valid form for new entries and is being retro-populated for existing entries. The tension axis is encoded at TWO layers: (i) the machine-readable `paired_with` + `tension_axis` fields in `meta.yaml` (Phase 3γ chair-side dispatch substrate), and (ii) doc-layer cross-refs in `references/quality-<id>.md` linking each principle to a principle of the paired expert that addresses the same question with the opposing emphasis. Reference paired seats (sub-2/3/4 empirical): torvalds↔ritchie (kernel-pragmatism ↔ Unix-purity); unclebob↔fowler (principle-purity ↔ economic-pragmatic); evans↔fowler (strategic-DDD ↔ emergent-microservices); hickey↔beck (fundamental-simplification ↔ incremental-TDD); majors↔hashimoto (debugging-in-prod ↔ immutable-prevention); sridharan↔majors (resilience-skepticism ↔ operational-realism). The verify-catalog C7 gate enforces the wire-format: `paired_with` MUST be a valid expert-ID shape or `null`; `tension_axis` MUST be a non-empty string ≤80 chars with no control characters or `null`; both keys MUST be present together or both absent (legacy carry-forward shape). Domain-coverage seating — "we don't have a database expert; add one" — is structurally rejected by this convention; the question is "across whose existing position does this new lens create a genuine disagreement?". Catalog enrichment by counterpart-not-coverage is the substrate that makes Phase 3γ chair-side dispatch produce meaningfully-divergent expert positions on the same question rather than monocultural agreement.

**Origin:** Phase 3β sub-2 dec-008 (paired-tension catalog enrichment shape, ratified after torvalds+unclebob seat-pair) → sub-3 empirical confirmation (evans+hickey second cluster) → sub-4 empirical confirmation (majors+sridharan third cluster, 6/22 paired seats live). Promoted from candidate convention to floor at sub-4 closure per `feedback_pin_dev_tool_versions_with_resolver_caret` (drift discipline — pin the convention once empirical confirmation thresholds are reached).

**Principle:** `references/refactoring.md` → P4 (names reveal design — `paired_with` + `tension_axis` field names are the contract); `references/quality-llm.md` → P3 (rule-first / model-second — encode catalog seating as schema, not as prose convention reviewer must remember); sibling memory `feedback_multi_expert_convergence_promotion` (3+ independent experts converging on same axis = structural truth, promote to floor).

---

### EC-35: D7 shell-paste discipline — numerical claims in validator briefs reproduce from shell paste, never synthesised prose

**Convention:** Every numerical claim in a writer-side validator brief (`/tmp/<phase>-<NX>-validator-brief.md`) — counts, sha256 digests, line ranges, gate output, byte-identity assertions, EXPECTED_COUNT bumps — MUST be reproduced from a shell-paste evidence block of the form `$ <command>\n<output>` literals, NOT from synthesised prose written from the writer's recollection. The brief carries a "D7 shell-paste evidence" section near the top with each numerical claim's command + raw output. The reader-validator instance independently re-runs each command and asserts the writer's brief matches; mismatch is the canary that the writer's prose drifted from the running system (cache-miss between writer's mental model and on-disk truth). The convention generalises beyond validator briefs to ANY artefact where numerical claims about the codebase's empirical state are made (commit messages, HANDOFF documents, council review findings, post-merge audit reports) — when the claim is empirical, the claim's substrate is shell output, not prose. Reference: the `_phase2-coverage-tokens.yml` byte-paste claims, the `_ref-mirrors.lock` sha256 attestation manifest, and the verify-catalog C12 gate together form a triple-defence shape — the writer pastes shell evidence (D7), the lock manifest pins the claim (artefact), and the gate re-runs the claim at every CI invocation. Synthesised prose ("21 dirs", "sha256 abc...") slips silently when the writer's working memory drifts from disk; the shell-paste discipline forces the drift to fail-CLOSED at the brief layer.

**Origin:** Phase 3β sub-1 dec-009 (D7 shell-paste discipline candidate) → 7-commit zero-drift empirical threshold reached across sub-1/sub-2/sub-3 (N3.15..N3.21) → sub-4 confirmation (N3.22+N3.23) → promoted from candidate to floor at sub-4 closure. Sibling memories `feedback_trust_diff_not_prose` (universal — ship-blocker claims grep-the-diff not trust-the-prose), `feedback_validator_self_grep_format_variations` (validator empirical-claim discipline applies symmetrically).

**Principle:** `references/quality-llm.md` → P3 (rule-first / model-second — empirical claims are rule-shaped, not LLM-judgement-shaped); `references/quality-testing.md` → mutation-resistance (the artefact must mutation-test against the running system on every re-read); sibling memories `feedback_trust_diff_not_prose`, `feedback_validator_self_grep_format_variations`, `feedback_runtime_check_applies_symmetrically`.

---

### AP-15: `web/scripts/detect-stack.ts` is canonical; council router SKILL.md are mirror artifacts

**Pattern:** Phase 0 stack-detection logic for `/council-plan`, `/council-implement`, `/council-review` lives canonically in `web/scripts/detect-stack.ts` (exported `detectStack(workspaceRoot)` + `renderRefusal(result)` + closed-list constants `MARKER_NAMES` / `OVERRIDE_VALUES` / `REFUSAL_HEADLINES`). The three router `SKILL.md` files at `~/.claude/skills/{council-plan,council-implement,council-review}/SKILL.md` are MIRROR artifacts whose drift is enforced by `web/scripts/detect-stack.skill-mirror.test.ts` (asserts each SKILL.md cites every MARKER_NAME + REFUSAL_HEADLINE + OVERRIDE_VALUE verbatim AND that `-aura` / `-copilot` variants do NOT contain a Phase 0 section). The `.council-stack-override` file is the user-facing escape hatch, NOT a workaround for missing detection — when adding monorepo layouts or new markers, extend the detector in `detect-stack.ts` first, then update SKILL.md to mirror new constants. There is NO SKILL.md include mechanism in the Claude Code harness; the canary IS the drift discipline. Forking a SKILL.md to insert "shared" Phase 0 content is the wrong move per `feedback_skill_fork_dont_replace.md`.

**Origin:** Council Review 2026-06-01-2026 (Hunt + Persistence convergence on EC-7 boundary; also `fact-005` in `.agents/knowledge/codebase-facts.jsonl`).

**Rationale:** Future sessions extending Phase 0 (e.g. adding a new stack, new marker, new override value) need to know which file is authoritative — editing SKILL.md without editing detect-stack.ts produces a green mirror canary but broken runtime; editing detect-stack.ts without editing SKILL.md turns the canary red. Both must move together.

---

### EC-36: Every filesystem-access predicate in `detect-stack.ts` must inline full path-resolution discipline OR route through `resolveMarker`

**Convention:** Any code path in `web/scripts/detect-stack.ts` that performs filesystem access (`existsSync` / `readFileSync` / `readdirSync` / `lstatSync` / `statSync`) MUST EITHER (a) route through the canonical `resolveMarker(rootResolved, relPath)` wrapper, which performs `..`/`/`-prefix reject + `existsSync` + `lstatSync` symlink reject + `realpathSync` + workspace-bounds check (`startsWith(rootResolved + sep)`); OR (b) inline the complete equivalent discipline at the access site AND document the equivalence in a comment that explicitly names which checks are present. Partial discipline ("we do lstat-reject but skip realpath because depth-1 entries can't escape") is forbidden because the convention floor declared in the file header says "every marker access goes through `resolveMarker`" — duplicating the wrapper inline silently violates this invariant when readers trust the header. New filesystem-access sites (e.g. `enumerateCandidatePrefixes` added 2026-06-01) MUST either be folded into `resolveMarker` or extend it. Documentation MUST NOT lie about what defences are present (the inline comment "Defensive realpath bounds check" is forbidden when no `realpathSync` is called).

**Origin:** Council Review 2026-06-01-2026, Finding 1 (Hunt × Persistence convergence). Crystallises and tightens the project's pre-existing `EC-7` (filesystem-access predicates inline path resolution OR exposed only via resolving wrapper) for the specific `detect-stack.ts` boundary.

**Principle:** `references/security.md` → Principle 2 (Automate defences — make the wrong thing impossible); `references/quality-persistence.md` → Principle 6 (validate at the boundary). Sibling memory `feedback_call_site_presence_not_just_symbol_export` (the existence of `resolveMarker` doesn't prove every site calls it — grep call sites in addition to the symbol). Convention floor for `detect-stack.ts` specifically; ratifies EC-7 for this file going forward.

---

---

### EC-37: PLAN "Risks & Watchpoints" items demand BOTH a behavioural test AND a `git grep` of production call sites before claiming addressed

**Convention:** Every item enumerated in a `/council-plan-aura` output's "Risks & Watchpoints" section that names a contract, invariant, or wired behaviour MUST be verified at `/council-implement-aura` close time via (a) a behavioural test that exercises the contract (typecheck-pin is insufficient — string `event` names, signature-widened optional args, and JSDoc claims are not type-system-enforced), AND (b) a `git grep` of the production call sites that demonstrates the contract is wired beyond unit tests. The implementation log MUST cite the test ID and grep output for each watchpoint item it claims addressed. Symbol export + helper existence + isolated unit test ≠ wired-in-production. Reference symptoms from Council Review 2026-06-04-0823: sticky-`anthropicModel` preserved as PLAN watchpoint, `pickSessionDefaultModel` helper added, tests assert the contract, but `HomePage.tsx:253` and `CronManager.tsx:850-856` call sites omit the third argument — contract unenforced in production despite plan + helper + tests being green. Three of seven P1 findings in that review (sticky preference, EC-22 emit-path coverage, HomePage lifecycle assertion) share this exact failure shape.

**Origin:** Friedman × Beck × React/Web UI — Council Review 2026-06-04-0823 (P1 findings #1, #4, #5, #6 convergence)

**Principle:** `references/quality-testing.md` → "Specific" desideratum + Mutation resistance; `references/quality-ux.md` → P9 (trust through reasoning visibility); sibling memories `feedback_call_site_presence_not_just_symbol_export` (universal) + `feedback_council_documented_contract_canary` (JSDoc-only contracts are doku-not-enforcement) + `feedback_verify_test_bodies_not_just_names`

---

### EC-38: Cache predicates and timeout decisions over `Date.now()` MUST clamp negative-skew via `Math.max(0, now - past)` OR detect anomaly and force-refresh

**Convention:** Any predicate of the shape `(now - pastTimestamp) > thresholdMs` where both `now` and `pastTimestamp` derive from `Date.now()` (wall-clock) MUST defend against host clock jumping backward (NTP correction after drift, manual `date -s`, VM resume from snapshot, developer laptop sleeping with NTP off then waking). Two acceptable shapes: (a) clamp at zero — `Math.max(0, now - pastTimestamp) > thresholdMs` so negative skew is treated as zero-age (still bounded by threshold going forward), OR (b) detect anomaly — `if (now < pastTimestamp - SKEW_TOLERANCE_MS) treatAsMissAndForceRefresh()`. The clamp form is simpler; the tolerance form is more conservative for security-sensitive predicates. Document the choice in the predicate comment. Bare `(now - past) > ttlMs` silently fails-OPEN on negative skew — the cache appears fresh until wall-clock advances past `pastTimestamp + ttlMs` again, which on a week-suspended laptop is forever. Reference: `anthropic-models-cache.ts:762` `isCacheRecordValid` shipped without the clamp; same shape lurks anywhere `idle-timer`, `session-grace`, or `recording-rotation` uses `Date.now()` deltas.

**Origin:** Persistence-FS × Carmack — Council Review 2026-06-04-0823 (P2-10)

**Principle:** `references/quality-persistence.md` → P7 (Clock not monotonic — replay determinism / TTL correctness); sibling memory `feedback_wallclock_anchored_derivation` (universal — wall-clock anchored derivation requires explicit anomaly handling)

---

### EC-39: Dropdown / overlay / dialog dismissal MUST restore focus to the trigger on EVERY dismissal path (Escape AND click-outside AND any future programmatic close)

**Convention:** Any component that mounts a transient overlay (dropdown, dialog, popover, sheet, menu, listbox panel) — i.e., owns an `open: boolean` state with multiple dismissal paths — MUST restore keyboard focus to the trigger element on EVERY close path, not just the Escape path. Acceptable shapes: (a) close path wraps `requestAnimationFrame(() => triggerRef.current?.focus())` gated on `document.activeElement` being inside the overlay container (so pointer-click on a different focusable element doesn't yank focus from where the user clicked), OR (b) a shared `useOverlayDismissal` hook owning the focus contract for every dismissal path. Asymmetric paths — Escape restores focus, click-outside doesn't — silently violate WCAG 2.4.3 (Focus Order) and the APG dialog/listbox dismissal contract. Reference precedent that DID get it right: `CouncilToggle.tsx:189,211` wraps close in `requestAnimationFrame(() => triggerRef.current?.focus())`. Reference precedent that DROPPED it: `ModelSwitcher.tsx:107-116` click-outside calls only `setOpen(false)` — same component, same overlay, two dismissal paths, two different focus outcomes. Tests MUST cover focus-restore on EVERY dismissal path (not just Escape), using `await waitFor(() => expect(triggerRef).toHaveFocus())`.

**Origin:** a11y Auditor × React/Web UI — Council Review 2026-06-04-0823 (P1 #2)

**Principle:** `references/quality-a11y.md` → P4 (focus management on dynamic UI); WCAG 2.4.3 Focus Order; sibling pattern: `CouncilToggle.tsx` overlay-dismissal contract

---

### EC-40: Test-only escape hatches MUST use static `import` of `node:fs` (or peer modules), NOT inline `require()` + `eslint-disable`

**Convention:** Helpers marked test-only via the `__` prefix convention (`__resetMemoryCacheForTests`, `__deleteDiskCacheForTests`, `__seedForTests`) MUST use static ESM `import` statements at the top of the file for any `node:fs`, `node:crypto`, or sibling-module functions they need. The inline `// eslint-disable-next-line @typescript-eslint/no-require-imports` + `require("node:fs") as typeof import("node:fs")` pattern is forbidden because (a) it suggests the import is "dangerous" without actually preventing production callers from invoking the test helper, (b) Bun's bundler tree-shakes unused ESM imports correctly so the "production bloat" justification is empty, AND (c) it establishes a precedent — the next test helper added to the file copies the pattern, normalising bypass of the module's defensive write-side checks (`writeAtomicJson` atomic-write + bounds-check discipline). The `__` prefix already signals test-only intent; the import shape doesn't add to that signal. Reference: `anthropic-models-cache.ts:984-998` `__deleteDiskCacheForTests` shipped with the require + eslint-disable pair — Persistence reviewer noted the natural next step ("let me add `__seedDiskCacheForTests` while we're at it") bypasses `writeAtomicJson` entirely. The first one is fine in isolation; the second crosses a line.

**Origin:** Backend-TS × Persistence-FS — Council Review 2026-06-04-0823 (P3-BT-1, P2-6)

**Principle:** `references/quality-backend.md` → P5 (Resource lifecycle hygiene); `references/quality-persistence.md` → P6 (Validate at the boundary — same boundary discipline applies to test escape hatches)

---

### EC-41: Inflight-token guards over async results MUST prefer SUCCESS commit when a newer token is still pending; rejecting may NOT clobber a slower successful result

**Convention:** Any module-scope or slice-scope counter that arbitrates "the latest call wins" over concurrent async operations (`Map<key, number>` token pattern; `AbortController` cancellation; promise-result-discrimination after-the-fact) MUST defend against the race where an EARLIER-resolving REJECTION (network blip on call B, token 2) clobbers a LATER-resolving SUCCESS (slow but valid response on call A, token 1). Two acceptable shapes: (a) "rejection is not result" — when commit-check fires and the current token still matches but the outcome is rejection, do NOT mutate state to "rejected" if any other call is still pending; keep "pending" status until the latest token resolves, OR (b) "highest-tokened success wins on tie-break" — track the highest tokened result and prefer success when timestamps match. The naive shape (`if (token === myToken) commit; else discard`) leaks the contract — "latest call wins" silently means "latest-RESOLVING call wins regardless of correctness." UI ends in `status: "rejected"` with `dynamicBackendModels[backend] === undefined` after a single concurrent reject inverts a successful concurrent fetch — visible to users as "static fallback indefinitely until manual reload" on flaky networks. Reference: `settings-slice.ts:144-240` `loadBackendModels` shipped with the naive shape; symptom visible on any concurrent post-Settings-save refetch + transient blip. Minimum acceptable defence: a comment documenting the trade-off so the next reader knows the contract is "latest-resolving-wins" and not "latest-wins."

**Origin:** Backend-TS × React/Web UI — Council Review 2026-06-04-0823 (P2-BT-2, P2-9)

**Principle:** `references/quality-backend.md` → P7 (Async correctness — latency-induced ordering inversions); `references/quality-frontend.md` → P2 (eliminate state that can be derived — when status derives from "latest call," derive correctly)

---

### AP-16: `anthropic-models-cache.ts` 1221-LOC single-file is structurally justified by AP-3 co-location

**Pattern:** The 1221-LOC line count of `web/server/anthropic-models-cache.ts` is intentional and follows the AP-3 writer-reader-parser-in-one-file precedent (`council-types.ts`, `observer-prompt.ts`). The file co-locates: (a) the discriminated-union `AnthropicModelsResult` + `CachedModelsRecord` schemas, (b) `parseAnthropicModelsResponse` + `parseAndPrepareAnthropicModels` parsers, (c) `fetchAnthropicModelsRaw` HTTPS boundary, (d) `readMemoryCache` / `writeMemoryCache` / `readDiskCache` / `writeDiskCache` persistence primitives, (e) `getAnthropicModels` orchestrator with single-flight Promise lock, (f) structured-log emission per branch, (g) test-only escape hatches (`__resetMemoryCacheForTests` etc.). Extracting any of these to a sibling module would re-introduce the writer/reader schema-drift footgun that AP-3 was specifically codified to close. Code review should not re-flag the file size as a structural concern UNLESS a new concern is added that has a different reason-to-change (e.g., a generic `BackendModelCache<T>` interface across Claude + Codex + a third backend would justify extraction — see PLAN Risks & Watchpoints "Fowler stretch — Codex symmetric move" parked discussion). Until then, size is correct; cohesion is the load-bearing axis.

**Origin:** Fowler — Council Review 2026-06-04-0823 (returned 0 P1 / 0 P2 / 3 P3 — explicit structural sign-off)

**Rationale:** Multi-file decomposition of a tightly-coupled writer+reader+parser+orchestrator surface re-introduces the exact drift the AP-3 floor was codified to prevent; the line count is a derived metric, the cohesion is the structural metric.

---

### EC-42: Vacuous-test detection — every behavioural test MUST be mutation-resistant; if removing the production defence leaves the test green, the test does not pin behaviour

**Convention:** Every test that claims to pin a contract introduced by a code change MUST be REMOVABLE-FROM-CODE-AND-RED — that is, mentally (or actually, via mutation testing) flip the production defence to its prior shape; if the test still passes, the test is a structurally vacuous artefact, NOT a contract pin. Sibling discipline to EC-37: EC-37 demands the test exist, EC-42 demands the test actually red on regression. Common failure shapes flagged by Council Review 2026-06-04-1826:
- **Simulation-instead-of-verification:** test manually sets the post-state (`element.focus()`) and asserts subsequent behaviour, rather than triggering the producer that's supposed to set the post-state. Symptom: comment in the test admits the workaround ("JSDOM doesn't implement X exactly, so call .focus() directly to model the post-rAF state"). Fix: use the producer-realistic harness — `vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb)=>{cb(0);return 0;})` to flush rAFs synchronously, OR an integration harness that runs the producer.
- **Wrong-renderer-instance:** test renders two component instances, opens the first, queries via `screen.getByRole(...)` which finds an artefact from the SECOND (or a stale prior render via test-framework cleanup quirks), asserts the expected null on the WRONG instance. Symptom: passes regardless of whether the production fix is in place. Fix: single render with the exact setup state; query via `within(container)` not `screen` to scope.
- **Both-branches-identical-state-shape:** test exercises a defence that uses `if/else` to return state updates, but both branches happen to set the same fields to the same shapes (the defence is vacuous in the code itself). Symptom: collapsing the if/else into one return leaves both the production code and the test green. Fix: either make the branches genuinely different (one mutates a field the other preserves), OR delete the conditional and the test together — don't pretend the defence exists.
Reference: Council Review 2026-06-04-1826 found three independent burndown tests with these shapes shipping green; the META-pattern across them is "every claim has a test-shaped artefact" decay of EC-37's "every claim has a test" discipline.

**Origin:** Beck × a11y × Backend-TS — Council Review 2026-06-04-1826 (P1 findings #1, #3, #4 convergence)

**Principle:** `references/quality-testing.md` → Mutation resistance + "the red step is the proof"; sibling memories `feedback_verify_test_bodies_not_just_names` (universal — read test bodies not just names) + `feedback_council_documented_contract_canary` (JSDoc + plan invariants are doku-not-enforcement); convention EC-37 (sibling: PLAN watchpoints demand test + grep) + EC-22 (typed-channel emit paths need behavioural-assertion tests)

---

### EC-43: Convention-floor violations MUST be applied symmetrically — when an EC is codified, EVERY sibling call site of the same shape MUST be audited in the same commit

**Convention:** When a convention is added to `conventions.md` (Phase 7 of any Council Review), the commit that codifies the convention MUST ALSO grep the codebase for ALL sibling call sites with the same shape and either (a) bring them into compliance, OR (b) document each non-compliant site as a known-exception with a `// CONVENTION-EXEMPT: EC-N (reason)` comment + a follow-up issue. Adding a convention without auditing siblings is a structural failure: the next reviewer reads the convention, sees it nominally codified, and treats unaudited sibling sites as out-of-scope. Reference symptom from Council Review 2026-06-04-1826: EC-38 (cache predicates over `Date.now()` MUST clamp negative-skew) was added BY the first review's Phase 7 to close `isCacheRecordValid:762`. The SAME file's `readMemoryCache:841` has the identical bare `now - record.fetched_at > IN_MEMORY_TTL_MS` shape — never audited, ship green. Classic `feedback_symmetric_path_missing_transformation` shape: parallel paths where the missing transformation IS the bug. The grep cost is ~10 seconds at convention-add time; the rediscovery cost at the next review is one whole review cycle.

**How to apply:** For each new convention being added in Phase 7, the proposer MUST run `git grep` for the offending pattern across the repo (e.g., for EC-38: `git grep -E "now\s*-\s*\w+\s*>\s*"` to find bare TTL-style predicates). For each hit OTHER than the originating finding's site, either fix it in the same commit OR add a `// CONVENTION-EXEMPT: EC-N` comment with an issue link. The reviewer at the next pass reads the comments to know what's exempt vs unaudited.

**Origin:** Persistence-FS × Carmack — Council Review 2026-06-04-1826 (P2 #7 — EC-38 violated at sibling site in the same file)

**Principle:** `references/quality-persistence.md` → P7 (Replay determinism — applied symmetrically); sibling memory `feedback_symmetric_path_missing_transformation` (universal — parallel paths' missing transformation IS the bug); pairs with EC-37 (PLAN watchpoints demand test + grep) by extending the grep discipline to convention-floor edits

---

### EC-44: New discriminated-union semantic states MUST widen the type alias, NOT overload an existing variant with a sentinel-data-shape

**Convention:** When a code change introduces a semantically distinct state that previously was implicit (e.g., "rejected with prior data preserved" vs "rejected with no data"), the type union MUST be widened to discriminate the two states EXPLICITLY. Overloading an existing variant by ADDING a second field whose presence-or-absence carries the distinction (e.g., `status: "rejected"` + `data: T | undefined`) is forbidden because consumers reading the status field cannot decide the case without combining with a sibling field — and the type system doesn't enforce the combination is read. Acceptable shapes for widening: (a) literal-union extension — `"rejected" | "rejected-stale"` discriminates by the literal alone; (b) tagged-object union — `{kind: "rejected"; hasStaleData: boolean}` or `{kind: "rejected-empty"} | {kind: "rejected-stale"; data: T}` makes the discrimination structural. Forbidden shape: keeping the union narrow and documenting the implicit second-axis in JSDoc — that's `feedback_council_documented_contract_canary` (JSDoc-as-doku-not-enforcement) shipping a fresh instance. Reference symptom: Council Review 2026-06-04-1826 P2 #6 — `loadBackendModels` introduced "soft-rejected" semantics in burndown comments but `DynamicModelsStatus = "idle" | "pending" | "resolved" | "rejected"` was unchanged. The next consumer writing a refresh-button surface must combine `dynamicBackendModelsStatus[backend]` AND `dynamicBackendModels[backend] !== undefined` to render correctly, and the type system doesn't enforce the combination.

**How to apply:** When introducing a new semantic state, ask: "would a consumer reading ONLY the status field know which case they're in?" If no, widen the type. Add the corresponding selector that consumers SHOULD use (e.g., `selectDynamicBackendModelsStatusDetailed(s, backend): "idle" | "pending" | "resolved" | "rejected-empty" | "rejected-stale"`) so the discrimination is at one site, type-system-enforced.

**Origin:** Backend-TS × Fowler — Council Review 2026-06-04-1826 (P2 #6 — soft-rejected semantic introduced without type widening)

**Principle:** `references/quality-backend.md` → P8 (Type safety at the boundary); `references/refactoring.md` → P5 (Primitive Obsession — applied to "primitive" union variants); sibling EC-10 (Discriminated-union state renderers must compile-fail on missing variants) + EC-21 (Documented log/event triplet fields derive from single source — same shape: implicit-second-axis from a "single status field" with hidden combinator); sibling memory `feedback_council_documented_contract_canary`

---

### EC-45: Every kill-path on a persisted PID MUST re-verify process identity immediately before signalling

**Convention:** Any `process.kill(pid, signal)` (or `kill(pid, ...)`) that targets a PID NOT held as a live in-process handle — i.e. a PID read from disk, a sidecar, or classified from `/proc` — MUST call `verifyProcessIdentity(pid, sessionId, expectedStartMs)` (or recompute the argv/start-time anchor it relies on) immediately before the signal, and MUST abort the kill on any non-match verdict. The whole feature added `verifyProcessIdentity` precisely because a stored PID is no proof of identity across a server restart or after the original process exits; kill-paths that trust the raw PID re-open the exact PID-reuse hole the probe was built to close. The pure probe is fail-CLOSED and side-effect-free — there is no excuse for a kill-path to skip it. This applies symmetrically (EC-43) to relaunch, the orphan-reaper REAP branch, graceful shutdown, and any future signal site. Reference symptom: Council Review 2026-06-05-0731 Finding 2 (`relaunch()` SIGTERMs `info.pid` from a previous server instance with zero identity check) + Finding 9 (orphan-reaper no-known-session REAP issues SIGTERM with a classify→kill TOCTOU window).

**How to apply:** Before writing any `kill(pid, ...)`, ask: "is this PID a live handle I spawned in THIS process, or a value I read/classified?" If read/classified, gate the signal on a fresh identity verdict at the signal instant (not at classify time — the gap between classify and kill is real wall-time during which the PID can be reused). Abort on `mismatch`/`gone`/inconclusive.

**Origin:** Subprocess × Hunt — Council Review 2026-06-05-0731 (Finding 2 P1 + Finding 9 P2)

**Principle:** Track PID, but never trust PID across reboots; TOCTOU on lifecycle edges; sibling EC-17 (fail-CLOSED gates) + memory `feedback_verify_runtime_argv_not_source`

---

### EC-46: Primary state writes MUST be as atomic as archive writes — route through `writeAtomicJson`, never raw `writeFileSync`

**Convention:** Any persistence write whose truncation would break boot recovery (session state, launcher state — `saveSync` / `saveLauncher`) MUST go through the tmp+rename+fsync path (`writeAtomicJson`), identical to the already-atomic `moveToArchive`. A raw `writeFileSync` is not crash-atomic: a crash mid-write leaves a truncated JSON file on disk that the next boot cannot parse, stranding the very session the write was meant to preserve. The archive path was made atomic for exactly this reason; the primary path inherits the same requirement. The asymmetry "archive is atomic but the hotter primary write is not" is itself the bug.

**How to apply:** Grep for `writeFileSync` / `Bun.write` on any state file under the persistence layer; each one whose partial content would fail a subsequent parse must be converted to `writeAtomicJson`. When adding a new persisted artifact, default to the atomic helper.

**Origin:** Persistence — Council Review 2026-06-05-0731 (Finding 3 P1 — non-atomic `saveSync`/`saveLauncher`)

**Principle:** Crash-atomicity of load-bearing state; sibling EC-8 (sentinel-before-sweep) + AP-3 (writer+reader co-location)

---

### EC-47: `removeSession` MUST NOT signal the subprocess PID, MUST close browser sockets, and the no-kill invariant MUST be pinned by a mutation-resistance test

**Convention:** The entire safety argument for evicting a session on a STALE probe verdict rests on one property: `removeSession` (the eviction drop) only drops the Map row + cancels timers + clears persistence — it NEVER signals the PID. That property MUST be pinned by an EC-42 mutation-resistance test (remove the no-kill guarantee → a test goes red), because a future change that makes the drop also kill would silently turn "leaked orphan, reclaimed next boot" into "killed live process." SEPARATELY, the eviction drop MUST close + clear the session's browser sockets (the way `closeSession` does) and emit a terminal browser frame before the close — otherwise a still-subscribed tab gets no terminal signal, and on reconnect `getOrCreateSession` resurrects a blank zombie row (`nextEventSeq` reset to 1, no adapter), silently undoing the eviction. Gating eviction on `browserSockets.size === 0` alone is insufficient: it leaves the resurrection vector open for a tab that reconnects after the drop.

**How to apply:** At the eviction site, document the load-bearing "removeSession MUST NOT signal the PID" invariant and back it with a mutation test. Make `removeSession` symmetric with `closeSession` on socket teardown, and cross-check `getOrCreateSession` resurrection against the eviction sentinel / just-archived disk row so a post-eviction reconnect cannot recreate a live row.

**Origin:** Realtime × Subprocess — Council Review 2026-06-05-0731 (Finding 1 P1 — orphaned sockets + resurrection; Finding 12 P3 — stale probe verdict relies on non-destructive drop)

**Principle:** Make the bridge's death visible to the client (silent-death class); sibling EC-42 (mutation-resistance) + EC-16 (server-originated frames carry `origin`)

---

### EC-48: Wire `seq` is assigned by a single authority (`sequenceEvent`); pre-built `seq` in builder/selector paths is forbidden

**Convention:** The authoritative event sequence number is assigned at exactly one site — `sequenceEvent` (`nextEventSeq++`). No builder or selector upstream of the broadcast may pre-compute a `seq` and pass it along: it is dead weight that only HAPPENS to agree because nothing currently mutates `nextEventSeq` between frame-build and broadcast. Any future edit that emits a broadcast between those two points (e.g. a "draining" status_change before `cli_failed`) silently desynchronises the pre-built `seq` from the assigned one, breaking reconnect-replay gap math — with no test or type catching it, because the only guard today is a JSDoc prose contract. Either drop the pre-built `seq` entirely (let `sequenceEvent` be sole authority, as it already overwrites), or turn the prose invariant into a runtime tripwire: assert in `sequenceEvent` that any incoming `msg.seq` equals the assigned value before overwrite.

**How to apply:** When building a frame that will be broadcast, do NOT set `seq` from `nextEventSeq` at build time. Let the single sequencing site assign it. If a type forces the field, build with a placeholder and add the equality tripwire.

**Origin:** Realtime — Council Review 2026-06-05-0731 (Finding 8 P2 — undefended drain↔broadcast seq coupling)

**Principle:** Single source of truth for sequence; sibling EC-21 (single-source derived fields) + memory `feedback_council_documented_contract_canary` (JSDoc is doc, not enforcement)

---

### EC-49: Process-identity start-time anchors MUST store the kernel start instant, not a JS wallclock timestamp

**Convention:** When persisting the start-time factor used by `verifyProcessIdentity` (the sidecar's `processStartMs`), store the SAME quantity the verifier reads — the kernel process-start instant from `/proc/<pid>/stat` field-22 — captured as close to spawn as possible. Do NOT store `Date.now()` evaluated in JS after `Bun.spawn` returns: that is a different clock-of-record, and a GC pause / event-loop stall / cgroup `MemoryHigh` throttle between fork and the JS read can push the gap past the ±2s verification window, false-flagging a perfectly live, correctly-identified subprocess as `mismatch (starttime)` — and triggering a relaunch under exactly the memory pressure that caused the skew, compounding it. Compare like-for-like with zero clock-domain skew. (If the kernel read is genuinely unavailable, the fallback is to widen the tolerance AND document that the stored value is a JS-wallclock approximation — but the clean fix is to store the kernel quantity.)

**How to apply:** At spawn, read `/proc/<proc.pid>/stat` field-22 once and persist that as the identity anchor. The verifier already reads field-22; the two values must come from the same clock.

**Origin:** Subprocess — Council Review 2026-06-05-0731 (Finding 7 P2 — `processStartMs` is JS-wallclock, not kernel start instant)

**Principle:** Make data flow visible and explicit; compare like-for-like; sibling EC-38 (clamp negative wallclock skew) + memory `feedback_cgroup_memoryhigh_throttle_ui_hang`

---

### AP-18: The `cli_failed` drain clears ALL in-flight visual indicators atomically — including `pendingPermissions`

**Pattern:** When a session transitions to terminal `cli_failed`, the client-side dispatch MUST drain EVERY in-flight indicator for that session in one atomic step so the user sees exactly one terminal state, not "terminal banner + leftover spinner/approval." The existing drain already clears streaming / status / toolProgress / cliConnected; `pendingPermissions` is an in-flight indicator the drain currently MISSES, and it is load-bearing because the most natural way a CLI dies is mid-tool-call (a crash-loop on a tool) — exactly the state that leaves a permission pending. Since permission outranks `cliFailed` in the single banner slot, an un-cleared pending permission HIDES the terminal banner behind an Allow/Deny prompt for a dead subprocess: clicking either sends a `control_response` the CLI will never consume, and the "start a new session" surface stays invisible. Therefore: any indicator that can occupy or outrank the terminal-banner slot MUST be in the `cli_failed` drain set.

**How to apply:** When adding a new in-flight indicator or a new banner-slot occupant, audit the `cli_failed` dispatch and add it to the atomic drain if it can survive or outrank the terminal banner. The drain's stated intent ("one terminal state, not banner + spinner + …") is the test.

**Origin:** Friedman — Council Review 2026-06-05-0731 (Finding 5 P2 — pending permission hides terminal banner behind un-answerable approval)

**Rationale:** A terminal state that can be visually pre-empted by a stale interactive gate is a dead-end + trust-break; the atomic-drain contract only holds if it covers every slot occupant, not just the spinners.

---

### AP-17: Module-scope mutable flags for once-per-process operator warnings are legitimate ONLY when accompanied by (a) `__reset...ForTests` helper, (b) at least one test exercising the warn-path, (c) beforeEach reset in any orchestrator suite that could inadvertently trigger them

**Pattern:** Module-scope `let someFlag: boolean = false` IS an acceptable shape for once-per-process operator-facing warnings — the use case is "warn the operator about a degraded runtime configuration, but only on the first occurrence so the log doesn't fill with duplicates." This pattern is legitimate because the alternative (logging every occurrence) creates log-noise that hides the signal, and the alternative-alternative (carrying the flag through every call site as a parameter) is overkill for a process-level concern. HOWEVER: every module-scope mutable flag MUST come bundled with three test-infrastructure pieces:
1. **An exported `__resetForTests` companion helper** — names follow `__reset<FlagName>ForTests`. The `__` prefix signals test-only; the suffix names the flag explicitly so future test authors find it via grep.
2. **At least one test that exercises the warn-path** — proves the flag mechanism works AND that the corresponding `log.warn` (or equivalent) event-name fires with the documented shape (EC-22 emit-path discipline). Otherwise the warn ships green without ever being seen.
3. **A `beforeEach` (or test-suite-level) reset call in every orchestrator suite that COULD inadvertently trigger the warn-path** — prevents process-lifetime test leakage where one test's warn-trigger silently propagates the `true` flag state to every subsequent test in the suite, making subsequent tests assert against a degraded mode that production users wouldn't see.
Reference: Council Review 2026-06-04-1826 P2 #10 — `signalCoalesceDegradeLogged` shipped with the reset helper exported AND zero test callers AND zero test coverage of the warn-event AND no beforeEach reset in the orchestrator suite. Burndown added the helper performatively; the discipline was missing.

**Origin:** Beck × Backend-TS — Council Review 2026-06-04-1826 (P2 #10 — module-scope flag without test infrastructure)

**Rationale:** Module-scope mutable state is acceptable for the legitimate use case it serves, but it crosses the test-isolation boundary in ways that ordinary closure-scoped state does not. The three-piece bundle is the floor that keeps the legitimacy from drifting into test-pollution; without it, the next test author touching the suite inherits a hidden global with no obvious cause.

---

### EC-50: Observer participation visibility MUST be anchored on the review-file write within a bounded window, NOT on turn completion

**Convention:** Whether a Council observer is actually doing its job is observable from exactly one fact: a `<phase>-<provider>-observer.md` review file landed under `.council/reviews/` within a bounded window `T` of the wake that should have produced it. A wake-dispatch that the backend ACCEPTS (synthetic send returns `sent`, the observer's turn starts and even completes) proves only that the transport worked — it does NOT prove a review was produced. The whole accept-but-no-review failure class (a Codex observer that handshakes, takes the wake, runs a turn, and emits nothing to disk; a prompt that replies in chat instead of `Write`-ing the file per the observer contract) is invisible to any liveness check keyed on turn state. Therefore: arm a per-wake watchdog that fires if no review file for that `checkpoint_id` appears within `T`, and surface that timeout as the `wake_produced_no_review` degraded reason — do NOT treat "turn done" or "send accepted" as evidence of participation.

**How to apply:** When wiring any observer-wake path, key the success/failure decision on the review-file artifact (file present for this `checkpoint_id` within `T`), not on the turn lifecycle. The watchdog's single idempotent exit (`resolveObserverTurn`) must be reachable from BOTH the file-arrived path and the timeout path so neither leaks. A green turn with no file on disk is a degrade, not a success.

**Origin:** Realtime × Subprocess — Council Review 2026-06-13-2004 (claude+codex observer parity, Findings #3/#7 — accept-but-no-review invisible to turn-keyed liveness)

**Principle:** Observe the artifact, not the reporter; sibling EC-4 (watcher debounce never silently coalesces) + memory `feedback_progress_mirror_ui_reflects_reporter_not_ground_truth` (turn state mirrors the reporter, the file on disk is ground truth) + `feedback_llm_prompt_emit_ambiguous_transport` (chat-reply instead of file write).

---

### EC-51: Synthetic-send `sync` and `async` failure outcomes MUST converge on a single degraded channel

**Convention:** A server-synthesized observer wake can fail in two clock domains: synchronously (the `sendUserFrameFromServer` / `sendOrchestratorSyntheticFrame` call returns a `failed` / `socket_disconnected` / `busy`-exhausted outcome inline) or asynchronously (the send is accepted but a later `observer:wake-failed` bus event reports the turn never reached the backend). BOTH paths describe the same operational fact — "this wake did not get through" — and they MUST funnel into ONE degrade helper (`degradeObserverWakeFailure`) that emits the SAME `group:degraded` event with the `wake_send_failed` reason. Handling only the async listener (and letting the synchronous `failed`/`default` cases fall through silently) leaves a wake that demonstrably failed at call time looking healthy until some unrelated later signal trips the group — the two outcomes must not diverge in observability just because they failed on different ticks.

**How to apply:** Route every synthetic-send failure outcome — inline return value AND deferred bus event — through the single degrade helper. When you add a new `ServerSyntheticSendOutcome` variant, decide explicitly whether it is a participation failure and, if so, send it through the same helper; do not add a parallel inline degrade path. Test both the sync-return and async-event entries land identical `group:degraded` payloads.

**Origin:** Backend-TS × Realtime — Council Review 2026-06-13-2004 (claude+codex observer parity, Finding #4 — synchronous wake-send `failed` bypassed the degraded channel the async listener used)

**Principle:** Converge equivalent outcomes on one channel; sibling EC-8 (single idempotent exit) + memory `feedback_symmetric_path_missing_transformation` (parallel paths whose one missing branch is the bug) + `feedback_single_ack_defensive_path_first`.

---

### EC-52: A manually-triggered relaunch MUST mark the session intentional BEFORE the kill and ALWAYS clear it in `finally` — same EC-2 discipline as the auto-relaunch path

**Convention:** EC-2 (group-aware kills mark both ids intentional before either kill) is not limited to archive/delete. ANY relaunch that SIGTERMs a live process — the Settings "apply provider credentials" action, the explicit per-session relaunch button, the model-override relaunch — destroys and respawns a process. For a Council half that intentional kill is otherwise indistinguishable from a real death to the `session:exited` listener, which drives `armReconnect` → a transient `reconnecting`/`degraded` flicker on a perfectly healthy pair. Therefore `relaunchSession` MUST add the session id to `intentionalKills` BEFORE invoking `launcher.relaunch`, and MUST remove it in a `finally` block so a stale mark can never lock `scheduleProactiveRelaunch` out of genuine recovery later.

**How to apply:** Mark-before-kill, clear-in-finally is the shape for every code path that intentionally tears down a live CLI process and expects it back. The `finally` is non-negotiable: a relaunch that throws must not leave the id marked, or the next real death is silently swallowed. Test both the during-relaunch presence (mark visible at kill time) and the after/throw absence (mark cleared on success AND on exception).

**Origin:** Subprocess × Realtime — Council Review (PR #142, provider-credential relaunch, Finding #2 — manual relaunch flapped a healthy council pair to degraded)

**Principle:** Extend the intentional-kill boundary to every deliberate teardown, not just lifecycle archive; sibling EC-2 (group-aware kills mark intentional first) + EC-8 (single idempotent exit) + memory `feedback_validate_replacement_before_destroying_working_resource`.

---

### AP-19: Provider auth env at relaunch is reconciled through ONE module with global-authoritative Claude semantics; Codex stays inject-if-absent

**Pattern:** Auth environment variables for a relaunch are NOT carried forward verbatim from the previous spawn env — they are reconciled from the current global provider settings through a single shared module (`provider-auth-env.ts` → `reconcileProviderAuthForRelaunch`). For Claude the global settings are AUTHORITATIVE: clear ALL Claude auth vars (`CLAUDE_AUTH_ENV_VARS` — OAuth token + the three API/auth-token keys) by setting each to explicit `undefined` (NOT `delete`), then set exactly the one chosen credential (OAuth preferred over API key). The explicit `undefined` matters because the Bun spawn-env merge is `{...process.env, ...options.env}` — a `delete`d key would let an inherited `process.env` value shadow the intended state, so the var must be present-and-undefined to win the merge. When global settings carry NO Claude credential, ALL Claude auth vars are cleared symmetrically (deliberate de-auth, not a no-op). Codex is the asymmetric case: `OPENAI_API_KEY` is injected ONLY if absent, because an explicit env-profile key legitimately outranks the global default (precedence-skip).

**How to apply:** Never hand-roll auth-var manipulation at a spawn/relaunch site; route through `reconcileProviderAuthForRelaunch`. Claude = full clear-then-set (explicit undefined, OAuth>key, symmetric de-auth on empty). Codex = inject-if-absent. Non-auth env vars pass through untouched. New backends that gain a credential pick their side of the precedence model explicitly and add a test asserting it.

**Origin:** Hunt × Backend-TS — Council Review (PR #142, provider-credential relaunch, Findings #1/#7/#10b — stale auth var shadowing the chosen credential; inherited `process.env` surviving a `delete`)

**Rationale:** A relaunch is the moment the operator's current credential intent must take effect; reusing the old spawn env strands a session on a revoked/rotated key. Centralizing the precedence model in one module keeps the four-way Claude var interaction and the Codex asymmetry from drifting per call site; sibling memory `feedback_validate_replacement_before_destroying_working_resource` + `feedback_symmetric_path_missing_transformation`.

---

### EC-53: Every fire-and-forget async dispatch AND every `setTimeout`/`setInterval` callback MUST have a top-level `try/catch` — an unhandled rejection is fatal under Bun

**Convention:** Bun terminates the entire process on an unhandled promise rejection or an uncaught timer-callback throw — there is no per-request isolation as in a browser. So any `void somethingAsync()` (a deferred poll like `scheduleCatchupWakeWhenObserverReady`, a fanout), and any `setTimeout`/`setInterval` body (the EC-13 failsafe tick, the watcher re-arm catch-up `scheduleCatchupAfterRearm`), MUST wrap its work so a throw inside cannot escape. The failsafe interval and the re-arm timer are siblings: both re-run `scanForMissedObserverWakes` off a timer, so both carry the same guard. Swallow to a structured WARN (EC-9 shape), never let it propagate.

**How to apply:** At every `void <async call>` site and inside every timer callback that touches app state, the outermost statement is a `try { … } catch (err) { log.warn(..., { event: "…_failed", error: … }) }`. A helper that reads the filesystem or the sentinel (`readCouncilWakeSentinel`) from inside such a path must itself be guarded at the call boundary even if it "can't fail" — a corrupt file or an EACCES turns a benign scan into a server crash. Test the throw path: inject a failing dependency and assert the process-equivalent (the promise resolves / the interval keeps ticking) rather than rejecting.

**Origin:** Subprocess × Backend-TS — Council Review (PR #158, Findings #1/#12 — the void'd catch-up poll and the `scheduleCatchupAfterRearm` timer both lacked a top-level catch; a sentinel-read throw mid-poll could crash the Bun server)

**Principle:** The runtime has no blast-radius containment for async escapes; the code must provide it at each boundary. Sibling EC-9 (structured lifecycle logs) + memory `feedback_no_reissue_sideeffecting_op_on_autocontinue`.

---

### EC-54: A background/periodic scan MUST NOT unconditionally mutate shared live state — advance the shared manifest base only when genuinely ahead, or carry the base into the deferred dispatch

**Convention:** `scanForMissedObserverWakes` runs on three triggers (`init` / `failsafe` every 5 min / `watcher-rearm` per death) and shares `entry.lastCheckpoint` / `entry.previousCheckpoint` — the manifest-delta base read by `dispatchObserverWake` — with the live `handleCouncilCheckpoint` watcher. If the scan overwrites those fields unconditionally from a stale disk read, a concurrent live checkpoint at sequence N gets clobbered to `previous = current = N`, collapsing the `{delta, carried, dropped}` partition and silently under-reporting a checkpoint's modified-file set (which degrades the grounding gate). The scan MUST guard the mutation: only advance when it is strictly ahead of the live watcher (`!entry.lastCheckpoint || highest.sequence > entry.lastCheckpoint.sequence`). Likewise, a periodic scan MUST fail fast on conceptually-dead groups (status not `active`/`reconnecting`) and MUST de-duplicate in-flight catch-ups (an in-flight `Set` keyed `${groupId}:${checkpoint_id}`, cleared in `finally`) so overlapping triggers cannot stack N concurrent 30s pollers or double-send a wake.

**How to apply:** Any timer- or event-driven background pass that touches state a live path also writes: (a) gate every write behind a "am I actually ahead?" check, or thread the value through the deferred call as an argument instead of the shared entry; (b) pre-filter dead entities at scan time, not after a 30s poll; (c) hold an in-flight key for the duration of the async dispatch so concurrent triggers collapse to one. Test the concurrent-clobber case explicitly (live advances to N, then a scan re-reads N from disk → base must remain N-1→N, not N→N).

**Origin:** Subprocess — Council Review (PR #158, Findings #2/#3 — the failsafe/rearm scan clobbered the manifest base and stacked duplicate pollers with no in-flight guard or status pre-filter)

**Principle:** Canonical live state must not be corrupted by a stale background reader; a periodic re-check is a no-op only when it refuses to write unless strictly newer. Sibling EC-4 (watcher debounce never coalesces distinct payloads) + memory `feedback_progress_mirror_ui_reflects_reporter_not_ground_truth`.

