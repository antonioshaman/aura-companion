# FS-JSON Persistence Review — PR #91 (2nd pass, burndown verification)

Reviewer: Filesystem JSON-Store Persistence Expert (per `references/quality-persistence.md`)
Scope (second pass): `web/server/atomic-write.ts`, `web/server/anthropic-models-cache.ts` (re-verify only the lines the burndown touched), `web/server/fixtures/anthropic-models-response-hostile.json`, `web/server/fixtures/README.md`.
Baseline: first review at `.council/review-output/2026-06-04-0823/persistence.md` (0 P1 / 6 P2 / 5 P3). Convention floor as of `conventions.md` (incl. EC-37..EC-41, AP-16 added by first review). Per the brief, do NOT re-flag items the conventions or PLAN watchpoints already cover.

Verdict at a glance: **The 2 directly-named P2 fixes (P2-1 parent dir 0o700, P2-2 negative-skew clamp) land cleanly with EC-38 conformant shape and explicit citation in code comments.** 3 of the 6 first-pass P2 items are NOT addressed in the burndown (P2-3 reader file-size cap, P2-4 short-key suffix skip, P2-6 `__deleteDiskCacheForTests` bypass) — they were always P2-not-P1 and the brief lists only the 15 numbered findings from FINAL-REVIEW.md as the burndown's scope, of which only P2-1 (FINAL #8) and P2-2 (FINAL #10) carried forward. The P3 hostile-input fixture (FINAL #15) lands with documented entry-index → reject-reason map but **does NOT cover the ambiguous-`created_at` reject path** the first review specifically named (P2-5 deferred; explicitly future-deferred in fixtures/README.md as "if you tighten the parser per P3-4, extend this fixture"). One NEW finding on atomic-write.ts: the `chmod-after-mkdir` best-effort swallow is appropriate per Principle 1 BUT silently masks an operationally-real failure shape (EACCES on a pre-existing broader-perm dir owned by a different UID) that the operator should see in logs.

---

## First-pass items: status verification

### P2-1 (FINAL #8) — Parent dir mode 0o700: **CLOSED** with caveat

**File:** `web/server/atomic-write.ts:35-46`

**Verified:** `mkdirSync(dir, { recursive: true, mode: 0o700 })` AND `chmodSync(dir, 0o700)` in best-effort try/catch. Comment at L25-34 correctly cites the council finding + names the umask-mask reason chmod-after-mkdir is necessary. EC-38 conformant cross-cutting (touches all writers — council artifacts, env profiles, settings.json — which is the correct AP-14 single-assembly-site fix as the first review called for).

**Behavioural verification of the burndown's claim re. EXISTING parent dirs:**

The brief asks "does chmod-after-mkdir correctly tighten an EXISTING parent dir created by a different writer with broader perms, or only fresh-creates?"

**Yes — for the same-UID case.** `chmodSync(dir, 0o700)` operates on whatever exists at `dir` regardless of `mkdirSync`'s outcome (mkdir with `recursive: true` is no-op-on-exist; chmod runs unconditionally afterward). So a `~/.companion/` directory created by a previous bun run with broader umask gets retrofit to 0o700 on the next writer's first call. That's the operationally critical case and it works.

**Subtle gap (NOT escalated; cited as a NEW concern below):** if the pre-existing parent is owned by a different UID (e.g., systemd unit was reconfigured to drop privileges and the old `~/.companion/` is still root-owned), `chmodSync` throws EPERM and the catch block swallows it silently. The atomic write itself still proceeds (file mode 0o600 enforced at openSync), so the immediate side-channel — filename + mtime visible to other UIDs — survives without an operator-visible signal. Acceptable per Principle 1's "best-effort hardening" framing AND the comment explicitly documents this trade-off; flagged below as a NEW P3 because the operator should at minimum see ONE log line on the first occurrence so the metadata leak isn't permanently invisible.

---

### P2-2 (FINAL #10) — Negative clock-skew TTL fail-open: **CLOSED**

**File:** `web/server/anthropic-models-cache.ts:821`

**Verified:** `if (Math.max(0, now - r.fetched_at) > ttlMs) return false;` matches the EC-38 idiom exactly. Comment at L813-820 cites Council finding + names the realistic causes (NTP correction, VM resume from snapshot, suspended laptop wake). Clamp-at-zero is the simpler-of-two approaches the first review proposed; correctly chosen for a metadata cache where "tolerance-detect-and-refetch" would only matter if the operator's clock anomaly persisted for a full ttlMs window.

**Cross-check:** Same fail-open shape exists at `readMemoryCache:841` (`if (now - record.fetched_at > IN_MEMORY_TTL_MS)`). The first-review P2-2 was specifically about `isCacheRecordValid` (disk path) but EC-38's invariant is symmetric — see NEW finding below.

---

### P2-3 (first-pass) — `readFileSync` no upper-bound: **NOT ADDRESSED**

**File:** `web/server/anthropic-models-cache.ts:940` (`raw = readFileSync(ANTHROPIC_MODELS_CACHE_PATH, "utf8")`)

The brief asks "was this addressed in the burndown?" Answer: **no**. The line is structurally identical to the first review. No `statSync(path).size` cap, no `MAX_CACHE_FILE_BYTES` constant. Re-flagged as carry-forward below (downgraded to P3 — the first-pass severity stands but the burndown was not asked to address this finding per the FINAL-REVIEW.md scope).

---

### P2-4 (first-pass) — `apiKey.length < 8` skips suffix-leak assertion: **NOT ADDRESSED**

**File:** `web/server/anthropic-models-cache.ts:998-1005`

The brief asks "was this addressed?" Answer: **no**. Lines unchanged: `if (apiKey.length >= 8) { … suffix check … }`. No structural-walk alternative, no lowered threshold, no comment documenting empty-key as the ONLY skip case. Re-flagged as carry-forward P3 below.

---

### P2-5 (first-pass FINAL #15) — Fixture for hostile-input reject branches: **PARTIALLY CLOSED**

**File:** `web/server/fixtures/anthropic-models-response-hostile.json` + `web/server/fixtures/README.md`

**Verified covered:**
- Index 0: valid baseline survives — pin for sort + label normalisation (good).
- Index 1: bidi `display_name` (U+202E RLO + U+202C PDF embedded in the literal string) → MUST drop via `isBoundedSafeString` rejecting 0x202a-0x202e and 0x2066-0x2069. Verified the validator at L290-291 rejects exactly that range. ✓
- Index 2: C0 control `\t` (0x09 < 0x20) in `display_name` → MUST drop. Validator L287 rejects `code < 0x20`. ✓
- Index 3: C1 control `U+0080-U+009F` in `display_name` → MUST drop. Validator L289 rejects that range. ✓
- Index 4: `id` length >128 → MUST drop. Validator L284 rejects length > maxLen. ✓
- Index 5: `display_name` length >256 → MUST drop. Same check. ✓

**Verified NOT covered (gap):** Ambiguous `created_at` (e.g., `"2026"`, `"January 15"`, `"2026-01"`) — the first review's P3-4 watchpoint AND named in P2-5's list ("ambiguous created_at"). The fixture has zero entries exercising `created_at` reject branches at all (only Index 0 has a `created_at`, and it's valid). The fixtures/README.md table explicitly defers this to a future tightening of the parser ("if you tighten the parser per Persistence P3-4, extend this fixture"). Acceptable as a docu-deferred follow-up; flagged below as carry-forward of P3-4.

**Test alignment:** The test at `anthropic-models-cache.test.ts:1027-1051` asserts `parsed.droppedItems >= 5` AND `ids.every(id => id.length <= 128)`. Pins the cardinality but does NOT pin each reject branch's individual contribution. A future refactor that broadens `isBoundedSafeString` to allow tab (deliberately or by typo) would leave the count at 5 (tab-row promotes to valid, but length-bound and bidi rejects still fire) — the test stays green. **NEW P3 below — cardinality assertion is weaker than per-branch assertion**, the README's entry-index → reject-reason table is the documented contract but the test doesn't enforce per-row.

---

### P2-6 (first-pass) — `__deleteDiskCacheForTests` comment-only defence: **NOT ADDRESSED**

**File:** `web/server/anthropic-models-cache.ts:1043-1057`

The brief asks if the comment-only defence was added. Answer: **no**. The function is structurally unchanged from the first review — still uses `require("node:fs")` + ESLint-disable, still named `__deleteDiskCacheForTests` (the destructive-only intent is in the name suffix but not strongly signalled), and has NO comment warning future contributors NOT to add `__seedDiskCacheForTests` that bypasses `writeAtomicJson`. The structural risk is unchanged. Carry-forward P3 below.

---

### P3-1 (first-pass) — `assertCachePathInBounds` on `readDiskCache`: **NOT ADDRESSED**

**File:** `web/server/anthropic-models-cache.ts:933-945`

`readDiskCache` still goes directly to `readFileSync` without calling `assertCachePathInBounds`. The symmetric defence (writer is gated, reader is open) remains absent. Carry-forward P3.

---

### P3-3 (first-pass) — `cache_age_ms` single source of truth: **NOT ADDRESSED**

**File:** `web/server/anthropic-models-cache.ts:1119, 1147, 1199`

Three inline `currentTime - record.fetched_at` re-computes (memory hit, disk hit, stale-served). All use `currentTime` captured ONCE at L1109, so the single-source-of-truth invariant holds AT THE TIMESTAMP level (the part the JSDoc at L157 claims). The hygiene fix the first review proposed — extract a local `const ageMs = …` per branch — was NOT done. Severity unchanged — hygiene only. Carry-forward P3.

---

### P3-4 (first-pass) — Ambiguous `created_at` via `Date.parse`: **NOT ADDRESSED**

**File:** `web/server/anthropic-models-cache.ts:362-375`

The parser still uses bare `Date.parse(item.created_at)` + `Number.isFinite` — no strict ISO 8601 regex, no `isIsoTimestamp` import from `council-types.ts`. Carry-forward P3.

---

## NEW findings (introduced by or surfaced through the burndown)

### NEW P3 — `chmodSync` silent swallow in `atomic-write.ts` masks operationally-real EACCES on cross-UID pre-existing parent

**File:** `web/server/atomic-write.ts:36-46`

**Concrete failure mode:** The burndown's defensible best-effort `try { chmodSync(dir, 0o700) } catch { /* file 0o600 is the primary defence */ }` is the correct choice per Principle 1 for the common case (umask was the problem; chmod succeeds; we're done). But there is a NON-rare production shape it silently swallows: operator changes systemd unit's `User=` (or re-runs the installer as a different UID), the old `~/.companion/` survives with the previous-UID ownership, the new bun process owns nothing in there. `chmodSync` throws EPERM/EACCES; we catch + drop. The atomic file write proceeds because openSync inside that directory works (the dir is world-traversable for the file open to succeed in the first place at 0755). Result: file 0o600 protects the BYTES, but the side-channel the burndown was specifically trying to close — `ls -la ~/.companion/` reveals the cache exists — survives **permanently and invisibly** for that operator. There is no signal in any log that the hardening didn't take.

**Why this is P3 (not P2):** Production-realistic but bounded. The metadata leak is the same `(filename, mtime)` shape the first review already classified as P2 — which this NEW finding's failure shape regresses to. The defence-in-depth (file 0o600) holds. EC-9 forensic-triage discipline says: any silently-suppressed error on a hardening path should leave at least ONE log line so the operator can find it.

**Suggested fix shape:** Wrap the chmod in a one-shot module-load WARN-once if it fails (mirror the `signalCoalesceDegradeLogged` pattern the burndown introduced for AbortSignal — same shape, same rationale). Emit `event: "atomic-write.parent-chmod-failed"` with the dir path + errno on first occurrence. Operator now sees the metadata leak risk in logs ONCE per process lifetime; the in-loop best-effort behaviour is unchanged.

---

### NEW P3 — `readMemoryCache` TTL predicate has the SAME negative-skew fail-open shape EC-38 says to clamp

**File:** `web/server/anthropic-models-cache.ts:841`

**Concrete failure mode:** The burndown closed P2-2 at `isCacheRecordValid:821` (disk cache predicate) with `Math.max(0, now - r.fetched_at) > ttlMs`. **The same shape exists at `readMemoryCache:841` and was not clamped:** `if (now - record.fetched_at > IN_MEMORY_TTL_MS)`. EC-38 says "Cache predicates over `Date.now()` MUST clamp negative-skew (`Math.max(0, now - past)`)" — applies to BOTH cache tiers. Today the memory cache survives at most 1h so the staleness window from a backward clock jump is shorter, but the principle is symmetric and the burndown's fix is asymmetric.

**Why this is P3:** The IN_MEMORY_TTL_MS is 1h vs 24h for disk. A backward NTP jump of ≥1h is rarer than the 24h equivalent the disk predicate guards. Memory cache also dies on bun restart, so an operator who notices the staleness and restarts naturally clears it. Carrying forward as P3 because it's the canonical "symmetric path missing transformation" shape — fixed in one tier, missed in the sibling.

**Suggested fix shape:** One-liner mirror of the disk predicate: `if (Math.max(0, now - record.fetched_at) > IN_MEMORY_TTL_MS)`. Or extract `isWithinTtl(now, fetchedAt, ttlMs)` to a top-of-file helper and call both sites — single-source-of-truth on the clamp invariant, EC-38 enforced by construction.

---

### NEW P3 — Hostile fixture test asserts cardinality (`droppedItems >= 5`) instead of per-row reject attribution

**File:** `web/server/anthropic-models-cache.test.ts:1027-1051` + `web/server/fixtures/README.md:47-54`

**Concrete failure mode:** The README documents an explicit `entry-index → reject-reason` map: index 1 → bidi, index 2 → C0, index 3 → C1, index 4 → id length, index 5 → display_name length. **The test asserts only**: (a) baseline `claude-opus-4-7` is in `ids`, (b) the four explicit `evil/tab/c1/shortish` ids are NOT in `ids`, (c) all surviving ids ≤128 chars, (d) `droppedItems >= 5`. This pins the cardinality but NOT the per-branch attribution. A refactor that accidentally drops the bidi check but keeps the C0/C1 checks would: tab row still drops (C0), c1 row still drops (C1), the long-id row still drops (length), the long-name row still drops (length) — droppedItems stays at 4 (now miscounting since bidi row sneaks through) BUT the test demands `>= 5` and the long-id contributes one more so the count stays at 5. The bidi reject — the most security-relevant of all the branches and the explicit Trojan-Source defence the README cites by CVE — is no longer enforced by the assertion.

**Why this is P3:** Fixture coverage is materially better than no fixture; the named ids in `expect(ids).not.toContain(...)` do catch the most direct refactor mistakes. The gap is in proving the REASON each row was rejected, which is the contract the README documents and the parser's branched control-flow expresses.

**Suggested fix shape:** Either (a) parser exposes `droppedItems` as `Array<{id, reason}>` instead of a count, and the test asserts `droppedReasons.toContain("bidi")` etc. — touches the parser's return shape, larger change. Or (b) test does per-row narrowing: re-parse with N-1 rows (slicing one out) and assert `droppedItems` decreases by exactly 1, looping across all hostile rows. Cheaper, no production-code touch, pins each row's reject contribution against the contract. Documented contract becomes enforced contract.

---

## Carry-forward findings from first pass (lower severity, not in burndown scope)

These were P2/P3 in the first review, **not in the FINAL-REVIEW.md's 15 numbered findings the burndown was asked to close**, but they remain open and worth noting for the next iteration. Listed compactly per the no-recap convention:

- **P2-3 (now P3)** `readFileSync` no upper-bound size cap on cache file. Still open at `anthropic-models-cache.ts:940`. Suggest `statSync(path).size > MAX_CACHE_FILE_BYTES` precheck — see first review for the full shape.
- **P2-4 (now P3)** `apiKey.length < 8` tripwire skip. Still open at `anthropic-models-cache.ts:998`. Suggest `Math.min(8, key.length)` slice OR structural walk of `record`.
- **P2-6 (now P3)** `__deleteDiskCacheForTests` no contract comment + uses `require` + ESLint-disable. Still open at `anthropic-models-cache.ts:1043`. Suggest a top-of-function "TEST-ONLY DELETE-ONLY HATCH — do not add seed/write helpers here" comment + lift the import to top of file.
- **P3-1** `assertCachePathInBounds` not called from `readDiskCache`. Still open at L933-945. One-line addition.
- **P3-3** `cache_age_ms` re-computed inline at 3 emit sites. Hygiene only. Local `const ageMs = …` per branch.
- **P3-4** `Date.parse` tolerates ambiguous strings on `created_at`. Still open at L362-375; fixture explicitly defers this per README. Strict ISO 8601 regex + import of `isIsoTimestamp` from `council-types.ts`.
- **P3-5** Magic-number `model_count` in fixture — `EXPECTED_VALID_COUNT` constant co-located. Hygiene.

---

## Summary

| Severity | First pass | This pass | Notes |
|----------|-----------|-----------|-------|
| P1       | 0         | 0         | Foundational discipline holds — atomic write, schema strict-equality, fingerprint atomic-3-check, forensic preservation all unchanged and correct. |
| P2       | 6         | 0         | Two burndown-scope items (P2-1 parent dir, P2-2 clock-skew clamp) verified closed cleanly. Four other first-pass P2s (P2-3 size cap, P2-4 short-key, P2-5 fixture partial, P2-6 comment defence) NOT in burndown scope but worth noting as carry-forward — downgraded to P3 because the burndown was explicitly scoped to the 15 numbered FINAL findings only. |
| P3       | 5         | 3 NEW + 7 carry-forward = 10 | Three NEW (chmod silent swallow on cross-UID, memory cache same skew shape, hostile-fixture per-row attribution). Seven carry-forward (P2-3/4/6 downgraded + P3-1/3/4/5 unchanged). |

**Burndown's verdict on the 2 directly-named first-pass items:** clean close. EC-38 idiom applied exactly; AP-14 single-assembly-site discipline on the atomic-write change is correct. The 0o700 + best-effort chmod retrofit DOES correctly tighten existing parent dirs (operationally critical case verified by reading the burndown's mkdir-then-chmod sequence — chmod runs unconditionally after the no-op-on-exist mkdir).

**The single highest-value NEW finding is the cross-UID `chmodSync` silent swallow** — not because the failure mode is common, but because it's an operationally-realistic case (User= change in systemd) where the entire point of the burndown (parent dir 0o700) silently doesn't apply. A one-shot WARN-once log mirroring the burndown's own `signalCoalesceDegradeLogged` pattern (same module-scope-flag shape) closes the visibility gap without changing the in-loop best-effort behaviour.

**The single highest-leverage NEW finding is the memory-cache skew clamp** — exact same `Math.max(0, now - past) > ttlMs` shape, sibling site, EC-38 says it applies symmetrically. One-line fix; closes a "symmetric path missing transformation" antipattern the user's memory index explicitly names.

**The hostile fixture is the most evolutionary piece** — it covers 4 of 5 reject branches the first review named (bidi, C0, C1, id-length, display_name-length); the ambiguous-`created_at` row is deferred to when the parser tightens (correctly documented). Test assertion pins cardinality not attribution; one refactor of the assertion shape (per-row narrowing OR structured return from parser) closes the documented contract gap.

The burndown's scope discipline — fix exactly the 15 numbered findings, don't re-flag the floor — held. No regressions introduced on the persistence axes. The carry-forward P3 list represents the residual durability + edge-case backlog, NOT new risk surface.
