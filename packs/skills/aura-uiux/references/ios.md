# iOS and iPadOS — platform rules

Platform: ios

## When this applies

The screen ships as an iOS or iPadOS app: SwiftUI, UIKit, or a web view or cross-platform shell (React Native, Capacitor, Flutter) presented as a native app. A Telegram Mini App opened on an iPhone also takes the touch-target and Dynamic Type rules below. Desktop web defaults (hover affordances, small click targets, in-page back links) do not transfer.

## Addendum (2026-10-28) — layout, targets and text size

Source: apple-hig

- **Targets.** Controls default to 44×44 pt; 28×28 pt is the smallest Apple allows, and only for secondary controls with generous spacing. Spacing between controls matters as much as their size, because a mis-tap usually lands on the neighbour.
- **Safe areas.** Lay out inside the system safe areas and layout margins so nothing sits under the status bar, the Dynamic Island, the home indicator or the rounded corners. Backgrounds may extend edge to edge; text and controls may not.
- **Dynamic Type.** Use the system text styles, or custom styles that scale with the user's text-size setting, and check the largest accessibility sizes: text wraps instead of truncating, rows grow, and side-by-side layouts stack when the text no longer fits.
- **Hierarchy.** Put the most important content at the top and leading edge, group related items, and use progressive disclosure instead of showing every option at once. Mirror the layout for right-to-left languages by using system components.
- **Size classes.** Plan for compact and regular widths: iPad split view and Stage Manager change the width at run time. Where there is room, a tab bar may become a sidebar.

## Addendum (2026-10-28) — navigation and modality

Source: apple-hig

- **Back.** In a navigation stack, back is the leading button in the navigation bar plus the edge-swipe gesture; never block the gesture, and never put a second back control in the content.
- **Tab bar.** Use it to move between the app's top-level sections, never to trigger an action. Keep tab labels, keep each tab's navigation state when the user switches away and back, and keep the bar visible across the section.
- **Sheets.** Use a sheet for a short, self-contained task. On iPhone, sheets rest at a medium (about half) or large detent; show the grabber when the sheet can resize. Confirm before dismissing a sheet that holds unsaved input.
- **Full-screen modal.** Use one only for immersive or multi-step content, and always give an obvious way out (Done or Cancel in the toolbar).
- **Destructive choices.** Offer them in an action sheet tied to the control that started them: the destructive option uses the destructive style, and Cancel sits apart at the bottom. Use an alert only for something the user must know now, with at most a few buttons.
- **Gestures.** Every swipe or custom gesture has an on-screen equivalent (for example, an Edit mode with a Delete button next to swipe-to-delete) for people with limited dexterity, switch access or Voice Control.

## Addendum (2026-10-28) — permissions, onboarding, colour and motion

Source: apple-hig

- Ask for a permission at the moment the feature that needs it is first used, or inside onboarding after explaining the benefit. The purpose string is one short, specific sentence saying why the data is needed.
- Onboarding is short, skippable and comes after launch, not instead of it; teach by letting people do the task.
- Prefer the system background and label colours: in dark mode iOS uses dimmer base backgrounds and brighter elevated ones for layered surfaces such as sheets and popovers. Check contrast in both appearances and with Increase Contrast on.
- When Reduce Motion is on, replace zooming, scaling and parallax with fades or no animation.

## Source conflicts

- **Claim:** Minimum touch target size
  **Sources:** apple-hig, wcag-22
  **Default:** 44×44 pt for every primary and frequent control; 28×28 pt only for secondary controls with spacing that keeps the effective target at 44 pt.
  **Reason:** WCAG 2.5.8 sets a 24 px floor for the web; iOS users and Apple's review expect 44 pt, and the platform rule is the stricter one.
  **Platform scope:** ios
