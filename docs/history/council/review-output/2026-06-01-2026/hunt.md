# Hunt (Security) — Findings for `web/scripts/detect-stack.ts`

Domain note: this is a pure pre-spawn filesystem-detection utility. No spawn, no WS, no HTTP boundary, no markdown render. The relevant security lenses are EC-7 path-resolution discipline, symlink rejection, refusal-text leakage, and silent-cap observability. Threat model is "user shoots their own foot" — the workspace is the user's own tree — but the EC-7 invariant still matters because the tool is invoked by an autonomous skill harness on whatever directory the user happens to have cd'd into.

---

FINDING:
- Title: `enumerateCandidatePrefixes` bypasses the canonical `resolveMarker` EC-7 wrapper
- File: web/scripts/detect-stack.ts:231-259
- Principle: Principle 2 (Automate defences — make the wrong thing impossible) + project convention EC-7
- Severity: P2
- What's wrong: The file's stated convention (lines 12-14, header comment) is that "every marker access goes through `resolveMarker`". The new helper instead re-implements the symlink/bounds check inline: it calls `lstatSync` and rejects on `isSymbolicLink()`, but never calls `realpathSync` to verify the final resolved path stays inside `rootResolved`. `resolveMarker` does both; this helper does only the lstat half.
- Consequence: A non-symlink directory at depth 1 whose **own contents** include a symlinked `package.json` / `pyproject.toml` will still be opened by the probe functions, because the probes call `resolveMarker` per-file and that catches it — but the EC-7 invariant ("filesystem-access predicates inline path resolution OR exposed only via a resolving wrapper") is now violated at the directory level. The next refactor that adds, e.g., a directory-level marker check inside `enumerateCandidatePrefixes` will silently lose bounds-checking.
- Fix: Route the directory check through `resolveMarker(rootResolved, name)` and reuse its result. The current per-file `resolveMarker` calls downstream save this from being exploitable today, but the convention floor should be restored at the access site, not relied on transitively.

---

FINDING:
- Title: `Dirent.isDirectory()` follows-symlink ambiguity is mitigated only by a redundant `lstatSync`
- File: web/scripts/detect-stack.ts:245-254
- Principle: Principle 1 (If syntactically possible, it statistically exists)
- Severity: P3
- What's wrong: The inline comment on line 245 asserts "also rejects symlinks (isDirectory false on dirent symlinks)". This is misleading: `Dirent.isDirectory()` reflects the `d_type` byte from `readdir`, which for symlinks to directories is `DT_LNK` (returns `false` on `isDirectory()`) — but on filesystems that return `DT_UNKNOWN` (some NFS/FUSE/network mounts), Node falls back to a `stat`-style probe that **does** follow the symlink, so `isDirectory()` can return `true` for a symlinked dir. The code is saved by the subsequent `lstatSync` + `isSymbolicLink()` reject on lines 250-254, but the comment encodes a false invariant.
- Consequence: A future cleanup pass that trusts the comment and removes the "redundant" `lstatSync` would silently let symlinked directories into the candidate list on filesystems where `d_type` is `DT_UNKNOWN`.
- Fix: Either drop the misleading comment or rewrite it to say "Dirent.isDirectory() is unreliable for symlinks on filesystems that return DT_UNKNOWN; the lstatSync below is the actual gate." Mark the lstat call as load-bearing, not defensive duplication.

---

FINDING:
- Title: `MAX_CANDIDATE_SUBDIRS=64` silent cap with no diagnostic emit
- File: web/scripts/detect-stack.ts:101, 239-244
- Principle: Principle 9 (Assume breach — design for failure) — "absence of evidence is not evidence of absence"
- Severity: P3
- What's wrong: When a workspace has more than 64 depth-1 directories, the loop silently stops. There is no warning, no log line, no field in `DetectionResult` indicating truncation occurred. Counter increments inside the loop body (line 256) only for accepted entries — so 64 skipped dirs (hidden + node_modules + etc.) followed by the real `web/` would still leave room, but if the real marker dir sorts beyond position 64 of accepted entries in `readdirSync` order (which is filesystem-defined, not guaranteed alphabetical), it is silently skipped.
- Consequence: A user with a deep-multi-monorepo (rare but possible) sees `kind: "unknown"` and a refusal listing — they cannot tell whether their `services/web/` was not found because it doesn't exist or because the cap truncated before reaching it. Pre-image is "user shoots own foot" but the diagnostic gap turns a recoverable misconfiguration into an unobservable one.
- Fix: Add a `candidatesTruncated: boolean` field to `DetectionResult` set when the cap is hit, and surface it in `renderRefusal` as a one-line note ("Scan capped at 64 subdirs — increase or move marker closer to root"). No need for a configuration knob.

---

FINDING:
- Title: Refusal text enumerates subdirectory names from the workspace
- File: web/scripts/detect-stack.ts:702-713
- Principle: Principle 3 (Minimise state — you cannot lose what you do not have)
- Severity: P3
- What's wrong: With depth-1 scan enabled, `result.checked` accumulates `MarkerCheck` entries whose `path` field contains `<subdir>/package.json`, `<subdir>/pyproject.toml`, etc. `renderRefusal` prints every `present === true` entry under "Found at workspace root:" using the user-visible `c.path`. If a subdir is named to reveal sensitive intent (e.g. `acquisition-target-acme/`, `client-secret-tokens/`, `nda-foo-deal/`), the refusal output enumerates that directory name verbatim whenever that subdir happens to contain a probed marker file (package.json or pyproject.toml).
- Consequence: A user pasting the refusal output into a bug report, Slack, or a public Linear issue inadvertently discloses the structure of sibling directories they did not intend to expose. Existing root-only scan never had this property because only canonical paths (`web/package.json`, `pyproject.toml`) were ever printed.
- Fix: When the matched marker is in a depth-1 subdir, either redact the subdir segment (print `<subdir>/package.json`) or document the disclosure in the function header. The literal name is needed for the user to know which subdir to act on, so this is a P3 documentation concern, not a P1 leak — but it should be acknowledged.

---

FINDING:
- Title: Override-conflict refusal text safely round-trips the override value
- File: web/scripts/detect-stack.ts:685-695
- Principle: Principle 1 (If syntactically possible, it statistically exists)
- Severity: P3 (no issue — verification note)
- What's wrong: Nothing exploitable. `result.overrideConflictAsserted` is typed `"aura" | "python"` and only set on the `override.value !== null` branch (line 553), which is reached only after `readOverride` validated `trimmed` against the closed `OVERRIDE_VALUES` allow-list (line 490). The render branch substitutes `?` if the field is somehow undefined. No untrusted text from the override file reaches the refusal output.
- Consequence: None — verified clean.
- Fix: None needed. Worth a single-line code comment on line 685 noting "asserted is closed-enum, no escape needed" to lock the contract.

---

FINDING:
- Title: `readdirSync` basename trust is sound on Linux but undocumented
- File: web/scripts/detect-stack.ts:240-256
- Principle: Principle 1 (If syntactically possible, it statistically exists)
- Severity: P3 (verification note, no fix required)
- What's wrong: `entry.name` from `readdirSync({withFileTypes:true})` is a single path segment — POSIX filesystems forbid `/` in filenames, and `..` is a real directory entry filtered by the `name.startsWith(".")` check on line 243. The subsequent `join(rootResolved, name)` cannot escape the workspace via `name` alone. On Windows with NTFS, `:` and `\` in filenames are also forbidden by the OS layer. So traversal via `entry.name` is structurally impossible.
- Consequence: None — verified clean.
- Fix: None. The `relativeMarker.includes("..")` guard in `resolveMarker` already covers the defensive case if a caller ever passes a multi-segment prefix.

---

FINDING:
- Title: BOM / CRLF / size-cap discipline preserved across refactor
- File: web/scripts/detect-stack.ts:192-214, 438
- Principle: Principle 2 (Automate defences)
- Severity: P3 (verification note, no fix required)
- What's wrong: I verified that `readText` still strips the UTF-8 BOM (line 210), enforces `SIZE_CAP` (line 198), and the requirements probe still uses the CRLF-tolerant regex `/^aiogram\b/m` (line 438). The refactor that added the `prefix` parameter to each probe did not weaken any of these. `package.json` parsing still goes through `JSON.parse` with a `try`/`catch` (lines 300-304) — no eval or unsafe parse path.
- Consequence: None — defensive shape intact.
- Fix: None.

---

## Summary

- P1: 0
- P2: 1 (EC-7 boundary regression in `enumerateCandidatePrefixes`)
- P3: 5 (Dirent semantics comment, silent cap diagnostic, subdir name disclosure, two verification notes)

The dominant concern is the EC-7 boundary: the new helper does symlink-reject inline but skips the `realpathSync` bounds-check half of the canonical wrapper. The pipeline is not exploitable today (downstream `resolveMarker` per-file rescues it), but the convention floor declared by the file header is violated at the new access site. Everything else is either verification (clean) or hygiene around the new monorepo-mode disclosure surface.
