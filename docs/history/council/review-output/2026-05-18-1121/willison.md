# PR #68 Council Review — Simon Willison (LLM Pipeline)

**Branch:** `feat/council-mode-bootstrap-rest`
**Base:** `origin/main` (`d2324e9`)
**Lens:** §A prompt engineering discipline · §B context engineering
**Verdict:** No P1/P2 LLM-pipeline findings. Two P3 observations and one open-end flag for downstream evolution.

---

## Scope summary (Willison lens)

PR #68 is a Sidebar-glyph bootstrap fix. It adds a REST snapshot endpoint (`GET /api/groups`) and refactors three independent producers of the `group_created` wire shape to share one assembly site (`buildBrowserGroupRecord`). The keystone refactor is a structural one — it does not touch the model call, the observer's system prompt, the checkpoint/review payload schema, the wake dispatcher, the grounding gate, the manifest builder, or any artefact that influences what the observer model sees or replies with.

I read the full orchestrator diff and confirmed: zero hits on `handleCouncilCheckpoint`, `handleCouncilReview`, `dispatchObserverWake`, `observer-prompt`, `observer-system`, `observerPrompt*`, `applyCouncilObserverSpawnConfig`, `validateObserverFindings`, `buildObserverContextManifest`, or any STOP-grounding identifier. The observer pipeline is structurally untouched.

The new `BrowserGroupRecord` wire shape carries: `sessionGroupId`, `primarySessionId`, `observerSessionId`, `pairing` (e.g. `"claude+codex"`), `status`, optional `deadRole`, optional `wakeTimeoutMs`. It does NOT carry `observerPromptSha256`, `observerPromptSource`, `observerProvider`, `observerModel`, or any other prompt-provenance / model-identity field. The pairing label exposes only the backend kind (`claude` / `codex`), which is already on the wire via `SdkSessionInfo.backendType`. No new exfiltration surface to the browser.

---

## Findings

### W-1 — `pairing` label drift between live push and REST bootstrap (P3 — confirmed safe at this revision, open-end for future maintainers)

**File:** `web/server/session-orchestrator.ts:1192-1219` (live push) and `web/server/session-orchestrator.ts:2974-2992` (REST bootstrap)

**Finding.** The two producers source the `backendType` half of the `pairing` label from different stores: the live `group:created` listener reads from `this.launcher.getSession(...)` (post-spawn launcher map), while `getAllGroupsForBootstrap` reads from `g.primary.backendType` / `g.observer.backendType` (coordinator's `GroupRecord` snapshot). Both should agree because `createCouncilGroup` writes the same value into both stores on spawn — but the assertion is currently structural, not enforced. If a future refactor lets the coordinator `GroupRecord` stale-out its `backendType` while the launcher updates (or vice-versa), the wire pairing label will say `claude+codex` to one tab and `claude+claude` to another for the same group.

The shared `buildBrowserGroupRecord` helper guarantees the *format* of the pairing string is identical across producers, but it does NOT guarantee the *input* (`primary.backendType` + `observer.backendType`) is identical across producers. That's the next layer of drift the keystone refactor leaves on the table.

**Consequence.** From an LLM-pipeline perspective: the `pairing` label is what gates the frontend's provider-badge rendering and the panel-state deriver's pairing-availability hint. A drifted label between the live push and the REST bootstrap would cause the Sidebar to flip badge configuration on reload — a confusing UX but not a security or data-corruption event. The orchestrator's observer-wake / review-fanout paths do NOT consume the wire-shape `pairing` label; they read `g.primary.backendType` / `g.observer.backendType` directly. So the worst case here is a frontend visual flip, not a pipeline misroute.

**Fix.** Optional, defer: a unit invariant in `session-group-coordinator.ts` that asserts `g.primary.backendType === this.launcher.getSession(g.primary.sessionId).backendType` (and same for observer) before returning from `listAll()`. Or — preferred — collapse the live listener onto the coordinator's snapshot too, so both producers read from a single source. The launcher-vs-coordinator divergence is the open-end; closing it removes the last drift axis the keystone refactor doesn't catch.

---

### W-2 — `deadRole` absent from the bootstrap snapshot is a transcript-visibility gap (P3 — carry-forward, brief acknowledged)

**File:** `web/server/session-orchestrator.ts:2984-2989` (omission), `web/server/session-types.ts:578` (typed but never emitted), `web/server/session-group-coordinator.ts:93-105` (`GroupRecord` lacks the field entirely)

**Finding.** The `BrowserGroupRecord` interface optionally types `deadRole?: SessionGroupRole`, and the `group_degraded` runtime push correctly forwards it (`web/server/session-orchestrator.ts:1227-1232`). But `getAllGroupsForBootstrap` does not populate `deadRole` even when `g.status === "degraded"` — because the coordinator's `GroupRecord` doesn't persist `deadRole` at all (it's a transient parameter to the degraded transition, not a stored field). The frontend falls back to `?? "observer"` via the panel-state deriver, which means a user reloading the tab during an orchestrator-half death will see the observer half rendered as dead.

This is NOT a fresh defect — it's a carry-forward gap acknowledged in the context brief. I'm logging it under the Willison lens because of the *transcript-first debugging* discipline (§B). A user troubleshooting "why does the panel say my observer died when it was actually my orchestrator?" will reach for the recordings (`~/.companion/recordings/*.jsonl`) and find that the recordings DO have the correct provenance (they recorded the `group_degraded` push at the time it happened), but the *replay onto a reloaded tab* loses the provenance. The recording is correct; the post-restart re-derivation is wrong. That's the kind of transcript-vs-derived-state gap that wastes incident-response time.

**Consequence.** A reload during a degraded-orchestrator pair mislabels which half is dead in the Sidebar / panel header. The observer-wake / review-fanout pipeline is unaffected (degraded groups don't get woken at all per the bus-listener at line 1239-1251), so this is a display-only defect. But the panel's status pill is the first thing a user looks at when something feels wrong, and a wrong pill is a wrong starting hypothesis.

**Fix.** Out of PR #68 scope, but the smallest correct fix is to add `deadRole?: SessionGroupRole` to `GroupRecord`, set it in the `applyEvent` reducer on the `degraded` transition (alongside the existing emit), and forward it in `buildBrowserGroupRecord` when present. The forward path is one line in `getAllGroupsForBootstrap` once `GroupRecord` carries the field.

---

### W-3 — Open-end on prompt-provenance leakage (P3 — informational, NOT a current defect)

**File:** `web/server/browser-group-record.ts:1-58`, `web/server/session-types.ts:568-584`

**Finding.** Three independent paths now route through `buildBrowserGroupRecord` (live push, REST bootstrap, ws-bridge synthetic hydration). The current `BrowserGroupRecordParts` interface accepts ONLY `{sessionGroupId, primary, observer, status}` and the helper assembles ONLY the seven minimal wire fields. There is no path here today by which `observerPromptSha256`, `observerPromptSource`, `observerProvider`, or `observerModel` could reach the browser via the group-created channel.

But the helper's purpose ("centralise the wire-shape assembly so the three producers cannot drift") is itself a forcing function for future contributors who think "while we're in there, let's also send X". If a future PR adds a `Sidebar: show which prompt version is active` feature and reaches for `buildBrowserGroupRecord` as the natural site, that PR could leak prompt provenance to the browser by adding one field to the helper output. That would also be a Hunt concern (information-disclosure boundary), but the LLM-pipeline lens has a complementary worry: if the prompt sha is on the wire, the *prompt itself* becomes a queryable property of the frontend, which gives prompt-injection adversaries an easier route to ground their attacks ("ignore previous instructions, use the prompt with sha `abc123...`").

The current PR is clean. The structural open-end is: there is no codified rule that says "prompt-provenance fields stay out of the group wire shape." The keystone refactor made drift mechanically impossible across producers but did not codify the *content* invariant.

**Consequence.** No current defect. If a future PR adds a prompt-provenance field to `BrowserGroupRecord` without a security review, the helper would silently propagate it to all three producers and the browser would receive prompt-identifying data on every group push and every reload bootstrap — exactly the surface the observer's spawn-time prompt hash was designed NOT to expose to client code.

**Fix.** Add a one-line invariant to `browser-group-record.ts`: `// Forbidden fields: observerPromptSha256, observerPromptSource, observerProvider, observerModel. Prompt and model provenance stay server-side per the observer-spawn isolation contract (EC-1).` Pair with a producer-side unit test: `expect(Object.keys(buildBrowserGroupRecord(parts))).toEqual([...specific seven fields...])` so a future field addition mechanically fails the test rather than silently shipping. This is the §A `structured outputs` discipline (parse-or-fail at the boundary, reject unexpected shapes) applied to the producer side of the wire.

---

## Confirmations (NOT findings — recorded for the synthesis stage)

- **Observer dispatch pipeline untouched.** The `companionBus.on("group:created", ...)` listener changed only how it ASSEMBLES the broadcast payload. It still receives the same event arguments from the coordinator, still calls `wsBridge.broadcastToGroup` with the same target list, and does not interact with the wake dispatcher, the checkpoint watcher, the review watcher, the grounding validator, or the manifest builder. Same for the new `getAllGroupsForBootstrap` method — read-only snapshot of coordinator state, no side effects, no observer-half side channel.

- **Wire shape minimal.** `BrowserGroupRecord` exposes group-identity and lifecycle status only. The pairing label (`"claude+codex"`) reveals backend KIND, which is already on the wire via `SdkSessionInfo.backendType`; no new leakage.

- **No new model calls.** PR #68 adds zero new prompt-assembly sites, zero new LLM API calls, zero new context-packing code. The observer's prompt-versioning, sha-stamping, and bundled-fallback contract (`web/server/observer-prompt.ts` and `observer-prompt-bundled.ts`) is not touched.

- **No new structured-output parsing.** The new REST endpoint returns server-built JSON; it does not parse model output. No parse-or-fail discipline applies.

- **Transcript-first debugging not regressed.** The raw-protocol recorder (`web/server/recorder.ts`) captures NDJSON between server and CLI. The new wire-shape change (additive `status` field on `group_created`) is browser-bound, not CLI-bound; recordings of CLI traffic are unaffected. Browser-bound traffic was never in the recorder's scope.

---

## Verdict

No blocking LLM-pipeline findings. The PR is a structural fix that does not alter what the observer model sees, what it writes, what the orchestrator reads back, or how findings are grounded. The three Willison-lens P3 observations are forward-looking — they each protect a future PR from regressing a property the keystone refactor leaves implicit rather than explicit. Recommended fix order if any are taken: W-3 (one-line codification, ~10 minutes) > W-2 (carry-forward, out-of-scope) > W-1 (defer until coordinator snapshot becomes the single source for backend type).
