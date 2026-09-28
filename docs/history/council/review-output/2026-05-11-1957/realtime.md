# Realtime / NDJSON Protocol Review — Council Mode Phase A+B+C

Reviewer lane: protocol correctness on cross-process boundaries (JSON-RPC envelope, checkpoint sentinel via FS, schema contract between writer/reader pair).

Files in scope:
- `web/server/codex-envelope.ts`
- `web/server/council-types.ts`
- `web/server/checkpoint-watcher.ts`

---

## Finding 1 — JSON-RPC notification rejects spec-legal omitted `params`

**File:line-range:** `web/server/codex-envelope.ts:77-81`

**Principle:** Principle 7 — *Protocol drift: the CLI is undocumented, the contract is observed; required-field strictness on optional shapes drops legitimate frames.*

**Severity:** P2

**What's wrong:** The notification branch unconditionally requires `params` to be an object (`if (!isObject(parsed.params)) return null`). The JSON-RPC 2.0 spec marks `params` as **optional** on both requests and notifications. Codex backend versions that emit a parameterless notification (e.g. a bare `"method": "ping"` or `"method": "ready"`) will be silently dropped here. The same over-strictness applies to the request branch at lines 69-74. There is also no `jsonrpc: "2.0"` discriminator check — the validator does not assert the envelope claims to be JSON-RPC at all, yet imposes JSON-RPC-shaped rules on it.

**Consequence:** A Codex CLI version bump that adds a paramless notification — or one that includes `"jsonrpc": "2.0"` alongside an unexpected extra field — produces a null return, the caller drops the message, and the orchestrator silently loses observability. This is the classic protocol-drift silent-degradation mode flagged in `quality-realtime.md` P7.

**Fix:** Treat `params` as optional: accept `undefined`, normalise to `{}` (or to `undefined` in the discriminated union) when absent; only reject when present-but-not-an-object. If `jsonrpc` is the agreed contract field, assert its presence with the literal `"2.0"`. Add a `default`-branch log (or expose an `onDropped` callback) so unknown shapes are observable rather than invisibly skipped.

---

## Finding 2 — No method allowlist post-parse; envelope validator accepts any caller-controlled method name

**File:line-range:** `web/server/codex-envelope.ts:54-105` (entire `parseCodexFrame`)

**Principle:** Principle 8 — *Two protocols, one bridge: each protocol has its own ID schemes and lifecycle; mixing un-namespaced methods is a recipe for cross-protocol bug bleed.* Also Principle 7 — *Discriminator field used in a switch without default.*

**Severity:** P2

**What's wrong:** `parseCodexFrame` validates frame **shape** only. `method` is a bounded printable ASCII string — but there is no enumeration of permitted council-mode methods (e.g. `tools/list`, `tools/call`, `session/configured`, etc.). The context-brief explicitly notes this is "deferred until wiring", but the module is the cross-process trust boundary and it is exported as if final. A future caller that wires this into ws-bridge.ts will get parsed frames for **any** method name the peer chooses to send, including methods that map onto the Claude NDJSON namespace (collision risk per Principle 8) or unknown methods that look like internal control verbs.

**Consequence:** When wired in Phase D, the bridge will treat every well-shaped JSON-RPC frame as legitimate Codex traffic. A bug in the Codex CLI (or a hostile peer if the WS auth ever weakens) can drive arbitrary downstream branches by inventing method names — the parser's job ends at "shape OK" and there is no gatekeeper after it. The absence of a `default`-branch log on unknown methods also makes drift invisible: a new Codex version emitting `tools/list2` produces silent no-ops, not warnings.

**Fix:** Introduce an explicit `CODEX_COUNCIL_METHODS` allowlist (a `readonly Set<string>` or branded type) and have `parseCodexFrame` either (a) narrow the returned `method` field to the union of allowed methods, or (b) accept any method but expose a separate `isAllowedCouncilMethod(m)` guard so the bridge can log-and-drop unknown methods at one chokepoint. Either way, unknown methods must be observable.

---

## Finding 3 — `schema_version` has no migration / version-skew path

**File:line-range:** `web/server/council-types.ts:11` and parsers at lines 111, 146

**Principle:** Principle 7 — *Protocol drift; the contract is observed and any version bump may add or rename fields.*

**Severity:** P2

**What's wrong:** Both parsers reject with `null` if `schema_version !== 1` (strict equality against `COUNCIL_SCHEMA_VERSION`). There is no concept of "minor compatible" (e.g. accept v1 but also accept v1.1 if additive), no upgrade path documented, no `onDropped("schema-version-mismatch", ...)` distinguished from `onDropped("invalid-schema", ...)` in the watcher (line 87 emits a generic `"invalid-schema"`). When the orchestrator and observer ship at different versions (which can happen the moment an end-user updates one CLI but not the other in a paired session that is mid-lifecycle), **every** checkpoint silently drops with no operator-visible signal.

**Consequence:** A v2 orchestrator paired with a v1 observer (or vice versa) is indistinguishable from a corrupt-payload situation in logs. Operators investigating a wedged pair will spend hours before realising the issue is a version handshake, not a bug. This is exactly the drift-defence failure mode the brief flagged: "no version bump path defined yet."

**Fix:** (a) Document and implement a version negotiation: accept `schema_version` within a known set (e.g. `[1]` today, `[1, 2]` after a migration ships) and emit a distinct `onDropped("schema-version-mismatch", file, observed, expected)` reason. (b) Add a `MIN_SUPPORTED_SCHEMA_VERSION` / `MAX_SUPPORTED_SCHEMA_VERSION` pair so the writer side can also negotiate. (c) Capture the migration story in a comment in `council-types.ts` so the next contributor knows where to add v2.

---

## Finding 4 — Checkpoint dedup by filename is absent; double-rename / atomic-replace fires the handler twice

**File:line-range:** `web/server/checkpoint-watcher.ts:38-69`

**Principle:** Principle 2 — *Dedup is a correctness mechanism, not a performance hack.* The 150ms debounce coalesces **within-window** repeats but provides no idempotency at the payload level.

**Severity:** P1

**What's wrong:** The watcher debounces per-filename for 150ms (lines 53-59). This handles the platform-specific "two events for one rename" case mentioned in the comment. But there is no dedup on `checkpoint_id` — and `CheckpointPayload` has a `checkpoint_id` field explicitly documented at `council-types.ts:27` as *"Stable id for this checkpoint emission — used by observer for dedup."* The watcher never uses it. Scenarios that bypass the 150ms window and fire the handler twice for the same logical checkpoint:

1. **Orchestrator re-writes the same checkpoint file after a crash/restart** — atomic rename completes, handler fires, then orchestrator on restart writes the same payload again (idempotent from its side). The watcher fires `onCheckpoint` twice for the same `checkpoint_id`.
2. **Two different files containing the same `checkpoint_id`** (e.g. `phase-1.json` and a leftover `phase-1.bak.json` that happens to end `.json` and not start with `.`) — per-filename debounce treats them independently.
3. **Slow handler (>150ms)** — the debounce only covers the gap between FS events, not the gap between handler invocations. If the orchestrator legitimately re-emits 200ms apart, both fire.

**Consequence:** The observer wakes twice for the same checkpoint and produces two review files, doubles its work, and (depending on downstream wiring) may produce two `ObserverReviewPayload` writes that step on each other. This is the cross-process equivalent of the dedup-state-reset-on-reconnect failure mode in Principle 2 — the contract field exists, but the consumer doesn't honour it.

**Fix:** Inside `readAndEmit`, maintain a bounded `Set<checkpoint_id>` (FIFO, capped at e.g. 256 entries to bound memory) at the watcher scope. After parsing, check `seenCheckpointIds.has(payload.checkpoint_id)` before calling `onCheckpoint`; if seen, route to `onDropped("duplicate-checkpoint-id", file)`. This honours the documented contract on the type and matches the dedup discipline used in `claude-adapter.ts`'s rolling hash window.

---

## Finding 5 — `sequence` field is monotonic-by-contract but the watcher never enforces order

**File:line-range:** `web/server/checkpoint-watcher.ts:38-69` and `council-types.ts:32`

**Principle:** Principle 3 — *Sequence numbers + replay: the only honest reconnect.* Principle 4 — *Broadcast order not preserved per-receiver.*

**Severity:** P2

**What's wrong:** `CheckpointPayload.sequence` is documented as "Monotonic position of this checkpoint within the group" (council-types.ts:32). The watcher reads files in filesystem-event-arrival order — which on most platforms is roughly write-order, but is **not guaranteed**. Two checkpoints written in rapid succession (or a backfill scenario where the orchestrator writes phase-3 then phase-2) will be delivered to `onCheckpoint` in arrival order, not sequence order. The watcher has no `lastSequenceSeen` per `session_group_id`, no out-of-order detection, no replay request when a gap is observed.

**Consequence:** The observer can process checkpoint N+1 before checkpoint N if the FS surface reorders rename events (NFS, overlayfs, certain Docker layers). When the observer's review is grounded on artifacts that depend on the prior checkpoint's outputs, it reviews stale or absent files. Worse, the observer has no way to detect the gap — there is no "checkpoint N missing" signal. This is the FS-bus analogue of the missing-seq-number broadcast failure mode in Principle 3.

**Fix:** Track `lastSequenceSeen` per `session_group_id` inside the watcher (or pass it as part of `CheckpointWatcherOptions` so the coordinator owns the state). On receipt: (a) if `payload.sequence <= lastSeen`, drop via `onDropped("stale-sequence", file)`. (b) If `payload.sequence > lastSeen + 1`, emit a `onDropped("sequence-gap", file, expected, observed)` warning before delivering — gaps may be legitimate (orchestrator skipped a phase) but they must be observable. (c) Always deliver in sequence order if buffering is feasible.

---

## Finding 6 — `parseObserverReviewPayload` does not validate `findings.length === 0` distinctly from "missing findings"

**File:line-range:** `web/server/council-types.ts:152-153, 137-178`

**Principle:** Principle 6 — *control_request / control_response: single-shot ack discipline; a missing response wedges the producer.*

**Severity:** P3

**What's wrong:** The observer review is the FS-bus equivalent of a `control_response` — the orchestrator waits for it before advancing. The validator accepts `findings: []` (empty array) as valid (`Array.isArray` + `length <= MAX_FINDINGS` both pass for empty). Semantically, an empty findings list means "observer reviewed and found nothing." A missing `findings` field — currently also accepted as invalid because of the strict `Array.isArray` check — and an empty array are indistinguishable to the orchestrator unless it inspects the array length. There is no explicit "review verdict" field (e.g. `verdict: "clean" | "stop" | "note-only"`) that the orchestrator can switch on without inferring from findings array contents.

**Consequence:** When the orchestrator side gets wired (Phase D), it will have to infer review verdict from `findings.length === 0 && reviewed_at !== null`. Future ambiguity if a contributor adds a finding type that doesn't go into the array (e.g. a `summary` field), or if an observer ships a malformed review with present `reviewed_at` but absent `findings`: the inference breaks.

**Fix:** Add an explicit `verdict: "clean" | "advisory" | "stop"` field to `ObserverReviewPayload`, validate it exhaustively, and document that orchestrator MUST switch on `verdict` (not on `findings.length`). This is the single-shot-ack discipline applied to the FS bus: make the ack semantics explicit, not inferred.

---

## Finding 7 — `isBoundedString` forbids spaces, which breaks `emitted_at` / `reviewed_at` ISO-with-space variants and `observer_provider` multi-word values

**File:line-range:** `web/server/council-types.ts:70-72`, used at lines 116, 150, 151

**Principle:** Principle 7 — *Required-field strictness on optional shapes; speculative over-validation drops legitimate payloads.*

**Severity:** P2

**What's wrong:** `isBoundedString` rejects any string containing a space character. This is applied to:
- `emitted_at` (line 116) — ISO 8601 has two legal forms, `2026-05-11T19:57:00Z` (no space) **and** `2026-05-11 19:57:00Z` (RFC 3339 §5.6 NOTE, with a space separator). Some `toISOString`-equivalent producers (Python `datetime.isoformat(sep=' ')`, Postgres timestamptz cast, some Go formatters) emit the spaced form.
- `reviewed_at` (line 150) — same issue.
- `observer_provider` (line 151) — `"claude code"` or `"openai codex"` (multi-word provider names) are rejected.
- `session_group_id` (line 115) and `checkpoint_id` (line 112) — these are id strings, no-space is defensible, but the constraint is undocumented at the type level.

**Consequence:** A perfectly valid `emitted_at: "2026-05-11 19:57:00.000Z"` causes the entire checkpoint to be dropped as `invalid-schema`. The reason is invisible to the operator (single generic reason string). The orchestrator's review pair wedges, the observer never sees the checkpoint.

**Fix:** Split `isBoundedString` into purpose-specific predicates: `isBoundedId` (no spaces, used for ids) vs `isBoundedTimestamp` (allows space-separated ISO, or better — validate against a real ISO regex / `Date.parse` non-NaN check) vs `isBoundedLabel` (allows spaces, used for provider names). Make the constraint visible at each call site.

---

## Summary

7 findings: 1 P1, 5 P2, 1 P3.

The shape validator in `codex-envelope.ts` is strong on rejecting malformed JSON-RPC but **too strict** on legitimate spec-optional fields and **not strict enough** on method enumeration — both are drift-defence failures (Principle 7/8). The FS-bus checkpoint protocol has the correct primitives (atomic write, debounce, null-on-invalid) but **fails to honour its own dedup and ordering contracts** — `checkpoint_id` is defined "for dedup" but never used; `sequence` is documented as monotonic but never enforced. This is the cross-process analogue of the broadcast dedup/seq failure modes in `quality-realtime.md` P2/P3. The schema_version field has no migration path (P7). Two minor over-validation issues (spaces in timestamps, implicit verdict) round out the list.
