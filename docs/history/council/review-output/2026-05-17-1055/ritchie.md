# ritchie — Unix-discipline §A Process Lifecycle / §B Filesystem Persistence (read-side)

Scope: `web/scripts/detect-stack.ts` + `web/scripts/detect-stack.test.ts`.

---

## §A — Process Lifecycle

NOT IN SCOPE. The feature spawns no subprocess, registers no signal handler, opens no socket, manages no FIFO/pipe. The detector is a pure synchronous read against the workspace filesystem. No §A findings.

---

## §B — Filesystem Persistence (read-side)

### 1. Intermediate directory symlinks are not rejected, only out-of-root ones
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:104-134` |
| **Principle** | quality-ritchie.md §B Principle 1 (resolving-wrapper EC-7 idiom must catch ALL symlink traversal paths) |
**Finding:** `resolveMarker` uses `lstatSync` on the final candidate path, which only inspects the leaf component — intermediate directory symlinks (e.g. `web/` itself replaced by a symlink to a sibling directory) are followed silently by the underlying syscalls and slip past the `isSymbolicLink()` rejection. The realpath bounds-check that follows catches symlinks that escape the workspace, but a `web/` directory-symlink pointing back inside the same workspace passes both gates while still being a symlink that the spec intends to reject.
**Consequence:** A malicious or accidentally-created in-root directory symlink (e.g. a project where `web` symlinks to `packages/web`) is read as if it were a real directory, defeating the stated "refuse symlink leaves outright" contract for any marker whose parent path component is a symlink rather than a real directory.
**Fix:** Walk each intermediate path component with `lstatSync` and reject if any component is a symbolic link, OR explicitly document that the bounds-check is the only guarantee and the symlink-rejection applies to the leaf only — and update the leaf-vs-mid-path distinction in the test suite to lock the chosen contract.

### 2. CRLF regex is correct for `\r\n` line endings but the test does not cover a leading-CRLF file
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:340` / `web/scripts/detect-stack.test.ts:231-235` |
| **Principle** | quality-ritchie.md §B Principle 2 (encoding edge cases need positive evidence per variant — CRLF only counts when tested) |
**Finding:** The regex `/^aiogram\b/m` is in fact CRLF-tolerant in JavaScript's `m` mode because `^` anchors after `\n` regardless of any preceding `\r`, and the existing test exercises the `aiogram\r\n...` case at file start. However the dual case — a file whose FIRST line is `\r\n` or any other CRLF noise BEFORE the `aiogram` line — is not exercised, so a regression that changed the regex to `/^aiogram\b/` (no `m`) or `/^[A-Za-z]/m` order would only be caught by the start-of-file case, not the mid-file case.
**Consequence:** Notepad/Windows-authored `requirements.txt` files where the maintainer left a `\r\n` header line before `aiogram==3.7\r\n` would fail Python detection silently if the regex flags were ever changed; the current test would still pass.
**Fix:** Add one test that writes `\r\nrequests\r\naiogram==3.7\r\n` (aiogram on a non-first line, CRLF endings throughout) and asserts `python`. Two-line minimum is the bright line that distinguishes "anchored-at-byte-zero accident" from "true multiline anchor".

### 3. Whitespace-only override file is handled correctly but not under test
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:383-391` / `web/scripts/detect-stack.test.ts:274-284` |
| **Principle** | quality-ritchie.md §B Principle 4 (defensive-read code paths require positive test evidence, not just code presence — `feedback_recovery_branch_reachability.md`) |
**Finding:** The override reader calls `read.text.trim() === ""` so empty, whitespace-only, and newline-only files all reach the `malformed: true` branch. The existing test covers only the literal empty-string case (`writeFileSync(..., "")`); the spaces-and-newlines case (`"   \n\n"`) is not exercised. Code is correct but a future refactor that swapped `trim()` for `length === 0` would slip through.
**Consequence:** A user who accidentally saves the override file with their editor's "ensure trailing newline" setting on (yielding `"\n"`) is correctly refused today, but a regression could silently change that to a default — and current test suite would not catch it.
**Fix:** Add a test that writes `"   \n"` (or `"\t\n"`) to the override file and asserts `kind === "unknown"`, `overrideMalformed === true`. Locks the trim contract.

### 4. The `..` traversal check is over-broad — rejects legitimate filenames containing the literal substring
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:108` |
| **Principle** | quality-ritchie.md §B Principle 3 (path-validation predicates should reject precisely the traversal class, not a superstring) |
**Finding:** The check `relativeMarker.includes("..")` rejects any marker whose name happens to contain a double-dot anywhere — `node_modules..backup`, `web/foo..bar/package.json`, etc. With the current closed marker allow-list this never fires, but the predicate is a load-bearing safety gate whose specification is "reject parent traversal", not "reject the byte sequence `..` anywhere". A future marker addition (e.g. a versioned `pyproject..v2.toml`) would be silently rejected with reason `out_of_bounds`, which is misleading.
**Consequence:** The predicate is fail-closed today but its specification drifts from its implementation; a future marker addition could silently never match, with a reason code that misdescribes the cause.
**Fix:** Split into `..` ONLY as a path segment (`relativeMarker.split("/").includes("..")`) plus a check for absolute paths and Windows-style `\` separators. Keeps the safety intent, sheds the byte-sequence false positives.

### 5. Best-effort cleanup swallows errors silently — parallel-test interference can hide
| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:41-49` |
| **Principle** | quality-ritchie.md §B Principle 5 (test fixtures must be self-cleaning and parallel-safe; cleanup failures should surface, not silently swallow) |
**Finding:** The `afterEach` cleanup wraps `rmSync` in `try {} catch {}` with a `// best effort` comment. This is the right default to prevent one flaky test from cascading failures, but combined with `mkdtempSync` under `os.tmpdir()` it means a CI run that accumulates undeleted workspaces per failed test will silently grow `/tmp` over time, and the symlink-mid-path test in particular (which writes into a SECOND workspace via `newWorkspace()`) leaves two dirs behind on rm failure.
**Consequence:** On a heavily parallel CI with hundreds of test files, leaked `/tmp/detect-stack-XXXX` dirs accumulate and either trip a "too many files" canary or, worse, get reused by name-collision in some filesystems with truncated random suffixes.
**Fix:** Log the failure (`console.warn`) when `rmSync` throws so CI noise surfaces leaks; alternatively wrap in `rmSync(..., {recursive: true, force: true, maxRetries: 3})` to handle EBUSY on Linux without swallowing the final failure.

### 6. `isDirectory` re-stats the bot path after `resolveMarker` already stat'd it
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:169-177`, `293-326` |
| **Principle** | quality-ritchie.md §B Principle 6 (single-syscall-per-read discipline; double-stat opens a TOCTOU window) |
**Finding:** `probeRequirementsAndBot` calls `resolveMarker(rootResolved, "bot")` which `lstatSync`s the path and rejects symlinks, then calls `isDirectory(botRes.absolute)` which `lstatSync`s the same path AGAIN to confirm it's a directory. Between the two stats there is a small TOCTOU window where `bot` could be replaced (unlikely in practice, but the second stat is also redundant work). The first stat already has the information needed (`lstatSync` returns both `isSymbolicLink` and `isDirectory`).
**Consequence:** Defensive-coding hygiene — two syscalls where one would do; correctness is fine.
**Fix:** Have `resolveMarker` return the `lstat` result alongside the absolute path on the `ok: true` branch (or expose a sibling `resolveMarkerWithStat`), and use that stat in `probeRequirementsAndBot` instead of re-calling `lstatSync`.

### 7. JSON parse on `package.json` does not enforce object-typed root
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:213-226` |
| **Principle** | quality-ritchie.md §B Principle 7 (schema-validate parsed structured payloads; structural type-check before key access) |
**Finding:** After `JSON.parse(read.text)`, the code coerces `pkg` to an object only if `typeof pkg === "object"`, which accepts arrays (`Array.isArray(["aura-companion"])` is `true` and `typeof []` is `"object"`). A file containing the literal JSON `["aura-companion"]` parses fine, becomes an empty record after the coercion (`obj["name"]` on an array indexed by string `"name"` is `undefined`), and falls through to `matched: false`. This is fail-closed today but the type-check does not match its stated intent ("object" means "JSON object" in the protocol sense, not "non-primitive").
**Consequence:** A weird-but-valid JSON file (top-level array, or `null`) is silently treated as "no markers matched" rather than "json_parse"/"malformed-shape" — the user sees `unknown` with no parse error, which is misleading enumeration.
**Fix:** After parsing, additionally reject `Array.isArray(pkg)` and `pkg === null` — record `reason: "json_parse"` to keep the refusal enumeration accurate. One extra line, no behaviour change for well-formed inputs.

---

Findings written to /home/auracomp/aura-companion-v2-test-2/.council/review-output/2026-05-17-1055/ritchie.md — 7 findings (0 P1, 1 P2, 6 P3)
