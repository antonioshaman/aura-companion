# Troy Hunt — Security Review

**Timestamp:** 2026-05-11-1957
**Scope:** Phase A+B+C security primitives — observer-write-policy, group-authorization, codex-envelope, observer-permissions, atomic-write, session-group-coordinator, council-types.

These modules are pure primitives not yet wired into routes / cli-launcher / ws-bridge. Findings call out concerns at the module level even when wiring has not yet landed, because the contracts these modules expose now will be the contracts callers depend on.

---

FINDING:
- Title: Symlink resolution must be done by every caller, but the contract is documented only — no compile-time fence
- File: web/server/observer-write-policy.ts:1-43
- Principle: Path traversal — Principle 1 ("If it's syntactically possible, it statistically exists")
- Severity: P1
- What's wrong: `isObserverWriteAllowed` is a pure string predicate that documents in a comment that callers "are expected to resolve and realpathSync the path first". A caller that hands in a non-realpathed path lets a symlink inside `.council/observer/` point at `/etc/passwd` or `~/.ssh/authorized_keys` and the predicate happily returns true because the *prefix* still looks workspace-relative. The module is one careless caller away from a workspace escape.
- Consequence: The observer half — which the design says must never leave its sandbox — can clobber arbitrary files when an attacker (or even a careless human) drops a symlink under `.council/observer/`. Same-uid filesystem write means root-owned files outside the workspace are out of reach, but the user's own dotfiles, SSH keys, gitconfig, and Claude session JSON are all in play.
- Fix: Move the realpathSync responsibility *inside* the predicate (or expose a single `assertObserverWriteAllowed(target, root)` that does resolve + realpath + predicate atomically), and document that callers must NOT pre-resolve. A footgun that only fires when callers forget a step is the same shape as path traversal bugs the OWASP top-10 has been catching for fifteen years.

---

FINDING:
- Title: Specs allow-list matches "observer" anywhere in the filename — too loose
- File: web/server/observer-write-policy.ts:37-40
- Principle: Shrink the attack surface — Principle 5
- Severity: P2
- What's wrong: The third allow-list branch permits any file under `specs/` whose name ends `.md` and whose lower-cased name *contains* the substring "observer". A prompt-injected observer that wants to overwrite a meaningful spec only needs to choose a filename like `observer-please-ignore-this-is-the-real-spec.md` or `architecture-observer-notes.md` to silently clobber writes that belong to humans.
- Consequence: The observer surface for writing into `specs/` is wider than the design intends — any creatively-named file passes. Combined with the symlink finding above, this is a write primitive that can land near canonical workspace docs.
- Fix: Pin the spec filename pattern with an anchored regex (e.g. `observer-<phase>.md` where `<phase>` matches the same `PHASE_PATTERN` used in `council-types.ts`), or drop the `specs/` branch entirely and route all observer writes through `.council/`. Whichever you pick, eliminate "substring match" as the access rule.

---

FINDING:
- Title: `parseCodexFrame` accepts an array `params` only when it is an Object — but the JSON-RPC 2.0 spec allows arrays; meanwhile arbitrary nested data is unbounded
- File: web/server/codex-envelope.ts:54-105
- Principle: Validation at every boundary — Principle 2
- Severity: P2
- What's wrong: The parser enforces `isObject(parsed.params)` for both `request` and `notification` frames — so an array-shaped params (legal per JSON-RPC 2.0) is rejected, which is good if Codex never sends them. However the parser places no depth, key-count, or nested-size cap on the object — a single envelope can carry a 10-MB nested params blob with millions of keys, and the framer will accept it and hand it downstream where the recorder will write it to disk. There is no analogue of `COUNCIL_ARTIFACT_MAX_BYTES` here.
- Consequence: A malicious or misbehaving Codex subprocess (or a hostile peer in a future networked variant) can fill recordings, RAM, or the watcher's parse buffer simply by sending a giant params object. The frame validator is the last layer that could have stopped it before recording / forwarding.
- Fix: Add a `raw.length > MAX_FRAME_BYTES` short-circuit at the top of `parseCodexFrame` (mirror `COUNCIL_ARTIFACT_MAX_BYTES` style) and a bounded-depth check on `params` (e.g. max depth 8, max keys 1024). The frame validator is the choke-point — make it choke when input is unreasonable.

---

FINDING:
- Title: `error.data` is forwarded unvalidated
- File: web/server/codex-envelope.ts:89-100
- Principle: Validation at every boundary — Principle 2
- Severity: P3
- What's wrong: The error-frame branch validates `code` and `message` but passes `err.data` through unchecked — it can be any JSON value, including a giant nested object, and it ends up in the returned `CodexFrame.error.data: unknown`. Downstream consumers receive `unknown` and may stringify, log, or forward this without further validation.
- Consequence: A malformed or hostile error frame can smuggle arbitrary structured payload into downstream paths (logs, recorder, UI). Lower severity because `unknown` forces explicit handling by typescript consumers, but a `console.log(err)` somewhere strips that protection.
- Fix: Either drop `data` from the parsed envelope, or size-cap its serialized form. The principle is the same as the frame-size cap above: a validator that forwards unbounded fields is doing half the job.

---

FINDING:
- Title: Tmp file random suffix is sound, but tmp path is hidden so `realpathSync` won't see partial writes — and there is no umask hardening
- File: web/server/atomic-write.ts:1-52
- Principle: Minimise state — Principle 3 / Assume breach — Principle 9
- Severity: P2
- What's wrong: The atomic writer uses `randomBytes(8)` (64 bits) for the tmp suffix — enough to avoid collision, fine. But two issues: (1) `openSync(tmp, "w")` uses the process umask, so on a multi-user host the tmp file (and the renamed target) may be world-readable (0644 typical). Council artifacts include checkpoint payloads with the workspace's phase contents — those can contain code, secrets the user pasted, or internal architecture. (2) There is no `O_EXCL` on the open; if a `.<rand>.tmp` somehow collides (e.g. attacker plants one), the open silently truncates a pre-existing file. Probability is tiny but the principle ("make the wrong thing impossible") points at `O_CREAT | O_EXCL`.
- Consequence: On a shared host, council artifacts are readable by other UIDs. On any host, a planted symlink at `.<predictable>.tmp` could redirect the write (combined with predictability — note the random suffix mostly defends here, but `O_EXCL` is the belt-and-braces).
- Fix: Open with explicit mode `0o600` (e.g. `openSync(tmp, "w", 0o600)`) and pass the `O_EXCL` flag via numeric flag composition. The Aura recordings dir is documented as sensitive in `CLAUDE.md` — apply the same mode discipline to council artifacts.

---

FINDING:
- Title: Size cap is on JSON string length, but JS string length is UTF-16 code units, not bytes — under-counts for multibyte content
- File: web/server/atomic-write.ts:22-27
- Principle: Validation at every boundary — Principle 2
- Severity: P3
- What's wrong: `json.length > COUNCIL_ARTIFACT_MAX_BYTES` compares string `length` (UTF-16 code units) against a byte budget named `_MAX_BYTES`. For ASCII this is equivalent; for content with multibyte UTF-8 characters (CJK, emoji, accented Latin, code comments in non-English) the actual on-disk byte count can be up to 3× the `length` check. The same pattern repeats in `parseCheckpointPayload` and `parseObserverReviewPayload`.
- Consequence: Artifacts can exceed the documented 256 KiB cap by a factor of ~3 when content is non-ASCII. Not a vulnerability per se, but the cap exists explicitly as an OOM defence for the watcher — that defence is weaker than the comment promises.
- Fix: Use `Buffer.byteLength(json, "utf8")` (or equivalent) for the size check. Same fix in the two parsers in `council-types.ts`. If you keep the `length`-based check, rename the constant to reflect what it actually measures.

---

FINDING:
- Title: `archiveGroup` swallows kill failures silently — orphaned subprocesses possible with no telemetry
- File: web/server/session-group-coordinator.ts:148-164
- Principle: Assume breach — Principle 9
- Severity: P2
- What's wrong: Both `kill` calls are wrapped in empty `try { } catch { /* swallow */ }`. If a kill fails (subprocess already dead, permission error, kernel under load), the function returns `true` and the group is marked archived even though one half may still be running with file-write access to the workspace. There is no log, no metric, no return value distinguishing "archived cleanly" from "archived but one half might still be alive".
- Consequence: An observer subprocess can outlive its group record. With nothing watching it, it continues to consume the original tool allow-list and can keep writing to `.council/observer/` long after the UI thinks the pair is gone. From an audit-trail perspective this also breaks the invariant that "archived means no further writes from either half".
- Fix: At minimum, log kill failures with the session id and the original error. Ideally return a richer result type (`{ archived: true; killFailures: string[] }`) so callers can decide whether to retry, alert, or escalate. The rollback path in `createGroup` (line 121-128) has the same shape and the same problem.

---

FINDING:
- Title: Group ID format check passes 36-char strings that are not actually `grp_` + hex
- File: web/server/group-authorization.ts:29-33
- Principle: Type system as armour — Principle 2
- Severity: P3
- What's wrong: `isWellFormedGroupId` short-circuits on `v.length === 36` *and* the regex match. Both checks are present and the regex `/^grp_[a-f0-9]{32}$/` is anchored, so a passing string is genuinely the right shape. This is fine, but the `length === 36` pre-check is redundant with the regex and creates a subtle invariant: any future change to the prefix (e.g. `grpv2_…`) will silently fail format validation because the length check still says 36. That's a latent regression vector at the security boundary.
- Consequence: A future maintainer changing `generateGroupId` to use a different prefix or longer entropy will break authorisation in a confusing way — passing IDs come back as `null` from `authorizeGroupAccess`, mapped to 404, and the user sees "group not found" with no obvious cause.
- Fix: Drop the `length === 36` line and rely on the anchored regex. Or, better, derive the regex from a single constant that also feeds `generateGroupId` so the two cannot drift.

---

FINDING:
- Title: `findBySessionId` is O(n) and unauthenticated — no rate limit boundary
- File: web/server/session-group-coordinator.ts:171-178; web/server/group-authorization.ts:42-47
- Principle: Broken access control / rate limiting — Principle 7
- Severity: P3
- What's wrong: `resolveSessionGroup` accepts any string and linearly scans every group on every call. The function itself is fine, but it is the path the existing per-session authorisation will use, and there is no bound on how often or with what input it can be called. On its own this is hygiene; combined with no rate-limiting at the route layer (a documented Aura gap per the security reference), an attacker with the host token can flood lookups.
- Consequence: Lookup cost grows with active group count. Not exploitable today (in-memory map, small N), but the pattern propagates: every route that calls `findBySessionId` inherits the unbounded-loop shape.
- Fix: When this is wired into routes, ensure rate limiting at the route boundary and a secondary index (Map<sessionId, groupId>) inside the coordinator. Today's commit is fine as a primitive but flag the wiring step.

---

FINDING:
- Title: `isRelativeWorkspacePath` rejects `..` segments but allows leading `./`, `.git/`, hidden dotfiles
- File: web/server/council-types.ts:78-83
- Principle: Path traversal — Principle 1
- Severity: P2
- What's wrong: The validator rejects absolute paths and any `..` segment — good. But it allows segments starting with `.`: `.git/config`, `.ssh/id_rsa`, `.env`, `.companion/envs/something.json` are all "relative workspace paths" by this rule. The checkpoint payload's `artifact_paths` field is therefore a primitive that, once wired, lets the orchestrator instruct the observer to read sensitive dotfile contents from the workspace root. The observer's read tools are not bounded by `isObserverWriteAllowed` — that gates writes only.
- Consequence: A prompt-injected orchestrator can publish a checkpoint listing `.git/config`, `.env`, `.ssh/...` as artifact paths, and the observer half — running with `Read`/`Grep`/`Glob` in its allow list — will fetch and process them. Content can then leak via the observer's review file back into a path the orchestrator also reads.
- Fix: Either tighten `isRelativeWorkspacePath` to reject leading-dot segments (or specifically reject `.git`, `.env`, `.ssh`, `.companion`), or add a sibling `isObserverReadAllowed` predicate and gate the observer's reads on it. The "observer can write only here" rule is half the policy — "observer can read only there" is the other half and is missing.

---

FINDING:
- Title: `isBoundedString` forbids spaces — accidentally rejects timestamps and provider names with hyphens-and-spaces, and ISO timestamps with `:`
- File: web/server/council-types.ts:70-72
- Principle: Validation at every boundary — Principle 2 / Defence-in-depth correctness
- Severity: P3
- What's wrong: `isBoundedString` rejects any string containing a space. It is used to validate `checkpoint_id`, `session_group_id`, `emitted_at`, `reviewed_at`, `observer_provider`, and finding `claim`. The space-rejection is reasonable for IDs but is applied to `emitted_at` (ISO 8601 — fine, no spaces) and `claim` — where it silently truncates any review claim that contains a space. Wait — `claim` uses `isBoundedString(f.claim, MAX_CLAIM_LEN)` at line 158, and claims are sentences. Every claim with a space gets rejected. The whole `findings` array fails validation and the entire review is dropped.
- Consequence: The observer's review pipeline is broken-by-design: a one-word review like "wrong" parses; "the foo is wrong" returns null and the review is dropped silently. This converts a P3 hygiene issue into a P1 functional bug in the security pipeline — observers' STOP findings will not be parsed. Tests presumably use single-word claims; production reviews will not. (Severity stays P2 because it is a silent-failure security pipeline degradation, not an exploit.)
- Fix: Split the validator: keep a `isBoundedToken` (no-space, for IDs/timestamps) and an `isBoundedText` (allow spaces and printable chars, for claims). Apply the right one per field. This is also the kind of bug a property test would have caught.

---

## Summary

11 findings: 1 P1, 7 P2, 3 P3.

The cluster theme: the primitives are clearly written and the *intent* of each is documented, but several security-critical contracts live in comments rather than in the type system or the function body (symlink resolution; size-cap units; allow-list scope of reads; rollback failure reporting). Each is a place where a future caller can violate the security model without breaking any check the module itself performs. The `claim` validator bug also indicates the test suite is not exercising realistic adversarial inputs — recommend property-based tests for all four validators.
