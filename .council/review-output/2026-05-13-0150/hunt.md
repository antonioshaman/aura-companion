# Hunt (Security) — Regression Review 2026-05-13-0150

Scope: verify the 24 fixes from commit 02e28c1 (vs FINAL-REVIEW 2026-05-13-0100) introduce no new security regressions, and flag NEW concerns that emerged from the fix-pass surface area.

Files reviewed:
- `web/server/session-orchestrator.ts` (cross-group head check, `scanForMissedObserverWakes`, mandatory echo)
- `web/server/observer-prompt.ts` (EC-7 wrapper unchanged — verified intact)
- `web/server/council-wake-sentinel.ts` (new `deleteCouncilWakeSentinel`)
- `web/server/council-types.ts` (claim fence-triplet strip)

---

## Verification of fix landing — no regressions

**Cross-group check ordering (Finding #1 fix):** `handleCouncilCheckpoint` runs the `payload.session_group_id !== sessionGroupId` guard at lines 1262-1270, BEFORE `entry.previousCheckpoint`/`entry.lastCheckpoint` mutation (lines 1286-1287), BEFORE `councilGroupMeta.lastCheckpointReceivedAt` mutation (line 1289), BEFORE the `group:checkpoint` bus emit, and BEFORE `dispatchObserverWake`. Ordering is correct — a foreign-group payload triggers no state mutation, no fanout, no dispatch.

**EC-7 wrapper integrity (`observer-prompt.ts`):** `assertWakeManifestPathAllowed` unchanged since fix-pass. The realpath-then-check is still the sole containment predicate, exported only via the resolving wrapper (no separate predicate-only export). The climb-to-existing-ancestor loop is bounded by path-depth and the workspace-root realpath defence is intact. EC-7 still sound.

**Mandatory echo path:** Lines 1766-1791. Missing echo (`wakeEcho === undefined`) now hits the same branch as mismatch — all non-NOTE/INFO findings downgrade to NOTE with `downgradeReason: "wake_version_mismatch"`, an `observer.schema_mismatch` warn line lands, and the user sees a `DowngradedChip` explaining the downgrade. The fail-closed direction is correct; the downgrade is VISIBLE in the UI (chip + log), not silent.

---

## NEW findings

### H-R1 — `deleteCouncilWakeSentinel` skips the EC-7 realpath/containment wrapper for the unlink path

- **Title:** Sentinel-delete `unlinkSync` not bounded by workspace-root realpath check
- **File:** `web/server/council-wake-sentinel.ts:155-166` (deleteCouncilWakeSentinel); `councilWakeSentinelPath` at line 62
- **Principle:** EC-7 idiom (filesystem-access predicates inline path resolution OR exposed only via resolving wrapper) applied symmetrically to the new delete path. Hunt × Carmack Principle 1 — path traversal at boundary; Principle 7 — assertions as tripwires.
- **Severity:** P3
- **What's wrong:** The path is computed by plain `join(workspaceCwd, ".council", "state", "<groupId>-wake.json")` without any realpath resolution or workspace-containment check before the `unlinkSync` call. `unlinkSync` itself does NOT follow a trailing symlink on the leaf filename — that part is safe — but the DIRECTORY component (`.council/state/`) being a symlink is not defended. A workspace where `.council/state` is `ln -s /tmp/attacker-staging` causes the unlink to operate on a path outside the workspace root. The sentinel writer (`writeAtomicJson`) and the wake-builder both have realpath-bound containment elsewhere in this codebase (EC-7 wrapper in `observer-prompt.ts`, write-policy in `observer-write-policy.ts`); this delete helper is the one new fs-mutation introduced by the fix-pass without that idiom.
- **Consequence:** The realistic attack vector is narrow — the `sessionGroupId` filename is cryptographically-derived (per `group-authorization.ts`), so an attacker cannot pre-place a file at the colliding filename outside the workspace. The practical loss is bounded to "deleting a file the attacker already named with our groupId at their chosen path." But the EC-7 invariant exists precisely so reviewers do not have to reason this carefully every time. The fix-pass added an fs-mutation path that doesn't carry the convention; the next addition is more likely to drift further.
- **Fix:** Run `assertWakeManifestPathAllowed` (or equivalent realpath+containment) on the resolved sentinel path before `unlinkSync`, or document the symlink-resilience argument inline at the call site with reference to EC-7. The existing best-effort ENOENT absorption is fine to keep.

---

### H-R2 — `scanForMissedObserverWakes` is unbounded in file count + does not filter symlink entries

- **Title:** Restart-catchup scan has no per-group file cap and `readdirSync` includes symlinks
- **File:** `web/server/session-orchestrator.ts:676-736` (scanForMissedObserverWakes)
- **Principle:** Hunt × Carmack Principle 9 — assume breach (a malicious or compromised workspace must not crash initialize); Principle 5 — shrink attack surface (bounded enumeration).
- **Severity:** P3
- **What's wrong:** The scan reads `readdirSync(checkpointsDir).filter(f => f.endsWith(".json") && !f.startsWith("."))` with NO per-iteration cap on the number of files. Each file is then `readFileSync`'d and `parseCheckpointPayload`'d. Per-file size is bounded by `COUNCIL_ARTIFACT_MAX_BYTES` (256 KiB) inside the parser — good — but the file COUNT is not. A workspace with 100k `.json` files in `.council/checkpoints/` produces a multi-minute initialize stall (each file passes through `readFileSync` + JSON.parse + multiple validators). Also, `readdirSync` returns entries without `withFileTypes: true`, so symlinks are not distinguished — a symlink to a multi-gigabyte file fails the size cap inside the parser AFTER `readFileSync` has already buffered the bytes (Node returns the file via the symlink). The size cap is enforced post-read, not pre-stat, so a hostile symlink to a 10 GB file produces a 10 GB allocation before rejection.
- **Consequence:** Init-time DoS in a hostile workspace. The threat model is constrained (the user owns the workspace), but the codebase explicitly supports multi-group local-dev and the workspace dir is whatever cwd the user opened the session in. A user opening a session in a directory containing an attacker-supplied `.council/checkpoints/` tree (e.g. cloning an untrusted repo) gets a multi-minute hang or memory blow-up at initialize. The per-group try/catch contains the throw, but `readFileSync` of a huge file blows the heap before reaching the catch.
- **Fix:** Cap the readdir result at e.g. 256 entries per group (more than enough for any legitimate phase-checkpoint sequence). Use `readdirSync(dir, { withFileTypes: true })` and skip non-regular files. Pre-stat each candidate and skip if `size > COUNCIL_ARTIFACT_MAX_BYTES` BEFORE the readFileSync, mirroring the pattern `loadObserverSystemPrompt` already uses (`statSync` size check before read).

---

### H-R3 — Claim fence-triplet replacement bloats `claim` past `MAX_CLAIM_LEN`

- **Title:** Fence-triplet → `ʼ\`ʼ\`ʼ\`` substitution doubles each occurrence, can push validated `claim` past the documented 4000-char cap
- **File:** `web/server/council-types.ts:319-327` (parseObserverReviewPayload claim path)
- **Principle:** Hunt × Carmack Principle 2 — automated defences (validators are the contract; transformations that happen AFTER validation can violate the post-condition the validator was meant to enforce).
- **Severity:** P3
- **What's wrong:** `isBoundedText(f.claim, MAX_CLAIM_LEN=4000)` runs FIRST, then `.replace(/```/g, "ʼ\`ʼ\`ʼ\`")` runs SECOND. Each ASCII fence triplet (3 chars) becomes a 6-char replacement. A claim of 3999 chars filled with 1333 fence-triplets passes the validator at 3999, expands to 7998 after replace — past the documented bound. Not a homoglyph attack vector (the U+02BC replacement is harmless plain text rendered through JSX-escape downstream), but a validator post-condition drift: every downstream consumer that treats `claim` as bounded-by-MAX_CLAIM_LEN now sees a string up to 2× larger.
- **Consequence:** Concrete impact is bounded — `claim` is rendered in chat (JSX-escaped, no script injection vector via the replacement), written into `BrowserObserverFinding`, broadcast to browsers, and persisted by the recorder. The recorder line-size cap is generous; the chat rendering is fine. But the AP-3 single-source-of-truth contract for `claim` length is silently violated: a future consumer that allocates a fixed buffer or enforces a size budget based on `MAX_CLAIM_LEN` will under-size. The homoglyph framing in the regression brief is NOT the live vector — the live vector is contract drift on the length invariant.
- **Fix:** Either (a) cap the post-replace length: `if (claim.length > MAX_CLAIM_LEN) return null;` after the substitution, or (b) re-run `isBoundedText(claim, MAX_CLAIM_LEN)` after the replace to keep the validator as the single boundary. Option (b) is the EC-7-style idiom (single resolving wrapper enforces both shape AND post-condition).

---

## Items considered and dismissed (no new finding)

- **Homoglyph attack via U+02BC replacement.** The replacement is rendered through JSX which escapes everything as plain text — no script injection vector. U+02BC visually resembles ASCII apostrophe but produces no executable content; copy-paste of the resulting text into a terminal yields a non-functional command. Not a security issue.
- **Mandatory-echo as a downgrade-attack vector.** A "malicious observer" omitting the echo to suppress STOPs would still surface the findings as NOTE WITH a visible `wake_version_mismatch` chip AND a `WARN observer.schema_mismatch` log line. The downgrade is intentional fail-closed per prior review #12 and is NOT silent — user sees both the lowered severity AND the rationale. The alternative (drop the review entirely) is strictly worse for the user. Sound design.
- **Cross-group filter inside `scanForMissedObserverWakes`.** Verified at line 700 — `if (payload.session_group_id !== groupId) continue;`. Same filter as `handleCouncilCheckpoint`. Correct.
- **`unlinkSync` trailing-symlink-follow on the wake-sentinel file.** POSIX `unlink()` does not dereference the leaf symlink. Verified safe. (The directory-component symlink case is H-R1 above.)

---

## Summary

| # | Title | Severity |
|---|-------|----------|
| H-R1 | Sentinel-delete `unlinkSync` not bounded by EC-7 wrapper | P3 |
| H-R2 | `scanForMissedObserverWakes` unbounded file count + symlink-read pre-size-check | P3 |
| H-R3 | Claim fence-triplet replacement bloats past `MAX_CLAIM_LEN` post-validate | P3 |

All three are P3 hygiene/defense-in-depth concerns. No P1 or P2 emerged from the fix-pass surface. The 24 fixes land cleanly in the security domain — the cross-group head-check is correctly ordered, the EC-7 wrapper remains intact, the mandatory-echo downgrade is visible and fail-closed, and `deleteCouncilWakeSentinel`'s `unlinkSync` is safe for the trailing leaf.
