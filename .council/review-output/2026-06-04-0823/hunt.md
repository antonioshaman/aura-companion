# Hunt — Security Review (PR #91, dynamic Claude model list)

## Scope
- `web/server/anthropic-models-cache.ts` (full file)
- `web/server/routes.ts` Claude branch at ~1564-1605 + surrounding context

PLAN-aura-dynamic-model-list.md "Risks & Watchpoints" items (Subprocess R1, Willison
LLM lane, Fowler R1 stretch, Hunt R3 pre-auth oracle, Hunt R5 recording exclusion,
Frontend R1 sticky, EC-22 emit coverage, EC-10 future-proofing, a11y R4 aria-live
regression, Deploy R2 cache location) are NOT re-flagged here.

---

FINDING:
- Title: Key-suffix leak canary silently no-ops for short keys
- File: web/server/anthropic-models-cache.ts:939-946
- Principle: Principle 3 — Minimise state / never log secrets (also Carmack-Hunt
  Overriding Filter #4)
- Severity: P3
- What's wrong: `writeDiskCache` only checks `serialised.includes(suffix)` when
  `apiKey.length >= 8`. Real Anthropic keys are ~108 chars so this branch always
  fires in production today, but the guard is structurally "fail-open" for any
  caller that supplies a short input — including a future test or refactor that
  passes a synthetic placeholder like `"x"` or an empty-after-trim value. The
  Carmack idiom is "make the wrong thing impossible," and a guard that silently
  disables itself based on its own input length is the opposite of that.
- Consequence: If a future refactor accidentally adds an alternative short-key
  code path (managed-tenant test token, mocked CLI envelope), the leakage
  assertion does NOT fire and a malformed `CachedModelsRecord` containing the
  full short key could land on disk under `~/.companion/anthropic_models_cache.json`
  with mode 0o600 — readable by the local user processes the recorder is meant
  to fence off.
- Fix: Make the canary unconditional: when `apiKey.length` is below the suffix
  window, either compare against the full key OR throw a "key too short to
  fingerprint" precondition error. The Persistence R3 comment in the code says
  "throws on assertion failure so a future refactor that accidentally adds the
  key to the record goes red" — the length-gated escape hatch contradicts that
  documented intent. Keep the principle: the assertion must be path-invariant.

---

FINDING:
- Title: Test-only disk-cache delete helper is publicly exported with no callsite
  guard
- File: web/server/anthropic-models-cache.ts:984-998
- Principle: Principle 5 — Shrink the attack surface (unused mutation primitive
  in a public module export)
- Severity: P3
- What's wrong: `__deleteDiskCacheForTests` is exported and uses
  `require("node:fs")` to `unlinkSync` the cache file at the constant path. The
  `__` prefix is a naming convention, not enforcement — any future import from
  a non-test file (handler, REST route, slash-command, plugin loader) compiles
  green. The same surface for `__resetMemoryCacheForTests` is in-process state
  and recoverable; the disk-delete is a write op on a file under `COMPANION_HOME`.
- Consequence: A future REST handler that accidentally wires this in (e.g. a
  "clear model cache" admin endpoint that reuses the helper instead of a fresh
  authenticated mutation) would let any authenticated browser delete the cache
  file. Aura's auth middleware blocks the public network case, but localhost
  bypass + iframes + the cookie-based auth-fallback widen the practical reach.
  The risk is not theoretical: `__deleteDiskCacheForTests` is the only mutation
  primitive in this module that is NOT routed through `writeAtomicJson` and NOT
  preceded by `assertCachePathInBounds()`.
- Fix: Either move the helper into a sibling test-only file
  (`anthropic-models-cache.test-helpers.ts`) that production tsconfig excludes,
  OR inline its 4-line body into each test that needs it (per
  `feedback_skill_fork_dont_replace` and Persistence R6 escape-hatch hygiene).
  At minimum, route the unlink through `assertCachePathInBounds()` so a future
  caller that drifts the constant cannot escape the workspace bound.

---

FINDING:
- Title: `assertCachePathInBounds` is write-path only — disk read trusts the
  raw constant without realpath bounds check
- File: web/server/anthropic-models-cache.ts:874-916 (read path),
  840-861 (bounds helper, write path only)
- Principle: Principle 7 — Assertions as tripwires (EC-7/EC-36 inline realpath
  on every filesystem-access predicate)
- Severity: P3
- What's wrong: `readDiskCache` opens `ANTHROPIC_MODELS_CACHE_PATH` directly via
  `readFileSync` with no bounds assertion. The PLAN justifies the write-side
  wrapper as "defending against future refactors that might make the path
  dynamic"; that same defence is absent on the read side. The EC-7 idiom is
  symmetric — predicates resolving filesystem-derived paths must bounds-check
  on both directions, otherwise the "future-refactor" line of defence reads
  asymmetric to a maintainer who only inspects one half.
- Consequence: Today the path is a module constant joined from
  `COMPANION_HOME`, so there is no traversal vector. The day a maintainer adds
  an env override for the basename (multi-tenant subdirectory, per-key shard)
  or a `?key=...` query for cache inspection, the write path stays bounded but
  the read path silently follows the new dynamic value off-volume. Asymmetric
  defences are exactly the "trust the diff, not the prose" failure mode this
  feedback codebase has memorialised.
- Fix: Call `assertCachePathInBounds()` at the top of `readDiskCache` as well.
  It's already idempotent on the ENOENT branch (first-run safe), and the cost
  is one realpath syscall per cache read — negligible against the 60-minute
  memory TTL hit ratio. Per EC-7, the predicate is the wrapper; the wrapper
  must be the only filesystem entry point.

---

## Summary

No P1 or P2 security findings.

The code shows exceptionally careful security discipline:
- API key flows only through the `x-api-key` request header, never the URL,
  never logs, never throws (Hunt R3 + R5 verified)
- 502 envelope is a fixed enum string (`upstream_unauthorized` /
  `upstream_unavailable`) — no upstream prose, no upstream status text, no URL
  bytes leak to the browser (Hunt R2 verified)
- `ANTHROPIC_MODELS_URL` is a module-scope constant — SSRF defence by
  construction; the route's `:id` param cannot reach the upstream URL
- `computeKeyFingerprint` truncates SHA-256 to 16 hex chars (8 bytes entropy)
  — sufficient to disambiguate key rotation, low enough that the truncated
  hash is not directly invertible
- Defensive `serialised.includes(suffix)` canary on `writeDiskCache` — refuses
  to persist if the JSON body accidentally contains the API key's tail bytes
- TLS verification: Bun's default `fetch` enforces certificate validation;
  no `rejectUnauthorized: false` or equivalent escape hatch
- `AbortController` 5s timeout + `clearTimeout` in `finally` + body-drain on
  every branch — no resource-pin DoS via hung TLS handshake
- Single-flight `inflightFetches` lock keyed by fingerprint — collapses N
  concurrent cold-cache requests to one upstream fetch (Hunt R4 verified)
- EC-17 fail-CLOSED: empty key → 404, not 200-with-empty-list (Backend R5
  verified)
- EC-23 sentinel `<companion-cache:anthropic-models>` for path in logs —
  raw filesystem bytes never appear in structured log output
- Auth middleware at `routes.ts:158` applies to `/api/*` before the Claude
  branch handler — the cache lookup is correctly gated behind bearer/cookie
  verification (Hunt R3 pre-auth oracle invariant preserved)
- Recorder is wired to CLI subprocess and browser WebSocket channels only —
  the Bun native `fetch` to `api.anthropic.com` is not teed into JSONL
  recordings, so `COMPANION_RECORD=1` cannot leak the API key (Hunt R5
  invariant preserved structurally)

The three P3 findings above are hygiene tightenings against future refactors,
not exploitable bugs in the shipping code.
