# Realtime / NDJSON Protocol Expert — Findings

Reviewed: `web/server/claude-adapter.ts` (`sendOrchestratorSyntheticFrame`, lines 1126–1172, in juxtaposition with `sendUserFrameFromServer`, lines 1174–1252) and `web/server/ws-bridge.ts` (façade method `sendOrchestratorSyntheticFrame`, lines 329–337; outcome type at 69–73; caller mapping in `index.ts` lines 141–159).

Convention floor (AP-1..3, EC-1..13) not re-flagged.

---

## P1 — Fix Now

### P1.1 — Synthetic-send path has no orchestrator turn-state gate; sister wake path has one. Asymmetric correctness invariant.

**Where:** `claude-adapter.ts:1126` (`sendOrchestratorSyntheticFrame`) vs `claude-adapter.ts:1174` (`sendUserFrameFromServer`).

**What:** `sendUserFrameFromServer` gates on `if (this.observerTurnState === "in-flight") return { kind: "busy" }` BEFORE the transport gates, then sets `observerTurnState = "in-flight"` on success. `sendOrchestratorSyntheticFrame` deliberately drops the symmetric `orchestratorTurnState.kind === "in-flight"` check (JSDoc at 1122–1124 explains: "synthetic is an orchestrator-side concern and orchestrator turn-state is the caller's responsibility").

The problem is a TOCTOU window. The caller (`IdleTimerManager.fire`) reads `getOrchestratorTurnState()` to decide "should I synthesise", then calls `sendSyntheticFrame(sessionId, body)` → bridge → adapter. Between the caller's read and the adapter's send, a real user can type into the orchestrator composer (`handleOutgoingUserMessage` flips `orchestratorTurnState = { kind: "in-flight" }` at line 440). The synthetic now lands ON TOP of a genuine in-flight user turn, and the post-send line 1170 — `this.orchestratorTurnState = { kind: "in-flight" }` — is a no-op visually but the **CLI now has two `user` frames in flight against one orchestrator slot**, with the second frame's `result` arriving first will fire the `in-flight → awaiting-input` transition prematurely (line 850), clearing the synthetic sticky token (`noteTerminalResultFrame`, line 863) while the genuine user turn's `result` is still pending. The next `result` arrives, finds state already `awaiting-input`, and does NOT re-fire the bus event nor clear sticky tokens — silent invariant break.

The sister wake path avoided this exact bug by putting the check inside the adapter where the check and the state flip are atomic against the same `this.observerTurnState`. The orchestrator path explicitly hands the check to a caller that runs in a different stack — Carmack: "the check and the act must be the same act".

**Severity rationale:** Carmack Principle 6 (single-shot ack discipline) — a duplicate `user` frame is the CLI-side dual of a duplicate `control_response`. Carmack quality-realtime.md P1 line "make data flow visible and explicit". The doc explicitly handwaves the gap ("caller's responsibility"); see `feedback_council_documented_contract_canary` — JSDoc contracts are docs, not enforcement.

**Recommendation:** Move the gate inside `sendOrchestratorSyntheticFrame` mirroring the wake path. If the doc justification "synthetic is orchestrator-side concern" is load-bearing, gate on `orchestratorTurnState.kind === "in-flight"` returning `{kind:"busy"}` — the caller already handles `busy` from the wake path so the outcome shape is reused without consumer changes.

---

### P1.2 — Bridge façade outcome variants (`session_unknown` / `adapter_missing` / `unsupported_backend`) are not exhaustively switched at the auto-proceed call site; new variants will silently stringify.

**Where:** `index.ts:147–158`. The wake path's analogous mapping is in `session-orchestrator.ts:1808–1953` with a final `const _exhaustive: never = bridgeOutcome` tripwire (line 1946) that fails compile when a new `BridgeObserverWakeOutcome` variant is added without consumer handling.

**What:** The auto-proceed mapping is a 3-arm if/else chain:
```
backpressure → `backpressure(buffered=...)`
failed → `failed(...)`
else → outcome.kind
```
This compiles for any future variant — the `else` swallows it as a bare kind string. Specifically: when PR #52's outbound FIFO lands and adds a `{kind:"queued"; depth: number}` outcome (per the Task 11 plan documents), the auto-proceed pipeline will surface `error: "queued"` to its EC-9 log line while the wake path's exhaustive switch breaks the build — flagging the unhandled case for the human to map intentionally.

The asymmetry is worse because the synthetic path is the NEW one — the wake path got the exhaustive check after a council finding, the synthetic path was written from scratch and reverted to non-exhaustive mapping. The lesson it should have inherited didn't carry across.

**Severity rationale:** EC-5 (parsers reject unknown frame shapes) extends to typed protocol outcomes. quality-realtime.md Principle 7 ("Protocol drift") — every unhandled discriminator is a silent ingestion of unknown shape.

**Recommendation:** Replace the if/else cascade in `index.ts:147–158` with a `switch (outcome.kind)` that exhausts every variant and ends with `const _exhaustive: never = outcome; void _exhaustive;` — mirrors the wake path exactly.

---

## P2 — Fix Soon

### P2.1 — Backpressure threshold constant name (`OBSERVER_WAKE_BACKPRESSURE_THRESHOLD_BYTES`) is observer-scoped but now governs the orchestrator synthetic path; reading the synthetic code in isolation suggests cross-channel coupling.

**Where:** `claude-adapter.ts:65` constant; reused at line 1137 in `sendOrchestratorSyntheticFrame` and at line 1202 in `sendUserFrameFromServer`.

**What:** The constant name and its comment explicitly anchor on "wake frames" and "OBSERVER_WAKE_MAX_BYTES (32 KiB)". The new synthetic path is unrelated to observer wake — auto-proceed nudges are orchestrator-side and may carry larger bodies (user-facing prose, error tails, file references). The 1 MiB cap is still generous, so no immediate correctness issue, but:
- a future tuning of the observer-wake threshold to a tighter value (Carmack: "wake messages are bounded — tighten the cap to 256 KiB to fast-fail malformed builders") would silently tighten the synthetic threshold too.
- a future tuning of the synthetic threshold to a looser value (auto-proceed nudge bodies grow) would loosen the observer-wake threshold too.

Either change risks the other path silently. quality-realtime.md Principle 9 (Backpressure) — the cap is a load-bearing policy decision and needs an honest name + per-path tunability.

**Recommendation:** Rename to `SERVER_SYNTHESISED_FRAME_BACKPRESSURE_THRESHOLD_BYTES` (covers both paths) OR split into `OBSERVER_WAKE_BACKPRESSURE_THRESHOLD_BYTES` + `ORCHESTRATOR_SYNTHETIC_BACKPRESSURE_THRESHOLD_BYTES` with the same initial value but separate symbols. Either is fine; both make future tuning visible at the right granularity.

### P2.2 — Recorder.record is fire-and-forget but the synthetic path comment says "record BEFORE send so a crash-during-send leaves a forensic trail" — the SessionRecorder.record swallows all write errors via `_recordWriteErrorLogged` (recorder.ts:308–312). If the disk is full or the file moved out from under us, the "forensic trail" is silently dropped and only the second send-attempt logs once.

**Where:** `claude-adapter.ts:1159–1162` + `recorder.ts:289–314`.

**What:** This is shared with the observer-wake path, so it's not a regression introduced by this PR — but the synthetic path's JSDoc reads as if recorder writes are durable ("forensic trail"). For an auto-proceed pipeline that may operate unattended for many hours, a recorder write failure during the synthetic send produces zero observable signal except a one-time `console.warn` early on, then nothing. quality-realtime.md Principle 10 — "epistemic humility, you can't fix what you don't know is broken".

**Severity rationale:** P2 not P1 because the wake path has the same property and operationally we have not been bitten — but the synthetic path documents the property in a way that overstates it. The doc should be honest or the recorder should surface failures more loudly for `out`-direction frames specifically.

**Recommendation:** Either (a) downgrade the JSDoc claim to "record BEFORE send so a crash-during-send leaves a best-effort forensic trail" + add a TODO referencing recorder durability work; or (b) emit a single-shot per-session telemetry event on recorder write failure (companionBus, EC-9 shape) so the operator surface is consistent with the comment's claim.

### P2.3 — No replay test for `server:auto-proceed` recorder origin distinguishability.

**Where:** No coverage in `recorder.test.ts` / replay test fixtures for a session where BOTH a `server:council-wake` frame and a `server:auto-proceed` frame are recorded then replayed.

**What:** quality-realtime.md Principle 7 closing line ("No replay-based regression test ... Severity: P1 for a load-bearing protocol with no replay test"). The `RecordingOrigin` union is the load-bearing distinguisher between three provenance classes (browser / wake / auto-proceed). Replay-based tooling (incident triage, "did the auto-proceed nudge fire?") relies on this field being read correctly. A test that:
1. Constructs a session, records one frame with origin `browser` (field omitted), one with `server:council-wake`, one with `server:auto-proceed`,
2. Re-reads the JSONL,
3. Asserts the origin classification per line,

does not currently exist. The replay tooling (`replay.ts`) is in scope of the original Council Mode work but no auto-proceed-specific filter test exists.

**Severity rationale:** P2 not P1 because the writer side is structurally simple (string union → JSON field) and the field is already exercised in producer tests indirectly. But the protocol-correctness expert lens flags this as a missing canary for the same reason existing recorder.record signatures are tested.

**Recommendation:** Add one fixture-based recorder test that writes both wake and auto-proceed origin entries and reads back, asserting the entries can be partitioned by origin. ~20 lines including fixture.

---

## P3 — Consider

### P3.1 — `session_id: ""` on a synthetic frame to the orchestrator-half is correct per the protocol but contextually weaker than on the observer-half.

**Where:** `claude-adapter.ts:1145` (synthetic) and `claude-adapter.ts:1213` (wake).

**What:** Both paths pass `session_id: ""`. The doc on `sendUserFrameFromServer` (lines 1106–1108) explains: "the Claude Code NDJSON protocol documents this for the first `user` frame to a freshly spawned CLI ... the observer's CLI binds session via socket identity, not via the field." For the observer this is fine — observer is always-on-fresh-spawn-aware.

For the orchestrator, the synthetic is NOT typically the first frame — the user has been chatting for a while. The CLI accepts `""` (binds via socket), but the empty string in the NDJSON wire log makes provenance unclear at the protocol layer: every browser-relayed `handleOutgoingUserMessage` does `session_id: msg.session_id || ""` (line 429), which usually carries the real CLI session id from the browser's last init. The synthetic always carries `""`. So replay filtering "show me only user-typed messages" cannot rely on `session_id !== ""` — must rely on the `origin` recorder field (which IS there, good).

**Severity rationale:** P3 because the protocol layer behaves correctly, the recorder origin field already covers the distinguisher need, and the wake path establishes precedent. Flagged for honesty: a reader of just the NDJSON wire log without access to the recorder header may misattribute provenance.

**Recommendation:** Optional. Either accept (and document in a one-line `// Note:` at line 1145 that the empty session_id is intentional but provenance is recoverable only via recorder origin), or thread the real `cliSessionId` from `SessionState.session_id` if available at the bridge layer. The first is cheaper and matches the wake convention.

### P3.2 — `getBufferedAmount` is a Bun-specific extension; pure-`ws` clients (e.g. test harness) may not expose it.

**Where:** `claude-adapter.ts:1136` + `1201`.

**What:** Both paths call `this.cliSocket.getBufferedAmount()`. In production this is Bun's `ServerWebSocket`, fine. In tests, if a mock socket forgets to stub `getBufferedAmount`, the call throws and the test fails as `failed(getBufferedAmount is not a function)` — which is unrelated to the test's intent. Defensive: `typeof this.cliSocket.getBufferedAmount === "function" ? this.cliSocket.getBufferedAmount() : 0`.

**Severity rationale:** P3 trivial test ergonomics — would have flagged P2 if it had bitten production, but the test mocks in `claude-adapter.test.ts` already stub it correctly based on what shipped.

**Recommendation:** Leave as-is unless a future test harness migration to a `ws`-only mock breaks. Already de facto handled by current mocks.

---

## Convention adherence

- EC-5 (parsers reject unknown frame shapes) — outgoing path; no parse concerns. ✓
- EC-9 (structured JSON logs with `event` + `sessionGroupId` + `sessionId` + `role`) — the synthetic path delegates EC-9 to `index.ts:161` (`appLog.info("idle-timer-manager", entry.event, entry)`) and to the IdleTimerManager itself. Not in scope of this expert. ✓
- AP-2/AP-3/EC-1/EC-2/EC-7/EC-13 — not relevant to this surface. ✓
- Carmack Principle 3 line-discipline tripwire (`if (frame.includes("\n"))`) — preserved in both paths. ✓
- Carmack Principle 6 single-shot ack — see P1.1 (the orchestrator path can double-fire if not gated). ✗
- Carmack Principle 7 protocol drift — see P1.2 (non-exhaustive outcome mapping invites silent drift). ✗

## Summary

The synthetic-send path is a careful, well-commented mirror of the observer-wake path. The line-discipline assertion is preserved; the recorder origin discriminator is correctly added; the no-FIFO scope-limit is honestly disclosed. Two P1s — both about asymmetry the JSDoc explicitly handwaves but the protocol layer does not actually defend (turn-state gate hand-off across a TOCTOU boundary; outcome variant exhaustiveness inconsistent with the sister consumer). Two P2s — backpressure constant naming, recorder write-error honesty. P3s are documentation-grade.
