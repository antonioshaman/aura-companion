# Realtime / NDJSON Protocol Expert — review (2nd pass, post-burndown)

Scope per context brief: parser boundary in `web/server/anthropic-models-cache.ts`
is structurally unchanged. New `resolveCoalescedSignal` helper is an HTTP-level
abort-hygiene refactor (lines 580–605), not a WS protocol surface. The hostile
fixture (`web/server/fixtures/anthropic-models-response-hostile.json`) exercises
the parser reject branches the original P3 #15 flagged. NDJSON / JSON-RPC bridge
(`ws-bridge.ts`, `cli-launcher.ts`, `codex-envelope.ts`) untouched and excluded
from this pass per the context brief.

---

## Verification of first review's findings

### P2-1 — synthetic fixture (External Setup #1 fidelity gap)

**Status: STILL OPEN. Acceptable as documented dual-fixture shape; structural
gap NOT closed.** The burndown added `anthropic-models-response-hostile.json`
sibling fixture exercising 5 reject branches (bidi 0x202c/0x202e, C0 tab,
C1 0x85, id length>128, display_name length>256 — verified by codepoint
analysis). It did NOT replace the happy-path fixture with a real-capture, nor
add the `created_at` shape-tolerance probe (no `.000Z`-millisecond-precision
entry, no epoch-number entry). `fixtures/README.md` documents both fixtures
and the entry-index→reason map, but the "Hand-crafted JSON literals do not
substitute per convention floor" precondition from PLAN External Setup #1 is
not satisfied by adding more hand-crafted JSON.

The dual-fixture shape IS a strict improvement — the reject branches now have
on-wire replay coverage that the original review wanted. But EC-6 value
("replay survives wire drift the planner can't anticipate") still rests on
the happy-path file, and the happy-path file is still a planner-authored
literal. The original finding stands at P3 strength: acceptable to ship,
worth a follow-up issue tying any future parser change to a real-capture
refresh.

### P2-2 — `created_at` ISO strictness

**Status: DEFERRED per documented decision. Acceptable — explicit, attributed,
revisitable.** Code at line 365–375 still does `typeof === "string"` +
`Date.parse` + `Number.isFinite`. The test file documents this as an
intentional decision point. The ambiguity I flagged (intent #1 strict ISO vs
intent #2 polymorphic-by-spec) is resolved by the deferred-decision marker —
the contract today is "permissive `Date.parse` over string input only;
epoch-number rejected; not-a-date rejected". That's intent #1 in shape with
intent #2 in spirit. Acceptable as the documented state.

One residual nit (NOT a new finding): the test that drops "not-a-date"
(`anthropic-models-cache.test.ts:178`) doesn't cover the **`"January 15"`
locale-string** case I called out — `Date.parse("January 15")` returns a
finite epoch ms (year defaults to current host year). That's the actual
clock-injection vector the original finding named. If a future tightening
adds an ISO 8601 regex, this is the test case to add. Not blocking; covered
by the deferred-decision flag.

### P2-3 — `dropped_items` counter conflates 3 buckets

**Status: STILL OPEN. Single counter retained.** Line 321 (`let droppedItems
= 0`) is the only counter. Increments at lines 325 (envelope shape), 338
(`type !== "model"` forward-compat skip), 343 (`id` regex/length reject),
347 (`id` non-claude-prefix reject), 356 (`display_name` bad-shape), 366/371
(`created_at` bad-shape). All three semantic buckets I flagged still collapse
into one count. The burndown's hostile fixture VERIFIES the drops happen
(`expect(parsed.droppedItems).toBeGreaterThanOrEqual(5)` at line 1049) but
does NOT split the counter — assertion is a lower bound on the aggregate,
not a per-bucket count.

Recommendation unchanged: split into `dropped_unknown_type`, `dropped_bad_id`,
`dropped_bad_field` so an operator forensic-triaging `dropped_items=2` in
production can distinguish "Anthropic shipped `model_snapshot v2`" from
"Anthropic broke our parser." Still P2-grade impact, still a ~6 LOC fix.

### P3-1 — `has_more=true` pagination

**Status: PARTIALLY ADDRESSED. Log canary present; module-header negative-space
section + sticky-preference cross-reference NOT added.** The pagination-needed
WARN is wired (line 1229) and a behavioural test pins it
(test:785 `"emits anthropic-models.pagination-needed when has_more is true"`).
The module-header "THIS MODULE DELIBERATELY DOES NOT" section (lines 28–42)
does NOT include the "serves first page on `has_more=true`" decision — I
recommended pinning it there. Sticky-preference downgrade comment near the
warn site also absent.

These are documentation-grade omissions, not protocol issues. The protocol
behaviour is correct (serve-first-page + warn); my P3 was about pinning the
decision in the comment graph. NOT escalated.

### P3-2 — `isBoundedSafeString` missing U+2028/2029/061C

**Status: STILL OPEN. Bounds unchanged.** Lines 285–293 still loop `i = 0` to
`s.length` checking codepoints `< 0x20`, `=== 0x7f`, `0x80–0x9f`, `0x202a–0x202e`,
`0x2066–0x2069`. U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR), and
U+061C (ARABIC LETTER MARK) all PASS the gate today. Verified — the hostile
fixture does NOT exercise these three codepoints either (bidi entry uses
0x202c/0x202e only; no LS/PS/ALM entries). The gap I flagged remains and is
not even regression-tested.

As before, NOT a P2 because the upstream-trust boundary (operator-owned key →
Anthropic-controlled response) plus the `CLAUDE_MODEL_ID_RE` regex on `id`
(which IS the argv-injection-relevant defence) carry the load. `display_name`
is React-escaped at render. But if `isBoundedSafeString` is the documented
Trojan-Source defence hook (it is — line 277 says so), the blocklist is still
incomplete. Three array entries fix it. Add hostile-fixture entries for each.

### P3-3 — `source: "network"` provenance vs caller-triggered-IO labelling

**Status: STILL OPEN. No comment added.** The discriminated union at line 204
still types `source: "memory" | "disk" | "network"` with zero JSDoc
clarifying that `"network"` describes the data's provenance and NOT whether
this particular caller triggered the underlying HTTP request. Inflight
piggyback semantics (line 1265+ writes `source: "network"` for ALL receivers
of the same promise) is unchanged. Future dashboard slicing "network requests
per hour" by counting `source === "network"` results will still over-count
by N-concurrent on inflight collisions.

Not a protocol issue per se; documentation grade. Original P3.

---

## New findings introduced by the burndown — none at protocol level

The two changes in this pass that touch the realtime/HTTP boundary surface:

### Helper extraction (`resolveCoalescedSignal`, lines 580–605)

Reviewed under EC-5 + Backend P5 lens (HTTP-level abort hygiene, not WS).
The factoring:

1. **Correctness on the happy path** — `AbortSignal.any === "function"` → call
   with `[timeoutSignal, parentSignal]` exactly as the prior inline did.
   No semantic change.
2. **Correctness on the degraded path** — falls through to `parentSignal`
   alone (NOT `timeoutSignal`, NOT `undefined`). This is the
   "fail-towards-parent" choice — caller-abort still works, timeout is
   sacrificed. Matches the first review's recommendation #2 ("log
   `signal-coalesce-degraded` warn on the first occurrence and fall through")
   and explicitly fixes the prior silent demote.
3. **Module-scope flag (`signalCoalesceDegradeLogged`)** — once-per-process,
   reset helper exported. Acceptable. Realtime/protocol concern would be
   if the flag state leaked across browsers/sessions in a way that gated
   protocol behaviour; it does not — only logging is gated.
4. **No change to parent-signal propagation contract.** The caller-supplied
   `deps.parentSignal` path is preserved; the unsupplied path bypasses the
   helper entirely (line 665: `deps?.parentSignal ? ... : timeoutController.signal`)
   so the dormant branch costs nothing on production Bun/Node where
   `AbortSignal.any` is present.

No realtime protocol findings introduced. The factoring is structurally
neutral on the HTTP boundary.

One micro-observation (NOT a finding, not blocking): the helper's degraded
return drops the **timeout** entirely. Consequence under runtime regression:
if `AbortSignal.any` ever truly disappears at runtime AND a caller-supplied
parent-signal is present, the 5s timeout that protects the Hono worker from
TLS-hang becomes infinite for those requests. The fetch will still abort via
caller-cancel, but a caller that never cancels (e.g., a scheduled refresh
without an `AbortController`) inherits the un-bounded hang. The choice is
defensible ("parent-abort matters more than timeout because timeout is the
common case and parent-abort is the rare-but-correctness-load-bearing case"),
but the cost is named for the record. The structured WARN at line 599
adequately surfaces the state to operators.

### Hostile fixture content

Reviewed for any new realtime/NDJSON concerns introduced by the fixture
bytes themselves:

1. **Fixture is JSON-parseable.** `JSON.parse(readFileSync(...))` in the
   test succeeds. The bidi PoC entry uses 0x202e/0x202c codepoints
   embedded as JSON string bytes — these are valid JSON per RFC 8259
   (which only forbids unescaped control characters U+0000 through
   U+001F). U+2028/2029 inside JSON strings would also be parseable by
   `JSON.parse` but get rejected by some JSONP-XSS contexts — NOT relevant
   to this codepath (we're not embedding response bytes into a JS literal).
2. **Fixture is on-disk** under `web/server/fixtures/`. Loaded via
   `readFileSync` + `JSON.parse` at test time, NOT via any of the
   production NDJSON line-splitting code. No NDJSON-line-discipline
   concerns introduced.
3. **The C0-tab fixture entry's `\t` codepoints** would be a serious
   NDJSON concern if they were embedded in the WS bridge stream — tabs
   inside an NDJSON JSON object aren't a problem, but raw tabs inside a
   non-JSON-encoded line frame would be. Production path: parser
   receives a `JSON.parse`d object, never touches raw line frames at this
   layer. Not a finding; positively validates the C0-reject is correctly
   in the right defence layer.

No new realtime/protocol findings from the fixture.

---

## Out-of-scope explicit non-findings

Per context brief: NDJSON/JSON-RPC adapters, ws-bridge, council mode,
recordings, subprocess spawn argv, ws auth — explicitly untouched, NOT
re-reviewed.

The `signalCoalesceDegradeLogged` flag is process-lifetime; in a multi-test
file the reset helper at line 612–614 is the test contract. Not a runtime
correctness concern.

---

## Verdict

**First review's findings verified: P2-1 still open (acceptable as dual
fixture shape; structural gap deferred); P2-2 deferred per documented
decision (acceptable); P2-3 still open (single counter retained); P3-1
partially addressed (canary + test wired, doc nits remain); P3-2 still
open (U+2028/2029/061C still pass the gate); P3-3 still open (no doc
added).** No new realtime/protocol issues introduced by the helper
extraction or the hostile fixture.
