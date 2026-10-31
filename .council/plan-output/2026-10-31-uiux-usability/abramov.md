# Abramov — React/Zustand state review

Planning only. Evidence is current source and paired tests, not browser reproduction; no tests executed, live state changed, or product files edited. Read the complete `quality-frontend.md` reference and applicable conventions (especially EC-39, EC-41–43); consulted focused frontend/editor KB entries. Preserve PR449 guards and their regressions. Severity uses requested Nielsen 0–4 scale.

## Verified current-code problems and minimal implementation tasks

### R1 — Session drafts cross session boundaries and disappear on route changes
- **AC2, AC7; severity 3; heuristic:** user control / error prevention. Owner: frontend state.
- **Evidence:** `Composer.tsx:40–41` holds text/images only in component-local state. `App.tsx:420` renders the same unkeyed `ChatView` position for successive session IDs; `ChatView.tsx:327` renders the same unkeyed Composer. There is no reset/restore keyed to session ID. Switching A→B keeps A’s text/images while `handleSend` uses B’s new `sessionId` (`Composer.tsx:208–229`). Navigating to Settings or Diff unmounts the chat (`App.tsx:416–434`) and loses the draft. Pickup-draft handling is a separate initial-prefill mechanism, not preservation of ordinary edits.
- **Cost/scenario:** user types confidential or project-specific input in A, selects B, and can send that input to B; visiting Settings loses unfinished text.
- **Minimal change:** retain editable composer drafts by session ID outside the unmounting component; hydrate only that session’s draft. Preserve text and image attachments, clear only the successfully submitted session’s draft. Keying alone prevents carryover but still loses drafts and is insufficient. Keep ephemeral menus/caret local. No backend schema required; durable reload persistence is a separate decision.
- **Red first:** Composer test rerenders session A→B→A with different text/attachments and asserts isolation and restoration; App integration test types, navigates Settings/Diff, returns, and asserts draft survives. Test Send in B never emits A’s content, for Claude and Codex. Existing render/axe tests remain; represent restored-draft state in Playground.
- **Dependencies:** none; decide only in-memory versus reload persistence explicitly before implementation.

### R2 — Home form unmount silently drops draft and chosen project
- **AC2; severity 3; heuristic:** user control / error prevention. Owner: frontend state.
- **Evidence:** `HomePage.tsx:105,135–137` initializes text/cwd/images locally. `App.tsx:432–434` mounts Home only for the session surface with no selected session. Opening Settings/Prompts/etc. removes Home; returning reinitializes cwd from recent directories, not the selected unsent project. This is distinct from PR449’s fixed late folder-default response and stale launch-navigation guards.
- **Cost/scenario:** choose a project, compose a task, open Settings to fix credentials, return to an empty form and potentially another project.
- **Minimal change:** retain the unsent Home form in UI state across ordinary route transitions, including text, project and attachments; define explicit new-session/reset and successful-create clearing semantics. Do not keep every routed page mounted as a workaround.
- **Red first:** App/Home integration: select a non-default project, type and attach, navigate Settings→Home, assert exact restoration; explicit reset clears intentionally; failed creation preserves it; late creation from an abandoned form cannot clear a newer form draft.
- **Dependencies:** coordinate draft ownership with R1 and existing `homeResetKey` semantics, without a generic new framework.

### R3 — CLAUDE.md save completion falsely marks newer edits saved
- **AC2, AC5; severity 3; heuristic:** visibility of system status / error prevention. Owner: frontend editor.
- **Evidence:** `ClaudeMdEditor.tsx:61–82` captures `editContent` at Save, awaits the API and unconditionally `setDirty(false)`. The textarea remains editable while saving (`:317`); only Save is disabled (`:304`). Type B while save(A) is pending: disk receives A, editor displays B, Unsaved disappears and Save disables. Selecting another file while save is pending can similarly apply completion to a different selection. `load()` (`:26–46`) also has no request/selection lifetime guard on cwd/open changes.
- **Minimal change:** track saved content for the applicable file identity, derive dirty from editable versus saved contents, and scope load/save results to their request and file/dialog lifetime. A save of A must leave subsequently typed B dirty; old file/project loads must never overwrite the current project. Reuse the existing SessionEditorPane revision approach where appropriate rather than inventing an editor abstraction.
- **Red first:** deferred save test types A, saves, types B, resolves A; B stays visible and Unsaved/Save remain active. Deferred load cwd A→B resolved in reverse order must keep B. Save A, select B, resolve A must leave B unchanged. New-file save must also preserve newer typing rather than reload over it. Existing close-confirmation and axe tests remain.
- **Dependencies:** none. This is a different editor from PR449’s SessionEditorPane save/refresh protections; do not claim that fixed regression has reopened.

### R4 — Background tree-fetch failure destroys unsaved file content
- **AC2, AC5; severity 3; heuristic:** error prevention / recovery. Owner: frontend editor.
- **Evidence:** `SessionEditorPane.tsx:220–247` reruns the tree request on `changedFilesTick` and manual refresh. Its rejection handler calls `setSelectedPath(null)` (`:241`), irrespective of dirty state. The selected-path effect (`:272–281`) then clears content/originalContent. Dirty guards exist for explicit file selection/back and agent file refresh, but not this background failure path.
- **Cost/scenario:** edit a file unsaved; agent update or refresh starts a tree read; network/tree read fails; the editor abandons the selected file and wipes the unsaved buffer without confirmation.
- **Minimal change:** preserve selected file, content and last successful tree when a tree refresh fails; show retryable tree error independently. Initial empty-tree failure may show empty/error. Do not treat listing failure as proof the selected file was deleted.
- **Red first:** deferred/rejected tree refresh while dirty, triggered once by changedFilesTick and once by Refresh: editor keeps text and selection, Save remains usable, error and retry are visible. Resolve retry and assert the buffer remains. Keep PR449’s successful in-flight file refresh and stale-save tests.
- **Dependencies:** none.

## Hypotheses and acceptance boundaries

- Raw `acceptEdits` has a concrete display path: `Composer.tsx:99–104` defaults to `acceptEdits` then falls back to the raw mode string when a Codex mode has no match. This alone does not prove the screenshot’s server state was valid or which permission was effective. Capture sanitized session_init/sdk metadata first and verify the backend mapping before proposing a label fix. Never translate it to a stronger mode or alter actual permissions merely to improve the label. Coordinate with the backend/model semantics expert; not an additional implementation recommendation here.
- Parent-driven unmount of a dirty file editor may lose edits beyond R4; exact host transitions need a focused integration reproduction before adding another task. The local file-switch confirmation does not prove host navigation protection.
- No recommendation for useTransition/useDeferredValue, selector consolidation, a new routing library or broad component extraction: no measured latency or concrete failure justifies those changes.
- Physical iPhone keyboard, PWA lifecycle and VoiceOver remain manual acceptance. Component tests establish state invariants, not device usability. No browser verification claimed.
