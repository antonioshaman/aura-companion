# Fowler — structural plan

## 1. Separate portable data from executable session persistence
**Principle:** Architecture earns boundaries where data changes for different reasons; keep mutable state contained.
**What to get right:** Define one versioned, allowlisted portable-history contract and pure conversion/validation/Markdown functions in `web/server/portable-history.ts`; do not export `PersistedSession` wholesale or use `extractHandoff` as archive serialization. Put durable imported documents in `web/server/portable-history-store.ts` under a separate directory; imports must never enter `SessionStore`, launcher metadata, permission queues, or live bridge maps. This pays immediately because archive evolution otherwise couples every import to runtime restart schemas (AC1, AC2, AC4, AC6, AC10).
**Risk if skipped:** Runtime migrations silently change archive meaning; imported records become executable sessions or overwrite live state.
**Dependencies:** Agree contract and published limits before route/UI work; security seat owns validation/redaction details. Verifiers: `web/server/portable-history.test.ts`, `web/server/portable-history-store.test.ts`.

## 2. Add a read-only source seam, preserve existing lifecycle code
**Principle:** Extract pure logic; leave stable code alone and keep mutations sequential.
**What to get right:** Add a narrowly scoped read-only enumeration method to `SessionStore` for available root and cleanup-archived records: `loadAll()` currently reads root JSON only, while `moveToArchive()` uses the archive subdirectory. Compose export snapshots from persisted records plus live `wsBridge.getSession()` history with live data winning by session ID; expose only projected portable fields, and report skipped or unavailable content explicitly. Do not refactor session restoration or expand `ws-bridge.ts` into archive ownership (AC1, AC2, AC6).
**Risk if skipped:** Cleanup-archived sessions disappear from export, or stale persisted snapshots replace current history; a broad persistence refactor multiplies regression cost.
**Dependencies:** Portable contract; store's resolving path conventions. Verifiers: `web/server/session-store.test.ts`, `web/server/routes/portable-history-routes.test.ts` (both providers, root/archive/live collision cases).

## 3. Keep archive routes and continuation mutation order visible
**Principle:** Separate reasons to change without creating a generic provider framework.
**What to get right:** Register `web/server/routes/portable-history-routes.ts` through the existing authenticated API registration seam, injecting the archive store, read-only source access, orchestrator, and pickup-draft setter. Continuation must explicitly validate archive, selected provider and chosen cwd, derive a bounded draft, await `orchestrator.createSession`, and then set that new session's pickup draft; retain the existing continue-in-new endpoint unchanged because it preserves same-provider/Council recovery semantics. Use existing lifecycle preflight rather than duplicating backend availability checks; no imported model, auto-proceed, permission or Council configuration gets copied (AC8, AC9).
**Risk if skipped:** Adding cross-provider branches to existing recovery flow carries old model/Council state across providers and hides spawn side effects.
**Dependencies:** Portable contract/store and context builder; lifecycle injection available in `routes.ts`. Verifier: `web/server/routes/portable-history-routes.test.ts` (Claude→Codex and reverse, bad cwd/provider, no auto-send and source unchanged).

## 4. Isolate settings workflow state, reuse the HTTP boundary
**Principle:** Cohesive local state is cheaper than global state used by one subtree.
**What to get right:** Add a self-contained `PortableHistorySettings.tsx` settings child; `SettingsPage.tsx` only adds category/section composition. Keep selection, pending operation, errors, retry and imported-detail state local, use typed methods in `web/src/api.ts`, and navigate to a new session through existing routing after continuation succeeds. Share the portable contract via type-only imports; do not duplicate archive interfaces in frontend or introduce a Zustand slice (AC4, AC7, AC8, AC12, AC15).
**Risk if skipped:** SettingsPage's already broad state grows further, transient import errors leak across screens, and wire-shape changes require untyped manual coordination.
**Dependencies:** Route contract and error behavior. Verifiers: `web/src/components/PortableHistorySettings.test.tsx` (render/axe/keyboard/retry/empty state), `web/src/components/SettingsPage.test.tsx` (category integration), `web/src/api.test.ts` (authentication and wire errors if existing test seam supports it).

## 5. Keep full readable export separate from bounded continuation
**Principle:** Names must reveal intentional data loss; pure outputs can share a schema without sharing lossy transforms.
**What to get right:** Provide distinctly named pure full-history Markdown and bounded continuation builders from the portable contract, each returning explicit omission/truncation metadata. Reuse `handoff-extractor.ts` only where its image removal and short tool-result policy are appropriate for a continuation draft; never route archival Markdown through its lossy formatting. A single full-history rendering policy should feed readable download and safe textual viewing, with pagination or bounded detail loading rather than global store copies (AC2, AC7, AC10, AC11).
**Risk if skipped:** A supposedly complete Obsidian export becomes a 400-character tool-result summary, and future edits accidentally change both archive and model-context semantics.
**Dependencies:** Portable schema and continuation policy from Willison; security seat's safe renderer policy. Verifiers: `web/server/portable-history.test.ts`, `web/src/components/PortableHistorySettings.test.tsx`.
