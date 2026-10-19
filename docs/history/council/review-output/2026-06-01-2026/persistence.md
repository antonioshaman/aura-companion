# Filesystem JSON-Store Persistence Expert — Findings

Scope: `web/scripts/detect-stack.ts` only (read-only filesystem utility, not a writer). Standard atomic-write / JSONL / rotation lenses N/A. Findings focus on read-side discipline extended by this commit to depth-1 subdirs.

---

## FINDING 1

- **Title:** `readdirSync` failure in `enumerateCandidatePrefixes` silently degrades depth-1 scan to root-only — no `read_error` surfaced
- **File:** `web/scripts/detect-stack.ts` (lines 231–238)
- **Principle:** Principle 3 — close every state on every exit path (sentinel/orphan analogue: every failure mode becomes a structured result, never a silent downgrade — also asserted by the file's own header comment "No silent fallback (spec AC-3.3): every failure mode becomes a structured result … never silently downgrades 'malformed' to 'absent'")
- **Severity:** P2
- **What's wrong:** When `readdirSync(rootResolved, { withFileTypes: true })` throws (EACCES on the workspace root, transient EIO, EMFILE under fd pressure), the catch block does `return prefixes` where `prefixes === [""]`. The caller proceeds as if monorepo scan was attempted and produced no subdir candidates — indistinguishable from the legitimate "this workspace genuinely has no scannable depth-1 subdirs" case. The MarkerCheck array contains no entry recording that the enumeration step itself failed. By contrast, every per-marker `resolveMarker` failure surfaces as a `MarkerCheck` with `reason: "read_error"` and parsed=false — the convention this commit broke for the new enumeration layer.
- **Consequence:** A monorepo where the user has accidentally chmod-700'd the workspace root for an unrelated reason gets the same refusal text as a flat single-stack workspace ("no recognised stack markers at workspace root") — the user is told to add an override, not told their FS permissions are wrong. Diagnostic regression vs the per-marker discipline.
- **Fix:** Either (a) emit a synthetic enumeration-level MarkerCheck with `name: "<workspace>/ (directory scan)"`, `reason: "read_error"`, surfaced in the rendered refusal under "Found at workspace root" so the user sees the FS error; or (b) at minimum log the caught error to stderr from this script (it's a CLI utility, stderr is the natural channel). Silent fallback to a degraded candidate list violates the file's own stated no-silent-downgrade invariant.

---

## FINDING 2

- **Title:** Per-entry `lstatSync` failure in `enumerateCandidatePrefixes` silently skips entries — could produce inconsistent candidate lists across re-runs
- **File:** `web/scripts/detect-stack.ts` (lines 248–254)
- **Principle:** Principle 3 — idempotency on state transitions (read-side analogue: same input must yield same enumeration; transient errors must surface, not silently change shape)
- **Severity:** P3
- **What's wrong:** The per-entry `lstatSync(candidate)` is wrapped in `try { … } catch { continue; }`. A transient EIO or EACCES on one of the depth-1 entries causes that entry to be silently dropped from the candidate prefix list. Two back-to-back invocations of `detectStack(workspaceRoot)` could enumerate different candidate sets (a real concern in CI containers under fd/inode pressure, on network-mounted homes, or on FUSE-encrypted filesystems where `lstat` occasionally fails). The MarkerCheck array contains no record that an entry was skipped — caller cannot reconstruct what was attempted.
- **Consequence:** Determinism contract weakened. A monorepo where `apps/` triggers a transient lstat failure may return `kind: "unknown"` on first call, `kind: "aura"` on second — different refusal text without any code change or marker change. Diagnostically opaque; the user has no signal to suspect FS-level transient failure.
- **Fix:** Match the existing per-marker discipline: on lstat failure, push a synthetic MarkerCheck with `reason: "read_error"` for that prefix (or accumulate enumeration-time errors into a separate field on `DetectionResult`). The current behavior — silently `continue` on FS failure — is exactly the "silently downgrades to absent" anti-pattern the file header explicitly forbids.

---

## FINDING 3

- **Title:** `MAX_CANDIDATE_SUBDIRS=64` silent cap with no MarkerCheck entry, no log, no flag on `DetectionResult` — debuggability hazard for large monorepos
- **File:** `web/scripts/detect-stack.ts` (lines 101, 239, 241)
- **Principle:** Principle 5 — rotation invariants: bound storage without losing meaning (read-side analogue: bound work without losing the signal that bounding happened); Principle 10 — know your gaps (failure-mode disclosure)
- **Severity:** P2
- **What's wrong:** When a workspace root has >64 non-skip, non-hidden directories, the scan stops at entry 64 with no record. There is no log line, no flag in `DetectionResult` (e.g. `scanTruncated: true`), no synthetic MarkerCheck. The 65th directory could be `apps/` containing the only matching Aura `package.json`, and the user gets `kind: "unknown"` plus a refusal that lists no relevant markers — with zero indication that the scan was budget-capped, not exhaustive. The behavior is also order-dependent on `readdirSync` ordering, which is filesystem-defined (varies between tmpfs, ext4, APFS, NTFS).
- **Consequence:** Real-world monorepos using lerna/nx/turborepo can easily exceed 64 depth-1 entries (each package, each app, each tool). The script's behavior on those is "look unknown, suggest override" — but the override workflow doesn't help if the user genuinely wants auto-detection. Refusal text is mismatched to root cause: user thinks markers are missing, actually scan stopped early. This is the symmetric read-side equivalent of the rotation-without-disclosure pattern the persistence reference flags.
- **Fix:** Either (a) raise the cap (the work per candidate is bounded: 4 probe functions × small `existsSync`/`readText` — 256 entries is still sub-millisecond); (b) emit a `MarkerCheck` with `name: "(scan truncated at MAX_CANDIDATE_SUBDIRS)"` and surface it in the rendered refusal; or (c) add `scanTruncated: boolean` to `DetectionResult` and render a line in `renderRefusal` when true. The cap as a defensive budget is fine — silent truncation of a defensive budget is not.

---

## FINDING 4

- **Title:** `enumerateCandidatePrefixes` does NOT route through `resolveMarker` — second EC-7 path-resolution site with weaker discipline than the canonical wrapper
- **File:** `web/scripts/detect-stack.ts` (lines 231–259 vs lines 151–181)
- **Principle:** Principle 6 — validate at the boundary; EC-7 convention (filesystem-access predicates inline path resolution OR exposed only via resolving wrapper)
- **Severity:** P2
- **What's wrong:** `resolveMarker` (the canonical wrapper, lines 151–181) does four checks: prefix `/` / `..` reject, `existsSync`, `lstatSync` symlink reject, AND `realpathSync` + `startsWith(rootResolved + sep)` bounds check. The new helper `enumerateCandidatePrefixes` does its OWN inline FS access at line 250 — `lstatSync(candidate)` + symlink reject — but DOES NOT call `realpathSync` and DOES NOT bounds-check. The comment at line 246 reads "Defensive realpath bounds check — never traverse outside workspace" but the code does no `realpathSync` call. The comment lies about what the code does. The header comment at lines 10–13 explicitly says "every marker access goes through `resolveMarker`" — also untrue after this commit.

  Lstat-rejecting-symlinks at the dirent layer covers most of what realpath would catch (a depth-1 entry that is a symlink is dropped), so the actual exploit surface is narrow. But the asymmetric discipline means a future change to `resolveMarker` (e.g. adding a deny-list, a case-fold check, a length cap) will not apply to enumeration — drift hazard.

- **Consequence:** EC-7 convention regression. The two FS-access boundaries now differ; a reviewer reading `resolveMarker` no longer has the full picture of how paths get resolved in this module. The comment lying about realpath-bounds checking is the real persistence-class hazard: the next maintainer who touches `resolveMarker` and trusts the file-header invariant will not know to update enumeration in parallel.
- **Fix:** Either (a) factor a shared `lstatNonSymlinkInsideRoot(rootResolved, name)` helper that both `resolveMarker` and `enumerateCandidatePrefixes` call; or (b) reuse `resolveMarker` directly inside enumeration (it works fine for depth-1 dir names — the `..`-reject is satisfied, existsSync+lstat+realpath all apply). At minimum, correct the misleading inline comment "Defensive realpath bounds check" — the code does not call realpath.

---

## FINDING 5

- **Title:** BOM tolerance preserved across refactor — VERIFIED, no finding
- **File:** `web/scripts/detect-stack.ts` (lines 210–212)
- **Principle:** Principle 4 — line-terminator / encoding discipline (read-side analogue: input normalization at the boundary)
- **Severity:** N/A
- **What's wrong:** Nothing. Verified the refactor preserved BOM stripping. `readText` (lines 192–214) is the single read funnel; the BOM check at lines 210–212 (`raw.charCodeAt(0) === 0xfeff` → `raw.slice(1)`) runs unconditionally for every read. All four probes (`probePackageJson`, `probeWsBridge` — no read needed, `probePyproject`, `probeRequirementsAndBot`) route through `readText` for actual content reads. Both root mode (`prefix === ""`) and subdir mode (`prefix === "<dir>"`) hit the same `readText` path — the `prefix` parameter only changes the constructed `relPath`, not the read pipeline. Recorded as positive verification only.

---

## FINDING 6

- **Title:** CRLF tolerance preserved across refactor — VERIFIED, no finding
- **File:** `web/scripts/detect-stack.ts` (line 438)
- **Principle:** Principle 4 — line-terminator discipline
- **Severity:** N/A
- **What's wrong:** Nothing. Verified the `/^aiogram\b/m` regex at line 438 in `probeRequirementsAndBot` runs identically for root mode (`prefix === ""`) and subdir mode. The regex is multi-line (`/m` flag) and matches at line start — `\b` after `aiogram` ensures it matches `aiogram\n`, `aiogram\r\n` (since `\b` is a zero-width boundary), `aiogram>=3` etc. The refactor moved the read-and-match logic into a unified post-branch path (lines 426–445) where the only difference between root and subdir is the up-front `bot/` co-requirement check — both modes share the CRLF-tolerant read+regex. Recorded as positive verification only.

---

## FINDING 7

- **Title:** Size caps preserved across refactor — VERIFIED, no finding
- **File:** `web/scripts/detect-stack.ts` (lines 61–66, 297, 360, 426, 472)
- **Principle:** Principle 5 — bound resource consumption (read-side analogue: bound input size at the read boundary)
- **Severity:** N/A
- **What's wrong:** Nothing. Verified all four probes plus override read go through `readText(absolute, cap)`:
  - `probePackageJson` line 297: `SIZE_CAP.PACKAGE_JSON` (16K)
  - `probePyproject` line 360: `SIZE_CAP.PYPROJECT` (64K)
  - `probeRequirementsAndBot` line 426: `SIZE_CAP.REQUIREMENTS` (64K)
  - `readOverride` line 472: `SIZE_CAP.OVERRIDE` (1K)
  - `probeWsBridge` does not read content (existence-only check) — N/A
  The `readText` cap is checked via `statSync().size > cap` BEFORE `readFileSync` (lines 198–199), which is the correct order — never load a >cap file into memory. No code path was introduced that bypasses `readText`. Recorded as positive verification only.

---

## FINDING 8

- **Title:** `SKIP_SUBDIRS` does not include `coverage/`, `node-modules` typo-variants, or `.next` build artifact dirs that legitimately contain `package.json`
- **File:** `web/scripts/detect-stack.ts` (lines 76–100)
- **Principle:** Principle 6 — validate at the boundary (calibrated allow/deny lists); Principle 10 — know your gaps
- **Severity:** P3
- **What's wrong:** The skip list covers the obvious heavy hitters (`node_modules`, `dist`, `build`, `out`, `target`, `.next`, `.turbo`, `.cache`, hidden dirs, Python cache dirs). Missing/edge cases worth review:
  - `coverage/` — many JS/TS tooling pipelines write a `coverage/package.json` (nyc fixture, jest coverage snapshot tooling). Currently NOT skipped. Probability of containing `name === "aura-companion"` is zero; probability of containing `hono` in dependencies is zero. But a future scoped guard relying on "no coverage match" is at risk.
  - `.next` IS listed but `.nuxt`, `.svelte-kit`, `.astro`, `.remix` (other meta-framework build dirs) are NOT. Less likely to contain matching markers but same noise class.
  - The header comment at line 245 says "also rejects symlinks (isDirectory false on dirent symlinks)" — verify this is true for Node/Bun `Dirent.isDirectory()`. Per Node docs, `dirent.isDirectory()` on a symlink-to-dir returns `false` (it reflects lstat, not stat). Comment is correct, but worth a runtime cross-check on Bun (Bun's `node:fs` shims have occasional behavioral drift from Node).
  - `bot/` correctly excluded (real Python bot dir signal). `webapp/`, `apps/`, `packages/`, `services/` correctly excluded (legitimate monorepo conventions).
- **Consequence:** Low. The specificity-first invariant (literal `name === "aura-companion"` and literal `aiogram` substring) means accidental matches in `coverage/package.json` are unlikely. But the skip list is constant-defined, name-based heuristic with no test asserting "candidates from `coverage/` are dropped" — drift hazard if the list becomes load-bearing.
- **Fix:** Either (a) add `coverage`, `.nuxt`, `.svelte-kit`, `.astro` to `SKIP_SUBDIRS` for symmetry with `.next`/`.turbo`; or (b) document the calibration explicitly with a comment near the constant: "list is name-based heuristic for SCOPE only — specificity invariant means false-positives are caught by the content match step, so this list is best-effort budget management, not security."

---

## FINDING 9

- **Title:** Concurrent invocations of `detectStack` against a workspace under live mutation can read inconsistent state mid-scan — acceptable, but undocumented
- **File:** `web/scripts/detect-stack.ts` (whole file)
- **Principle:** Principle 7 — replay determinism (read-side analogue: same workspace state → same result; mid-scan FS mutation breaks this)
- **Severity:** P3
- **What's wrong:** `detectStack` is pure-functional w.r.t. its input AT THE TIME OF EACH SYSCALL but the function makes O(prefixes × 4) syscalls in sequence with no snapshot semantics. If the user (or a parallel session sharing the workspace) creates `apps/new-package.json` while `detectStack` is scanning, the result depends on syscall ordering. For a CLI utility invoked once interactively this is fine. For the documented use case (Phase 0 of `/council-plan`, `/council-implement`, `/council-review` — potentially invoked while a council pair is actively writing checkpoints to `.council/`), there's a real path where `.council/` directory state changes mid-scan.

  `.council` IS in `SKIP_SUBDIRS` (line 97), so mutations to `.council/checkpoints/*.json` cannot affect the result. That's the relevant defense. But there's no comment documenting WHY `.council` is skipped — a future maintainer might remove it without realizing it's the mid-scan-consistency anchor.

- **Consequence:** Minimal at present. The skip-list already protects against the highest-frequency mid-scan mutation (council checkpoint writes). Risk is forward: if another council artifact dir is added outside `.council/` (e.g. `.council-cache/`) and is NOT added to the skip list, mid-scan races become observable.
- **Fix:** Add a comment near `.council` in `SKIP_SUBDIRS` explaining the mid-scan-consistency anchor: "`.council` is skipped both for noise and because council session writes happen here mid-scan — including it would allow non-deterministic results across back-to-back invocations." Documentation-only fix.

---

## Summary

| # | Severity | Title |
|---|----------|-------|
| 1 | P2 | `readdirSync` failure silently degrades to root-only — no `read_error` surfaced |
| 2 | P3 | Per-entry `lstatSync` failure silently skips — non-deterministic across re-runs |
| 3 | P2 | `MAX_CANDIDATE_SUBDIRS=64` silent cap — no log, no flag, no MarkerCheck |
| 4 | P2 | `enumerateCandidatePrefixes` bypasses `resolveMarker` — EC-7 second-site weaker; comment misleads about realpath |
| 5 | N/A | BOM tolerance preserved — verified positive |
| 6 | N/A | CRLF tolerance preserved — verified positive |
| 7 | N/A | Size caps preserved — verified positive |
| 8 | P3 | `SKIP_SUBDIRS` calibration: missing `coverage/`, `.nuxt`, `.svelte-kit`; no test for skip behavior |
| 9 | P3 | Mid-scan consistency under workspace mutation — undocumented (`.council` skip is the anchor) |

Breakdown: 0 P1, 3 P2, 3 P3, 3 N/A (positive verifications).

**Overriding-filter pass:**
1. Crash → user-visible corruption? No — this is a read-only utility, no state being mutated.
2. Every exit path closes the state row? N/A — no rows.
3. Line-terminator discipline tight? Yes — BOM+CRLF preserved (Findings 5, 6).
4. Paths validated at boundary? Mostly — `resolveMarker` is rigorous; enumeration helper is weaker (Finding 4).
5. Replay round-trip? Conditional — silent failures in enumeration break determinism (Findings 1, 2, 3).

The persistence-discipline headline: **silent failures in the new depth-1 enumeration layer break the no-silent-fallback invariant that the rest of the file explicitly upholds.** Three findings (1, 2, 3) all share that root cause; addressing them together would close the asymmetry.
