# Portable project history (v1)

Settings → **Portable history** → **Open portable history** lists saved Claude and Codex sessions, including rows moved to the cleanup archive. Select sessions and **Export selected** to download one JSON archive. Import that file on another Aura installation to connect its history. Provider sign-in is not needed to export, import, read or download it; existing Aura installation authentication still applies.

Imported archives are stored separately at `$COMPANION_HOME/portable-history/` (normally `~/.companion/portable-history/`). They never enter live SessionStore/launcher state. Original sessions are not changed. Importing the same normalized content again returns the existing archive; export timestamps do not create duplicates. Imports use atomic private writes (files 0600, directory 0700).

## What is portable

The versioned `aura-portable-history` JSON contains source session ids, project/cwd provenance, provider and available model/CLI metadata, ordered supported historical messages, full tool inputs/results and available inline base64 attachments. Interrupted/errored status stays visible; missing legacy stream status remains unknown. Unsupported events/content and unavailable external media are reported in exclusions. The archive is a snapshot of what Aura still has, not recovery of deleted provider history. Active sessions can change after export; finish the current turn for a settled snapshot.

Source code, repository/worktree contents, external file attachments, provider accounts, native resume ids, environment/configuration, process identities, pending permission queues and executable session state are not backed up. Task lists and decisions are preserved where present in messages; no authoritative task summary is fabricated. Existing known-secret redaction is reapplied at export/import. **Review arbitrary text and binary attachments yourself before sharing**: automatic redaction cannot detect every secret and does not scan embedded binary bytes.

Use **Download Markdown / Obsidian** for a full textual copy of the selected session. Metadata and message contents are literal fenced text, including embedded attachment representations; no Obsidian plugin or cloud account is required. The JSON is the machine-readable import format; Markdown is for reading, not re-import. Aura's viewer displays literal text and does not load transcript HTML or remote images.

## Continuing with another provider

Select a connected archive and history session. Review **Continuation context**, choose Claude or Codex, explicitly enter an existing absolute workspace directory, then select **Create session with draft**. Aura creates an independent solo session using the selected provider and a held, editable draft. **The user must send the draft.** No saved commands run and no historical permissions are restored. Connect the matching source checkout separately. Current provider availability and its account requirements still apply.

The deterministic context is separate from the archive. It retains early setup, the newest user goal and recent evidence, with visible truncation/attachment omission counts. This is context transfer, not native cross-provider resume, restored model memory, or equivalent model quality. Local GPU agents, automatic synchronization and arbitrary third-party chat imports are outside v1.

## Published limits

| Item | Limit |
|---|---|
| JSON archive (import and export) | 32 MiB UTF-8 |
| Sessions per archive | 200 |
| Messages total | 50,000 |
| Individual string | 16 MiB UTF-8 |
| JSON nesting | 32 |
| JSON nodes | 250,000 |
| Review/exclusion notes | 10,000 |
| Continuation draft | 24 KiB UTF-8 |

Split a larger collection into session selections. A single over-limit session is rejected or reported unavailable; it is never silently summarized into an archive. Requests count actual streamed bytes, even with missing/forged Content-Length. Invalid/version-incompatible imports fail before persistence and do not replace existing archives.

## Code and verification

- `web/server/portable-history-types.ts`: browser-safe versioned data contract and limits.
- `portable-history.ts`: validation/redaction, evidence projection, literal full Markdown and bounded context.
- `portable-history-store.ts`: independent content-addressed durable imports; no model dependencies.
- `SessionStore.loadForPortableExport`: read-only root/cleanup inventory with explicit skipped count; live bridge snapshots take precedence.
- `routes/portable-history-routes.ts`: authenticated REST registration via existing `createRoutes`, no new WS protocol.
- `web/src/components/PortableHistorySettings.tsx`: lazy settings workflow, literal paginated history, explicit import/export/continuation.

Tests live alongside these modules; real-auth registration is verified separately in `routes/portable-history-auth.test.ts`. Component tests cover render, axe, keyboard/error recovery and hostile-content rendering. Browser smoke uses `agent-browser`; deterministic tests do not call live providers.
