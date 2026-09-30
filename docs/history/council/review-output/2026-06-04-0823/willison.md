# Willison — LLM Pipeline Review

PR: `feat/dynamic-claude-models` (commit `fdf88e0`)
Files: `web/server/anthropic-models-cache.ts`, `web/src/components/ModelSwitcher.tsx`
Reference: `quality-llm.md` (Carmack × Willison)

Plan line 211 declared the Willison lane "intentionally empty": renderer trust deferred to Hunt R6, parser replay to Realtime R1 + Task 2 fixture, fail-CLOSED to Backend R5. Two of those three transitive coverages hold up after implementation; one slipped, and two new LLM-pipeline-shaped concerns surfaced from how the dynamic list interacts with the SUBPROCESS CLI version downstream — which the plan's transitive coverage did not anticipate.

Findings are scoped to LLM-pipeline correctness as defined in `quality-llm.md`. General security (apiKey-in-argv, SSRF, etc.) is Hunt's lane and is NOT re-flagged here. General backend (timeout discipline, abort propagation) is Bun/Hono Backend's lane.

---

## P1 — None

The renderer-trust concern (markdown XSS at `display_name` rendering) is FULLY covered: `ModelSwitcher.tsx:201` renders `currentOption.label` and `:244` renders `model.label` as React children — default-escaped, no `dangerouslySetInnerHTML`, no markdown pass. The `title={currentOption.label}` (`:195`) and `title={model.label}` (`:228`) attributes are React-escaped too. `description` from `BackendModelInfo` is dropped by `toModelOptions` (`backends.ts:38-42`) before reaching the renderer — even if hostile upstream stuffed it with HTML, the frontend type (`api.ts:252`) lacks the field. The parser's `isBoundedSafeString` (`anthropic-models-cache.ts:282`) rejects C0/C1/DEL/bidi controls at ingest — Trojan-Source defence holds.

No P1 LLM-content-rendering finding remains.

---

## P2 — Model/CLI version-skew failure is opaque to the user

**File:** `web/server/anthropic-models-cache.ts` (orchestrator) + `web/server/cli-launcher.ts:840` (spawn site)

**Concrete failure mode:** Dynamic list returns `claude-opus-4-8-20260415` from Anthropic. User clicks it in `ModelSwitcher`. The session-creation path pushes `--model claude-opus-4-8-20260415` into argv (`cli-launcher.ts:840`). Local `claude` binary is older and does not know that id → process exits in <5s with a non-zero code → `cli-launcher.ts:953-971` logs `Session X exited (code=N)` and emits `session:exited`. The browser sees "session ended" with no breadcrumb saying "the model you picked was from the live Anthropic catalogue (source=network), not the static fallback, and the local CLI may not know it yet." The user retries the same model and gets the same opaque failure.

This is exactly the `quality-llm.md` Principle 7 pattern: *"The CLI version is the determining factor for protocol shape, available tools, and permission semantics. Hard-coded assumptions about a specific CLI version are versionic debt."* The plan called Subprocess R1 (no probe-spawn) — correct. But the symmetric concern — that the dynamic-list source must leave a forensic breadcrumb when the downstream consumer (CLI) rejects an id the API claimed exists — was NOT covered transitively by Hunt R6 or Backend R5.

**Minimum-viable breadcrumb:** When `cli-launcher` spawns with `options.model`, attach `model_source` (one of `static-fallback | dynamic-memory | dynamic-disk | dynamic-network`) to the session's `SdkSessionInfo` at construction. On an immediate-exit (uptime <5s, exit code non-zero), the post-mortem log line includes `model_source`. The route handler at `routes.ts:/sessions/create` already has access to whichever path resolved the model — propagate it. No probe-spawn required; this is metadata propagation, not validation. Pair with a doc note in the immediate-exit log: *"if model_source ≠ static-fallback, the selected model may not exist in this CLI version — try a model from the static fallback set."*

**Severity:** P2. Not a correctness gate; the spawn still fails closed (no work done under a wrong model). But it is the single most-likely user-facing regression introduced by this PR, and `quality-llm.md` Principle 7 is exactly the canon that says CLI version visibility per session matters.

---

## P2 — Model id flag-injection defence has ONE enforcement point, ZERO at spawn argv

**File:** `web/server/anthropic-models-cache.ts:264` (regex) + `web/server/cli-launcher.ts:840` (spawn site)

The regex `/^claude-[a-z0-9.\-]+$/` defends against argv-flag injection (a leading `-` is impossible). It fires at `parseAnthropicModelsResponse` (line 346) — i.e., at the boundary where Anthropic's JSON enters the cache. This is correct for the dynamic-list path. **But:**

1. **The static fallback path bypasses it.** `CLAUDE_MODELS` in `web/src/utils/backends.ts:47-51` is a frontend-only literal. Today's values are safe. A future contributor adds `{ value: "-rm-rf", label: "..." }` to that array (or worse: makes it dynamic from `localStorage`) and `cli-launcher.ts:840 args.push("--model", options.model)` happily pushes it.
2. **The `set_model` runtime channel bypasses it.** `claude-adapter.ts:560-568 handleOutgoingSetModel(model: string)` forwards arbitrary `model` strings as the `model` field of a `control_request`. Not argv (not a flag-injection vector via execve), but a hostile-or-buggy frontend can ship any string to the CLI's `setModel()` and there is no server-side rejection. The session's persisted `sdkSession.model` then echoes back through `cli-launcher` on the next relaunch — at which point it IS argv.
3. **No test asserts the spawn-side regex.** `Grep CLAUDE_MODEL_ID_RE` hits one file (`anthropic-models-cache.ts`). The cache parser is tested. The spawn site is not.

**Concrete failure mode:** Persisted session state has `model: "--print"` (e.g., a refactor accidentally seeded a flag-shaped default; or a future relaunch path reads a corrupted JSON). `cli-launcher.ts:840` produces `claude --sdk-url ... --model --print --output-format ...` — the `--print` after `--model` is consumed AS the model value, and the second `--print` is now duplicated, but along the way the user's session has effectively had its argv mutated by data. This is the same failure-class Hunt R6 was designed to defeat, but only at one of three entry points.

**Minimum-viable fix:** Promote `CLAUDE_MODEL_ID_RE` (or a re-export) to a shared `model-id.ts` module; call it from `cli-launcher.ts` immediately before `args.push("--model", model)` and throw a typed `InvalidModelIdError` on miss; call it from `claude-adapter.handleOutgoingSetModel` to reject before forwarding; add one test per call site asserting that `--rm-rf`, `--print`, `; rm -rf`, an empty string, and a 1000-char garbage string are all rejected. The cache's parser then becomes ONE of three defence layers, not the SOLE one — which matches `quality-llm.md` Principle 5 ("Make the wrong thing impossible") and matches the project's `feedback_one_fix_claim_grep_literal_value` memory pattern (one regex needs to live at every site that consumes the value).

**Severity:** P2. The dynamic-list parser does enforce it. Today's static fallback is safe. But declaring the spawn-side argv un-validated by inviting `Grep CLAUDE_MODEL_ID_RE` to return ONE hit is structurally fragile — it's exactly the "symbol exists, call site missing" pattern from `feedback_call_site_presence_not_just_symbol_export` in project memory.

---

## P3 — `has_more: true` is a logged-and-served partial; not a behavioural test

**File:** `web/server/anthropic-models-cache.ts:1166-1174`

When Anthropic ships paginated `/v1/models` (already plausible — they sell more than 4 models in production, and the fixture's 4 entries are intentionally toy), the parser logs `pagination-needed` and serves page 1 only. The dropdown silently misses `claude-opus-5-x` until someone reads the log.

This is `quality-llm.md` Principle 4 (Recording-based replay) AND Principle 7 (Model/CLI portability) intersecting. The plan flagged it as "out of scope" but did not add a behavioural assertion that the canary actually fires.

**Concrete failure mode:** Anthropic ships pagination 2026-Q3. The cache serves page 1 (the legacy/older models). The user, having already migrated to a newer model, can no longer find it. They check logs only after losing a day to "why is my model not in the dropdown?"

**Minimum-viable test:** Replay-fixture variant where `has_more: true` → assertion that the structured log entry `anthropic-models.pagination-needed` was emitted with the expected `key_fingerprint`. This is one new test; it makes the canary load-bearing instead of advisory.

**Severity:** P3 because today it's documented behaviour and not a correctness violation. Becomes P2 the day Anthropic ships pagination. Cheap to lift now (replay test, no production code change) versus debugging after the fact.

---

## P3 — Fixture is synthetic; one real-capture would catch upstream schema drift faster

**File:** `web/server/fixtures/anthropic-models-response.json` (39 lines), `web/server/fixtures/README.md`

Plan acknowledged this as parked. The fixture exercises the parser correctly given KNOWN content. It does NOT catch the case where Anthropic adds a new field (e.g. `deprecated_at`, `replacement_id`) that the parser silently ignores but the UI should surface, OR removes/renames a field the parser depended on (e.g. `display_name` → `name`).

This is `quality-llm.md` Principle 4: *"Replay only happy-path recordings."* The replay corpus today is synthetic-happy-path. One real capture (with operator's own key, key redacted) per quarter would catch schema drift the synthetic fixture cannot anticipate. The README documents the refresh procedure; it does not document that the refresh is OPERATOR's responsibility on each Anthropic version bump (`ANTHROPIC_VERSION_HEADER = "2023-06-01"` is pinned but the schema can drift within a version).

**Minimum-viable improvement:** Add a CHANGELOG-style log in `fixtures/README.md` for "last refreshed against `/v1/models`" date + the Anthropic API version that was current. When a user reports "my model isn't in the dropdown," operator checks if the fixture is older than the user's Anthropic catalogue.

**Severity:** P3. Plan flagged it. Real-capture cadence is operator process, not code. Lifting it to P3 only as a documentation discipline note.

---

## NOT A FINDING — display_name "Claude " prefix strip

**File:** `web/server/anthropic-models-cache.ts:485-487 normaliseModelLabel`

The brief asked: could a hostile upstream return `display_name: "Claudia Special"` and have `"Claudia"` survive the strip?

Verified: regex `/^Claude\s+/` requires literal `"Claude "` (5 chars + at-least-one-whitespace, anchored at start). `"Claudia Special"` starts with `Claudi` — no whitespace after `Claude`, NO MATCH, no strip. Label renders as `"Claudia Special"`. This is correct behaviour (graceful pass-through; hostile upstream is upstream's problem; the bytes are bounded + Trojan-Source-defended by `isBoundedSafeString` before this stage). Plan transitive coverage holds.

Not a finding.

---

## Summary

| Severity | Count | Items |
|----------|-------|-------|
| P1 | 0 | (renderer-trust covered transitively as plan claimed) |
| P2 | 2 | Model/CLI version-skew failure breadcrumb; CLAUDE_MODEL_ID_RE has one enforcement point not three |
| P3 | 2 | `has_more` canary needs behavioural test; fixture-is-synthetic operator-cadence note |

The plan's "Willison lane intentionally empty" was 80% correct. The two P2s are the surfaces the transitive coverage missed: (1) dynamic-list ↔ CLI-version-skew handoff has zero breadcrumb (Principle 7 says version visibility per session matters); (2) the parser's anti-flag-injection regex is the SOLE enforcement point for a value that flows into argv via two other paths (static fallback and persisted `set_model` state). Both fixes are surgical and well within the convention floor — neither requires re-architecting.
