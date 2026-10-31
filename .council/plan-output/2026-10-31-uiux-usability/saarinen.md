# Saarinen — visual/mobile planning review

No necessary product-code change is established in this visual lane. Do not create a restyling or token-migration task from this review.

## Evidence and disposition

- Read the required `quality-ui.md`, Saarinen `platform-ios.md` and `token-ladder.md`, the confirmed brief, `conventions.md` matching rules, and `docs/reviews/mobile-usability-2026-10-31.md`; inspected the assigned CSS/components and the saved Codex Home screenshot. Native iOS materials/type prescriptions do not automatically apply to this web/PWA surface.
- Independently opened the read-only preview at `http://127.0.0.1:5199` through `/home/auracomp/.npm-global/bin/agent-browser`, session `uiux-saarinen-plan`, at 320×800. Closed the initially open mobile sidebar and selected dark mode. Screenshot evidence: `/tmp/saarinen-dark320.png`; initial sidebar evidence `/tmp/saarinen-320.png`. These are local planning artifacts, not physical-device results. No session launch, archive or other server mutation was attempted.
- The current Home input, its wrapped option rows and send control remain visibly contained at 320 px. Isolation text wraps, including the long filesystem path. The long page scrolls vertically; lower options being below the initial fold is not by itself a defect. No offscreen/inert sidebar children were counted as targets. Saved 439 px Codex screenshot likewise shows a contained input and clear primary-action hierarchy. These observations support AC3 for these particular states only.
- `web/src/index.css:194–220` defines a darker card/input (`#141413`) inside the lighter dark page (`#262624`); `HomePage.tsx:1058` uses it for the input. The screenshot reads as a distinct inset editing well. Although this differs from a raised-overlay ladder, it is not evidence that a menu/modal is indistinguishable, and does not justify globally lightening every card. Semantic `cc-*` roles already exist. Keep overlay-specific issues contingent on actual rendered ambiguity.
- `HomePage.tsx:1036–1058` uses reserved top space, compact heading and separated input; `Composer.tsx:520` and `:808–910` contain blur/shadow/transition treatments. Their mere presence is not a demonstrated daily-task failure. No decorative redesign or wholesale animation cleanup is recommended.

## Required visual acceptance, shared verifier rather than a separate implementation task

**AC3/AC6; heuristic:** consistency, visual hierarchy and visibility of system status. **Severity:** unassigned pending reproduction (physical-device acceptance is not a finding).

Reuse the mobile verifier owned by the accessibility/UX implementation task: capture Home plus expanded model/mode/environment controls, normal Composer plus permission/error states, sidebar, and an editor dialog at 320/390/439 CSS px in both themes. Test realistic long labels/paths and both providers. Assert visible active controls remain inside their intended viewport/container, popovers separate visibly from underlying content, and action state changes do not displace the input/send control. Exclude inert/offscreen drawer descendants from geometry checks. Preserve screenshots on failure and add a focused component regression before each confirmed fix; new chat states belong in Playground. This is a verifier requirement, not a proposal for a new visual abstraction.

On a physical iPhone/PWA, record keyboard-open portrait, landscape, safe areas, text enlargement and opening a bottom-anchored popover; confirm input/send remain reachable and labels do not overlap. Browser emulation does not pass that gate. Dependency: UX/accessibility scenario registry and physical-device access. If a reproducible visual failure appears, assign its file/line, severity 0–4 and smallest layout fix then; do not pre-authorize a broad restyle.

Raw `acceptEdits` labeling belongs to the UX/backend-semantics investigation (AC4), not an independently duplicated visual task. No permission change is proposed.
