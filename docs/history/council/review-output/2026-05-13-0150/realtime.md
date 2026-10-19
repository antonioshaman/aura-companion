# Realtime / NDJSON Protocol — Regression Review (2026-05-13-0150)

Scope: `web/server/__fixtures__/observer-wake/claude-v1.jsonl` (NEW),
`web/server/observer-wake-fixture.test.ts` (NEW),
`web/server/claude-adapter.ts` (markActivity reposition + turn-state resets on
detach/transport-close), `web/server/observer-prompt.ts` (unchanged since fix-
pass — `buildObserverWakePayload`).

Cross-referenced fix-pass closures from FINAL-REVIEW 2026-05-13-0100:
- #7 / EC-6 wake-frame fixture — fixture file lands at
  `__fixtures__/observer-wake/claude-v1.jsonl`, 5 fixture tests in
  `observer-wake-fixture.test.ts`.
- #8 content-shape asymmetry — fixture pins the array-of-one-text-block shape;
  the third assertion of the second test asserts
  `Array.isArray(parsed.message.content) && length === 1`.
- #9 `wakeTimeoutMs` optional on wire — `web/src/types.ts:133` declares
  `wakeTimeoutMs?: number`; `web/src/observer-panel-state.ts:87` falls back to
  the 300_000 frontend literal when absent; `web/src/ws.ts:1189` passes the
  optional value straight through to the store.
- P2-R3 prior pass (`observerTurnState` stuck) — reset now present in BOTH
  `detachWebSocket` (`claude-adapter.ts:193`) and `handleTransportClose`
  (`claude-adapter.ts:242`); JSDoc on each method names the prior review entry.
- #15 `markActivity` reposition — `sendUserFrameFromServer` (`claude-adapter.ts
  :993`) calls `onActivityUpdate` unconditionally BEFORE the three gates, with a
  comment naming the regression direction.

All five closures land as described. The on-disk fixture parses as a strictly
single-line NDJSON frame terminated by exactly one `0x0a`; the `parent_tool_use
_id: null`, `session_id: ""`, `Array.isArray(content)`, and version-first echo
key-order checks are all enforced explicitly.

---

## P3-R1 — "Live builder canary" doesn't compare against the fixture; pinned-bytes drift remains silently possible

**Concrete protocol-level failure:** The fifth test in
`observer-wake-fixture.test.ts:92-125` ("the live builder, given the same
inputs, produces a body that round-trips through the same parsers") is named
the producer-side canary in its own comment — but it never compares the
live-built body against the on-disk fixture. It re-asserts the same partial
projection (`observer_wake_payload_version === 1`, echo fields, fence presence)
that tests 1-4 already pin from the on-disk side. The fixture's prose preamble
(`A new checkpoint has arrived. Read only the workspace-relative paths…`), the
directive terminator copy, the JSON indentation (`JSON.stringify(payload, null,
2)`), and the exact key-order inside the JSON block are all in
`observer-prompt.ts:492-503`. A future refactor that re-words one prose
sentence in the builder, or flips the JSON indent to `null, 4`, would leave the
fixture and the live builder green independently — the fixture is then a
stale snapshot of a prior wire shape, and any consumer that pinned the fixture
bytes (e.g., a Python integration test that loads the JSONL and feeds it to a
captured replay harness) silently desynchronises.

**Why P3 not P2:** the asymmetry is only exploitable if downstream tooling
treats the fixture as a byte-pinned contract. Today, no such tooling exists in
the repo — every reader of the fixture either parses the JSON or assertson the
fields it already validates. The risk is forward-looking: the fixture is
sitting in `__fixtures__/observer-wake/claude-v1.jsonl` looking like a frozen
wire contract, and a future EC-6-style replay test in another language has no
way to know it's actually drifted.

**Fix direction:** add a sixth assertion at the end of test #5 that reads the
on-disk fixture, parses the live builder's `result.textBody`, and asserts the
two `message.content[0].text` bodies are byte-equal. Optionally compare the
full assembled NDJSON line minus the trailing `\n`. The test would then fail
LOUDLY on any builder-side change — the developer either accepts the new shape
by re-emitting the fixture (one-liner: `JSON.stringify({...frame}) + "\n"`) or
fixes the regression. Pair with a `__fixtures__/observer-wake/REGEN.md` one-
paragraph note that documents the regen command. Pattern matches the
"feedback_trust_diff_not_prose" idiom — the canary doesn't trust the prose
("live builder produces…"), it greps the diff.

**Severity:** **P3** — boundary clarity for a wire contract that's about to
be referenced from external test harnesses.

---

## P3-R2 — `session_id: ""` rationale is still prose-only; no runtime canary against the CLI's tolerance

**Concrete protocol-level failure:** `claude-adapter.ts:978-981` documents
that `session_id` is `""` for the first wake frame "because the Claude Code
NDJSON protocol documents this for the first `user` frame to a freshly spawned
CLI, and the browser-side path also passes `""` by default. The observer's
CLI binds session via socket identity, not via the field." The fix-pass added
a fixture test that pins the field VALUE (`expect(parsed.session_id).toBe("")`
at fixture test line 45) and `claude-adapter.test.ts:522` does the same — but
neither test exercises the CLI's actual tolerance. The contract is observed,
not stated by the CLI; a future CLI version that adds `session_id` validation
on the first user frame (rejecting empty strings) would wedge every wake
silently. The bridge would see the wake go out, never receive a `result`, and
the dispatcher would queue forever until `wakeTimeoutMs` flips state to
`reviewing-stalled` — a 5-minute false-negative window with no diagnostic
explaining why.

**Why P3 not P2:** the prior pass flagged this as P2-R4 (rationale-without-
canary) and the fix-pass intentionally chose not to add a runtime canary —
the rationale being that browser-side `handleOutgoingUserMessage` at
`claude-adapter.ts:366` ALSO falls back to `""` on the first user frame, and
no production complaint has surfaced. That's a reasonable design call: a
runtime canary would have to either parse `system.init`'s `session_id` and
echo it (changing the wire contract), or probe a `session_id: <init.session_
id>` frame and observe the response (extra round-trip). Both are heavier than
the bug they prevent.

**Fix direction:** keep `""` and prose-only IF a fixture-replay test is
landed that feeds a captured CLI recording through the adapter and asserts
the observer's `result` frame arrives (EC-6 idiom — replay a captured
recording, not a synthetic one). The current fixture test only round-trips
through the writer side; it never validates that a real CLI accepts the
frame. If/when such a replay harness lands, this watchpoint closes
automatically.

**Severity:** **P3** — watchpoint, not actionable now. Documented here so the
prior pass's P2-R4 isn't lost track of.

---

## No new realtime/protocol findings beyond P3-R1 and P3-R2 watchpoints.

The fix-pass closes the EC-6 fixture gap and the content-shape asymmetry
concerns from the prior pass. The fixture's single-line NDJSON discipline,
array-content shape, version-first key order, and CheckpointPayload round-trip
all land correctly. `observerTurnState` resets are present in both detach
paths; the JSDoc on each names the prior review's #2 — accurate. (The
`disconnect()` method at `claude-adapter.ts:217-229` does NOT reset turn-state
either, but its sole caller `ws-bridge.ts:452` immediately sets
`session.backendAdapter = null` and discards the entire adapter instance —
stale state on an unreferenced instance is unreachable. Correct as-is; no
finding.)

`wakeTimeoutMs` event-buffer replay hydration: a `group_created` frame from a
pre-Task-9 server arrives with the field absent, `ws.ts:1189` passes
`undefined` into the store, `observer-panel-state.ts:87`
(`typeof group.wakeTimeoutMs === "number" ? group.wakeTimeoutMs : 300_000`)
falls back to the documented frontend constant. Frontend-server constant
match: server emits `OBSERVER_WAKE_TIMEOUT_MS = 300_000` per fix #18; frontend
literal is `300_000`; comment names the constraint at lines 83-86. Optional-
field discipline restored to additive — matches the rest of the wire (`reason
?`, `supersededCheckpointIds?`).

Markdown emit complete.
