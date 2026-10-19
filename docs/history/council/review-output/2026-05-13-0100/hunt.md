# Troy Hunt — Security Review (Council Mode Observer Auto-Wake, Story 2 AC#1)

Scope: `observer-prompt.ts`, `claude-adapter.ts`, `session-orchestrator.ts` (dispatch/sentinel), `council-wake-sentinel.ts`, `council-types.ts`.

Domain stance: I focused on the four vectors the brief asked for — NDJSON injection at the wake-builder boundary, the realpath wrapper's correctness, sentinel path construction, and cross-group leakage — plus a recorder content audit and a sync send-throw audit.

---

FINDING:
- Title: Cross-group checkpoint leakage when two groups share a workspace cwd
- File: web/server/session-orchestrator.ts:1135-1170 (handleCouncilCheckpoint) and 1083-1106 (startCouncilWatchers); web/server/checkpoint-watcher.ts entire file
- Principle: Principle 7 — Assertions as tripwires / access control (session-as-capability sibling)
- Severity: P1
- What's wrong: `createCouncilGroup` accepts `req.base.cwd ?? process.cwd()` without uniqueness checks, so two council groups created against the same workspace both attach watchers to the same `<cwd>/.council/checkpoints/` directory. The checkpoint file does carry a `session_group_id` field (validated by `parseCheckpointPayload`), but `handleCouncilCheckpoint` never compares `payload.session_group_id` against the watcher's closure-bound `sessionGroupId` before invoking `dispatchObserverWake(sessionGroupId, payload)`. Each watcher fires on every `.json` write in the shared directory.
- Consequence: A checkpoint emitted by group A (with `session_group_id = grpA`) is dispatched as a wake to group B's observer, with the wake body's echo field showing `grpA` while the actual frame lands on `grpB`'s socket. The observer in group B reads group A's manifest paths, produces a review of code outside its own session's view, and the sentinel for group B records group A's `checkpoint_id` — silently poisoning B's idempotency state forever. This is real cross-tenant leakage in a multi-group local dev scenario (which the codebase explicitly supports — `multi-group server never cross-contaminates sentinels` is asserted in the sentinel module's JSDoc, but the runtime does not enforce it).
- Fix: At the head of `handleCouncilCheckpoint`, reject when `payload.session_group_id !== sessionGroupId` with a structured EC-9 drop line ("foreign-group checkpoint observed"). Alternatively (or additionally), refuse to register a second watcher pointing at the same `<cwd>` and surface that as a creation error to the caller.

---

FINDING:
- Title: `councilWakeSentinelPath` joins `sessionGroupId` into a path with no validation
- File: web/server/council-wake-sentinel.ts:62-64 (councilWakeSentinelPath), 106-118 (read), 131-143 (write)
- Principle: Principle 1 — If it's syntactically possible, it statistically exists (path traversal sub-class) / EC-7 idiom
- Severity: P2
- What's wrong: `councilWakeSentinelPath`, `readCouncilWakeSentinel`, and `writeCouncilWakeSentinel` all accept `sessionGroupId: string` without inline validation against `GROUP_ID_PATTERN` from `group-authorization.ts`. Today's only callers feed coordinator-generated `grp_<32-hex>` ids, but the module exports the helpers and is the obvious extension point for future restart-reconcile / cleanup callers. A `sessionGroupId` of `"../../tmp/evil"` produces a path of `<cwd>/.council/state/../../tmp/evil-wake.json` and `writeAtomicJson`'s `mkdir -p` + rename will happily write outside the workspace.
- Consequence: Future callers (especially anything dispatching from a foreign-supplied id during reconciliation, REST hydration, or a restart sweep) can silently land arbitrary files anywhere on the filesystem the server user can write to. This is a latent path-traversal sink; it is not exploitable today but the contract that prevents it is documented in JSDoc only ("Contract = documentation, not enforcement" — universal feedback).
- Fix: Inline an `isWellFormedGroupId` check at the head of all three helpers (path-builder + reader + writer) and return null / throw on mismatch. Then the EC-7 idiom is actually honoured — the resolving wrapper enforces what the JSDoc claims.

---

FINDING:
- Title: Sentinel reader treats permission-denied identically to file-missing
- File: web/server/council-wake-sentinel.ts:106-118 (readCouncilWakeSentinel)
- Principle: Principle 9 — Assume breach / fail-loud over fail-silent
- Severity: P3
- What's wrong: `readCouncilWakeSentinel` absorbs every `readFileSync` failure (ENOENT, EACCES, EIO, EBUSY, etc.) and returns `null`. The dispatcher (`dispatchObserverWake` line 1224) interprets `null` as "no prior wake" and proceeds to dispatch. The module's JSDoc explicitly acknowledges this is "the safe-fail direction (better to re-wake than to silently never wake)", but a permission-denied or transient IO error on a populated sentinel will cause the same checkpoint to be re-dispatched across every server restart until the FS error clears.
- Consequence: A privilege-mode or filesystem-permissions misconfiguration that prevents the server from reading its own sentinel (but not writing — atomic-rename overwrites without read) silently turns the restart-idempotency guard into a no-op. Repeated observer wakes for the same checkpoint id pile context-window cost on every restart with no log line distinguishing this case from "first checkpoint of group". Pair with the existing fact that the watcher's seen-LRU is also in-memory.
- Fix: Distinguish ENOENT from other read failures inside `readCouncilWakeSentinel` — return `null` only on ENOENT; on other errors, return a typed sentinel-failure indicator (or log structurally and still return null but with a one-line EC-9 warn so an operator sees it). The dispatcher already wraps the write side in try/catch with a structured log; symmetry on the read side closes the silent-degradation gap.

---

FINDING:
- Title: `claim` claim-field in observer findings tolerates fence-triplet and CR/LF for echo back into the orchestrator chat
- File: web/server/council-types.ts:189-198 (isBoundedText) and 312 (parseObserverReviewPayload uses it for `claim`); knock-on into `observer-prompt.ts` wake builder (echo fields validated separately, but `claim` is downstream input not output)
- Principle: Principle 1 — If it's syntactically possible, it statistically exists (NDJSON line-discipline injection sibling)
- Severity: P3
- What's wrong: `isBoundedText` permits tab/CR/LF inside claim strings (intentional, for code excerpts), and does NOT reject the ``` triplet. The wake-builder boundary correctly rejects CR/LF/NUL/fence-triplet for OUTBOUND manifest paths and echo fields (lines 339-345, 410-419, 461-466 in `observer-prompt.ts`), but inbound `findings[].claim` text has no equivalent guard at the format-transformation boundary where it gets injected back into the orchestrator chat (`wrapObserverFindingForInjection` in `observer-attribution.ts`, out of this review's scope). Within Hunt's lane: at the parse boundary, this is a `claim` that contains CR/LF + fence-triplet that the orchestrator's display surface inherits.
- Consequence: A buggy or hostile observer producing a `claim` with `\r\n` + ``` could disturb downstream rendering or break out of any fenced display the orchestrator wraps it in. Not exploitable on the observer→server NDJSON path itself (the file is parsed JSON, not transported as NDJSON), but the symmetry break between outbound (rejecting fence triplet) and inbound (accepting it) is the kind of asymmetric setup that ships green and breaks later.
- Fix: Either (a) split `isBoundedText` per semantic category — one for "claim text destined for chat injection" (reject fence triplet + CR/LF), one for "code excerpt that legitimately contains both" — or (b) push the format-transformation check down to `wrapObserverFindingForInjection`. The validator-per-semantic-category lesson applies here.

---

FINDING:
- Title: Recorder origin field "server:council-wake" enables forensic replay but the recorded body contains the unredacted manifest paths and phase
- File: web/server/claude-adapter.ts:1018-1032 (sendUserFrameFromServer recorder.record call)
- Principle: Principle 3 — Minimise state (recordings audit)
- Severity: P3
- What's wrong: The wake-frame recording captures the full assembled `textBody` (with embedded JSON of session_group_id, checkpoint_id, phase, and full manifest path lists) into `~/.companion/recordings/`. This is intentional and well-justified for forensic replay, and the recording dir already inherits the broader privacy stance of the recorder. The brief asked whether the new content category needs redaction; for this scope the answer is mostly no — paths went through `isRelativeWorkspacePath` (rejects `.env`, `.ssh`, `.companion`, etc.) and `assertWakeManifestPathAllowed` (rejects out-of-workspace). The body never includes file CONTENTS, only paths. However: the phase name is free-form (within `PHASE_PATTERN` `[A-Za-z0-9_.-]`), and a user-chosen phase like `acquire-prod-api-key` is now recorded for every wake. Branch/feature naming hygiene is the only thing keeping that out of recordings.
- Consequence: A `~/.companion/recordings/` directory leak now also leaks phase names and the structure of `.council/` manifest paths per checkpoint. Same severity as the existing recorder content; the new origin field doesn't elevate it but it's a new audit channel worth flagging.
- Fix: Document in the recorder README that wake-frame recordings include phase + manifest-path structure (no file contents). If recordings are ever shipped off-host for support, scrub `origin: "server:council-wake"` entries or coarsen `phase` to a fixed enum.

---

FINDING:
- Title: Sync send-throw path in `sendUserFrameFromServer` does NOT roll back the recorder write
- File: web/server/claude-adapter.ts:1018-1032 (record-then-send sequence)
- Principle: Principle 9 — Assume breach / failure consistency
- Severity: P3
- What's wrong: The adapter records the wake frame BEFORE calling `cliSocket.send` (line 1023-1025), then catches a synchronous send throw and returns `{kind:"failed"}`. The recorder entry persists as if the frame had been transmitted. The brief asks whether the orchestrator's failed-send path leaks state or wedges the watcher; the orchestrator side is clean (structured EC-9 log, no degradation, no watcher unhook), but the recorder shows a frame that never crossed the socket. The intent is documented ("Record BEFORE send so a crash-during-send leaves a forensic trail"), and that's a defensible choice — but the recording does not carry an outcome marker pairing it with the dispatcher's `group.observer_wake_failed` log line.
- Consequence: Replay from recordings will replay frames that were never delivered; reconstructed turn-state from recording will be wrong. Mild forensic distortion, not a security breach — but a replay-based regression test (EC-6 idiom) built against this recording would falsely "pass" on the failed-send case.
- Fix: Either (a) move the `recorder.record` call after a successful `send`, accepting loss of forensic trail on crash-during-send; or (b) append a second recorder entry on the throw branch with a sentinel marker so replay can correlate. Option (b) preserves the crash-trace intent without distorting replay.

---

No P1 issues in: `observer-prompt.ts` wake-builder NDJSON line-discipline (CR/LF/NUL + fence triplet checks are properly placed at the format-transformation boundary; `hasUnsafeWireCharacters` correctly rejects 0x00, 0x0A, 0x0D; the JSON.stringify post-assertion in `sendUserFrameFromServer` is a defensible tripwire); `assertWakeManifestPathAllowed` realpath wrapper (the `+sep` prefix-confusion guard is present at lines 320-321, the missing-tail climb is bounded and behaves correctly even under partial-existence + ancestor-symlink scenarios; defense-in-depth against absolute paths via `resolvePath` collapsing them).

Summary: 1 P1 (cross-group leakage when workspaces collide), 2 P2 (sentinel path footgun, plus the implicit half of the leakage one), 4 P3 (silent permission-error degradation, claim field format-asymmetry, recorder content audit, recorder-vs-send ordering).
