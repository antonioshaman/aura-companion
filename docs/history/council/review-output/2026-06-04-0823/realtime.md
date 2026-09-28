# Realtime / NDJSON Protocol Expert — review

PR adds **no WS protocol changes**. In-scope concern: EC-5 (reject unknown
shapes, tolerate polymorphic-by-spec fields) and EC-6 (replay-tested) discipline
applied to the Anthropic `/v1/models` HTTPS body parser at
`web/server/anthropic-models-cache.ts`. Reviewed against
`PLAN-aura-dynamic-model-list.md` "Risks & Watchpoints" — items already parked
there are not re-flagged.

The NDJSON / JSON-RPC bridge (`ws-bridge.ts`, `cli-launcher.ts`,
`codex-envelope.ts`, session orchestrator) is explicitly out of scope per the
context brief and was not touched.

---

## P1 — none

The parser boundary discipline is solid. EC-5 strict-on-discriminator
(`type === "model"`) plus per-item-drop is correctly applied; EC-6 fixture
replay exists; trojan-source defence on `display_name` is present and matches
the Hunt R6 spec; version-aware-numeric tiebreaker on Risk #6 (`4-10 > 4-7`) is
implemented as documented; pagination canary fires and the server still serves
the first page (graceful-degrade). No protocol-correctness P1 found.

## P2

### P2-1 — Fixture is synthetic; EC-6 replay claim is structurally weaker than the convention floor expects

`web/server/fixtures/anthropic-models-response.json` is a **hand-crafted JSON
literal** with a synthesised `claude-opus-4-8-20260415` id and ISO timestamps
authored by the planner, not bytes captured from a real `api.anthropic.com`
response. The plan's External Setup row #1 explicitly required *"Capture a real
Anthropic `/v1/models` response with the developer's own API key (NOT
committed) → snapshot a redacted version to
`web/server/fixtures/anthropic-models-response.json`"* with the rider *"Hand-
crafted JSON literals do not substitute per convention floor."* That precondition
was not satisfied during implementation; the fixture lacks fields a real
response carries that EC-6 would catch under wire drift:

- `id`-format whitespace / case quirks Anthropic may produce
- Currently-unspec'd-but-spec-tolerated fields (Anthropic has added
  `input_token_limit`, `output_token_limit` to other endpoints over time)
- The actual byte-shape of `created_at` (is it `2025-10-01T00:00:00Z` vs
  `2025-10-01T00:00:00.000Z` vs an epoch number — see P2-2)
- Pagination cursor envelope shape (`first_id` / `last_id`) if `has_more` is
  ever true

`fixtures/README.md` documents that this is a placeholder and instructs
refreshing from a real capture — but the documented intent is not the shipped
state. EC-6's value comes from **the replay surviving wire drift that synthetic
fixtures can't anticipate**; today, parser changes that pass the synthetic
fixture might still break on the real wire.

Recommendation: keep the file shape, but add a follow-up issue tying the next
PR that touches the parser to a real-capture refresh, AND in the immediate term
extend the fixture with one entry that uses a `created_at` shape the planner
guessed (millisecond-precision suffix `.000Z`) — if it parses today, document
that Anthropic's shape variants are tolerated; if it doesn't, that's a
real-fidelity gap. Pairs with `feedback_protocol_handshake_vs_transport_state`:
synthetic fixtures pass shape, real wire tests handshake.

### P2-2 — `created_at` parser accepts epoch-number too liberally? Or too strictly?

`parseAnthropicModelsResponse` requires `typeof item.created_at === "string"`
and runs `Date.parse`. Anthropic's other public endpoints emit `created_at`
as **either** an ISO 8601 string OR a Unix epoch integer depending on the
endpoint (compare `/v1/messages` batch responses which emit epoch-number for
`created_at`). Per EC-5 "tolerate polymorphic-by-spec fields," a numeric
`created_at` from a future `/v1/models` envelope drop would land each row in
the dropped bucket — silent secondary-sort degradation (the version-numeric
fallback would still produce sane ordering, but the canary
`anthropic-models.upstream.success.dropped_items` would spike with no signal
to operator that a wire-format toggle, not vendor garbage, was the cause).

Two acceptable resolutions, pick one and document the intent:

1. Tighten the contract — claim "the parser hard-rejects anything not ISO 8601
   string, because `/v1/models` specifically only ever returns that shape" and
   add an inline comment citing the Anthropic docs revision. Drop is then
   semantically *"vendor introduced a breaking shape change"*, not "we are
   under-permissive."
2. Loosen to polymorphic-by-spec — accept both `string` (parse via
   `Date.parse`) and finite-non-negative `number` (treat as epoch seconds if
   `< 1e11`, epoch ms otherwise — matches the heuristic Anthropic's own SDKs
   use). Drop only when both branches fail.

The current code reads like #2 was intended (the optional-with-fallback shape
suggests tolerance) but lands on #1 strictness. Either is fine; ambiguity is
the finding.

### P2-3 — `model_snapshot` and future-type forward-compat: silent drop conflates two cases

The fixture's `model_snapshot` entry is correctly skipped via the
`item.type !== "model"` guard, and the comment on line 337
("EC-5 strict on discriminator") frames this as the intended forward-compat
behaviour. Good. But the **dropped_items** counter conflates three
semantically distinct buckets into one number:

1. `type !== "model"` (forward-compat skip — Anthropic added a new resource
   kind, working as designed)
2. `id` regex reject (legitimate vendor garbage / non-claude provider entries
   like the fixture's `gpt-4o`)
3. Bad shape of `display_name` / `created_at` on an otherwise-valid `model`
   entry (parser-coverage gap, the real EC-5 signal)

Today only case (3) should ever spike unexpectedly — it's the only one that
indicates a wire-shape drift the parser doesn't handle. Case (1) is expected
churn; case (2) is constant (the gpt-4o type fixture row is a single drop).
Bucketing them under one counter means an operator seeing `dropped_items=2`
in production can't distinguish "Anthropic shipped model_snapshot v2" from
"Anthropic broke our parser." 

Recommendation: split into `dropped_unknown_type`, `dropped_bad_id`,
`dropped_bad_field` in the parse result and surface all three in the
`anthropic-models.upstream.success` log payload. Cost: ~6 lines of code, one
test. Value: the canary becomes diagnostic instead of just a flag.

## P3

### P3-1 — `has_more=true` + serve-partial is the right call for v1, but document why "log warn + serve partial" rather than "treat as parse error"

Per `getAnthropicModels` lines 1166-1174, `parsed.hasMore === true` fires an
`anthropic-models.pagination-needed` WARN log and the server still serves
the first page. This is defensible — the alternative (treat as
`upstream-unavailable` so the user sees no models) is strictly worse for
availability when the first page already contains the tier-leaders the UI
needs (opus / sonnet / haiku flagship). But:

- The behaviour is not documented in the module-header comment under "THIS
  MODULE DELIBERATELY DOES NOT" — it's a deliberate decision worth pinning.
- If the user has a sticky preference (`settings.anthropicModel`) that's on
  page 2, the sticky-preference plumbing (PLAN watchpoint #6 / Frontend R1)
  will silently fall through to `dynamic[0]` and the user gets a different
  model than they configured without a UI signal explaining why. Not a P2
  because Anthropic does not paginate `/v1/models` today (4-5 models total),
  but worth a code comment near the pagination-needed log: *"if this ever
  fires, sticky preference may silently downgrade — see PLAN R1"*.

### P3-2 — `isBoundedSafeString` bidi range omits two newer Unicode controls

The bidi-control blocklist covers U+202A-202E and U+2066-2069 — the original
CVE-2021-42574 surface. Unicode added two more bidi-adjacent controls in
later revisions that adversarial rendering exploits have used:

- **U+2028 LINE SEPARATOR** and **U+2029 PARAGRAPH SEPARATOR** — these
  bypass JSON string parsers that treat them as literal terminators (the
  classic JSONP-XSS via U+2028 vector). They're not bidi but they're in the
  same "renders-invisible-text-or-breaks-tokens" family that
  `isBoundedSafeString` claims to defend against.
- **U+061C ARABIC LETTER MARK** — a directional formatting code introduced
  post-CVE that some Trojan-Source PoCs have used to evade the original
  detection lists.

Neither is a P2 because the upstream-trust boundary (Anthropic-owned key →
their `/v1/models` endpoint) is operator-controlled, and the
`CLAUDE_MODEL_ID_RE` `^claude-[a-z0-9.\-]+$` regex on `id` is the actual
load-bearing defence (id flows into argv). `display_name` is React-escaped
at render time per Hunt R6. But if `isBoundedSafeString` is the documented
"Trojan-Source defence" hook, completing the blocklist costs three array
entries.

### P3-3 — Single-flight lock has a subtle inversion: memory-cache check happens **before** the inflight check, but the inflight promise's own resolution also writes to memory cache

Lines 1052-1074: memory hit returns immediately. Inflight piggyback comes
next. In the happy path this is correct. But consider:

1. Request A: cold cache, allocates inflight, starts fetch.
2. Request B (concurrent, same fingerprint): sees no memory hit, sees A's
   inflight promise, awaits it.
3. Request A's promise resolves → writes to memory cache → deletes inflight
   entry → returns the result.
4. Request C arrives during step 3's microtask window: memory cache now has
   the entry, returns immediately. Good.
5. Request D arrives between B awaiting and A resolving: gets the promise
   handle, awaits, fine.

The race window is benign because both branches converge on the same result
object. But the **logging** diverges: A logs `cache.miss` + `upstream.success`,
B/D log nothing (they're awaiting the promise, not re-entering `getAnthropicModels`),
C logs `cache.hit.memory`. Operator metrics that count "cold-cache fetches per
hour" by counting `upstream.success` will correctly show 1 (good), but a
metric that counts "client requests served from network" by summing
`source: "network"` results across all returns will overcount as
N-concurrent-requests instead of 1 (the result object carries
`source: "network"` for all N receivers of the piggy-backed promise).

Not a bug — the discriminated-union's `source` field is honest about
*where the data came from* not *which request happened to fetch it*. But if
a future dashboard slices "network requests per hour" off `source` field
emissions, the inflation surprises. Worth a one-line comment on
`AnthropicModelsResult.source` documenting *"source describes the data's
provenance, not whether this particular caller triggered the network IO."*

---

## Convention floor compliance (positive notes — not findings)

- **EC-5 (reject unknown shapes; tolerate polymorphic-by-spec):** Envelope check
  rejects non-object / array root; `data` required as array; per-item `type`
  strictly discriminated; `display_name` / `created_at` correctly modelled as
  optional. Within the qualifications under P2-1/P2-2/P2-3, the floor is met.
- **EC-6 (replay-tested):** Test exists at `anthropic-models-cache.test.ts:301-311`
  and reads `fixtures/anthropic-models-response.json` from disk. Mechanism is
  in place; fidelity caveat at P2-1.
- **EC-7 / EC-36 (FS-access predicate inlines realpath):** `assertCachePathInBounds`
  realpaths `COMPANION_HOME` and bounds-checks the join. Out of scope for the
  realtime lane but noted.
- **EC-9 (structured logs):** Every branch in `getAnthropicModels` emits a
  named event with consistent fields. EC-21 single-source for triplets is
  followed (`cache_age_ms` derived from `record.fetched_at`, never re-sampled
  from `Date.now()` at log time).
- **EC-23 (path sentinel in logs):** `ANTHROPIC_MODELS_CACHE_LOG_LABEL`
  `<companion-cache:anthropic-models>` is used everywhere the path would
  otherwise appear.

---

## Out-of-scope explicit non-findings

Per context brief: no NDJSON line-splitting changes (no producer touched), no
dedup-window changes, no sequence/replay changes, no broadcast fan-out
changes, no keep_alive cadence changes, no control_request/control_response
discipline changes, no Codex-vs-Claude adapter changes, no backpressure
changes. The Codex models read path at `routes.ts:1531-1561` is preserved
unchanged per the Fowler-stretch parking decision in PLAN R3.

**No protocol drift on the WS surface.**
