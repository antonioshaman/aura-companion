# Android — platform rules

Platform: android

## When this applies

The screen ships as an Android app: Jetpack Compose, Views, or a web view or cross-platform shell presented as a native app. A Telegram Mini App opened on Android also takes the touch-target and back rules below. Desktop web defaults (hover affordances, small click targets, in-page back links) do not transfer.

## Addendum (2026-10-28) — targets, layout and window size

Source: material-3, material-components-android

- **Targets.** Make every touch target at least 48×48 dp (about 9 mm on any screen), even when the visible icon is 24 dp: the padding is part of the target. Larger targets serve more people.
- **Window size classes.** Design for compact (under 600 dp, a phone in portrait), medium (600–839 dp) and expanded (840 dp and up) widths; foldables and tablets move between them at run time. Height classes exist too, for landscape phones.
- **Navigation.** Use a navigation bar for three to five top-level destinations in compact and medium widths, with a label under every icon. In expanded widths switch to a navigation rail. Do not use a navigation bar for a single task or for actions.
- **Edge-to-edge.** Draw behind the system bars but keep content and controls inside the window insets, so the gesture area and status bar never cover a control.

## Addendum (2026-10-28) — back, sheets, dialogs and messages

Source: material-3

- **Back.** The system back gesture and button own back navigation. Support predictive back, which previews the destination while the user swipes, and let it dismiss sheets and dialogs. Never put a second back control in the content.
- **Bottom sheets.** On phones, a modal bottom sheet spans the width, sits above a scrim and can be dismissed by tapping the scrim, swiping down or with predictive back. Use one instead of a dialog or inline menu for a long list of actions; give a full-height sheet a visible close control.
- **Dialogs.** Use them sparingly for decisions that must interrupt. A dialog has at most two actions: one confirms, the other dismisses. A single action is only an acknowledgement. Keep its content short enough not to scroll.
- **Snackbars.** For low-importance feedback such as "Message archived" with Undo, use a snackbar: one at a time, at most one action, never covering navigation or frequently used targets.

## Addendum (2026-10-28) — colour, elevation and motion

Source: material-3

- Express depth with tonal surface roles, not shadows: the background uses `surface`, and nested regions such as navigation use the five surface-container roles (lowest to highest). Shadows and scrims are reserved for overlap such as a sheet over content.
- Every container colour has a matching on-colour for its text and icons; never pair them across roles.
- Use the motion tokens of the motion scheme rather than ad-hoc durations, and honour the system's remove-animations setting.

## Source conflicts

- **Claim:** Depth in dark themes: tone or shadow
  **Sources:** material-3, apple-hig
  **Default:** On Android, tonal surface-container roles for nesting and shadow or scrim only where surfaces overlap.
  **Reason:** Material 3 separates surfaces by tone by default and keeps shadows for overlap; Apple's base and elevated backgrounds are a different mechanism with the same goal, so each platform follows its own system.
  **Platform scope:** android, ios
