# FS-JSON Persistence Review — PR #91 (Dynamic Claude Model List)

Reviewer: Filesystem JSON-Store Persistence Expert (per `references/quality-persistence.md`)
Scope: `web/server/anthropic-models-cache.ts`, `web/server/fixtures/anthropic-models-response.json`, `web/server/fixtures/README.md`
Baseline read: `PLAN-aura-dynamic-model-list.md` "Risks & Watchpoints" — items already addressed there are NOT re-flagged below.

Verdict at a glance: **Persistence floor is clean.** Atomic-write reuse, schema-version strict-equality, fingerprint-as-sentinel, EC-7 realpath bounds check, 0o600 inheritance, and forensic-trace preservation on parse failure all land correctly. The deliberate non-features (no debounce, no rotation, no orphan-sweep, no `fs.watch`) are appropriate for a bounded poll-on-request cache record and are documented in the module header. The findings below are residual durability + edge-case concerns NOT covered by the plan, ordered by severity.

---

## P1 — none

The high-blast-radius patterns (non-atomic write on durable record, missing newline on JSONL, rotation deleting open files, path traversal via slug, re-serialised raw bytes, cross-FS rename) do not apply or are correctly handled:

- `writeAtomicJson` is the single write site (tmp-in-same-dir + fsync(fd) + rename + fsync(parent)), file mode 0o600 enforced at `open(2)` time, payload bounded at 256KB at the wrapper. Same-fs by construction because tmp is `join(dirname(target), …)` and target is `COMPANION_HOME/anthropic_models_cache.json`.
- Not JSONL — single bounded JSON record. Rotation/orphan-sweep do not apply.
- No slug input — path is a module-scope constant `ANTHROPIC_MODELS_CACHE_PATH` derived from `COMPANION_HOME` (env-overridable but never request-derived). EC-7 realpath bounds check at `assertCachePathInBounds()` is defensive belt-and-braces.
- Fingerprint is `sha256(key).slice(0,16)` (8 bytes entropy) — one-way, not the raw key. Defensive `apiKey.slice(-8)` substring assertion in `writeDiskCache` blocks accidental key bleed into the serialised payload.

---

## P2 — Findings

### P2-1. Parent directory mode is not enforced — fingerprint leak via filename on multi-UID hosts

**File:** `web/server/anthropic-models-cache.ts:840-861` (`assertCachePathInBounds`) + `web/server/atomic-write.ts:24-25` (`mkdirSync(dir, { recursive: true })`)

**Concrete failure mode:** PLAN Task 4 explicitly required "File mode `0o600`, parent dir `0o700`." The file mode 0o600 IS inherited from `writeAtomicJson` (correct). The **parent dir mode is not set** — `atomic-write.ts:25` calls `mkdirSync(dir, { recursive: true })` with no `mode` argument, so the directory is created with `0o777 & ~umask`, typically `0o755` (world-readable on most Linux). On a shared host (council reviewers run on `/home/auracomp/` shared between operators; production VPS where `~/.companion/` is created by the systemd unit user but other UIDs can read the home dir), `ls -la ~/.companion/` reveals `anthropic_models_cache.json` exists. While the cache file itself is unreadable (0o600), the **filename + mtime** disclose that an Anthropic API key is configured on the host and approximately when the user last opened a session. The PLAN called for `0o700` precisely to close this side-channel; the implementation silently dropped it.

**Why this is P2 (not P1):** No raw secret bytes leak. The leak is "operator has a key, last seen at T" metadata. P2 in the FS-JSON severity ladder (silent schema drift / orphan-state-equivalent).

**Suggested fix shape:** Either set `mode: 0o700` on `mkdirSync` in `atomic-write.ts` (touches other callers — council artifacts, env profiles — which is actually correct since the same leak applies there), OR add a one-shot `mkdirSync(COMPANION_HOME, { recursive: true, mode: 0o700 })` + `chmodSync(COMPANION_HOME, 0o700)` at module load. The chmod path is necessary because `mkdir(mode)` is masked by umask but `chmod` is not.

---

### P2-2. Wall-clock TTL predicate fails-open under negative clock skew

**File:** `web/server/anthropic-models-cache.ts:746-764` (`isCacheRecordValid`), `762` (`if (now - r.fetched_at > ttlMs) return false`)

**Concrete failure mode:** `fetched_at` is captured via `Date.now()` at write time (`anthropic-models-cache.ts:1178`). `now` at read time is also `Date.now()`. If the host clock jumps **backward** (NTP correction after a drift event, manual `date -s`, VM resume from snapshot), `now - fetched_at` becomes **negative**. The predicate `(now - fetched_at) > ttlMs` evaluates to `false` for a negative LHS → cache is considered **fresh** until wall-clock catches back up. In the worst case (developer laptop sleeps for a week with NTP off, wakes up before NTP correction lands), a 25h-old cache passes the 24h staleness check because the read-time `now` reports a value EARLIER than `fetched_at`. The cache then survives all the way until wall-clock advances past `fetched_at + 24h` again.

The `quality-persistence.md` Principle 7 flagged this for replay ordering ("Clock not monotonic, ts: Date.now() is wall-clock, which can jump backward on NTP correction") — same root cause, different surface. P3 there because replay; P2 here because it gates correctness of the cache hit decision the operator's UI depends on.

**Why this is P2:** Realistic on developer laptops + cloud VMs that suspend/resume. Failure mode is "stale models served as fresh" — visible to user only when Anthropic ships a new model the operator can't see. Not corruption; not security; just a silent staleness window.

**Suggested fix shape:** Either clamp `now - fetched_at` at 0 (`Math.max(0, now - fetched_at) > ttlMs`) so negative skew is treated as zero-age (still bounded by ttlMs forward), OR detect `now < fetched_at - SKEW_TOLERANCE_MS` and treat as miss (force refetch on clock anomaly). Clamp-at-zero is simpler; tolerance approach is more conservative. Either way, document the choice in the predicate comment.

---

### P2-3. `readFileSync` of cache file has no upper-bound — adversarial file size can OOM the bun worker

**File:** `web/server/anthropic-models-cache.ts:881` (`raw = readFileSync(ANTHROPIC_MODELS_CACHE_PATH, "utf8")`)

**Concrete failure mode:** The **writer** is bounded (256KB via `COUNCIL_ARTIFACT_MAX_BYTES` at `writeAtomicJson`). The **reader** is not. If anything else writes to that path — a misbehaving sibling process, a user pasting a multi-GB file as `~/.companion/anthropic_models_cache.json` to "see what happens", or a future refactor that adds non-atomic-write logic that doesn't enforce the cap — the reader pulls the entire file into a UTF-8 string in one shot, blocking the bun event loop AND consuming address space at peak ~2× (UTF-16 string materialisation). Bun has no per-handler memory cap; an OOM-killed bun parent takes down ALL active Companion sessions across the host.

Hostile threat model is weak (local-dev tool, the only entity supposed to write that path is this same module). But "future refactor that breaks the size invariant" is realistic — the writer-side cap is enforced in `atomic-write.ts`, not at this module, so a switch to a different writer (or a `__seedDiskCacheForTests` helper that bypasses the wrapper, like the existing `__deleteDiskCacheForTests`) silently loses the cap.

**Why this is P2:** Trust boundary is between this module's writer and reader, and the cap currently sits only on the writer side. Asymmetric trust — flagged by `feedback_symmetric_path_missing_transformation.md` family of pitfalls.

**Suggested fix shape:** Before `readFileSync`, `statSync(path).size` cap-check against a constant like `MAX_CACHE_FILE_BYTES = 512 * 1024` (twice the writer cap, leaving headroom for legitimate JSON growth). On overage → treat as miss with reason `oversize`, emit structured log, fall through to network fetch. Cheaper than a streaming parser; aligns with EC-23 forensic discipline.

---

### P2-4. `apiKey.length < 8` skips the runtime suffix-leak assertion

**File:** `web/server/anthropic-models-cache.ts:939-946` (`writeDiskCache`):

```
if (apiKey.length >= 8) {
  const suffix = apiKey.slice(-8);
  if (serialised.includes(suffix)) { throw … }
}
```

**Concrete failure mode:** The defensive assertion only fires when the key has ≥ 8 chars. For test keys, malformed keys, or keys someone hand-pastes truncated, the assertion is bypassed entirely — `writeDiskCache` will happily write whatever's in `record` to disk, including (in some hypothetical future-refactor bug) the raw test key bytes if a field accidentally got populated with them. Real Anthropic keys are ~100 chars long so production is safe, but the assertion's stated purpose ("defence against future refactor that accidentally adds the key to the record") evaporates exactly in the codepath most likely to exercise it — test runs with synthetic short keys.

Cross-references the Hunt domain (credential-handling) but lives in the persistence boundary because the disk write is where the leak materialises. Plan Task 4 said "substring check on last-8-chars of key" but did not address the short-key case.

**Why this is P2:** Real-world keys are long → production unaffected. But the assertion is operating as a tripwire, and tripwires that silently disable themselves on the most common test-input shape are anti-tripwires (Carmack: "assertions as tripwires"). Beck-wise, this is the "test that doesn't fail when it should" pattern.

**Suggested fix shape:** Two options. (a) Lower the threshold — for keys ≥ 4 chars, slice the longest available suffix (`Math.min(8, key.length)`) and check; only skip when key is empty (already caught at `getAnthropicModels:1041` no-key branch). (b) Replace with a structural check: walk `record` and assert no string field's value equals `apiKey` exactly. Structural is more robust; substring is cheaper. Either way, document that empty-key is the ONLY skip case.

---

### P2-5. Fixture lacks coverage for the bidi-control + long-string reject paths

**File:** `web/server/fixtures/anthropic-models-response.json`

**Concrete failure mode:** The fixture exercises three parser branches: valid (4 entries), `type !== "model"` rejection (1 entry), id-regex rejection (1 entry). It does **NOT** exercise: (a) `display_name` containing a bidi control character (Trojan-Source CVE-2021-42574 defence at `isBoundedSafeString`), (b) `display_name` exceeding 256 chars (length cap), (c) `id` exceeding 128 chars, (d) `id` containing a C1 control byte, (e) optional `created_at` present but malformed (non-string or unparseable ISO). The hostile-input branches in `parseAnthropicModelsResponse` (lines 342-376) are unreached by the EC-6 replay test.

Per EC-6 "Load-bearing protocol parsers require replay-based regression tests" — the fixture is the regression artefact, and a regression artefact that only covers the happy path + 2 trivial rejects has weak protective value. If Anthropic ever returns a `display_name` that legitimately contains a `‮` (right-to-left override) — extremely unlikely but the entire defence rationale of `isBoundedSafeString` rests on rejecting these — there is no test that demonstrates the reject path actually fires against on-wire bytes (not synthetic test literals).

**Why this is P2:** Test-quality + persistence intersection. Cross-references `feedback_verify_test_bodies_not_just_names.md` and `feedback_validator_per_semantic_category.md` from the user's memory index — validator coverage gated only by what the fixture exercises silently false-passes the missing categories.

**Suggested fix shape:** Add a second fixture (or extend the existing one) with adversarial entries — one per reject branch — and add corresponding assertions in the parser test that each entry lands in `droppedItems` for the expected reason. Document in `fixtures/README.md` which line in the fixture exercises which reject branch (line → reject-reason map). Keeps the existing happy-path fixture pristine for the sort-order assertions.

---

### P2-6. `__deleteDiskCacheForTests` bypass leaks the writer cap if it grows into a `__seedDiskCacheForTests`

**File:** `web/server/anthropic-models-cache.ts:984-998`

**Concrete failure mode:** This helper currently only deletes (`unlinkSync` with ENOENT tolerance). Safe. The persistence concern is **structural**: the test escape hatch establishes a precedent that direct `node:fs` calls bypass `writeAtomicJson` and bypass the module's defensive write-side checks (`assertCachePathInBounds`, `apiKey` substring assertion, byte-size cap). The natural next addition — "let me seed a known-good cache for the disk-hit test" — would call `writeFileSync(ANTHROPIC_MODELS_CACHE_PATH, JSON.stringify(seed))` which is **non-atomic**, **non-bounds-checked**, and **unbounded in size**. A test crashing mid-write would leave the cache file truncated; the next production read would hit the `parse` branch and forensic-preserve a corrupt file the test author didn't intend to commit to disk.

Plus the inline `require("node:fs")` + ESLint-disable pair (line 986-987) is a code-smell that invites "let me add one more direct-fs call here while we're at it." The first one is fine in isolation; the second crosses a line.

**Why this is P2:** Slow-burn structural risk, not an immediate bug. Persistence R6 — test-only escape hatches should route through the same atomic-write wrapper as production, or be explicitly marked as "destructive-only, never additive" with a comment.

**Suggested fix shape:** Either (a) inline a top-of-file `import` of `node:fs` named-export `unlinkSync` (no `require`, no eslint-disable), and rename the helper to `__forceUnlinkDiskCacheForTests` to make the destructive-only intent crisp in the function name, OR (b) add a comment at the helper declaring the contract: "TEST-ONLY DELETE-ONLY HATCH. Do not add seed/write helpers here — route through `writeDiskCache` or `writeAtomicJson` to preserve atomic-write + bounds-check discipline." The comment approach is cheaper and addresses the actual concern (future refactor temptation).

---

## P3 — Findings

### P3-1. `assertCachePathInBounds` is called from `writeDiskCache` but NOT from `readDiskCache`

**File:** `web/server/anthropic-models-cache.ts:874-916` (`readDiskCache`)

**Concrete failure mode:** `assertCachePathInBounds` is only invoked at `writeDiskCache:937`. The read path goes directly to `readFileSync(ANTHROPIC_MODELS_CACHE_PATH, "utf8")` with no bounds check. Today the path is a constant so the check would be a no-op, BUT — per the docstring's own rationale ("defending against future refactors that might make the path dynamic") — the same justification applies symmetrically to the reader. If the cache path ever becomes derived (env-override of basename, multi-tenant sub-directories), the writer is gated and the reader is open. Symmetric path missing transformation.

**Why this is P3:** Defensive only; impossible-by-construction today. But conventions floor (EC-7) asks for the wrapper to gate access — not just writes.

**Suggested fix:** Call `assertCachePathInBounds()` at the top of `readDiskCache` too. One-line change; preserves the symmetric defence under future-refactor pressure. If perf matters (it doesn't at one call per request), short-circuit it under a module-load-time once-cache.

---

### P3-2. `JSON.stringify(record)` ordering is implementation-defined — fingerprint substring check is order-fragile

**File:** `web/server/anthropic-models-cache.ts:938-946` (`writeDiskCache`)

**Concrete failure mode:** The defensive assertion does `serialised.includes(suffix)` against `JSON.stringify(record)`. V8 and Bun both currently preserve insertion order for string-keyed objects (ES2015+), so the serialisation is stable. **However** — the assertion's protective claim is "a future refactor that adds the apiKey to a field will go red here." If that future refactor adds the key to a field whose value is then BASE64-encoded, or hex-encoded, or otherwise transformed (the natural mistake when copy-pasting from a code sample), the suffix substring no longer appears in the serialised bytes and the tripwire silently passes. The check is form-specific, not content-specific.

**Why this is P3:** Today the record shape is fixed, the future-refactor risk is hypothetical, and the assertion still catches the most direct mistake (raw key bytes inlined into a string field). But it's worth either upgrading the assertion to walk the record structurally (defence becomes shape-agnostic) or weakening the docstring claim ("catches raw inlining, not encoded leakage") so the next refactor author has accurate expectations.

---

### P3-3. `fetched_at` and the `Date.now()` at read time are not source-of-truth-aligned for "cache_age_ms" log fields

**File:** `web/server/anthropic-models-cache.ts:1060, 1088, 1140` (cache_age_ms log fields)

**Concrete failure mode:** EC-21 documented log triplets derive from a single source. The `cache_age_ms` field is computed as `currentTime - record.fetched_at` — `currentTime` is captured ONCE per request at `1050` from `nowImpl()`. Good. But the three log emit sites (memory-hit at 1060, disk-hit at 1088, stale-served at 1140) each re-compute the subtraction. If a future refactor inlines a fresh `Date.now()` at one of those log lines (the natural mistake when adding a fourth emit site), the triplet desynchronises — `key_fingerprint` derives from one moment, `cache_age_ms` from another. The reader-side test (Persistence R5) verifies the values but not the **single-source-of-truth provenance**.

**Why this is P3:** Hygiene only. Today the code is correct; the concern is durability under future edits.

**Suggested fix:** Either (a) compute `cache_age_ms` once at the top of each branch into a local `const ageMs = currentTime - record.fetched_at`, then reference `ageMs` in the log object — makes the single-source-of-truth visible at a glance, OR (b) extract a `formatCacheHitLog(record, currentTime)` helper. Both eliminate the re-compute-on-each-emit-site risk.

---

### P3-4. `created_at` parser tolerates any ISO string `Date.parse` accepts — including ambiguous ones

**File:** `web/server/anthropic-models-cache.ts:362-375` (`parseAnthropicModelsResponse`)

**Concrete failure mode:** `Date.parse("2026")` returns a finite epoch ms (Jan 1 2026 UTC) in V8/Bun. `Date.parse("2026-01")` similarly. `Date.parse("January 15")` returns a value WITH THE CURRENT YEAR injected — clock-dependent. None of these are valid ISO-8601 timestamps per RFC 3339 but the parser accepts them as `finite`. The sort secondary key (`created_at desc`) then uses these as comparable epoch ms, potentially producing non-deterministic sort outcomes for fixture replay if the year-injection variant ever appears in upstream data.

`isIsoTimestamp` from `council-types.ts` exists for exactly this purpose (per CLAUDE.md "isIsoTimestamp validators per semantic category") and is the per-semantic-category validator the user's memory `feedback_validator_per_semantic_category.md` calls out.

**Why this is P3:** Anthropic's API documentation lists `created_at` as ISO 8601 in RFC 3339 shape. Realistically they will not ship `"January 15"`. But the parser claim is "EC-5 polymorphic-by-spec, tolerate missing"; the reality is "polymorphic-AND-ambiguous, tolerate anything Date.parse swallows."

**Suggested fix:** Replace `Date.parse(s)` + `Number.isFinite` with a stricter ISO 8601 regex (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/` — matches the fixture's actual shape `"2026-04-15T00:00:00Z"`) followed by `Date.parse`. If `council-types.ts:isIsoTimestamp` already does this, import it.

---

### P3-5. Fixture file lacks a `model_count` reference assertion comment

**File:** `web/server/fixtures/README.md` + `web/server/fixtures/anthropic-models-response.json`

**Concrete failure mode:** The README says "4 valid claude-* entries" — a literal count. The fixture has 6 raw entries. The parser produces 4. The reader (`anthropic-models-cache.test.ts`) presumably asserts `models.length === 4`. When the fixture is refreshed (the README has explicit instructions for this), it is **easy** for the refresher to add entries to the JSON and forget to update the README count. Test then fails with `expected 4, got 7` and the reader has to triage which is correct: the test, the fixture, or the README.

**Why this is P3:** Hygiene only. Self-documenting fixtures are a maintenance-cost saver.

**Suggested fix:** Add a 1-line comment at the top of the fixture: `// 6 entries: 4 valid + 1 model_snapshot reject + 1 non-claude reject. Parser produces 4.` JSON technically doesn't permit `//` but a `_comment` field at envelope level OR a triple-blank-line `_NOTE` entry that the parser drops naturally would work. Alternative: rename the file `anthropic-models-response.6entries-4valid.json` and embed the cardinality in the basename. Either way, the parser test's `expect(models.length).toBe(4)` should source from a constant `EXPECTED_VALID_COUNT` co-located with the fixture file, NOT a magic-number literal.

---

## Convergent observations (not findings)

- **No debounce, no rotation, no orphan-sweep, no `fs.watch`** — module header is correct that these don't apply. The cache record is a single bounded poll-on-request artifact; the failure modes those mechanisms exist to manage are absent here. Saving the reader from re-deriving this absence on every code review.

- **Forensic-trace preservation on parse fail** (don't auto-delete the corrupt file at line 890-892) — correct application of Persistence Principle 5 ("never delete a file currently held open, but also never delete a file that contains potentially-useful forensic state without operator intent"). The next successful write atomically replaces; the next failed write does nothing — exactly the right behaviour.

- **Disk-write failure is non-fatal** (line 1186-1195) — correct trade-off. In-memory cache is still authoritative for the rest of the TTL window; loss-of-disk-write degrades only the cold-start hit on next bun restart. Logged at WARN with `cache.write-failed` event → operator sees it but the request still succeeds.

- **`fetched_at` is captured BEFORE the network fetch returns** (line 1050 + 1178) — debatable but defensible. Captures "when did this request kick off" rather than "when did upstream actually respond." For a 5s-bounded fetch this matters only in pathological cases (fetch completes in 4.999s, fetched_at undershoots by 4.999s → cache ages out 5s early). Not a finding; intentional.

---

## Summary

| Severity | Count |
|----------|-------|
| P1       | 0     |
| P2       | 6     |
| P3       | 5     |

No P1 because the foundational discipline is correct — atomic write, schema strict-equality, fingerprint atomic-3-check, forensic preservation, EC-7 bounds. The P2 cluster is around defensive-assertion robustness (parent dir mode, suffix-check threshold, reader-side bounds check, file-size cap, fixture coverage) and the wall-clock TTL skew window. The P3 cluster is hygiene + future-refactor durability.

The single highest-value fix is **P2-1 (parent dir mode 0o700)** because it directly closes a metadata side-channel the PLAN explicitly called for. The single highest-leverage fix is **P2-2 (clock-skew clamp)** because it makes the cache predicate robust to a class of clock anomalies that grow more common as developer machines suspend/resume more frequently.
