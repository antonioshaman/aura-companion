# Simon Willison — LLM Pipeline Review (Council Mode Phases E + G)

Scope: observer-prompt, observer-attribution, observer-grounding, review-watcher, session-orchestrator (handleCouncilReview + watcher wiring), cli-launcher observer-role branch, `.council/prompts/observer-system.md`, council-types deltas. Conventions AP-1..3 and EC-1..9 honoured — not re-flagged.

---

## P1 findings

### W-P1-1 — Server-generated finding ids are non-deterministic, so any re-emission produces duplicate rows in the browser

**File:** `web/server/session-orchestrator.ts` lines 449-469 (`handleCouncilReview` id assignment)

**Failure mode:** `handleCouncilReview` mints fresh ids via `randomBytes(8).toString("hex")` on every call. The browser's de-dup in `council-slice.appendObserverReview` (lines 278-284) is keyed on `finding.id`. The only dedup gate between filesystem and browser is the watcher-process-local `seenDedupKeys` Set in `watchReviews` (review-watcher.ts:57), which is constructed inside the function body and lives only as long as the AbortSignal that started it. The result: any path that re-invokes `watchReviews` for the same group — server restart while the review file still exists on disk, group recreation after archive, abort+restart of the watcher on a transient error — re-emits the *same* review with *new* `fnd_<hex>` ids. The browser sees those as distinct findings and appends them. STOPs duplicate as STOPs, NOTEs duplicate as NOTEs, the FindingsLog grows without bound. The observer's panel becomes unreliable after the first server restart of a long-running council group. Cross-reference: `quality-llm.md` Principle 4 — "If you can't reproduce a bug" — and the existing Aura recording-replay culture. The natural fix is a deterministic id derived from `(session_group_id, checkpoint_id, observer_provider, findingIndex)`, which is what the watcher's own dedup key is already built around.

**Severity:** P1 — observability of LLM judgements is the product. Silent duplication breaks every panel decision the user makes about the observer's signal.

---

### W-P1-2 — `handleCouncilReview` correlates downgrades to findings by *array index*, but the browser correlates by *id* — when no STOPs were downgraded the mapping is fine, but a downgrade against any non-zero index falls back to a fresh random id that matches nothing on the browser

**File:** `web/server/session-orchestrator.ts` lines 464-469

**Failure mode:** The downgrade-to-finding correlation reads `findings[d.index]?.id ?? `fnd_${randomBytes(8).toString("hex")}``. Defensive fallback is sensible, but the *primary path* is also fragile: `findings` is the post-map array built in the immediately preceding `.map((f, idx) => …)`, so `findings[d.index]` is the just-minted random id — that part works. However, the downstream contract is that `BrowserObserverDowngrade.id` MUST equal the corresponding `BrowserObserverFinding.id` so the browser FindingsLog can render the downgrade chip on the right row. The current code achieves this only because (a) the map preserves order and (b) `d.index` references the original observer payload's index, which equals the post-map index because the map is 1:1 and order-preserving. That invariant is implicit and EC-coverage-gap: a future refactor that filters findings (e.g. drops INFO rows server-side) silently breaks the chip alignment. There is no test asserting `downgrades[i].id === findings[downgrades[i].index].id` against a realistic mixed-tier payload. Combined with W-P1-1's id non-determinism, the fallback `fnd_<hex>` branch produces a downgrade with an id that matches **no** finding row — the chip is orphaned.

**Severity:** P1 — the destructive-banner UX rests on this correlation; an orphan downgrade hides the demotion that is the gate's whole point.

---

### W-P1-3 — Observer system-prompt artifact loads from `cwd/.council/prompts/observer-system.md`, so a workspace can supply a replacement prompt and silently re-role the observer

**File:** `web/server/cli-launcher.ts` lines 586-601; `web/server/observer-prompt.ts` lines 75-124

**Failure mode:** The observer-role branch resolves the prompt path from the session's `cwd` — typically the user's workspace, possibly a worktree or container — *not* from a server-trusted location (e.g. `__COMPANION_PACKAGE_ROOT`/.council/prompts). The loader's defences (schema header pinned, size cap, min-body floor) are about *malformed* prompts, not *adversarial* ones. A workspace that ships its own `.council/prompts/observer-system.md` — including the version sentinel and 256+ bytes of plausible prose — passes every validator. The observer then runs under a workspace-supplied role definition that may instruct it to never emit STOPs, to emit ungrounded STOPs, or to leak environment data into the review file. Willison P1 (the bridge is downstream of an LLM, every byte is untrusted) extends here to the prompt artifact itself when its source-of-truth is workspace-rooted. The plan brief asserted "Observer prompt-at-spawn is hard-fail" — that solves the *missing* case, not the *substituted* case. Hunt should also see this; calling out the LLM angle because the failure surface is the model's behaviour, not a code path.

**Recommended hardening:** Load the prompt from a process-trusted root (the install dir), and either disallow workspace overrides or require an explicit settings toggle that surfaces in the council-mode toggle UI. At minimum, log the resolved path + SHA-256 to the structured logger at every spawn so a substituted prompt is forensically visible. The `info.observerPromptSha256` field already exists; nothing currently emits it.

**Severity:** P1 — the prompt is the entire role definition of an independent reviewer; trust boundary is at file-path, not at file-content.

---

### W-P1-4 — Phase E pure helpers (`buildObserverContextManifest`, `wrapObserverFindingForInjection`, `formatObserverInvocationLog`) have no production callers, but the prompt + the grounding gate + the docs all describe behaviour that depends on them

**Files:** `web/server/observer-prompt.ts:161-193`, `web/server/observer-attribution.ts:81-117`, `web/server/observer-attribution.ts:163-184`. Production-side grep returns only the test files. `handleCouncilReview` does NOT call the attribution wrapper before emitting `group:review`; `handleCouncilCheckpoint` does NOT call `buildObserverContextManifest` before writing or relaying the manifest; no path calls `formatObserverInvocationLog`.

**Failure mode:** Three distinct correctness-by-documentation gaps:

1. **Manifest is cumulative, not delta.** The prompt artifact (`.council/prompts/observer-system.md` lines 26-30) tells the observer "Read **only** the manifest paths." `buildObserverContextManifest`'s JSDoc says "*observer receives only the artifacts that changed since the previous checkpoint, NOT the cumulative `.council/`+`specs/` tree growing across phases.*" But on the server side, `handleCouncilCheckpoint` simply stores `payload` as `entry.lastCheckpoint` (line 421) and relays `payload.checkpoint_id/phase/sequence` (lines 422-427); the observer-side reads the on-disk checkpoint JSON itself. Whatever the orchestrator writes there is what the observer sees — there is no server-applied delta filter. The "pure helper exists and is tested" satisfies the unit-level shape; the integrated path does NOT enforce the delta. If the orchestrator writes a cumulative manifest, the observer suffers Willison P8 context distraction; the prompt cannot tell because the prompt cannot count files. This is the watchpoint the brief flagged — confirmed as a real gap.

2. **Attribution wrapper is dead code.** `wrapObserverFindingForInjection` produces a preamble-prefixed envelope that is supposed to inject findings into the orchestrator chat as a synthetic system message with explicit untrusted-content delimiters. No callsite uses `injectionText` or `attribution`. The browser renders findings directly from `BrowserObserverFinding` fields through `BlockerBanner` JSX — which IS safe (Hunt P1, confirmed by `BlockerBanner.test.tsx:89-97`) — but the documented multi-layer defence ("preamble + delimiter + JSX escape") is in reality a single-layer defence (JSX escape only). If a future refactor adds prose rendering, dangerouslySetInnerHTML, a markdown layer, or a Telegram-style mirror, the documented preamble layer doesn't exist to fall back on. EC-7 / EC-9 echo: invariant in JSDoc is documentation; invariant in the call-graph is enforcement.

3. **Invocation log is unemitted.** `formatObserverInvocationLog` produces an EC-9-shaped entry tagged `observer.invocation.completed` with `promptSha256`, `latencyMs`, `stopCountRaw/Grounded`, `downgradeCount`. Nothing in `handleCouncilReview` calls it; the only log line in that path is the warn on grounding-validation throw (line 442). The forensic re-run guarantee that the prompt SHA is captured at every observer invocation — the whole reason `observerPromptSha256` exists on `SdkSessionInfo` — does not survive review completion. Recording-based regression on observer-quality drift is the project's secret weapon (Willison P4); without the invocation log it is unsupported.

**Severity:** P1 collectively, because each of the three integration gaps invalidates a contract that the surrounding code, comments, and prompt *claim* is enforced. Per-item this would be P1 / P2 / P2, but the pattern is structural: Phase E built the right primitives and Phase G wired the FS events but didn't compose the two.

---

## P2 findings

### W-P2-1 — Grounding semantic-shift (manifest-as-modifiedFiles) is documented in the source but the observer prompt's wording is misleading

**Files:** `.council/prompts/observer-system.md` lines 59-62; `web/server/session-orchestrator.ts` lines 431-433.

**Failure mode:** The prompt tells the observer "A STOP that is not grounded in `evidence_path` *and* in a file the orchestrator actually modified in this phase will be downgraded to NOTE." The implementation grounds against `entry.lastCheckpoint?.artifact_paths` — the *manifest* paths, which is the observer's READ set, not a git-diff or a modification list. For the v1 spec — where the observer's contract is "produce findings only about manifest paths" — these two sets are intentionally identical, but the prompt's word "modified" misleads the model toward a different intent. If an orchestrator emits a manifest of paths that include un-modified READ-only context files (legitimate use of `artifact_paths` as the observer's reading window), STOPs against the un-modified files are grounded, which is the opposite of the prompt's stated guarantee. Either tighten the prompt language to "in your manifest" (matching the implementation) or tighten the checkpoint contract so `artifact_paths` is documented as "modification set, never reference set" and split off a separate `reference_paths` for read-only context. Document the choice in `council-types.ts` JSDoc on `CheckpointPayload.artifact_paths`.

**Severity:** P2 — drift between the prompt and the gate erodes observer calibration, which compounds.

---

### W-P2-2 — `handleCouncilReview` silently drops the entire review on a grounding throw, with no replay-friendly artefact

**File:** `web/server/session-orchestrator.ts` lines 438-447

**Failure mode:** When `validateObserverFindings` throws — currently only on a misconfigured `workspaceRoot`, but defence-in-depth assumes future failure modes — the catch block logs a warn and `return`s. The observer's review file is on disk; the browser sees no `observer_review` message; the next checkpoint may overwrite the manifest. The recording layer doesn't capture review files (the recorder is wired to CLI WebSocket NDJSON, not the .council FS surface). The observer's signal is lost without any replay-friendly artefact. Willison P4 (recording-based replay): every observer signal should be reproducible from a recording, but the council-mode signal channel is *out-of-band* of the recorder. At a minimum, emit a structured-log line that includes the review-file path so a forensic re-run can rebuild the lost signal from the on-disk file.

**Severity:** P2 — silent observer-failure isn't a security issue but it is a debuggability cliff.

---

### W-P2-3 — Observer system prompt embeds the JSON schema example as a code block, which a Claude or Codex model may interpret as "use this exact provider value" — the prompt is *not* CLI-agnostic in the way the brief claimed

**File:** `.council/prompts/observer-system.md` lines 99-122 (the schema example), line 109 in particular.

**Failure mode:** The schema example shows `"observer_provider": "claude" | "codex"` and `"observer_model": "<your model id>"`. For a `claude+claude` pairing the observer is Claude — fine. For a hypothetical future `claude+gemini` pairing, the observer is told to emit `"claude" | "codex"`, which would fail `parseObserverReviewPayload`'s `isBoundedToken` check (no — actually any token passes) but would mis-label the provider for downstream UI. The plan watchpoint T13 said the prompt should be CLI-agnostic; in practice the schema enum is hard-coded in the prompt, and any new provider added to `backend-provider.ts`'s `SUPPORTED_PAIRINGS` will also need a prompt edit. Either pull the provider-list into a templated section of the prompt (load + interpolate at spawn) or relax the prompt to say "your provider name token, e.g. claude or codex".

**Severity:** P2 — versionic debt, slow-acting. Realistic risk only when a third provider is wired.

---

### W-P2-4 — Observer prompt artifact is loaded fresh at every spawn (correct), but there's no test asserting prompt-mutation-between-spawns produces a different `observerPromptSha256`

**Files:** `web/server/cli-launcher.ts:586-601`, `web/server/observer-prompt.test.ts`.

**Failure mode:** The brief asked: "what happens if the artifact is replaced mid-session? is it a fresh load per spawn?" Answer: yes, fresh load per spawn because `loadObserverSystemPrompt` is called inside the `Bun.spawn` path. But there's no test that catches a regression where the artifact path is memoised, cached, or hoisted to module-init. The in-repo-artifact test (`observer-prompt.test.ts:132-140`) is a load-canary, which is good (Willison P4 echo), but a freshness-canary is also necessary: write artifact-A → load → verify SHA-A; rewrite artifact-B → load → verify SHA-B differs. Cheap to add; protects against an "optimisation" PR.

**Severity:** P2 — defensive coverage gap, no live bug.

---

### W-P2-5 — The review-watcher dedup key is `(checkpoint_id, observer_provider)` but `seenDedupKeys` is process-local AND function-local

**File:** `web/server/review-watcher.ts:57`

**Failure mode:** Cross-references W-P1-1 from a different angle. The watcher's dedup correctly handles same-file rewrites within one watcher lifetime. It cannot dedup across: (a) watcher restart on the same group (e.g. `stopCouncilWatchers` → re-create after an aborted phase); (b) server restart (the file may still be on disk from the last session); (c) different observer providers reviewing the same checkpoint — correctly NOT deduped, two providers should land. The contract is correct for (c) but mis-specified for (a) and (b). Either persist the dedup keys (write a sentinel into `.council/reviews/.seen.jsonl` keyed by `(group, checkpoint, provider)`), or accept the re-emission at this layer and dedup deterministically *downstream* (which is what W-P1-1 proposes). One of the two; current code does neither for restart cases.

**Severity:** P2 — primary impact is W-P1-1's duplication, called out separately because the fix locus is different.

---

## P3 findings

### W-P3-1 — Observer model id is captured in the review payload but no CLI version is logged at spawn time

**File:** `web/server/cli-launcher.ts` (observer branch line 586-601); compared against Willison P7 (model/CLI portability).

**Failure mode:** The `ObserverReviewPayload.observer_cli_version` field is filled by the observer itself (the model writes its own CLI version into the JSON). For a misbehaving observer the field is whatever the model says, including stale or fabricated. Server-side detection of the observer's actual CLI version at spawn (analogous to `claude --version`) would give a forensic ground-truth. Not load-bearing yet — most bug reports will name a single CLI version — but versionic debt accumulates.

**Severity:** P3.

### W-P3-2 — Observer doesn't stream, review file is one-shot — verified, no stream-lifecycle gap, but the WS shape allows multiple `observer_review` messages per group lifetime with no `complete` flag

**Files:** `web/server/session-orchestrator.ts:330-346`, `web/src/store/council-slice.ts:270-291`.

**Failure mode:** Council-mode is correctly *not* a streaming surface — one review per checkpoint, atomically written, watched, emitted. No stream lifecycle to model (Willison P2 N/A here). However, the browser's append-on-`observer_review` has no notion of "review N complete vs review N partial." If a future change makes the observer emit incremental findings (e.g. real-time review for long phases), the store has no `streaming|complete|errored` discriminator. Document the current one-shot guarantee in `council-types.ts` so a refactor doesn't silently break it.

**Severity:** P3 — pre-emptive documentation of an invariant.

---

## Cross-cutting summary

The Phase E primitives are individually excellent — pure, tested, EC-compliant. The Phase G integration partially composes them: grounding is wired and validated, prompt loading is wired, FS watchers are wired. But three of the most safety-relevant Phase E helpers — context-manifest delta, attribution-wrapper, invocation-log — are *not* called from any production path, while the documentation, comments, and prompt artifact behave as if they are. The single most leveraged fix is W-P1-4: wire the three unused helpers into `handleCouncilCheckpoint` and `handleCouncilReview`, which also resolves the W-P1-3 forensic-gap (prompt SHA captured per invocation) and W-P2-1's grounding-semantic drift (delta manifest matches "modified" prompt language).

W-P1-1 (deterministic finding ids) is the highest-yield independent fix — small surface, large reliability return, removes the duplicate-on-restart class.

W-P1-3 (workspace-rooted prompt path) is the highest-trust-boundary risk; coordinate with Hunt's lane.

No findings against the renderer trust boundary (`BlockerBanner.test.tsx:89-97` is a meaningful test), against the ai-validator (out of scope, no `ai-validator.ts` touched in Phases E+G), or against streaming (correctly absent). Replay-based coverage is present for the prompt-artifact and the grounding helper; absent for the integrated review pipeline (W-P2-2). The bridge's recorder doesn't see the FS surface; that's a project-wide gap but only newly relevant for council mode.
