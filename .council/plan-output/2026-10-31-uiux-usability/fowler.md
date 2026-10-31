# Fowler — structural planning advice

Planning only. Inspected assigned components, App/session ownership, narrow ChatView and Diagnostics route dependencies, refactoring reference and accepted conventions. Evidence below is current-code inspection; no browser, physical-device, CLI or mutation verification was performed. These recommendations support the existing defect owners rather than adding parallel implementation tasks.

## 1. Own ordinary drafts by their actual lifetime

**AC2, severity 3, heuristic: user control / error prevention.** `Composer.tsx:40–41` owns text/images in component state; `ChatView.tsx:327` renders Composer without a session key while `App.tsx:423` changes its session prop in place. Conversely Home text/images (`HomePage.tsx:105,137`) disappear when Home unmounts (`App.tsx:427`). The store's `pickupDrafts` (`sessions-slice.ts:62`) explicitly represents one-shot handoff, not editable drafts. These different lifetimes explain the already-assigned cross-session leakage and navigation-loss findings.

**Minimal boundary:** one narrow ordinary-draft owner in the frontend store, keyed by Companion session ID, plus a distinct Home draft slot containing the editable creation text/images/project. Keep picker visibility, focus, menus and errors component-local. Define Home reset semantics explicitly so merely opening Home never acts as discard. Keep pickup consumption as an explicit handoff operation; seed only an empty ordinary draft. Do not turn pickupDrafts into an ambiguously consumed editable-draft cache. A new draft slice is reasonable if it keeps these fields out of sessions-slice; it is not a prerequisite to fixing behavior, and needs no persistence/schema/backend change. Keep attachment lifecycle and cleanup explicit. Deleting a session must release its ordinary draft.

**Red-first:** type different text/attachments in A/B, switch both ways; leave/reopen Home with selected project; recover failed launch; submit clears only the submitted owner, and session removal clears its draft. Run for both backends. Test handoff precedence separately. Dependencies: draft-isolation and Home-draft owners must agree on the draft contract before either edits Composer/store; one owner implements the shared contract. No third task to reorganize all slices.

## 2. Keep document request ownership local and visible

**AC1/AC2/AC5, severity 3, heuristic: error prevention / recovery.** `ClaudeMdEditor.tsx:26–47` installs every load response, and `:61–84` clears dirty state after any save completion. It lacks the resource/revision ownership already present in `SessionEditorPane.tsx:253–270`. Separately the editor tree-load catch (`SessionEditorPane.tsx:238–243`) clears selectedPath for a background tree failure: tree availability controls document ownership even though these change for different reasons.

**Minimal boundary:** keep tree status separate from the open document buffer; tree errors must not clear a document. In ClaudeMdEditor, retain local request epoch + resource identity + edit revision, and captured save path/content; only the matching operation may update that resource's baseline/status. A save of revision N cannot mark revision N+1 clean. Explicit selection/close continue to own discard decisions. Do not build a generic async-resource hook or unified editor service: the existing editor guards provide a pattern, not evidence that their different image/tree/multi-file workflows share an implementation.

**Red-first:** defer load A, switch cwd/reopen for B, resolve B then A; defer save, type again, finish save; background tree refresh rejects with a dirty open file and retry preserves buffer. Assert user-visible buffer/path/dirty state, not ref increments. Component render+axe/interaction tests accompany modifications. Dependencies: coordinate the existing CLAUDE.md race and tree-refresh owners; these can otherwise ship independently of drafts.

## 3. Put the report trust boundary in the reader, not its consumers

**AC8/AC5, severity 3, heuristic: recovery / error prevention.** `kb-analysis-store.ts:88–106` claims `isReport` is a complete KbAnalysisReport type guard but validates only shallow fields; `signals.every` dereferences `s.signal` without first rejecting null. `readLatestReport` catches JSON parsing (`:116–121`) but validation occurs outside that catch (`:126`). A malformed nested report can escape the documented unavailable-state contract. This is the existing nested-validation defect, independently confirmed by inspection.

**Minimal boundary:** replace/extend the pure validator at this read boundary to validate every field downstream consumers require, using unknown-safe nested checks and finite numeric checks where needed; malformed input returns the existing `report-invalid` unavailable variant. Do not add defensive shape checks to every card, change the storage schema, or wrap all Diagnostics failures in an empty-report fallback. Keep read/write and decision mutations visibly ordered. The separately assigned analysis/decision race belongs in their shared mutation admission boundary, not in this parser or a new UI lock.

**Red-first:** disk fixtures with null signal and malformed nested finding/merge-task fields return unavailable without throwing; valid versioned fixture remains available; newer-schema behavior remains intact. Use isolated temp roots. Dependencies: parser owner implements once; Diagnostics UI consumes the existing unavailable state. Decision-race and archive-loss fixes remain separately owned.

## No additional structural work justified

Do not split App, HomePage, Composer, sessions-slice or ws-bridge solely for file length. Existing routing and PR449 request guards should stay unless a distinct failing scenario proves otherwise. No generic request coordinator, new protocol, shared global loading/error state, or broad component extraction is needed for these repairs. Keep component-specific late-response ownership local; share a pure helper only if the actual fixes reveal identical tested logic.

The permitted five recommendations are not a quota: these three cover the concrete structural seams. Physical iPhone keyboard/safe-area/VoiceOver acceptance remains a separate evidence stage; source inspection cannot close it.
