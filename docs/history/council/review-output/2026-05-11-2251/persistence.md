# FS-JSON Persistence Expert — Council Review (Phases D–G)

Reviewer: Filesystem JSON-Store Persistence Expert (Carmack lens)
Scope: `web/server/review-watcher.ts`, `web/server/review-watcher.test.ts`, `web/server/observer-prompt.ts`, `web/server/observer-prompt.test.ts`, `web/server/observer-write-policy.ts` (wiring confirmation only)
Conventions floor: AP-1..3, EC-1..9 (NOT re-flagged).

---

## P1 — Fix Now

### P1-1 — `watchReviews` debounce keys on filename only — silently coalesces distinct payloads on the same path (EC-4 regression on the new watcher)

- **File:** `web/server/review-watcher.ts:75–84`
- **Severity:** **P1**
- **Principle:** `quality-persistence.md` Principle 2 ("debounce is a correctness window"); convention EC-4.
- **What's wrong:** The debounce map is keyed by `file` (filename). When an FS event arrives for an existing key, the existing timer is `clearTimeout`-ed and replaced. If two distinct payloads land on the same path within the 150 ms window (the orchestrator's writeAtomicJson + a quick re-emit; two different observer attempts on the same `<phase>-observer.md`; or — most importantly — both providers in `claude+codex` pairing writing to the same `<phase>-observer.md` filename because neither the protocol nor `observer-system.md` instructs them to namespace by provider), only the **last** write is ever read. The dedup-by-`(checkpoint_id, observer_provider)` set at lines 122–129 deduplicates *after* the read — but only the last rename's bytes are read, so the first write's payload is permanently lost. The watcher's docstring promises EC-4 ("`watchReviews` ... same atomic-write + debounce + dedup contract as `watchCheckpoints`"), but EC-4 explicitly forbids filename-only keying when distinct payloads can collide on the same path. The same shape is inherited from `checkpoint-watcher.ts` — but here it bites harder because the `(checkpoint_id, observer_provider)` two-axis dedup key implies the design contemplates two providers reviewing the same checkpoint, and the only way that can land via this watcher is either (a) two distinct filenames (uncontracted in the prompt) or (b) two distinct writes to the same path within ~150 ms (silently coalesced).
- **Concrete data-loss mode:** In `claude+codex` pairings (the experimental case this whole branch exists to enable), the claude-half observer's review is silently dropped whenever the codex-half writes within 150 ms — and the user sees only one set of findings with no log line saying anything was lost. That is the exact "EC-4 silent coalesce" failure that the prior council review codified the convention to prevent.
- **Fix:** Either key the debounce map by `(file, sizeOnEvent)` / `(file, mtimeNs)` (read both metadata fields inside the watch loop), OR read inside the debounce window and emit per distinct content hash. Add the regression test EC-4 mandates: two `writeAtomicJson(samePath, distinctPayload)` calls inside one 150 ms window both surface (or one is recorded via `onDropped` with reason `"superseded"`). The current test at `review-watcher.test.ts:96–117` writes the *same* payload twice — it cannot detect the regression.

---

### P1-2 — Observer review filename is ambiguous in the multi-provider pairing — no protocol contract for provider-disambiguation on the path

- **File:** `web/server/review-watcher.ts:25` (regex), `.council/prompts/observer-system.md` (entire — no filename rule), `web/server/observer-write-policy.ts:45`
- **Severity:** **P1**
- **Principle:** `quality-persistence.md` Principle 6 (validate at the boundary); Principle 8 (every shape is a contract); EC-4 root cause.
- **What's wrong:** The pinned filename shape `^[A-Za-z0-9_-][A-Za-z0-9_.\-]{0,63}-observer\.md$` allows the phase prefix to contain hyphens, so both `phase-a-observer.md` and `phase-a-claude-observer.md` / `phase-a-codex-observer.md` would pass the gate. But `observer-system.md` (the only file telling the model how to emit) does **not** specify a filename. The docstring at `review-watcher.ts:13–14` says "an LRU of seen `(checkpoint_id, observer_provider)` pairs dedups re-emission" — that key cannot disambiguate two providers writing to the **same** filename within the debounce window (P1-1) and cannot direct two providers to write **different** filenames either (no prompt instruction). Neither half of the pair currently has a path contract; whichever writes second wins. The "two reviews for the same checkpoint from different providers should both surface" comment at lines 122–123 is aspirational, not enforced anywhere.
- **Concrete data-loss mode:** Half of every `claude+codex` review session is silently lost or silently overwritten depending on race timing. This is the entire experimental pairing's value proposition collapsing into "whoever writes last wins" — without a log line saying so.
- **Fix:** Pin a provider-aware filename in (a) `observer-system.md` ("write to `.council/reviews/<phase>-<provider>-observer.md`"), (b) the `REVIEW_FILENAME_PATTERN` regex (require the `<provider>` segment as a token from the allow-list `claude|codex`), and (c) the dedup key (per-file, so the LRU is shadow-redundant for the provider axis but still useful for re-emission of the same file). Add a test asserting that two providers writing distinct filenames within 150 ms each surface their distinct payloads.

---

## P2 — Fix Soon

### P2-1 — `seenDedupKeys.add()` runs BEFORE handler is awaited — a transient handler exception permanently drops the review

- **File:** `web/server/review-watcher.ts:129–138` (also identical shape in `checkpoint-watcher.ts:126–137` — re-flag here because the review path is new and the bug carries through)
- **Severity:** **P2**
- **Principle:** `quality-persistence.md` Principle 3 ("close every state on every exit path") + Principle 4 (no silent swallow); EC-8 ("silent swallow of action-side failures is forbidden").
- **What's wrong:** `seen.add(dedupKey)` is committed before `await onReview(payload)` runs. If the handler throws (transient WS broadcast failure, downstream grounding bug, anything), `onDropped("handler-error", ...)` logs the drop — but the dedup key is already poisoned. The observer cannot recover by re-writing the same review file: the next emission will be dropped as `"duplicate-review"`, not retried. The committed state is "we acknowledged this checkpoint" while the user side never received it.
- **Concrete data-loss mode:** A transient `companionBus.emit` failure or a one-shot bug in the grounding pipeline silently consumes the review forever, even after the underlying fault is fixed. The user sees nothing in the FindingsLog, and the only trace is a single warn log line at the moment of failure.
- **Fix:** Move `seen.add(dedupKey)` to AFTER `await onReview(payload)` resolves successfully. On handler-error, do NOT add the key — let the next file event retry. (The LRU still bounds re-emission storms because the file's mtime/size won't change without a new write.) Add a regression test: a handler that throws on first call then succeeds on a re-issued review surfaces on the second attempt.

---

### P2-2 — Cross-watcher event-order race: review can be processed before its checkpoint, collapsing `modifiedFiles` to empty and downgrading every STOP

- **File:** `web/server/session-orchestrator.ts:430–447` (`handleCouncilReview`) coupled with `review-watcher.ts` + `checkpoint-watcher.ts`
- **Severity:** **P2**
- **Principle:** `quality-persistence.md` Principle 2 (debounce window is a correctness window); Principle 3 (every transition idempotent — here the cross-transition ordering is not enforced anywhere).
- **What's wrong:** Two independent watchers each apply a 150 ms debounce on their own directory. When the orchestrator writes the checkpoint atomically and the observer is fast enough to read it and emit a review within ~150 ms, the two watchers' `setTimeout` expirations are unordered relative to each other. If the review fires before the checkpoint handler runs, `entry.lastCheckpoint` is still `null` (or the previous phase's value) and `modifiedFiles = new Set([])` — every STOP in the review gets downgraded to NOTE by `observer-grounding.ts` because no path can be in the empty set. The browser sees a "degraded review" with zero ungrounded STOPs and no banner — the destructive findings are silently demoted.
- **Concrete data-loss mode:** Every observer review that lands in the rare-but-real "fast observer, slow orchestrator dispatch" window has all its STOPs demoted to advisory NOTEs — without any log line saying that ordering caused the demotion (the downgrade reason will look like the normal "evidence_path not in manifest" downgrade). The session continues looking healthy.
- **Fix:** Make the review handler wait for the matching `checkpoint_id` to be present in a per-group map (not just `lastCheckpoint`), with a bounded timeout. Either (a) buffer reviews keyed by `checkpoint_id` and flush when the matching checkpoint arrives, or (b) reject the review with a distinct drop reason `"checkpoint-not-yet-seen"` and rely on retry / dedup logic to re-fire. The current "last-write-wins on the per-group `lastCheckpoint` slot" is too coarse to defend against the FS-event race.

---

### P2-3 — `.md` extension with JSON content is a maintainability landmine + the in-tree documentation actively misleads

- **File:** `web/server/council-types.ts:4–6` (docstring), `web/server/review-watcher.ts:5–9` (docstring), `.council/prompts/observer-system.md:98–123` (output spec), file extension at write sites
- **Severity:** **P2**
- **Principle:** `quality-persistence.md` Principle 8 (every persistent JSON should declare its shape, not lie about it).
- **What's wrong:** Review files have extension `.md` but contain strict JSON. The council-types.ts header says "`<phase>-observer.md` — frontmatter block parsed via `ObserverReviewPayload`" — but `parseObserverReviewPayload` does pure `JSON.parse(raw)` with no frontmatter splitting and no markdown handling. The doc is wrong about the contract. Any future contributor who reads the docstring and tries to add a frontmatter `---` block (or any markdown around the JSON) breaks the parser silently — the file will be dropped at `JSON.parse` with reason `"invalid-schema"`, and the observer's findings will silently never reach the user.
- **Concrete data-loss mode:** A future contributor (or LLM session) "fixes" the JSON-in-`.md` confusion by wrapping the JSON in a code fence or adding YAML frontmatter — every review file from that point on is silently dropped because the parser is strict-JSON.
- **Fix:** Pick one: either (a) actually emit markdown with a fenced JSON code block + frontmatter, and extract via a real parser; or (b) rename the file extension to `.json` everywhere (filename pattern, prompt, write sites, docstrings). I recommend (b) — the file is a machine contract, not a human-readable artefact, and `.json` carries the load-bearing parser invariant in its name. Update `council-types.ts:4`, `review-watcher.ts:5`, the regex at `review-watcher.ts:25` + `observer-write-policy.ts:45`, the `observer-system.md` output spec, and the `assertObserverWriteAllowed` test fixtures together.

---

### P2-4 — `assertObserverWriteAllowed` and `isObserverReviewFilenameAllowed` are exported but never called from any write site

- **File:** `web/server/observer-write-policy.ts` (entire), search confirmation across `web/server/` shows zero non-test callers
- **Severity:** **P2** (sentinel-not-wired risk; the EC-7 fix from the prior review remains a primitive that nothing depends on)
- **Principle:** `quality-persistence.md` Principle 3 (sentinel rows but for files — must be invoked at every exit/write path); EC-7 (the integrated wrapper exists *so the boundary is enforced*).
- **What's wrong:** The prior review (1957) added `assertObserverWriteAllowed` as the EC-7 integrated wrapper that callers should use. In this Phase D-G surface there is **no** caller of either `assertObserverWriteAllowed`, `isObserverWriteAllowed`, or `isObserverReviewFilenameAllowed` outside their own test file. The watcher reads from the directory and applies its own filename regex (`REVIEW_FILE_PATTERN`) which happens to duplicate the policy module's regex byte-for-byte — but the duplication is a coincidence enforced only by `grep`, not by a shared symbol. The server side does not gate the observer's writes via this module at all; the observer's write policy is currently enforced solely by the SDK tool-set (`allowedTools` / `disallowedTools` at spawn) — not by the path allow-list this module was built to implement. The prompt's framing said "just confirm it's still wired"; my read is that **it is not wired**. It is a guard primitive that no production path invokes.
- **Concrete data-loss / corruption mode:** A future contributor who sees the rich `assertObserverWriteAllowed` API in `observer-write-policy.ts` may reasonably assume the boundary is enforced and refactor an unrelated path with `Write`/`Edit` exposure in the observer SDK profile — at which point the absence of a `canUseTool` callback handing through `assertObserverWriteAllowed` means the path allow-list is moot. (Hunt's 1957 review #1 flagged this; it was supposed to be wired in a later phase. Phases D-G have not wired it.)
- **Fix:** Wire `assertObserverWriteAllowed` into the observer SDK spawn's `canUseTool` callback so every `Write` / `Edit` / `MultiEdit` invocation pre-resolves the target path against the workspace allow-list before tool execution. Pair with `isObserverReviewFilenameAllowed` for the specific `.council/reviews/` branch. The single duplicated regex in `review-watcher.ts:25` should `import { isObserverReviewFilenameAllowed } from "./observer-write-policy.js"` so future tightenings of the pattern apply uniformly.

---

### P2-5 — `buildObserverContextManifest` has no production caller; the "observer sees only the delta" guarantee is currently only a function-level contract

- **File:** `web/server/observer-prompt.ts:161–193`; search shows zero non-test callers
- **Severity:** **P2**
- **Principle:** `quality-persistence.md` Principle 8 (a function that promises a shape but is never invoked promises nothing). Per the source comment lines 142–145 the function exists explicitly to enforce "observer receives only the artifacts that changed since the previous checkpoint, NOT the cumulative tree growing across phases."
- **What's wrong:** `buildObserverContextManifest` is a pure helper with seven tests, but no runtime caller. The orchestrator's `handleCouncilReview` does not consult it; the observer's spawn path does not consult it; `entry.lastCheckpoint?.artifact_paths` is shoved verbatim into `modifiedFiles` for grounding. The observer (per `observer-system.md`) is told to "read the artifacts at the paths the checkpoint lists" — i.e. it reads the entire `artifact_paths` array, not the delta. By checkpoint 5 in a long phase chain, the observer is reading 5× the intended context budget. The grounding validator (`observer-grounding.ts`) trusts `modifiedFiles = artifact_paths` — so the bound is what the orchestrator decides to emit, not what's actually changed since last cycle.
- **Concrete data-loss / drift mode:** Two manifestations: (a) the observer's context window fills with carry-over content, displacing the new-since-last-cycle bytes that are the entire point of independent review; (b) findings about the carry-over files all pass grounding (they're in the artifact_paths) even when they're stale relative to the actual phase delta — silent inflation of the review surface.
- **Fix:** Either (a) actually call `buildObserverContextManifest` in `handleCouncilCheckpoint` and pass `manifest.delta` to the observer's per-checkpoint input (replacing `artifact_paths`), and pass `manifest.carried` separately as "optional cross-cut"; or (b) if the intent is genuinely to keep the cumulative manifest for now, delete the unused helper + tests and amend the source comment to match reality. Shipping a function that documents a contract and is never invoked is the "documentation as enforcement" anti-pattern EC-7 was written to forbid (here applied to behaviour rather than security).

---

### P2-6 — `loadObserverSystemPrompt` is sync (`statSync` + `readFileSync`) on the spawn hot path with no caching — stat happens once per observer spawn

- **File:** `web/server/observer-prompt.ts:85–124`
- **Severity:** **P2**
- **Principle:** `quality-persistence.md` Principle 9 ("don't build on assumptions you can't verify" — sync FS on hot paths blocks the event loop for the worst-case storage backend).
- **What's wrong:** Every observer spawn reads the prompt artifact synchronously twice (stat + readFile). On a fast SSD this is microseconds; on NFS / a remote `$TMPDIR` / an encrypted FUSE this can stall the Hono request handler for many milliseconds, blocking all other in-flight requests because `readFileSync` ties up the libuv main thread. There is no in-memory cache keyed by `sha256` (which the function already computes); each council spawn pays the cost again. A separate concern: `statSync` followed by `readFileSync` is a TOCTOU window — the file can change between stat and read; the size cap defends only against the stat'd size, not against a swap-in. Low concern on a developer workstation; non-trivial on multi-user / shared-host deployments.
- **Concrete failure mode:** A user starts a council pairing while their `$TMPDIR` is on a slow / mounted filesystem; the Hono backend's event loop blocks for the duration of the stat+read, refusing other WebSocket frames during that window. Worst case: NFS stale-handle errors throw inside the sync call and the entire orchestrator initialize path fails.
- **Fix:** Cache the loaded `ObserverPromptArtifact` keyed by absolute `sourcePath` + `mtimeNs`, with TTL-based revalidation. Use `fs.promises.stat` + `fs.promises.readFile` so the call is awaitable. If the artifact must remain sync because spawn is sync, at minimum cache the parsed result so only the first spawn per server process pays the cost.

---

## P3 — Consider

### P3-1 — `seenDedupKeys` is a `Set` advertised as LRU but evicts FIFO

- **File:** `web/server/review-watcher.ts:55, 130–133` (also `checkpoint-watcher.ts:54, 127–131`)
- **Severity:** **P3**
- **Principle:** Hygiene; the docstring promises a property the data structure does not deliver.
- **What's wrong:** `Set.prototype.values()` returns insertion order. The eviction at lines 130–133 removes the oldest *inserted* entry, not the oldest *accessed* — there is no `seen.delete(x); seen.add(x)` touch-on-hit step. This is FIFO, not LRU. The constant is named `SEEN_LRU_CAP`, the comment says "LRU of seen pairs." At 256 entries the practical difference is negligible for normal cadence, but a long-running orchestrator with a burst of distinct checkpoints in quick succession can evict a recently-emitted key that the observer is about to re-emit (e.g. observer flake → restart → re-emit → "duplicate-review" drop because the key fell out of the FIFO window).
- **Fix:** Rename to `SEEN_FIFO_CAP` (correct the docstring), OR upgrade to a real LRU (`Map` with `delete + set` touch-on-hit). The Map approach is six lines of additional code and matches what the name claims.

---

### P3-2 — `parseObserverPromptHeader` regex requires the header to be on the literal first line — a UTF-8 BOM-prefixed file will fail silently before reading

- **File:** `web/server/observer-prompt.ts:34, 54–61, 98`
- **Severity:** **P3**
- **Principle:** `quality-persistence.md` Principle 8 (loaders should handle the formats real editors produce); Principle 9 (don't trust environment defaults).
- **What's wrong:** `HEADER_PATTERN` is `^<!-- observer-system-prompt v(\d+) -->\s*$` matched against `raw.split("\n", 1)[0]`. If the file has been edited by a tool that prepends a UTF-8 BOM (`﻿`) — common for Windows-edited markdown — the first line starts with the BOM and the regex fails; the loader throws "missing or malformed header" rather than parsing the visible header. The error is recoverable (open the file, strip BOM, save) but the error message points at "malformed header" not "BOM detected," which is a confusing debug path the first time it happens to a Windows contributor.
- **Fix:** Strip a leading BOM in `parseObserverPromptHeader` before the regex check, and add a test case `it("tolerates a leading UTF-8 BOM", () => ...)`. One-line fix; the tradeoff is "accept silently" vs "warn loudly" — silent acceptance is the convention for BOM in most modern parsers.

---

## Summary

- **2 × P1** — both rooted in the same systemic issue: the multi-provider review path was designed (per the dedup key shape) to support two providers reviewing the same checkpoint, but neither the filename contract nor the debounce key supports that design. EC-4 is violated by inheritance from `checkpoint-watcher` — the new `review-watcher` should not have copied the filename-only debounce keying without addressing it.
- **6 × P2** — a transient-handler-error silently consumes the review forever (P2-1); cross-watcher event-ordering race silently downgrades STOPs (P2-2); `.md`-extension-with-JSON-content actively misleads documentation (P2-3); the EC-7 wrapper exists but no path invokes it (P2-4); the per-checkpoint context-manifest helper is unused, so the "delta-not-cumulative" guarantee is fictional (P2-5); sync FS on the spawn hot path with no cache (P2-6).
- **2 × P3** — FIFO-mis-named-LRU (P3-1); BOM-fragile header parser (P3-2).

The single most important fix is **P1-1 + P1-2 together** — the debounce-key shape plus the filename contract — because both are pre-conditions for the `claude+codex` pairing this entire branch exists to enable. Without them, the experimental pairing's value proposition (two independent reviewers) silently degrades to "whichever provider wrote last wins, and no log line says so."

The P2 cluster is where the implementation drifted from intent: the `assertObserverWriteAllowed` boundary, the `buildObserverContextManifest` delta enforcement, and the JSON-in-md naming are each "the contract is written in a comment but not enforced in the code path." Each one is one PR away from being real; together they're a maintainability ceiling the next council review will keep bumping against.
