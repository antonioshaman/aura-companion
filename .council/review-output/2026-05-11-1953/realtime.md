# Realtime / NDJSON Protocol Expert — Council Review

**Scope:** `codex-envelope.ts` + tests, `council-types.ts` + tests.
**Lens:** JSON-RPC envelope correctness, framing discipline, drift tolerance, ID namespacing across Codex vs Claude NDJSON paths, error-envelope fidelity, cross-process contract shape (writer/reader).

The envelope module is a **pure per-line parser** — it does no framing, no buffering, no I/O. That's the right shape for a contract layer. Findings are accordingly about what the parser **commits the bridge to** when Task 12 lands, plus contract-shape gaps in `council-types.ts`.

---

## P1 findings

### P1-RT-1 — Numeric-only `id` discipline silently desynchronises Codex from the real JSON-RPC 2.0 wire

**Where:** `web/server/codex-envelope.ts:43–45,69–101` (the `isValidId` predicate accepts only non-negative integers and is gated into every `id`-bearing branch).

**Failure mode:** JSON-RPC 2.0 explicitly permits `id` to be a string, a number, or null (for notifications). The Codex CLI is a JSON-RPC 2.0 speaker. The moment a future Codex version (or a different Codex subcommand path — e.g. tool-result correlation with UUID-style ids, which Codex *has* shipped in past releases) emits `"id":"abc-uuid"` or even `"id":1.0` serialised as `1` on one host and parsed back through JSON as `1` on another, **every such frame returns `null` from `parseCodexFrame` and is silently dropped by the caller**. The Hunt-aligned "reject-on-unknown" principle is correct as a security stance for *method names* and *shapes*; applying it to JSON-RPC's documented permitted id-type space inverts the contract into "reject the spec".

This is exactly the "switch-without-default discipline" tension the brief flagged in reverse: unknown **methods** must be rejected (correct here), but unknown **optional field shapes within a known-shaped frame** must be tolerated (incorrect here — `id` is a polymorphic-by-spec field, not an unknown extension).

Compounding: there is no telemetry hook on the `return null` paths inside `parseCodexFrame`. A frame rejected for the legitimate reason (hostile/malformed) and a frame rejected because Codex shipped UUID ids tomorrow are observationally indistinguishable. The bridge will go silent in a way that **looks like the CLI just stopped talking**.

**Why P1:** the brief explicitly named "JSON-RPC `id` namespacing (string vs numeric collision risk with the existing Claude NDJSON path)" as a focus. The current commit decided that question by exclusion: only numbers, no namespace. That decision is load-bearing for Task 12 routing and is silently wrong against the JSON-RPC spec.

**Principle:** Realtime P7 (Protocol drift — required-field strictness on optional shapes) + P8 (Two protocols, one bridge — JSON-RPC `id` collision across backends). Required-field strictness on a *polymorphic-by-spec* field is the strictest form of this anti-pattern.

**Recommendation framing:** widen `id` to `string | number` at the parser layer, namespace at the *router* layer (Task 12), and emit a structured drop-with-reason on every `return null` so silent-rejection has a fingerprint.

---

### P1-RT-2 — No replay-based regression test against captured Codex JSON-RPC recordings

**Where:** `web/server/codex-envelope.test.ts` — 100% hand-crafted JSON literals; no `recordings/*.jsonl` fixture loaded.

**Failure mode:** Per the brief, `codex-envelope.ts` is "the strict typed parser that every Codex JSON-RPC frame must pass through before persistence or browser delivery." The CLAUDE.md documents that the server already records **all raw protocol messages** to `~/.companion/recordings/*.jsonl`, and `replay.ts` exists specifically to load and filter them. Yet the test suite exercises only hand-authored shapes the author already imagined.

The realtime reference doc names this exact gap as P1: *"A recording-based regression test (load a known JSONL, feed it through the adapter, assert the typed-event output) catches CLI version drift before users do."* The Claude NDJSON adapter is presumed to share this gap, but here we have a *brand-new* protocol parser shipping its first test suite without a single line from a real Codex transcript.

The consequence: any Codex frame shape the author didn't think of — `id` as string (see P1-RT-1), `params` as an array (the JSON-RPC spec permits this; Codex may use it for positional tool args), missing `params` on notifications that have no arguments, a notification with an `id` field set to `null` (also legal per spec) — will be silently dropped on day one and there's no test that would have caught it.

**Why P1:** the parser is the new load-bearing protocol boundary. Shipping it without a captured-transcript test gives no safety net against the very drift the strict-shape regime is meant to handle.

**Principle:** Realtime P7 (no replay-based regression test on a load-bearing protocol).

---

## P2 findings

### P2-RT-1 — `params` strictness rejects two legitimate JSON-RPC 2.0 shapes (array params, omitted params)

**Where:** `codex-envelope.ts:72,79` — `if (!isObject(parsed.params)) return null;` on every request and notification.

**Failure mode:** Per JSON-RPC 2.0 §4.2, `params` "MAY be omitted" and when present "MUST be Structured (Array or Object)". The parser rejects both omission and array form. Test `codex-envelope.test.ts:105–108` (`rejects array-shaped params`) and `:110–113` (`rejects missing params on a request/notification`) consciously encode these as wrong — but those tests are encoding an **assumption about Codex's subset**, not enforcing the spec.

The comment on the array-params test says *"per the existing adapter"* uses `Record<string, unknown>` — but the brief explicitly notes "the actual ws-bridge integration is NOT in this batch." The existing adapter is the Claude NDJSON path; the codex adapter is exactly what's being introduced. Justifying tightness against a path that isn't yet wired is circular.

Concrete failure: when Codex sends a "ping"-style notification with no params, or a positional `tool.call(["Read", "/tmp/x"])` — both legitimate JSON-RPC — the bridge silently drops the frame and the orchestrator's UI goes quiet.

**Why P2 (not P1):** unlike `id`, the brief did not flag this explicitly, and Codex's current observed subset may genuinely be object-only. But the test comment makes it clear this was a decision, not a derivation — the decision should be stated in the parser's contract (a comment block at the top citing the Codex subset and version observed) and ideally relaxed to spec.

**Principle:** Realtime P7 (required-field strictness on optional shapes).

---

### P2-RT-2 — Error envelope drops fidelity by collapsing `data: undefined` into the payload

**Where:** `codex-envelope.ts:96–100`:
```
return {
  kind: "error",
  id: parsed.id,
  error: { code: err.code, message: err.message, data: err.data },
};
```

**Failure mode:** The brief explicitly asked for "error-envelope translation fidelity (preserve `code`/`message`/`data` structure under a typed `kind` rather than collapsing)." The shape is mostly preserved, BUT:

1. `data: err.data` is written unconditionally. When `err.data` is absent on the wire (legal — per JSON-RPC 2.0 §5.1 `data` is OPTIONAL), the typed result carries `data: undefined`. This is observable downstream: `"data" in frame.error` returns `true`, but `frame.error.data === undefined`. The test on line 43 (`error: { code: -32601, message: "Method not found", data: undefined }`) **encodes this as expected** — but it's a fidelity bug: a frame with no `data` field and a frame with `"data": null` are now indistinguishable.
2. `data` is typed `unknown` — fine — but is passed through with **no size cap**. The error `message` is capped at 4000 chars (line 95). A hostile or buggy Codex sending a 50 MB JSON tree in `data` rides through to the recording layer unchecked. The `MAX_ERROR_MESSAGE_LEN` defence has a sibling-gap.

**Why P2:** the brief named this exact axis. Preservation is *almost* right; the `undefined` injection plus uncapped `data` weakens both the contract and the JSONL append-safety story (a 50 MB `data` blob serialised into the recording line breaks the "one JSON object per line" assumption only if it contains a literal `\n` after stringification — JSON serialisation can't produce that — but it does balloon the recording file and erode replay performance).

**Principle:** Realtime P8 (error envelope translation losing fidelity).

---

### P2-RT-3 — `parseCheckpointPayload` uses `MAX_FINDINGS` as the cap for `artifact_paths` — a stringly-typed coincidence that will drift

**Where:** `council-types.ts:19` defines `MAX_FINDINGS = 50`. Line 118: `if (parsed.artifact_paths.length > MAX_FINDINGS) return null;`. Line 153 reuses the same constant for findings count in `parseObserverReviewPayload` (correct usage).

**Failure mode:** The reuse is a coincidence. `artifact_paths` is a list of files the observer must read; `findings` is a list of review verdicts. These are unrelated quantities with unrelated upper bounds. Using the same constant name for both:

- silently couples two limits that should evolve independently — bumping `MAX_FINDINGS` to 100 silently bumps the max artifact path count, even though the watcher size cap and per-path length cap are tuned for a smaller list;
- makes the validator code lie about what it's enforcing (`if (parsed.artifact_paths.length > MAX_FINDINGS)` reads as a copy-paste bug to a reviewer);
- triggers the "magic stringly-typed schema field that would silently drift" failure mode the brief explicitly named for `council-types.ts`.

**Why P2:** this is the cross-process contract layer. A drift here is exactly the silent-desync the schema is meant to prevent. The contract is the docstring + the constant *intent*; right now they disagree.

**Principle:** Realtime P7 (Protocol drift — contracts that don't say what they enforce drift first).

**Fix shape:** introduce `MAX_ARTIFACT_PATHS` separately (likely smaller — a phase rarely produces 50 artifacts).

---

### P2-RT-4 — `isBoundedString` defines "valid" as "contains no spaces" and is applied to `emitted_at`, `reviewed_at`, `observer_provider`, `session_group_id`, `checkpoint_id`

**Where:** `council-types.ts:70–72`:
```
function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max && !v.includes(" ");
}
```
Used at lines 112, 115, 116, 147, 149, 150, 151, 158.

**Failure mode:** Two distinct problems:

1. **`emitted_at` / `reviewed_at` are ISO timestamps.** A valid ISO-8601 timestamp with timezone designator can be `"2026-05-11T10:00:00.000Z"` (no space — fine) but ISO-8601 also permits `"2026-05-11 10:00:00Z"` (space separator between date and time — formally legal per RFC 3339 §5.6). The validator silently rejects the latter. More urgently: **the validator doesn't actually validate that the string is a timestamp at all** — `"chk-abc-not-a-timestamp"` passes for `emitted_at`. The name `isBoundedString` is a lie about what it's enforcing on a timestamp field. Drift opportunity: a writer that switches to space-separator format kills the pair silently.
2. **`observer_provider` is a free-form provider name** (`"claude"`, `"codex"` per the tests). Forbidding spaces is fine here. But `checkpoint_id` and `session_group_id` are opaque identifiers — forbidding spaces is the only character constraint applied, with **no other character whitelist**. A `checkpoint_id` of `"chk-001;rm -rf /"` passes validation. The brief says the checkpoint_id is used by the observer for dedup; if it's *also* used in a filename or shell context downstream (the docstring at the top of the module says `.council/checkpoints/<phase>.json` uses `phase` in the path — `checkpoint_id` *isn't* in the path today but a future Task 13/15 likely puts it there), the constraint is too loose.

**Why P2:** the writer/reader contract here is the single source of truth between two LLM-driven processes. Validation that mis-describes itself (`isBoundedString` for timestamps) is the prototype of "magic stringly-typed that silently drifts."

**Principle:** Realtime P7 (the contract must say what it enforces — drift starts where naming and semantics diverge).

---

### P2-RT-5 — Schema version is a fixed literal `1` with no migration affordance, no `min`/`max` window, no test for forward-compat tolerance

**Where:** `council-types.ts:11` (`COUNCIL_SCHEMA_VERSION = 1 as const`); `:111,146` (`if (parsed.schema_version !== COUNCIL_SCHEMA_VERSION) return null;`).

**Failure mode:** The test at `council-types.test.ts:46–49` correctly asserts that `schema_version: 999` rejects. That's drift-defence in the forward direction (newer writer, older reader rejects). But there's **no inverse test** (older writer, newer reader — does the reader accept 1 when it's on schema 2? Currently: no, it would reject). And there's **no test for `schema_version: 0`** or non-integer schema versions or string schema versions.

The brief explicitly named: "versioned, optional fields handled with explicit defaults, no schema field that's magic stringly-typed that would silently drift." The current shape is: schema version is enforced but not *managed*. When schema 2 ships, every observer review written under schema 1 becomes unparseable. No `acceptedVersions: ReadonlyArray<number>` set, no `migrateFromV1(v1payload)` hook, no test for the migration story.

For a *brand-new* schema this is acceptable today — but the brief calls out "no schema field that's magic stringly-typed that would silently drift", and the current `as const`-typed literal is the moral equivalent: it's not stringly-typed, it's *literally-typed*, which has the same effect of making evolution a breaking change with no escape hatch.

**Why P2:** the brief explicitly named versioning as part of the contract review. The decision to do strict-equality versioning is fine for v1 but should be a *documented* decision, not an emergent one.

**Principle:** Realtime P7 (versioning IS the drift-defence; emergent equality is brittle).

---

### P2-RT-6 — Parser commits to a routing assumption: `params` will be passed forward as `Record<string, unknown>` not preserved as wire-shape

**Where:** `codex-envelope.ts:18–22` — the discriminated `CodexFrame` types `params: Record<string, unknown>` and `result: unknown` and `error.data: unknown`.

**Failure mode:** The brief asked: "flag if you see assumptions baked into the envelope module that pre-commit a particular routing approach that would constrain Task 12."

The parser pre-commits two things that constrain ws-bridge integration:

1. `params` typed as `Record<string, unknown>` (not the raw parsed object) means the router cannot tell, downstream, whether a frame's `params` originally arrived as `{}` (empty object) vs whether the parser had to coerce it. Today that's not a distinction — the parser rejects non-object `params` — but if P2-RT-1 is accepted (relax to array params), the router needs to know which shape it got. A `kind: "request" | "request-positional"` distinction at parse time is cheaper than re-typing downstream.
2. The frame discriminant uses `kind: "request" | "notification" | "result" | "error"` — there is **no `kind: "raw" | "unknown"` reject-branch**. The parser is binary: parse-and-type, or `null`. That commits Task 12 to a routing approach where unknown frames are dropped at the parser boundary with no telemetry surface. If the bridge wants to record unknown frames (per the recordings story — raw is preserved separately, so this is partially mitigated) AND surface them as "unknown protocol activity" to the orchestrator UI for drift detection, it needs the parser to return a typed `{ kind: "unknown", raw }` for shapes-that-parse-as-JSON-objects-but-don't-match-known-frames.

The current commit-to-null-on-unknown approach is correct as a *security* decision (Hunt's reject-on-unknown principle, which the brief said to defer to). It is **incomplete** as a *protocol-drift-defence* decision: drift defence wants visibility of unknown-frame counts, not silent drops.

**Why P2:** pre-commits Task 12 to "drop and forget." The brief asked for this exact lookout.

**Principle:** Realtime P7 (drift defence requires visibility, not just rejection).

---

## P3 findings

### P3-RT-1 — Method-name validator rejects 0x00–0x1F but accepts 0x7F (DEL) and the C1 control range (0x80–0x9F)

**Where:** `codex-envelope.ts:36–39` — the loop checks `< 0x20` only.

**Failure mode:** Hunt-aligned defence-in-depth on method names. The C0 control range is the dangerous one for terminal output, but 0x7F (DEL) and the C1 controls have been used in past escape-sequence attacks against logging surfaces. Method names per JSON-RPC are advisory — Codex's own surface is `tool.call`, `thread.message`, etc. — printable ASCII would be the honest contract.

**Why P3:** unlikely to be exercised in practice; method names come from Codex internals, not from LLM output. Flagging as a future-proofing nudge, not a fix-now.

**Principle:** Realtime P7 (the validator should say what it enforces; "no C0 controls" is narrower than the comment claims, which says "control characters").

---

### P3-RT-2 — Error code is `typeof === "number"` + `Number.isInteger` but not range-checked against JSON-RPC reserved windows

**Where:** `codex-envelope.ts:94`.

**Failure mode:** JSON-RPC 2.0 reserves `-32768..-32000` for server errors and defines specific codes (`-32700` parse error, `-32600` invalid request, etc.). The parser accepts any integer including positive ones (which JSON-RPC reserves for "application-defined errors" — fine) and `Number.MAX_SAFE_INTEGER` (less fine — useless but accepted). A range check `[-32768, 32767]` or even just `[Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]` would tighten the contract without ruling out legitimate values.

**Why P3:** the bridge surfaces the code in UI verbatim; an out-of-band code doesn't break anything, it just produces a strange-looking error string.

**Principle:** Realtime P8 (error envelope fidelity has a useful-range component).

---

### P3-RT-3 — `parseObserverReviewPayload` does not enforce that `checkpoint_id` echoes a known checkpoint — but the docstring claims it must

**Where:** `council-types.ts:53` — the docstring says *"Mirrors the checkpoint this review answers — observer must echo it."* The validator at `:147` only checks it's a bounded string.

**Failure mode:** The validator can't check echo-correctness because it has no access to the issued checkpoints — that's a router-layer concern. Fine. But the docstring asserts a contract the validator does not enforce, which makes this a *protocol drift opportunity*: a future maintainer reading the code may assume the validator handles the echo check (it doesn't) or may add a *partial* check (only validates format) that gives false safety.

**Why P3:** documentation/code mismatch on a contract field. The fix is either to enforce at a higher layer with a clear "echo validation happens in `<file>`" pointer in this docstring, or to weaken the docstring to "should echo, but echo validity is a router-layer concern."

**Principle:** Realtime P7 (contracts must say what they enforce, not what someone else enforces).

---

## Summary

10 findings: 2 × P1, 6 × P2, 3 × P3 — wait, recount: 2 P1, 6 P2, 3 P3 = 11. Let me recount the P2 block: RT-1, RT-2, RT-3, RT-4, RT-5, RT-6 = 6. P3: RT-1, RT-2, RT-3 = 3. P1: RT-1, RT-2 = 2. Total: **11 findings**.

**Strongest signal:** P1-RT-1 (numeric-only `id`). The brief explicitly asked about JSON-RPC `id` namespacing across the Codex and Claude paths; the current parser answers that question by rejecting half the JSON-RPC 2.0 spec. Combined with P1-RT-2 (no replay test), this means the parser is shipping with confidence calibrated to hand-authored shapes, not to observed Codex traffic.

**Strongest contract-drift signal:** P2-RT-3 (`MAX_FINDINGS` mis-applied to `artifact_paths`). This is the prototype of the "magic stringly-typed field that silently drifts" the brief named.

**Routing pre-commit flag (for Task 12):** P2-RT-6 — the parser is binary parse-or-null. Task 12 will need either a separate "unknown frame observed" telemetry path or a `kind: "unknown"` variant added here. Worth flagging now so Task 12 doesn't grow ad-hoc detection elsewhere.

**Shared principle with Hunt** (per brief's "agree on principle name"): the reject-on-unknown stance for **method names and frame shapes** is correct and load-bearing for security. The realtime extension is: reject-on-unknown must be paired with **visibility-on-unknown** (telemetry/counter) and must not extend to *polymorphic-by-spec* fields (`id`, `params`-as-array, optional `params`).
