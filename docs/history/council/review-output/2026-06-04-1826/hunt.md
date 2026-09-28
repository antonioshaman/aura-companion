# Hunt (Security) — 2nd Pass Review

**Burndown verification for PR #91 (commit `9d922c0`).**

**Closed-loop check on first-review items in scope:**

- **P2 #8 (parent dir 0o700)** — `atomic-write.ts:35` now passes `mode: 0o700` to `mkdirSync` and follows with `chmodSync(dir, 0o700)`. Address of the immediate parent IS tightened in the common case. Two residual gaps surfaced below as new findings.
- **P2 #10 (clock-skew clamp)** — `anthropic-models-cache.ts:821` correctly wraps the comparison in `Math.max(0, now - r.fetched_at)`. Closed.
- **P2 #11 (`AbortSignal.any` silent demote)** — `resolveCoalescedSignal` at `:588-605` now preserves the parent signal when `AbortSignal.any` is unavailable and emits a structured warn once-per-process. The semantic flip (drop timeout instead of drop parent) is documented at `:651-664` and is the explicitly accepted tradeoff. No new SSRF/abort-bypass introduced — `ANTHROPIC_MODELS_URL` remains a module-scope constant; `resolveCoalescedSignal` does not touch the URL, the API key, or the request body.
- **Key-fingerprint discipline** — `writeDiskCache` at `:998-1005` still runs the suffix-substring assertion; the new `signal-coalesce-degraded` warn at `:599-602` emits only `event` + a literal `reason` string, no fingerprint or key bytes leak.
- **Hostile fixture** — verified byte-for-byte. The bidi controls (U+202E, U+202C), tab (`\t`), C1 control (U+0085), 138-char overlong id, and 400+ char display_name are all rejected by `isBoundedSafeString` before they ever leave the parser. The fixture is consumed only by parser unit tests — it never reaches a real browser DOM, a CLI argv, or a log emission. No accidental real attack vector introduced.

**New findings introduced by the burndown:** 2 (1 P2, 1 P3).

---

FINDING:
- Title: `chmodSync` best-effort swallow re-opens the exact metadata side-channel the fix was meant to close
- File: `web/server/atomic-write.ts:36-46`
- Principle: Principle 3 (Minimise state — the less you store, the less you lose) — Hunt's "side-channel via parent-dir listing"
- Severity: P2
- What's wrong: The `chmodSync(dir, 0o700)` is wrapped in a bare `try { ... } catch { /* best-effort */ }` that swallows every error, including EPERM. The original P2 #8 finding identified the threat as **directory-listing metadata leakage on multi-UID hosts** (filename + mtime of `anthropic_models_cache.json` reveals an Anthropic key is configured and when the user last opened a session). On that exact threat model, the parent dir already exists with broader perms from a prior writer running under a different UID — and `chmod` against a non-owned directory returns EPERM, which the burndown silently swallows. The inline comment "file 0o600 is the primary defence" misses the point: file mode does not gate `ls` of the parent directory. The fix can no-op on the platform it was designed for, with no log trail.
- Consequence: On shared-tenant Linux hosts the original side-channel (filename + mtime reveal user-level activity and key-configured status) persists undetected. Operator believes 0o700 landed; `ls -la ~/.companion/` from another UID still works because chmod was silently EPERM'd at server boot.
- Fix: Distinguish EPERM from EACCES/ENOTDIR/ELOOP. On EPERM, emit a structured WARN once (parent-dir-mode-degraded) so an operator can see the silent regression. Optionally `lstat` the dir and assert mode-bits → 0o700; if not, log loudly. Keep the swallow only for the "already correctly-tightened by a prior writer" case (stat says 0o700 → no-op silently).

---

FINDING:
- Title: Intermediate parent dirs created by `recursive: true` retain umask-default perms — `COMPANION_HOME` itself never tightened
- File: `web/server/atomic-write.ts:35-43`
- Principle: Principle 3 (Minimise state) + Principle 5 (Shrink the attack surface — every dir is a metadata egress)
- Severity: P3
- What's wrong: `mkdirSync(dir, { recursive: true, mode: 0o700 })` creates EACH intermediate level with `mode & ~umask`, not 0o700 deterministic. The subsequent `chmodSync(dir, 0o700)` only tightens the leaf — never `COMPANION_HOME` itself or any intermediate. The first-review fix proposed (verbatim from FINAL-REVIEW.md P2 #8 Fix paragraph): "pair with a one-shot `chmodSync(COMPANION_HOME, 0o700)` on module load to retrofit existing installs." This module-load retrofit was NOT delivered. A fresh install with `umask 022` lands `~/.companion/` at 0o755 (world-readable); writeAtomicJson then tightens `~/.companion/envs/<profile>/` to 0o700 but `ls -la ~/.companion/` still reveals every subdirectory name (recordings, envs, sessions, cache).
- Consequence: On every default-umask Linux/macOS install, the `COMPANION_HOME` root remains world-readable indefinitely. Directory listing discloses the user's Companion topology (which features are configured, when each was last touched). The leaf-only fix is a partial close — it addresses the per-writer dir, not the canonical home.
- Fix: Add a one-shot `chmodSync(COMPANION_HOME, 0o700)` at the top of `paths.ts` (or as an explicit `ensureCompanionHomePerms()` called from server bootstrap), idempotent and best-effort with a structured WARN on failure. This was the explicit first-review prescription and was missed in burndown.
