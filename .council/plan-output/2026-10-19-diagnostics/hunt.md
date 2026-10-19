# Troy Hunt — security recommendations for Diagnostics page + KB/memory analyzer v1

Grounding (verified in the repo, not assumed): bearer/cookie auth middleware sits at `web/server/routes.ts` line ~411 and protects every route registered after it; `stats-routes.ts` is deliberately registered BEFORE it (public). The `companion_auth` cookie is `httpOnly` + `SameSite=Strict`, so cross-site form POSTs do not ride on it. `web/scripts/kb-health.ts` already has the archive-before-rewrite move, per-line fail-closed parsing, and preserves unparseable rows verbatim. `web/server/atomic-write.ts` writes 0600 files in 0700 dirs with a byte cap. EC-7 (resolving wrapper), EC-23 (no raw paths in logs) and the sweep preview-token pattern (`routes.ts` ~817-890) are the existing patterns to reuse. `MessageBubble.tsx` renders markdown via react-markdown without raw HTML.

RECOMMENDATION 1
- Title: Register all four diagnostics routes behind the existing auth middleware, and keep the feature off the WebSocket entirely
- AC defended: AC6, AC8, AC9, Must (spec §5)
- Principle: Principle 7 — Assertions as tripwires: routes without auth middleware; Principle 4 — WebSocket auth
- What to get right: The new `register<Diagnostics>Routes` call must be placed after the bearer/cookie middleware in `routes.ts`, not next to `stats-routes.ts` which is intentionally public. The overview exposes MainPID, versions, session ids, pair ids and drift reasons, and the two POSTs mutate the KB and the decisions log, so none of them may be reachable unauthenticated, and a route-level test should prove a request with no token gets 401 for all four. Resist adding a WS broadcast of report findings or runtime data; the spec says REST-only and polling keeps the surface inside the already-audited auth boundary.
- Risk if skipped: Anyone on the LAN (or anyone who can reach the prod box's port) reads the operator's runtime topology and archives KB lines without a token.
- Depends on: —

RECOMMENDATION 2
- Title: No filesystem path ever comes from a request; the KB dir, reports dir and memory dir are three server-side constants resolved once
- AC defended: AC7, AC8, AC9, Must (spec §5)
- Principle: Principle 1 — Path traversal; EC-7 resolving wrapper
- What to get right: The decisions body carries only entry ids, a decision keyword and an optional merge target; the run body carries nothing (or only a boolean "include memory"). The server derives the KB directory from its own repo root, the reports directory from `COMPANION_HOME`, and the memory directory from the server's own project slug (the same slug derivation the drift detector already documents, with the `/` and `_` to `-` collapse) — never from a session's `cwd`, a query parameter or a header. Each of the three roots is realpath-resolved once at module init and every file touched beneath them is checked to be inside that resolved root, with symlinks rejected, exactly as EC-7 requires for `isObserverWriteAllowed`.
- Risk if skipped: A crafted decision or query parameter turns the "archive" move or the memory read into a read/write of an arbitrary file under the service user's home, including `.claude/.credentials.json`.
- Depends on: —

RECOMMENDATION 3
- Title: The current report is the authorization capability for decisions — validate runId, entryId, decision and mergeInto against it, and only it
- AC defended: AC7, AC8
- Principle: Principle 7 — Session ID as authorisation / IDOR; Principle 2 — validation at every Hono boundary (same shape as the sweep preview token)
- What to get right: The decisions handler loads the latest report from disk, and accepts an item only if the body's runId equals that report's runId, the entryId is one the report actually flagged, the decision is one of the four known keywords, and `mergeInto` (when present) is also an entry in the same report and differs from entryId; anything else is a 400 for the whole batch, and a runId that is not the latest is a 409 so a stale tab cannot act on findings it no longer sees. Bound the array length (a few hundred is plenty), reject duplicate entryIds in one batch, and strip unknown fields rather than persisting them. Server-side generated values — timestamp and `by: "owner"` — are set by the handler, never read from the body.
- Risk if skipped: Any string posted as an entryId becomes a mutation of the KB, so a buggy or malicious client archives entries that were never proposed, which is exactly the "automatic edit" the owner forbade.
- Depends on: 2

RECOMMENDATION 4
- Title: Make the memory report structurally unable to write — read-only module, bounded reads, fs-spy test
- AC defended: AC9, Must (spec §5)
- Principle: Principle 1 — If it's syntactically possible, it statistically exists (make the wrong thing impossible)
- What to get right: The memory analyzer lives in its own module that imports only read and stat primitives, takes the resolved memory root as an argument and returns findings; it never receives a writer, and no code path in the decisions handler branches on memory findings except to append a `seen` line to `decisions.jsonl` under `COMPANION_HOME`. Cap what it reads (file count, per-file bytes, total bytes) so a 2.2 MB directory that grows cannot stall the event loop or blow the 100 ms `trackSync` budget, and skip anything that is not a regular file. The AC9 test must spy on every write-capable fs call and assert zero calls whose path starts with the memory root, not merely assert the directory looks the same afterwards.
- Risk if skipped: One refactor that "helpfully" stamps a `reviewedAt` into a memory file violates the owner's hardest rule, silently and permanently.
- Depends on: 2

RECOMMENDATION 5
- Title: Archive by id through the extracted kb-health module in-process — no subprocess, no shell, archive-before-rewrite preserved
- AC defended: AC7, AC8
- Principle: Principle 1 — Command injection (the #1 risk in this stack); Principle 9 — assume breach / design for failure
- What to get right: The brief already says extract `kb-health.ts` rather than shell out; make that a hard rule: the analyzer and the decisions handler must contain no spawn of `bun`, `git` or anything else, because entry ids and file names would otherwise become argv. Add a narrow "archive these ids" function next to `pruneKb` that reuses the same ordering (append to the archive store first, rewrite the live store second, both atomic) so a crash duplicates rather than loses a line, preserves unparseable rows verbatim, and treats an id that is already absent from the live store as a no-op success. The `keep` decision's `reviewedAt` and the `merge` decision's `mergePending` belong in the report or decisions log, not in the KB line, so the only KB write the whole feature performs is the archive move.
- Risk if skipped: A shell-out turns every KB id into an injection point and loses the byte-exact "nothing deleted" guarantee the tests have to prove.
- Depends on: 2, 3

RECOMMENDATION 6
- Title: Treat KB and memory text as untrusted content in the cards — plain text rendering, no raw HTML, no link construction from entry fields
- AC defended: AC7, AC9, Must (spec §5)
- Principle: Principle 1 — XSS in chat content (stored variant)
- What to get right: `fact`, `recommendation`, `tags`, `affectedFiles`, `provenance.reference`, memory `name`/`description` and any body excerpt were written by agents that echo tool output, web pages and user pastes, so they are stored, replayable attacker-reachable strings. Render them as React text nodes (auto-escaped); never use `dangerouslySetInnerHTML`, never a markdown renderer with raw HTML enabled, and if markdown is wanted reuse the react-markdown setup from `MessageBubble` which keeps HTML off. Do not turn `affectedFiles` or `provenance.reference` into clickable hrefs or image sources, and do not render memory file bodies at all — name, description, signal and a path relative to the memory root are enough to decide "seen". Truncate long fields in the card so a multi-megabyte `fact` cannot freeze the page.
- Risk if skipped: A poisoned KB line (one `/learn` from a compromised web page) executes in the operator's authenticated tab and can call the decisions endpoint with the real token.
- Depends on: —

RECOMMENDATION 7
- Title: Classify upstream state into an enum; never forward raw upstream error bodies, tokens or stack traces through the overview
- AC defended: AC3, Must (spec §5)
- Principle: Principle 3 — Minimise state; Principle 9 — stack traces in error responses
- What to get right: The Usage card needs only a status keyword (ok, kv-quota, oauth-expired, unreachable, unknown), the time of the last success and the time the current state began; the server maps the upstream status code to that keyword and discards the body. `usage-limits.ts` handles OAuth refresh and its failure messages can carry grant details, so none of its error strings may be copied into the overview JSON or into the diagnostics log line. Same discipline for every card: the Backend card exposes counters and versions, not env vars, argv or absolute cwd; the Pairs card exposes ids, roles, states and ages, not checkpoint or prompt content; every error response from the four routes is a fixed generic message with detail logged server-side only.
- Risk if skipped: The overview becomes a convenient one-call dump of the host's OAuth refresh failure text and process topology for anyone holding or guessing the token.
- Depends on: 1

RECOMMENDATION 8
- Title: Single-flight is a server-side mutex with a cooldown, and the memory flag is enforced on the server, not by hiding a button
- AC defended: AC6, Must (spec §5)
- Principle: Principle 7 — Rate limiting absent on expensive endpoints; Principle 5 — shrink the attack surface
- What to get right: The in-flight guard lives in the analyzer service as a single promise or boolean that the run route consults and sets atomically before any work starts, so two concurrent POSTs cannot both pass; the 409 is the result of that guard, not of the UI's disabled state. Add a short minimum interval between manual runs (tens of seconds) so a looping client cannot keep the event loop busy re-reading the KB, and make the hourly ticker use the same guard so a manual run and a scheduled run never overlap. A run that includes the memory report must be refused by the server when `diagnosticsMemoryReport` is off, regardless of what the client sent.
- Risk if skipped: A stuck tab or a leaked token becomes a CPU denial-of-service against the prod box that also hosts live council sessions, and "default off" for memory analysis becomes a client-side suggestion.
- Depends on: 1

RECOMMENDATION 9
- Title: Bound the new settings keys at the route boundary and in `normalize`
- AC defended: AC4, AC5
- Principle: Principle 2 — Automate defences: validation at every Hono boundary, no boundary `any`
- What to get right: `newEntriesThreshold`, `sessionsThreshold` and `maxAgeDays` must be accepted only as finite positive integers inside explicit ranges (for example 1 to 1000 entries, 1 to 10000 sessions, 1 to 365 days) both in `settings-routes.ts` and in `settings-manager.ts`'s `normalize`, falling back to the defaults for anything else, and `diagnosticsMemoryReport` must be a strict boolean. Add the keys to the explicit `Pick` allow-list in `updateSettings` so they are patchable on purpose, and write the settings test that proves a zero, negative, string or NaN threshold does not land on disk.
- Risk if skipped: A threshold of zero makes the analyzer "due" every hour, rotating report files and rereading the KB forever; a huge `maxAgeDays` silently disables the safety net.
- Depends on: —

RECOMMENDATION 10
- Title: Reports are written atomically with 0600 and a byte cap; the "keep last 20" rotation is the only deletion in the feature and must be bounded by a strict filename pattern
- AC defended: AC5, AC7, Must (spec §5)
- Principle: Principle 1 — Path traversal (on the delete side); Principle 3 — minimise state
- What to get right: Reports go through `writeAtomicJson` with a sensible `maxBytes` (the council-artifact default is a reasonable ceiling) so one runaway KB cannot fill the disk, with `runId` generated server-side and the filename built only from a server timestamp and that id. The rotation step enumerates the resolved reports directory, considers only regular files whose names match the exact report pattern, never follows symlinks, and explicitly excludes `decisions.jsonl`; it must never be given a path derived from any other source. Put a test on it that plants a stray symlink and a decoy file in the directory and asserts both survive.
- Risk if skipped: The one `unlink` in the feature is pointed at the wrong file (the decisions log, or something a symlink points at) and the owner's audit trail or a KB store disappears.
- Depends on: 2

RECOMMENDATION 11
- Title: `decisions.jsonl` is append-only via a single O_APPEND write per batch, server-stamped, and read back fail-closed per line
- AC defended: AC8, AC9
- Principle: Principle 9 — assume breach: design for failure; Principle 3 — state hygiene
- What to get right: Follow the `usage.log` discipline from `kb-health.ts`: one appended write per decisions batch, lines produced by the server from already-validated fields with `ts` and `by` set in the handler, and no code path that rewrites or truncates the file. When the analyzer reads decisions back (to honour the 90-day `keep` suppression and to exclude `mergePending` pairs), it must skip malformed lines with a counted warning rather than abort, so a half-written line after a crash cannot either wipe the history or make a suppressed entry reappear as a fresh finding. Treat the file as the audit trail for the one destructive action in the feature, and make the AC8 test assert that the archive move and the decisions line are both present after the call.
- Risk if skipped: A rewrite-in-place path or a hard parse failure erases the only record of what was archived and why.
- Depends on: 3

RECOMMENDATION 12
- Title: `dead-reference` checks resolve agent-written paths inside the repo root only; log lines and findings carry relative paths or hashes, not absolute ones
- AC defended: AC7, Must (spec §5)
- Principle: Principle 1 — path traversal; EC-23 (no raw filesystem paths in structured logs); Principle 6 — code transparent to analysis
- What to get right: `affectedFiles` and `provenance.reference` are free-form strings written by agents; the existence check must refuse absolute paths, anything containing `..`, and anything that resolves (via realpath) outside the repo root, reporting those as "dead" rather than probing the real filesystem for them. The `event=kb_analysis.*` log lines may carry counts, ids, runId and durations but never the paths themselves (EC-23); the on-disk report and the overview JSON may carry repo-relative or memory-root-relative paths only, never the service user's home directory prefix. Apply the same rule to the memory `dead-reference` signal, whose inputs are paths pulled out of markdown bodies.
- Risk if skipped: A KB line with an absolute path becomes a file-existence oracle for the whole host, and the structured logs start leaking the operator's topology into journald and any future log sink.
- Depends on: 2
