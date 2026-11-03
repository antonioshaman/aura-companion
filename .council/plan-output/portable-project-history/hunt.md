# Hunt — security planning recommendations

Read security.md, binding spec, context brief, existing secret-redaction.ts, atomic-write.ts and routes.ts auth/continuation seams. Recommendations are preventive design requirements, not claims of existing vulnerabilities.

RECOMMENDATION:
- Title: Make imports inert, bounded data with no extraction paths (AC5, AC6, AC9)
- Principle: 1 — If it is syntactically possible, it statistically exists; 2 — validation at every boundary.
- What to get right: Prefer one versioned JSON document, runtime-validated before persistence, with published byte, session/message, string and nesting limits; reject unsupported versions, malformed types and unsafe object keys. Generate archive storage ids on the server, validate route ids and resolve paths beneath a dedicated private archive root; imported cwd, filenames, attachment names and session ids must never become filesystem destinations or live session keys. Validate fully before one atomic durable commit so failed imports leave prior archives unchanged.
- Risk if skipped: An attacker supplies traversal filenames or oversized/deep JSON to overwrite host files, poison live state or exhaust the Bun event loop/memory.
- Depends on: Fowler archive schema/store task.

RECOMMENDATION:
- Title: Export a redacted allowlist, never a persisted session object (AC2, AC3)
- Principle: 3 — Minimise state.
- What to get right: Construct an explicit archive DTO containing only supported historical fields, excluding env/config/auth/raw protocol/process identity/permission state, then apply the existing structured/text redactor to every textual value including metadata and tool-input/result JSON; do not trust historical redaction stamps. Reapply policy to imported data before storage/display/download and stamp policy version while warning that arbitrary text and binary attachments need human review; preserve available inline attachments without treating paths/URLs as fetch instructions. Use writeAtomicJson with a deliberate finite size cap and private directory/file permissions, and log only ids/error codes rather than bodies or archive snippets.
- Risk if skipped: A routine export copies account tokens from old tool output or unknown session fields to an openly shared backup.
- Depends on: Archive DTO definition; import/store boundary.

RECOMMENDATION:
- Title: Keep archive access under existing authentication and tenancy (AC3, AC4, AC8, AC9)
- Principle: 4 — WebSocket auth; 7 — access control.
- What to get right: Register list/read/export/import/continue/download routes after the existing routes.ts authentication middleware, retain managed-auth scope where enabled, and do not accept an archive id as authorization. In the current single-owner installation the existing owner token authorizes its archive collection; avoid inventing a multi-user ownership model, but never introduce an unauthenticated download or lookup by arbitrary persisted path. Use existing authenticated/origin-checked browser WebSocket upgrades for the newly created session; no new archive socket or protocol frame is needed.
- Risk if skipped: Someone on the network guesses an archive id or uses a public download route to read entire private project histories.
- Depends on: Route registration seam and current auth contract.

RECOMMENDATION:
- Title: Render historical content without executable markup or network side effects (AC10, AC11)
- Principle: 1 — XSS in chat content; 5 — shrink attack surface.
- What to get right: Use React text rendering for archive/tool content or a tightly restricted renderer that disables raw HTML, images, embeds and external-resource auto-loading; validate links and allow navigation only through explicit user action with safe schemes. Markdown downloads should be attachments with a safe fixed/generated filename, text content type and nosniff; present downloaded Markdown as readable data, without implying control over third-party Obsidian plugins. Provide explicit absence markers for unsupported executable or remote media representations rather than rendering imported SVG/HTML as active DOM.
- Risk if skipped: An imported transcript executes stored script or silently loads an attacker tracking URL containing sensitive context.
- Depends on: Fowler viewer task; Beck frontend hostile-content verifier.

RECOMMENDATION:
- Title: Continuation accepts only explicit provider and workspace choices (AC7, AC8, AC9)
- Principle: 1 — command injection; 7 — access control.
- What to get right: Accept an allowlisted Claude/Codex backend and user-selected existing working directory, validate through the existing orchestrator, and populate a bounded pickup draft with explicit historical/untrusted-context framing. Never copy imported argv, model config, permission flags, env, resume ids, system instructions or saved tool calls into spawn configuration, and never interpolate transcript text into shell commands. Create a fresh independent session only after preflight succeeds and require a deliberate user send; do not call the existing continuation route wholesale because it writes handoff files and preserves old backend settings.
- Risk if skipped: A crafted archive smuggles shell flags or permissive execution settings into a newly spawned agent, turning import into host command execution.
- Depends on: Willison continuation contract; existing orchestrator createSession and setPickupDraft.

Verification handoff to Beck: enforce auth refusal on remote unauthenticated read/write/download; reject traversal/unsafe keys/depth/oversize/version failures without state changes; round-trip nested JSON secrets and metadata; assert no transcript body logs; hostile HTML/SVG/javascript-links/remote image render triggers no execution or resource loads; assert import spawns nothing and continuation forwards only backend/cwd then sets a draft without send (AC3, AC5, AC9, AC11).

## Read-only Task 2/3 preparation

- **Storage paths (AC5/6):** Reuse `resolveCleanupPath(root, filename)` from `cleanup/cleanup-paths.ts` behind a private archive-store helper; validate generated content ids against exactly lowercase SHA256 hex, append a fixed `.json`, and never expose arbitrary relative paths. This wrapper already checks deepest existing ancestor realpaths against canonical root, including a legitimately symlinked root. Add `lstat` regular-file checks before read/list and reject symlink entries (including dangling symlinks); the existing resolver catches every error while climbing ancestors, so it alone does not prove a leaf is a regular file. Initialize a private archive directory once; no user-controlled subdirectories. These checks protect untrusted archive requests, not arbitrary concurrent mutation by another process running as the same OS user.
- **Content-address canonicalization (AC3/6):** `redactStructured`'s hex64 rule masks every 64hex string value, even a `contentHash` field; the key suffix exception does not exempt string scanning. Build normalized/redacted content first, hash deterministic key-ordered JSON of that content, then create a server-owned envelope containing id/import timestamp and persist via `writeAtomicJson` without a second envelope-wide redaction pass. Exclude generated export/import timestamps and content id from the identity hash; retain source history timestamps because those are meaningful data. Never trust an uploaded id. Test repeated same-content exports at different times, key-order permutations, import→download→reimport, restart, and that the stored/returned id remains 64hex rather than `[REDACTED]`.
- **Actual session enumeration (AC1):** `SessionStore.loadAll()` only enumerates immediate root JSON files, excluding launcher/runtime siblings; it already includes `archived: true` records that remain in root but not eviction-moved `<directory>/archived/*.json`. No `loadArchived()` method exists. Smallest change is one explicit read-only store enumeration method for both locations, preserving root precedence per session id and reusing migration; use directory entries/regular-file checks and the existing resolving wrapper for archived paths. Do not feed imported archives into SessionStore or launcher enumeration.
- **Real auth integration (AC3/4/8/9):** Add a separate route integration test file instead of extending `routes.test.ts`, whose hoisted auth-manager mock returns true for every token. Set and restore a test `COMPANION_AUTH_TOKEN`, use real `createRoutes` and real auth-manager (mock only subprocess/service collaborators), and mount its router at `/api` exactly as production does. `app.request` without a Bun server env has no trusted loopback peer; use a remote-looking request and forwarding header to make bypass impossible. Assert no/wrong bearer returns 401 for every archive endpoint, real bearer succeeds, real auth cookie follows the existing contract, and 401 invokes neither persistence nor orchestrator; also test the downloaded document route. Registration must occur after `api.use('/*', ...)` around routes.ts:431, through the existing protected route registration block around :2600. Production managed-auth wraps the application in index.ts and has no per-user tenant id, so preserve the installation-wide owner scope rather than suggesting token-derived archive ownership.
