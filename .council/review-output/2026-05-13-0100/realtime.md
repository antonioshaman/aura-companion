# Realtime / NDJSON Protocol Review — Observer Auto-Wake (Story 2 AC#1)

Reviewer: Carmack × Realtime/NDJSON Protocol Expert
Scope: server→CLI `user` NDJSON synthesis path (sendUserFrameFromServer, sendObserverWakeFrame, buildObserverWakePayload, handleCouncilCheckpoint, wire frame additions).
Conventions floor honoured: AP-1..AP-3, EC-1..EC-9 not re-flagged.

The overall judgement: the line-discipline + size-cap + char-class boundary at the **builder** is honest and well-placed; the adapter-level tripwire is sound. The most concerning items are (a) the absence of an EC-6 replay fixture pinning the wake frame's exact on-wire shape, (b) the silent shape divergence between `handleOutgoingUserMessage` (string-content) and `sendUserFrameFromServer` (array-of-one-text-block), (c) backpressure-as-drop with no per-group retry signal, and (d) `wakeTimeoutMs` made required on `group_created` after the slice already shipped without it — a stamped wire break.

---

## P1 — Fix Now

### P1-R1: No EC-6 replay fixture pins the wake `user` frame's on-wire shape

**Concrete protocol-level failure:** `sendUserFrameFromServer` is the **first** server-initiated `user` NDJSON frame in the codebase. The CLI is undocumented and reverse-engineered (`WEBSOCKET_PROTOCOL_REVERSED.md`). The wake frame shape is asserted only at the JS-level builder (`buildObserverWakePayload.test.ts` covers `textBody`; nothing pins the assembled envelope `{type:"user", message:{role:"user", content:[{type:"text",text}]}, parent_tool_use_id:null, session_id:""}`). A CLI upgrade that tightens `content` validation (e.g. rejects `content` as a 1-element array when the previous form used a string), a parent_tool_use_id field rename, or a session_id non-empty requirement will silently break **every** wake without a single test going red. The whole point of Recorder v2's `origin:"server:council-wake"` tag was to make this exact frame replayable; the tag exists but no test loads a captured wake recording and asserts byte equality.

**What to do:** add `claude-wake-frame.fixture.jsonl` (a minimal captured/synthesised JSONL with one `_header` line + one outbound `origin:"server:council-wake"` entry). Add a `claude-wake-replay.test.ts` that (i) invokes `sendUserFrameFromServer` with a known payload, intercepts the bytes handed to `cliSocket.send`, strips the trailing `\n`, asserts byte-exact equality with the fixture, and (ii) round-trips through `replay.ts` to assert the recording reader survives the v2 origin tag. This closes the load-bearing-protocol-with-no-replay-test hole called out in Principle 7 / Principle 10 (rule 5).

Severity: **P1**.

---

### P1-R2: `handleOutgoingUserMessage` (string-content) vs `sendUserFrameFromServer` (array-content) — asymmetric wire shape, no test pins either

**Concrete protocol-level failure:** the two `user`-frame producers emit structurally different shapes for the same logical thing:

- Browser path (`handleOutgoingUserMessage`, line 350): `message.content` is a **bare string** when no images are attached.
- Wake path (`sendUserFrameFromServer`, line 997): `message.content` is **always** `[{type:"text", text}]`.

Both shapes are documented Claude SDK forms, and today's CLI accepts either — but the divergence is an unforced asymmetry with no doc-comment explaining "the CLI tolerates both" and no test asserting it. The asymmetry has three failure modes:

1. **Drift trap.** If a future CLI tightens the contract to one shape, exactly one of these paths starts failing, and the failure mode depends on whether the user is in Council Mode. We will spend half a day finding it.
2. **Echo-handling asymmetry.** `handleUserEcho` (line 873) silently drops every echoed user-role message because "string echoes duplicate the user's own composer message" and "array echoes (tool_result blocks) duplicate output already surfaced". A wake `user` frame with array-text-block content will also be echoed back and dropped — fine in practice but **not** what the comment says ("array echoes (tool_result blocks)" — server-wake echoes are array-text, not tool_result). The echo-drop logic happens to be a strict-enough filter (`_msg` unused), but if the comment ever motivates a more-discriminating echo handler ("drop string OR array-of-tool_result; pass array-of-text through"), wake echoes start flooding the observer's chat history.
3. **No discriminator** for the browser to tell a server-originated user echo apart from its own composer message. The CLI strips `origin`-style metadata on the way back. Today the wake frame's `text` body starts with `# Council Checkpoint — <phase>` so it's not user-confusable; if a future builder changes the preamble, a server-synthesised wake could land back in the chat history as if the user wrote it.

**What to do:** either (a) align the wake builder to emit string content when there is no media (keep the array form gated behind a comment "array form is the future shape; switch when a CLI version requires it"), or (b) flip `handleOutgoingUserMessage` to always emit array form and add a single doc-comment in `claude-adapter.ts` explaining the canonical shape. Pair the choice with one test per producer asserting on-wire bytes, plus a static-grep canary in `claude-protocol-drift.test.ts` that fails if a third producer of `type:"user"` frames appears without going through one of these two methods.

Severity: **P1** — it's not a runtime bug today, but it's a Carmack "if a mistake is possible, it will eventually happen" P1: two producers of the load-bearing frame, neither pinned, asymmetric by construction.

---

### P1-R3: `wakeTimeoutMs` is REQUIRED on `group_created` — wire break for any in-flight client / restart-replay event

**Concrete protocol-level failure:** `session-types.ts:387` declares `wakeTimeoutMs: number` without `?`. The recorder v1→v2 design correctly contemplated back-compat for the **recording header**, but the **`group_created` browser wire frame** got a new required field. Two concrete failure paths:

1. **Event-replay buffer with persisted v1 frames.** `WsBridge` keeps a per-session ring of `BufferedBrowserEvent`s (`session.eventBuffer`, persisted to disk via `session-store.ts`). A buffer entry written before this PR is the v1 `group_created` shape WITHOUT `wakeTimeoutMs`. After this PR deploys and an existing browser reconnects with `last_seq < eventBuffer.tail`, the replay sends a frame the new TypeScript type says cannot exist. The client's `ws.ts` switch reads `msg.wakeTimeoutMs` and writes `undefined` into `GroupRecord.wakeTimeoutMs`, the deriver gets `NaN` for the `reviewing` deadline, and the panel locks `reviewing-stalled` permanently. The bug is silent because the field-presence-check is lost in TS narrowing.
2. **Browser cached older bundle.** Same scenario after a deploy: an unrefreshed tab has the v1 client; the server sends v2 with `wakeTimeoutMs`. Old client tolerates it (extra fields ignored) — fine. But the reverse: a partial deploy where one frontend bundle is older and the server is new is the common-canary failure.

The whole protocol pattern in this codebase is **additive optional fields** (`group_degraded.reason?`, `observer_review.supersededCheckpointIds?`). Making `wakeTimeoutMs` required violates that pattern without a stated reason. The plan said "client uses it to bound `reviewing`" — fine — but a missing-field fallback to the server constant copied as a frontend literal would have been the additive-compatible choice.

**What to do:** mark `wakeTimeoutMs?: number` on the wire type. In `ws.ts`, fall back to a documented frontend default constant (`DEFAULT_WAKE_TIMEOUT_MS`) when absent, and EC-9-log the substitution so a stale-buffer replay is observable but non-fatal. Static-grep canary in a drift test: every required field on a `type:"<wire-event>"` union member must have an entry in a back-compat allowlist.

Severity: **P1** (silent UI lockup on replay; trivially fixed).

---

## P2 — Fix Soon

### P2-R1: Backpressure-as-drop has no per-group retry signal — wake is lost until the next checkpoint

**Concrete protocol-level failure:** `sendUserFrameFromServer` returns `{kind:"backpressure"}` when `getBufferedAmount() > 1MiB`. The dispatcher (`session-orchestrator.ts:1387`) maps this to a `skipped` outcome and logs at info level. **No retry, no enqueue, no follow-up timer.** The pending checkpoint is discarded; the watcher's `pendingCheckpoint` slot stays empty because the busy gate is `observerTurnState === "in-flight"` — backpressure doesn't trip that gate, so newest-wins queueing doesn't fire. The next observer wake fires only when the **next checkpoint file** lands. If no further checkpoint arrives, this one is permanently skipped and the observer sleeps through it.

`OBSERVER_WAKE_MAX_BYTES` is 32 KiB and the wake frame is well under 1 MiB, so backpressure here means the **observer transport is stuck**, not "the frame is too large". The correct response to stuck-transport is **the same** as observer_busy: park the checkpoint in `pendingCheckpoint` and re-fire on the next `observer:turn-done` (which won't come if the observer is stuck — but it will come on `reconnect_ok` after the socket dies and recovers, and that already triggers `drainPendingObserverWake`).

**What to do:** route `backpressure` through the same newest-wins queue path as `busy` (set `entry.pendingCheckpoint = payload`, log at info with `queued: true`). Or, conversely, document explicitly that 1 MiB backpressure means terminal transport death and let the next `session:exited` handler clean up — but then the kind should rename to something like `transport_stalled` so the audit log doesn't read like a recoverable condition.

Severity: **P2** (lost wake under load; observer underreviews silently).

---

### P2-R2: Belt-and-braces line-discipline check is technically redundant, but keep it — flag the **other** gap instead

The prompt asks whether the builder's CR/LF/NUL strip + adapter's post-`JSON.stringify` `\n` assertion is redundant. **Both are correct as written.** `JSON.stringify` contractually escapes `\n` inside any string value to `\\n`, so a single newline in `text` can only appear inside the envelope's structural commas/braces — which the builder controls. The adapter's `frame.includes("\n")` is genuinely a builder-bug tripwire (e.g. a future templater that bypasses `JSON.stringify` for performance). Keep it.

**But:** the symmetric check is **missing on the browser-relayed path**. `handleOutgoingUserMessage` (line 350) builds NDJSON via `JSON.stringify` and sends it through `sendToBackend` → `sendRaw` with no `frame.includes("\n")` tripwire. The browser can pass arbitrarily-shaped `content` strings; the same builder-bug class (someone refactors to a template literal) would land here too. The wake path is hardened; the user path is not. Either both have it or neither does — pick consistency.

**What to do:** lift the assertion into `sendRaw` (single chokepoint), drop the duplicate from `sendUserFrameFromServer`. Or document the asymmetry: "wake path has no test-replay yet (P1-R1) so the tripwire is the live canary; browser path has implicit user-feedback when broken so the tripwire is unnecessary."

Severity: **P2**.

---

### P2-R3: `observerTurnState` correctness — confirmed isolated, but the comment lies about the canary

The implementation is correct: the in-flight flip happens ONLY inside `sendUserFrameFromServer` (line 1036), the idle flip happens only in `handleResultMessage` when transitioning from in-flight (line 755). Browser-initiated `user_message` traffic does not touch this field. **This is the right behavior.**

The doc-comment at line 138–143 says: *"The observer-tab composer is disabled in council mode, so cross-contamination isn't a concern, but the field name and the toggle sites are scoped narrowly on purpose."* This is wrong-by-construction defence:

- The composer being disabled is a frontend rule, enforced in `Composer.tsx` (probably; not in scope here). A frontend bug, a programmatic `BrowserOutgoingMessage` injection, or a future browser-API addition can produce a `user_message` to the observer.
- If a user-initiated `user_message` ever arrives at the observer's adapter, the adapter happily forwards it via `handleOutgoingUserMessage` — and the subsequent `result` frame triggers the in-flight→idle flip emit even though no wake was sent. That emits `observer:turn-done`, which calls `drainPendingObserverWake`, which fires the queued wake if one exists. That's actually **fine** behaviour — but the comment claims cross-contamination "isn't a concern" while the real defence is "the in-flight→idle flip is gated on the FROM state, not on which path created the result". State the actual invariant.

**What to do:** rewrite the doc-comment to state: "The flip-emit is gated on transition from in-flight, so a result frame from a browser-initiated turn (in-flight=idle to start) is a no-op. The composer-disabled rule is defence-in-depth, not the load-bearing argument." Pair with a unit test that explicitly fires a browser user_message at a Council observer, observes the `result`, and asserts `observer:turn-done` is NOT emitted. Today no such test exists — the invariant is only stated, not pinned.

Severity: **P2** (correct behaviour with mis-stated invariant; one motivated future refactor away from a real bug).

---

### P2-R4: `session_id: ""` for every wake — pragmatic, but the rationale needs a runtime canary

The Realtime plan said "two-state builder: empty first, populated subsequently." Implementation kept `""` always (line 999). The doc-comment at line 966 says: *"the Claude Code NDJSON protocol documents this for the first user frame to a freshly spawned CLI, and the browser-side path also passes `""` by default. The observer's CLI binds session via socket identity, not via the field."*

This is **probably correct** for today's CLI — the browser path also passes `""` by default and works fine. But "probably correct on the undocumented reverse-engineered protocol" is exactly the spot Principle 7 (Protocol drift) names: a future CLI version that starts validating `session_id` on second-and-later user frames against its known session would silently drop wakes (or worse, attribute them to a sibling session). No test pins this.

**What to do:** add a runtime invariant in dev mode that asserts session_id="" is acceptable to the CLI by **observing the next CLI message** after a wake — if the CLI ever emits an `error` system message with `subtype:"invalid_session_id"` (or equivalent on a future schema), surface it as a structured EC-9 log and flip to populating the field from `session.state.cli_session_id`. Alternatively: an integration test against a real CLI binary that fires a second wake and asserts the result arrives. The current state is "we hope `""` keeps working", and given the load-bearing-protocol-undocumented-CLI risk class, that needs a canary.

Severity: **P2**.

---

### P2-R5: Hybrid body (H1 + fenced JSON + directive) — fence is the protocol, not prose

The body shape combines markdown preamble, ```json fence, and a directive sentence. The builder defensively rejects ``` triplets in echo fields and manifest paths (lines 415, 464) — correct. **But two protocol gaps in the assembled body:**

1. The directive sentence (line 501) says "Emit one review file matching the `ObserverReviewPayload` JSON schema described in your system prompt." The schema lives in `.council/prompts/observer-system.md`, loaded at spawn. If the observer is on a fresh socket post-restart and the system prompt didn't make it through (`applyCouncilObserverSpawnConfig` rejected, version skew, etc.), the wake says "described in your system prompt" but the prompt isn't loaded. Failure mode: observer freelances a JSON shape, server-side validator rejects every finding, panel sits in `sleeping` forever. The directive should be self-contained: include the literal `ObserverReviewPayload` minimal example INSIDE the fenced block, not "go look it up elsewhere".
2. The directive ends with "Begin." — a model directive. Different model families parse the ```json fence differently in instruction-following mode. Claude generally respects "emit JSON matching schema X" deterministically; future Codex pairing (deferred but planned) parses prose-around-fence with less determinism than Claude. The body shape is announced as portable across model families ("Plain English on either side of the fence is the portability hedge across model families (Willison Principle 7)") — but the empirical claim "would the observer's stream-json reader parse this deterministically across model families?" has not been tested. Today the scope is claude+claude so this is dormant, but the Codex deferred-shipping date will arrive and there is no test fixture proving the parse holds.

**What to do:** include the `ObserverReviewPayload` schema example inline in the fenced block (or as a sibling fenced block). When Codex pairing un-defers, ship a replay fixture set: synthesise a wake, run it through both providers' JSON-mode outputs, assert both produce a valid review. Without that fixture, the "portability hedge" is marketing.

Severity: **P2**.

---

### P2-R6: Server-initiated `user` frame is invisible to existing protocol-drift canary

`claude-protocol-drift.test.ts` scans `routeCLIMessage` for handled CLI message types and asserts alignment with upstream SDK. The new **outbound** server-synthesised frame doesn't participate in this canary — there is no symmetrical drift check on producer side. If a future SDK upgrade changes the canonical `user` frame shape (e.g. `parent_tool_use_id` rename, `message.role` lifted), the producer drifts silently. The single source of truth for the "user frame shape" is now spread across:

- `handleOutgoingUserMessage` (browser path)
- `sendUserFrameFromServer` (server path)
- Nothing else asserts the shape

**What to do:** add a producer-side static-grep canary in `claude-protocol-drift.test.ts`: parse both methods, extract the literal JSON envelope keys via regex (`type|message|parent_tool_use_id|session_id`), assert they match a pinned set. Bonus: assert `content` shape in each method is documented (string OR array of blocks). Pair this with the P1-R1 replay fixture.

Severity: **P2**.

---

## P3 — Consider

### P3-R1: `observer:turn-done` is the only adapter event that escapes to the global bus from `claude-adapter.ts`

The adapter is otherwise a stateful translator: incoming NDJSON → typed `BrowserIncomingMessage` callback (via `browserMessageCb`). Emitting on the global `companionBus` from `handleResultMessage` is a one-off escape hatch. It's currently the **only** way the orchestrator gets a result-frame signal, since `browserMessageCb` is the bridge's private listener, not the orchestrator's. The pattern is fine for a single use case but anti-pattern at scale: as soon as a second "adapter cares about an event the orchestrator wants" arrives, this becomes a pile of `companionBus.emit` calls inside protocol-translation code. Cleaner: route through the bridge's existing `session:result` channel (it likely exists) and have the orchestrator subscribe at session granularity.

Severity: **P3** (architectural). Today's single instance is fine; document that the next call site of `companionBus.emit` inside `claude-adapter.ts` requires architectural review.

---

### P3-R2: Recorder writes BEFORE `cliSocket.send` throws — forensic-trail-positive but false-positive on send failure

Line 1023: `recorder.record(...)` happens before `cliSocket.send(frame + "\n")`. The doc-comment at line 1019 justifies it: "a crash-during-send leaves a forensic trail". Correct intent. But the recording then says "we sent a wake" when no bytes actually crossed the wire. A replay reader can't distinguish "wake sent, observer crashed" from "wake never sent, adapter threw". For audit purposes the distinction matters.

**What to do:** add a paired recorder entry on the catch branch — `recorder.recordEvent` with `event:"wake_send_failed"` or similar lifecycle marker. The send→fail pair is then disambiguable in replay.

Severity: **P3**.

---

## Convention-floor compliance (audit only, not flagged)

- EC-7 idiom honoured in `assertWakeManifestPathAllowed` — realpath + containment as one wrapper, predicate not exported.
- EC-4 — checkpoint watcher's monotonic-sequence guard at `handleCouncilCheckpoint` (line 1143) is correct; out-of-order rejection is server-side authoritative.
- EC-9 — every dispatcher branch lands in exactly one structured log entry with `event`/`sessionGroupId`/`observerSessionId`. Verified.
- EC-6 — **explicitly violated** by P1-R1. Flagged above.

---

## Summary

| Severity | Count | Theme |
|----------|-------|-------|
| P1       | 3     | No replay fixture; shape asymmetry; required-field wire break |
| P2       | 6     | Backpressure-as-drop, line-discipline asymmetry, mis-stated invariant, session_id canary, hybrid-body portability, producer drift canary |
| P3       | 2     | Bus escape hatch, recorder write-before-send |

**The keystone P1 is the missing replay fixture.** Everything else is recoverable through process; the missing fixture is a structural EC-6 violation on the most load-bearing piece of this PR — the first server-initiated `user` NDJSON frame in the codebase. Fix that first; the others are cheap once the fixture exists because they each map to one or two added assertions on the same captured bytes.
