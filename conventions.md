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
