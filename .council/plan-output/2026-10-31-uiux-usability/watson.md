# Watson — accessibility planning evidence

Planning only; current PR449 preview, 2026-10-31. Read quality-a11y.md, assigned components and paired FolderPicker tests, EC-39/accepted conventions, narrow Council dependencies, prior rendered scan, and relevant KB matches. Browser: `/home/auracomp/.npm-global/bin/agent-browser --session uiux-watson-plan --args '--no-sandbox'`, localhost:5199 only. No product/state writes or CLI launches. No axe rerun is claimed. Three recommendations, all backend-neutral and shared by Claude/Codex.

## 1. Restore folder-picker focus on dismissal

- **Verified; AC6/AC2; severity 2/4.** `web/src/components/FolderPicker.tsx:89–119` installs its own trap without recording/restoring an opener; HomePage.tsx:1245 unmounts it on close. Keyboard user loses their location after choosing or dismissing a project directory. Heuristic: user control and freedom; WCAG focus order; accepted EC-39.
- **Browser reproduction:** Home → focus the folder button (`web` in this fixture) → activate → Escape → wait for closing animation. `document.activeElement.tagName === "BODY"`, dialog absent. Existing shared `use-modal-dialog.ts` already restores focus; this picker bypasses it.
- **Minimal change:** bring this picker onto the existing modal focus contract, preserving its manual-path Escape behavior and closing animation. Restore the actual opener for Escape, Close, backdrop, and successful selection; ensure nested modal ownership remains correct. Do not introduce another focus abstraction.
- **Red-first test/verifier:** FolderPicker.test.tsx integration harness with a real opener: user keyboard opens, verifies focus inside, Escape closes, focus returns. Repeat Close/backdrop/select; assert actual producer behavior rather than manually focusing the expected destination. Test reverse/forward Tab including disabled/hidden controls and nested picker. Retain render + axe. Browser repeat in both themes.
- **Dependency:** shared modal hook reuse must retain the picker’s input-specific Escape handling. Update Playground only if a new demonstrated state is needed.

## 2. Give repeated Playground components unique relationship IDs

- **Verified DOM defect, gallery impact; AC6/AC9; severity 1/4.** On `#/playground`, browser counted `council-toggle-help` ×5, `council-budget-notice-title` ×2, `checkpoint-coverage-title` ×2, `uiux-toolkit-help` ×3. Prior incomplete `duplicate-id-aria` entries are real collisions, not clean checks. CouncilToggle.tsx:293/308 statically links every switch to the same ID. The gallery therefore cannot reliably demonstrate each example’s own description/label. Heuristic: consistency and standards; WCAG relationships/name-role-value.
- **Minimal change:** per-instance React useId for component-local descriptions/titles and relationship attributes in these four components. Also scope CouncilToggle’s listbox/options IDs per instance when supporting multiple mounted examples. Do not present these as proven production navigation failures: single-instance production behavior was not shown broken.
- **Red-first test/verifier:** render two differing instances, assert each `aria-describedby`/`aria-labelledby` resolves to its own descendant, assert no duplicate IDs; open two independent listboxes and assert option references remain instance-local. Existing component render + axe and full rendered Playground scan, light/dark.
- **Dependency:** none; small constituent component edits and tests, within the existing Playground evidence task.

## 3. Correct unsupported names on generic badge containers; preserve explanatory text

- **Verified markup defect; AC6; severity 1/4, raise only if assistive-device testing demonstrates lost essential meaning.** Browser confirms `div[data-testid=provider-badges]` and multiple FindingsLog chips use `aria-label` with no supported naming role. ProviderBadges.tsx:141–144; FindingsLog.tsx:172,205,220,270,286,300,314; TaskPanel.tsx:416 is the matching CI-summary candidate. This resolves the prior `aria-prohibited-attr` candidates to actual generic-element markup, rather than treating incomplete as PASS. Heuristic: consistency/standards; accessible names must have appropriate semantics.
- **User impact limits:** provider child badges already use `role=img` and role/provider labels; downgrade reasons are visible inline. These are not proven silent/unusable controls. Some reviewer chips rely on a longer aria-label than their compact visible text; preserve that explanation explicitly rather than simply deleting every label.
- **Minimal change:** remove redundant unsupported wrapper labels where child text already conveys meaning; use a named group for a genuine grouped summary; use visible or sr-only text for chip explanations. Avoid gratuitous `role=img` on text groups, which would hide useful child semantics. No sweeping badge redesign.
- **Red-first test/verifier:** explicit role/name or text assertions for each affected semantic pattern, plus rule-focused rendered axe scan; assertions must check the required reviewer/reason/CI information survives. Existing tests must retain render + axe + interactions where applicable. Playground remains the combined verifier.
- **Dependency:** none; can be combined with recommendation 2 as a small ARIA correction task.

## Incomplete candidates resolved without a new bug claim

- Home’s `aria-haspopup=listbox` candidate is the disabled Council pairing trigger; `listbox` is valid. Its `aria-controls=council-pairing-listbox` points to a conditionally mounted popup (`CouncilToggle.tsx:350,372–375`). A collapsed trigger referring to a currently unmounted popup is not evidence that the value `listbox` is invalid. No recommendation to change permissions, disable the dropdown, or force hidden panels into the accessibility tree. Open-state relation needs the verifier above; duplicate gallery IDs are tracked separately.
- Provider child badges already have explicit `role=img` and names: do not remove those valid semantics while correcting their generic wrapper.
- PermissionBanner already announces politely, provides Alt+Shift+P review focus, and restores prior focus when focus was inside the dismissed banner. Do not impose automatic focus theft on arrival based solely on the reference’s older blanket advice; verify the existing noninterrupting flow with assistive technology.
- Composer already has a named textarea and visible focus style; shared modal hook already handles visibility/disabled controls, nesting and focus return. No new general replacement or abstraction is justified.
- Offscreen/inert sidebar children and the already fixed mobile create buttons were not counted as new findings.

## Acceptance evidence still required (not established defects)

Physical iPhone/PWA + VoiceOver: Home → folder picker → cancel/select → chat → permission request/review/decision → interrupted/reconnected output. Record spoken names, focus destination after close, keyboard/safe-area overlap and touch reachability with keyboard shown. Include both themes and both CLI fixtures. Test actual streaming announcements once, without rereading the complete conversation, and distinguish static Playground from streaming behavior. Browser DOM inspection does not validate speech timing, rotor behavior, hardware keyboard, Dynamic Type or PWA keyboard geometry. Native iOS reference was read for device acceptance context; Aura remains a web/PWA, so native point-size rules are not asserted as automatic web violations.

No additional contrast, motion, CodeMirror/xterm, or streaming defects are claimed from this narrow evidence. Prior 22-state axe results remain bounded evidence, not whole-product accessibility certification. Keep unresolved manual checks explicitly open in the consolidated registry; physical-device acceptance is a verifier, not an invented implementation task.
